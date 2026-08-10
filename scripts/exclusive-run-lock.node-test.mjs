import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
