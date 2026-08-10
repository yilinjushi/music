import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
} from "./exclusive-run-lock.mjs";
import {
  acquirePlaywrightRunLock,
  withPlaywrightRunLockHeld,
} from "./playwright-evidence-lock.mjs";

test("Playwright acquires the canonical lock before config construction", () => {
  const config = readFileSync(
    join(projectRoot, "playwright.config.ts"),
    "utf8"
  );
  const acquireAt = config.indexOf("acquirePlaywrightRunLock();");
  const evidenceModeAt = config.indexOf("const evidenceMode");
  const defineConfigAt = config.indexOf("export default defineConfig(");
  assert.ok(acquireAt > -1);
  assert.ok(acquireAt < evidenceModeAt);
  assert.ok(acquireAt < defineConfigAt);
  assert.doesNotMatch(config, /globalSetup\s*:/);

  const reporter = readFileSync(
    join(projectRoot, "scripts/playwright-evidence-reporter.mjs"),
    "utf8"
  );
  assert.ok(
    reporter.match(/withPlaywrightRunLockHeld\(\(\) =>/g)?.length >= 2,
    "reporter cleanup and final write must both assert live lock ownership"
  );
});

test("the lock remains owned throughout reporter-style final writes", () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-lock-final-write-"));
  const processRef = new EventEmitter();
  const lockDirectory = evidencePipelineLockPath(root);
  try {
    acquirePlaywrightRunLock({ root, processRef });
    assert.equal(existsSync(lockDirectory), true);

    let wrote = false;
    withPlaywrightRunLockHeld(
      () => {
        assert.throws(
          () => acquireEvidencePipelineLock(root, "competing reporter"),
          /already running/
        );
        writeFileSync(join(root, "final-write.json"), "{}\n");
        wrote = true;
      },
      { root, processRef }
    );

    assert.equal(wrote, true);
    assert.equal(existsSync(lockDirectory), true);
    processRef.emit("exit", 0);
    assert.equal(existsSync(lockDirectory), false);
    assert.throws(
      () =>
        withPlaywrightRunLockHeld(() => {}, {
          root,
          processRef,
        }),
      /without its live pipeline lock/
    );
  } finally {
    processRef.emit("exit", 1);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exception and an external signal leave a safely recoverable lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-lock-process-exit-"));
  const worker = join(root, "worker.mjs");
  writeFileSync(
    worker,
    `import { acquirePlaywrightRunLock } from ${JSON.stringify(new URL("./playwright-evidence-lock.mjs", import.meta.url).href)};\n` +
      `acquirePlaywrightRunLock({ root: ${JSON.stringify(root)} });\n` +
      `process.stdout.write("ready\\n");\n` +
      `if (process.argv[2] === "throw") setImmediate(() => { throw new Error("fixture crash"); });\n` +
      `else setInterval(() => {}, 1_000);\n`
  );

  const run = (mode) =>
    new Promise((resolveRun) => {
      const child = spawn(process.execPath, [worker, mode], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (mode === "signal" && stdout.includes("ready\n")) {
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code, signal) =>
        resolveRun({ code, signal, stdout, stderr })
      );
    });

  try {
    const crashed = await run("throw");
    assert.notEqual(crashed.code, 0);
    assert.match(crashed.stdout, /ready/);
    assert.match(crashed.stderr, /fixture crash/);
    const releaseAfterCrash = acquireEvidencePipelineLock(
      root,
      "post-crash writer"
    );
    releaseAfterCrash();

    const signaled = await run("signal");
    assert.equal(signaled.signal, "SIGTERM");
    assert.match(signaled.stdout, /ready/);
    const releaseAfterSignal = acquireEvidencePipelineLock(
      root,
      "post-signal writer"
    );
    releaseAfterSignal();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
