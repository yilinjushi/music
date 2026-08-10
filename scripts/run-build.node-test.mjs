import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectRoot } from "./evidence-utils.mjs";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
} from "./exclusive-run-lock.mjs";
import { runProductionBuild } from "./run-build.mjs";

function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
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
}

function waitForClose(child) {
  return new Promise((resolveClose) => {
    child.on("close", (code, signal) => resolveClose({ code, signal }));
  });
}

test("the standard build holds the pipeline lock through every command", async () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-lock-"));
  const verifier = join(root, "verify-lock.mjs");
  const marker = join(root, "verified.txt");
  const lockDirectory = evidencePipelineLockPath(root);
  try {
    writeFileSync(
      verifier,
      `import assert from "node:assert/strict";\n` +
        `import { readFileSync, writeFileSync } from "node:fs";\n` +
        `const owner = JSON.parse(readFileSync(${JSON.stringify(join(lockDirectory, "owner.json"))}, "utf8"));\n` +
        `assert.ok(owner.activeChildren.some((child) => child.pid === process.ppid));\n` +
        `writeFileSync(${JSON.stringify(marker)}, owner.token);\n`
    );
    await runProductionBuild({
      root,
      commands: [
        {
          label: "lock verifier",
          executable: process.execPath,
          arguments: [verifier],
        },
      ],
    });
    assert.ok(readFileSync(marker, "utf8").length > 0);
    assert.equal(existsSync(lockDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build conflicts fail closed while explicit CI token reentry stays owned", async () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-reentry-"));
  const lockDirectory = evidencePipelineLockPath(root);
  const previousToken = process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
  delete process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
  const releaseOuter = acquireEvidencePipelineLock(root, "canonical CI");
  try {
    await assert.rejects(
      runProductionBuild({ root, commands: [] }),
      /already running/
    );
    process.env[EVIDENCE_PIPELINE_TOKEN_ENV] = releaseOuter.token;
    await runProductionBuild({ root, commands: [] });
    assert.equal(existsSync(lockDirectory), true);
  } finally {
    releaseOuter();
    if (previousToken === undefined) {
      delete process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
    } else {
      process.env[EVIDENCE_PIPELINE_TOKEN_ENV] = previousToken;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed build command releases the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-failure-"));
  try {
    await assert.rejects(
      runProductionBuild({
        root,
        commands: [
          {
            label: "intentional failure",
            executable: process.execPath,
            arguments: ["-e", "process.exit(7)"],
          },
        ],
      }),
      /exit code 7/
    );
    const release = acquireEvidencePipelineLock(root, "post-failure writer");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM is forwarded and the lock releases only after the child exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-sigterm-"));
  const command = join(root, "command.mjs");
  const wrapper = join(root, "wrapper.mjs");
  const started = join(root, "started.txt");
  const completed = join(root, "completed.txt");
  try {
    writeFileSync(
      command,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(started)}, String(process.pid));\n` +
        `process.on("SIGTERM", () => setTimeout(() => process.exit(143), 250));\n` +
        `setTimeout(() => writeFileSync(${JSON.stringify(completed)}, "unsafe"), 30_000);\n`
    );
    writeFileSync(
      wrapper,
      `import { runProductionBuild } from ${JSON.stringify(new URL("./run-build.mjs", import.meta.url).href)};\n` +
        `try { await runProductionBuild({ root: ${JSON.stringify(root)}, commands: [{ label: "signal fixture", executable: process.execPath, arguments: [${JSON.stringify(command)}] }] }); }\n` +
        `catch (error) { if (error?.signal) process.kill(process.pid, error.signal); throw error; }\n`
    );
    const child = spawn(process.execPath, [wrapper], {
      stdio: "inherit",
    });
    const closed = waitForClose(child);
    await waitForFile(started);
    child.kill("SIGTERM");
    assert.throws(
      () => acquireEvidencePipelineLock(root, "signal competitor"),
      /already running/
    );
    assert.deepEqual(await closed, { code: null, signal: "SIGTERM" });
    assert.equal(existsSync(completed), false);
    const release = acquireEvidencePipelineLock(root, "post-signal writer");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILLed wrapper cannot expose the lock while its child is alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-sigkill-"));
  const command = join(root, "command.mjs");
  const wrapper = join(root, "wrapper.mjs");
  const started = join(root, "started.txt");
  const releaseChild = join(root, "release.txt");
  const completed = join(root, "completed.txt");
  let child = null;
  let commandPid = null;
  try {
    writeFileSync(
      command,
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid }));\n` +
        `while (!existsSync(${JSON.stringify(releaseChild)})) await new Promise((resolve) => setTimeout(resolve, 20));\n` +
        `writeFileSync(${JSON.stringify(completed)}, "done");\n`
    );
    writeFileSync(
      wrapper,
      `import { runProductionBuild } from ${JSON.stringify(new URL("./run-build.mjs", import.meta.url).href)};\n` +
        `await runProductionBuild({ root: ${JSON.stringify(root)}, commands: [{ label: "kill fixture", executable: process.execPath, arguments: [${JSON.stringify(command)}] }] });\n`
    );
    child = spawn(process.execPath, [wrapper], {
      stdio: "inherit",
    });
    const closed = waitForClose(child);
    await waitForFile(started);
    child.kill("SIGKILL");
    assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });

    assert.throws(
      () => acquireEvidencePipelineLock(root, "orphan competitor"),
      /already running/
    );
    const owner = JSON.parse(
      readFileSync(join(evidencePipelineLockPath(root), "owner.json"), "utf8")
    );
    const commandIdentity = JSON.parse(readFileSync(started, "utf8"));
    commandPid = commandIdentity.pid;
    assert.ok(
      owner.activeChildren.some(
        (active) => active.pid === commandIdentity.parentPid
      ),
      "the orphaned dist writer must remain part of lock liveness"
    );

    writeFileSync(releaseChild, "release\n");
    await waitForFile(completed);
    let release;
    const deadline = Date.now() + 5_000;
    while (!release && Date.now() < deadline) {
      try {
        release = acquireEvidencePipelineLock(root, "post-orphan writer");
      } catch (error) {
        if (!/already running/.test(String(error))) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    assert.equal(typeof release, "function");
    release();
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGKILL");
    }
    if (commandPid) {
      try {
        process.kill(commandPid, "SIGKILL");
      } catch {
        // The fixture command normally exited after its release marker.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("package and canonical CI use the locked standard build entry", () => {
  const packageJson = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8")
  );
  assert.equal(packageJson.scripts.build, "node scripts/run-build.mjs");
  assert.equal(packageJson.scripts["build:release"], "npm run build");

  const ci = readFileSync(join(projectRoot, "scripts/ci-test.js"), "utf8");
  assert.match(
    ci,
    /name: "Build",\s*cmd: "npm run build",\s*nestedEvidenceWriter: true,/
  );
});
