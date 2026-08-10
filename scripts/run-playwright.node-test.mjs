import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectRoot } from "./evidence-utils.mjs";
import {
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
} from "./exclusive-run-lock.mjs";
import { runPlaywright } from "./run-playwright.mjs";

function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const poll = () => {
      if (exists(path)) {
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

function fixtureScripts(root) {
  const lockModule = new URL("./exclusive-run-lock.mjs", import.meta.url).href;
  const playwrightLockModule = new URL(
    "./playwright-evidence-lock.mjs",
    import.meta.url
  ).href;
  const playwright = join(root, "fake-playwright.mjs");
  const verifier = join(root, "fake-verifier.mjs");
  writeFileSync(
    playwright,
    `import { appendFileSync } from "node:fs";\n` +
      `import { assertPlaywrightRunLockHeld } from ${JSON.stringify(playwrightLockModule)};\n` +
      `assertPlaywrightRunLockHeld({ root: process.env.FIXTURE_ROOT });\n` +
      `appendFileSync(process.env.TIMELINE, "playwright:" + process.argv.slice(2).join(" ") + "\\n");\n`
  );
  writeFileSync(
    verifier,
    `import { appendFileSync } from "node:fs";\n` +
      `import { acquireEvidencePipelineLock } from ${JSON.stringify(lockModule)};\n` +
      `const release = acquireEvidencePipelineLock(process.env.FIXTURE_ROOT, "fixture verifier", { allowInheritedToken: true });\n` +
      `appendFileSync(process.env.TIMELINE, "verifier\\n");\n` +
      `release();\n`
  );
  return { playwright, verifier };
}

test("one outer lock covers Playwright reporters and the evidence verifier", async () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-wrapper-evidence-"));
  const timeline = join(root, "timeline.txt");
  const scripts = fixtureScripts(root);
  try {
    const code = await runPlaywright({
      root,
      args: ["--project=fixture"],
      environment: {
        ...process.env,
        PLAYWRIGHT_EVIDENCE: "1",
        FIXTURE_ROOT: root,
        TIMELINE: timeline,
      },
      playwrightCli: scripts.playwright,
      verifier: scripts.verifier,
    });
    assert.equal(code, 0);
    assert.equal(
      readFileSync(timeline, "utf8"),
      "playwright:test --project=fixture\nverifier\n"
    );
    assert.equal(exists(evidencePipelineLockPath(root)), false);
    const releaseAfter = acquireEvidencePipelineLock(root, "post-wrapper");
    releaseAfter();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary --list still runs under the wrapper and does not verify", async () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-wrapper-list-"));
  const timeline = join(root, "timeline.txt");
  const scripts = fixtureScripts(root);
  try {
    const code = await runPlaywright({
      root,
      args: ["--list"],
      environment: {
        ...process.env,
        FIXTURE_ROOT: root,
        TIMELINE: timeline,
      },
      playwrightCli: scripts.playwright,
      verifier: scripts.verifier,
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(timeline, "utf8"), "playwright:test --list\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SIGKILLed wrapper cannot expose a running Playwright child", async () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-wrapper-sigkill-"));
  const playwright = join(root, "blocking-playwright.mjs");
  const wrapper = join(root, "wrapper.mjs");
  const started = join(root, "started.json");
  const releaseChild = join(root, "release.txt");
  const completed = join(root, "completed.txt");
  const runPlaywrightModule = new URL("./run-playwright.mjs", import.meta.url)
    .href;
  const playwrightLockModule = new URL(
    "./playwright-evidence-lock.mjs",
    import.meta.url
  ).href;
  let wrapperProcess = null;
  let playwrightPid = null;
  try {
    writeFileSync(
      playwright,
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `import { assertPlaywrightRunLockHeld } from ${JSON.stringify(playwrightLockModule)};\n` +
        `assertPlaywrightRunLockHeld({ root: ${JSON.stringify(root)} });\n` +
        `writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, gatePid: process.ppid }));\n` +
        `while (!existsSync(${JSON.stringify(releaseChild)})) await new Promise((resolve) => setTimeout(resolve, 20));\n` +
        `writeFileSync(${JSON.stringify(completed)}, "done");\n`
    );
    writeFileSync(
      wrapper,
      `import { runPlaywright } from ${JSON.stringify(runPlaywrightModule)};\n` +
        `process.exitCode = await runPlaywright({ root: ${JSON.stringify(root)}, playwrightCli: ${JSON.stringify(playwright)} });\n`
    );
    wrapperProcess = spawn(process.execPath, [wrapper], { stdio: "inherit" });
    const wrapperClosed = new Promise((resolveClose) => {
      wrapperProcess.on("close", (code, signal) =>
        resolveClose({ code, signal })
      );
    });
    await waitForFile(started);
    const identity = JSON.parse(readFileSync(started, "utf8"));
    playwrightPid = identity.pid;
    wrapperProcess.kill("SIGKILL");
    assert.deepEqual(await wrapperClosed, {
      code: null,
      signal: "SIGKILL",
    });

    assert.throws(
      () => acquireEvidencePipelineLock(root, "Playwright competitor"),
      /already running/
    );
    const owner = JSON.parse(
      readFileSync(join(evidencePipelineLockPath(root), "owner.json"), "utf8")
    );
    assert.ok(
      owner.activeChildren.some((child) => child.pid === identity.gatePid),
      "the pre-run gate must hold a lease before Playwright starts"
    );

    writeFileSync(releaseChild, "release\n");
    await waitForFile(completed);
    let release;
    const deadline = Date.now() + 5_000;
    while (!release && Date.now() < deadline) {
      try {
        release = acquireEvidencePipelineLock(root, "post-Playwright writer");
      } catch (error) {
        if (!/already running/.test(String(error))) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    assert.equal(typeof release, "function");
    release();
  } finally {
    if (
      wrapperProcess?.exitCode === null &&
      wrapperProcess?.signalCode === null
    ) {
      wrapperProcess.kill("SIGKILL");
    }
    if (playwrightPid) {
      try {
        process.kill(playwrightPid, "SIGKILL");
      } catch {
        // The fixture normally exits after its release marker.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("package, config, reporter, verifier, and CI enforce the wrapper contract", () => {
  const pkg = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8")
  );
  assert.equal(pkg.scripts["test:e2e"], "node scripts/run-playwright.mjs");
  const config = readFileSync(
    join(projectRoot, "playwright.config.ts"),
    "utf8"
  );
  assert.match(config, /assertPlaywrightRunLockHeld\(\);/);
  assert.doesNotMatch(config, /acquirePlaywrightRunLock\(\);|globalSetup\s*:/);
  const reporter = readFileSync(
    join(projectRoot, "scripts/playwright-evidence-reporter.mjs"),
    "utf8"
  );
  assert.ok(reporter.match(/withPlaywrightRunLockHeld\(\(\) =>/g)?.length >= 2);
  const verifier = readFileSync(
    join(projectRoot, "scripts/verify-playwright-evidence.mjs"),
    "utf8"
  );
  assert.match(verifier, /allowInheritedToken:\s*true/);
  const workflow = readFileSync(
    join(projectRoot, ".github/workflows/ci.yml"),
    "utf8"
  );
  assert.doesNotMatch(workflow, /Verify Playwright execution evidence/);
});

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    if (error?.code === "EISDIR") return true;
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
