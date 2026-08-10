import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
  acquireExclusiveRunLock,
  evidencePipelineLockPath,
} from "./exclusive-run-lock.mjs";
import { projectRoot } from "./evidence-utils.mjs";

test("exclusive run locks reject a concurrent owner and release cleanly", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-"));
  const lock = join(root, "lighthouse.lock");
  try {
    const release = acquireExclusiveRunLock(lock, "Lighthouse evidence");
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.throws(
      () => acquireExclusiveRunLock(lock, "Lighthouse evidence"),
      /already running/
    );
    release();
    const releaseAgain = acquireExclusiveRunLock(lock, "Lighthouse evidence");
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive run locks recover an invalid stale owner", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-stale-"));
  const lock = join(root, "lighthouse.lock");
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), '{"pid":0}\n');
    const release = acquireExclusiveRunLock(lock, "Lighthouse evidence");
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead owner remains live while its recorded child is alive", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-child-live-"));
  const lock = join(root, "pipeline.lock");
  try {
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "parent-token",
        activeChildren: [
          { pid: process.pid, nonce: "live-child", startedAt: "fixture" },
        ],
      })}\n`
    );
    assert.throws(
      () => acquireExclusiveRunLock(lock, "child-protected writer"),
      /already running/
    );

    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "parent-token",
        activeChildren: [
          { pid: 999_999_998, nonce: "dead-child", startedAt: "fixture" },
        ],
      })}\n`
    );
    const release = acquireExclusiveRunLock(lock, "post-child writer");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active child cleanup is nonce-bound", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-child-nonce-"));
  const lock = join(root, "pipeline.lock");
  try {
    const release = acquireExclusiveRunLock(lock, "nonce owner");
    const child = release.trackActiveChild(process.pid);
    assert.equal(
      release.untrackActiveChild({ ...child, nonce: "different-run" }),
      false
    );
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    assert.deepEqual(owner.activeChildren, [child]);
    assert.equal(release.untrackActiveChild(child), true);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a late release never deletes a replacement owner's live lock", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-owner-swap-"));
  const lock = join(root, "pipeline.lock");
  const parked = join(root, "parked.lock");
  try {
    const releaseFirst = acquireExclusiveRunLock(lock, "first owner");
    renameSync(lock, parked);
    const releaseSecond = acquireExclusiveRunLock(lock, "second owner");
    const secondOwner = readFileSync(join(lock, "owner.json"), "utf8");

    releaseFirst();
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), secondOwner);

    releaseSecond();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owner initialization window is never mistaken for a stale lock", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-init-"));
  const lock = join(root, "lighthouse.lock");
  try {
    mkdirSync(lock);
    assert.throws(
      () => acquireExclusiveRunLock(lock, "Lighthouse evidence"),
      /still initializing/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two stale-lock recovery contenders never both acquire", async () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-race-"));
  const lock = join(root, "lighthouse.lock");
  const worker = join(root, "worker.mjs");
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), '{"pid":0}\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    writeFileSync(
      worker,
      `import { acquireExclusiveRunLock } from ${JSON.stringify(new URL("./exclusive-run-lock.mjs", import.meta.url).href)};\n` +
        `const release = acquireExclusiveRunLock(${JSON.stringify(lock)}, "race");\n` +
        `process.stdout.write("acquired\\n");\n` +
        `await new Promise((resolve) => setTimeout(resolve, 200));\n` +
        `release();\n`
    );
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [worker], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.equal(
      results.filter((result) => result.stdout === "acquired\n").length,
      1
    );
    assert.equal(
      results.filter((result) =>
        /already running|initializing/.test(result.stderr)
      ).length,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a controlled stale-owner ABA cannot replace or delete a live owner", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-aba-"));
  const lock = join(root, "pipeline.lock");
  try {
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      '{"pid":0,"token":"stale-owner"}\n'
    );
    assert.throws(
      () =>
        acquireExclusiveRunLock(lock, "ABA fixture", {
          recoveryHooks: {
            afterMarkerAcquired() {
              const replacement = join(lock, "replacement-owner.json");
              writeFileSync(
                replacement,
                `${JSON.stringify({
                  pid: process.pid,
                  token: "replacement-owner",
                  startedAt: "controlled-interleaving",
                })}\n`
              );
              renameSync(replacement, join(lock, "owner.json"));
            },
          },
        }),
      /already running/
    );
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    assert.equal(owner.token, "replacement-owner");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PID reuse recovery requires a verifiable process identity", () => {
  const root = mkdtempSync(join(tmpdir(), "exclusive-run-lock-pid-reuse-"));
  const lock = join(root, "pipeline.lock");
  try {
    const releaseProbe = acquireExclusiveRunLock(lock, "identity probe");
    const observedIdentity = JSON.parse(
      readFileSync(join(lock, "owner.json"), "utf8")
    ).processIdentity;
    releaseProbe();

    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        processIdentity: {
          platform: "linux",
          bootId: "different-boot",
          startTimeTicks: "0",
        },
        token: "reused-pid",
      })}\n`
    );
    const identityIsVerifiable =
      process.platform === "linux" &&
      typeof observedIdentity?.bootId === "string" &&
      typeof observedIdentity?.startTimeTicks === "string";
    if (identityIsVerifiable) {
      const release = acquireExclusiveRunLock(lock, "PID reuse fixture");
      release();
    } else {
      assert.throws(
        () => acquireExclusiveRunLock(lock, "unverifiable PID fixture"),
        /already running/
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline lock paths canonicalize symlink aliases with realpath", () => {
  const parent = mkdtempSync(join(tmpdir(), "exclusive-run-lock-realpath-"));
  const root = join(parent, "checkout");
  const alias = join(parent, "checkout-alias");
  try {
    mkdirSync(root);
    symlinkSync(root, alias, "dir");
    assert.equal(
      evidencePipelineLockPath(root),
      evidencePipelineLockPath(alias)
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("pipeline reentry is explicit and never leaks through the parent environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-pipeline-reentry-"));
  const worker = join(root, "worker.mjs");
  const previousToken = process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
  delete process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
  const release = acquireEvidencePipelineLock(root, "parent pipeline");
  try {
    assert.equal(process.env[EVIDENCE_PIPELINE_TOKEN_ENV], undefined);
    writeFileSync(
      worker,
      `import { acquireEvidencePipelineLock } from ${JSON.stringify(new URL("./exclusive-run-lock.mjs", import.meta.url).href)};\n` +
        `const release = acquireEvidencePipelineLock(${JSON.stringify(root)}, "nested writer", { allowInheritedToken: true });\n` +
        `release();\n`
    );
    const run = (env) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [worker], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stderr }));
      });
    const blocked = await run({ ...process.env });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /already running/);
    const nested = await run({
      ...process.env,
      [EVIDENCE_PIPELINE_TOKEN_ENV]: release.token,
    });
    assert.equal(nested.code, 0, nested.stderr);
  } finally {
    release();
    if (previousToken === undefined)
      delete process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
    else process.env[EVIDENCE_PIPELINE_TOKEN_ENV] = previousToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reentrant writer self-leases across parent SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-reentrant-sigkill-"));
  const coordinator = join(root, "coordinator.mjs");
  const writer = join(root, "writer.mjs");
  const ready = join(root, "ready.txt");
  const releaseWriter = join(root, "release.txt");
  const completed = join(root, "completed.txt");
  const lockModule = new URL("./exclusive-run-lock.mjs", import.meta.url).href;
  let coordinatorProcess = null;
  let writerPid = null;

  const waitForFile = (path) => {
    const deadline = Date.now() + 5_000;
    return new Promise((resolveWait, rejectWait) => {
      const poll = () => {
        if (existsSync(path)) {
          resolveWait();
          return;
        }
        if (Date.now() >= deadline) {
          rejectWait(new Error(`timed out waiting for ${path}`));
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  };

  try {
    writeFileSync(
      writer,
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `import { acquireEvidencePipelineLock } from ${JSON.stringify(lockModule)};\n` +
        `const release = acquireEvidencePipelineLock(${JSON.stringify(root)}, "nested fixture", { allowInheritedToken: true });\n` +
        `process.on("exit", release);\n` +
        `writeFileSync(${JSON.stringify(ready)}, String(process.pid));\n` +
        `while (!existsSync(${JSON.stringify(releaseWriter)})) await new Promise((resolve) => setTimeout(resolve, 20));\n` +
        `release();\n` +
        `writeFileSync(${JSON.stringify(completed)}, "done");\n`
    );
    writeFileSync(
      coordinator,
      `import { spawn } from "node:child_process";\n` +
        `import { acquireEvidencePipelineLock, EVIDENCE_PIPELINE_TOKEN_ENV } from ${JSON.stringify(lockModule)};\n` +
        `const release = acquireEvidencePipelineLock(${JSON.stringify(root)}, "parent fixture");\n` +
        `spawn(process.execPath, [${JSON.stringify(writer)}], { env: { ...process.env, [EVIDENCE_PIPELINE_TOKEN_ENV]: release.token }, stdio: "inherit" });\n` +
        `setInterval(() => {}, 1_000);\n`
    );
    coordinatorProcess = spawn(process.execPath, [coordinator], {
      stdio: "inherit",
    });
    const coordinatorClosed = new Promise((resolveClose) => {
      coordinatorProcess.on("close", (code, signal) =>
        resolveClose({ code, signal })
      );
    });
    await waitForFile(ready);
    writerPid = Number(readFileSync(ready, "utf8"));
    coordinatorProcess.kill("SIGKILL");
    assert.deepEqual(await coordinatorClosed, {
      code: null,
      signal: "SIGKILL",
    });

    assert.throws(
      () => acquireEvidencePipelineLock(root, "nested competitor"),
      /already running/
    );
    const owner = JSON.parse(
      readFileSync(join(evidencePipelineLockPath(root), "owner.json"), "utf8")
    );
    assert.ok(
      owner.activeChildren.some((child) => child.pid === writerPid),
      "the inherited writer must automatically register a self lease"
    );

    writeFileSync(releaseWriter, "release\n");
    await waitForFile(completed);
    let release;
    const deadline = Date.now() + 5_000;
    while (!release && Date.now() < deadline) {
      try {
        release = acquireEvidencePipelineLock(root, "post-nested writer");
      } catch (error) {
        if (!/already running/.test(String(error))) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    assert.equal(typeof release, "function");
    release();
  } finally {
    if (
      coordinatorProcess?.exitCode === null &&
      coordinatorProcess?.signalCode === null
    ) {
      coordinatorProcess.kill("SIGKILL");
    }
    if (writerPid) {
      try {
        process.kill(writerPid, "SIGKILL");
      } catch {
        // The fixture writer normally exits after removing its self lease.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("every standalone evidence writer participates in the pipeline lock", () => {
  const writers = [
    "scripts/ci-test.js",
    "scripts/playwright-evidence-lock.mjs",
    "scripts/run-build.mjs",
    "scripts/verify-playwright-evidence.mjs",
    "scripts/run-lighthouse.mjs",
    "scripts/verify-pwa.mjs",
    "scripts/verify-release.mjs",
    "scripts/verify-licenses.mjs",
    "scripts/run-audit.mjs",
    "scripts/generate-sbom.mjs",
    "scripts/verify-playback-sample.mjs",
    "scripts/generate-evidence-manifest.mjs",
  ];
  for (const file of writers) {
    assert.match(
      readFileSync(join(projectRoot, file), "utf8"),
      /acquireEvidencePipelineLock\s*\(/,
      file
    );
  }
});

test("canonical CI passes its token to the reentrant final manifest", () => {
  const ci = readFileSync(join(projectRoot, "scripts/ci-test.js"), "utf8");
  const manifest = readFileSync(
    join(projectRoot, "scripts/generate-evidence-manifest.mjs"),
    "utf8"
  );
  assert.match(ci, /npm run evidence:manifest/);
  assert.match(
    ci,
    /\[EVIDENCE_PIPELINE_TOKEN_ENV\]:\s*releasePipelineLock\.token/
  );
  assert.match(manifest, /Evidence manifest[\s\S]*allowInheritedToken:\s*true/);
});
