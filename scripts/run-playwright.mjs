import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./evidence-utils.mjs";
import {
  PLAYWRIGHT_RUN_LOCK_TOKEN_ENV,
  acquirePlaywrightRunLock,
} from "./playwright-evidence-lock.mjs";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
} from "./exclusive-run-lock.mjs";

const require = createRequire(import.meta.url);
const CHILD_GATE_ARGUMENT = "--playwright-child-gate";
const scriptPath = fileURLToPath(import.meta.url);

function runChild(executable, args, { cwd, env, spawnImpl }) {
  return new Promise((resolveChild, rejectChild) => {
    // The gate joins the inherited lock and registers its self lease before it
    // sends "ready". Only then may it start the real CLI, so killing this
    // wrapper in the spawn-to-track window can never expose an unleased writer.
    const gate = spawnImpl(
      process.execPath,
      [scriptPath, CHILD_GATE_ARGUMENT, cwd],
      { cwd, env, stdio: ["ignore", "inherit", "inherit", "ipc"] }
    );
    let result = null;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) rejectChild(error);
      else resolveChild(result);
    };
    gate.once("error", settle);
    gate.on("message", (message) => {
      if (message?.type === "ready") {
        try {
          gate.send({ type: "run", executable, args });
        } catch (error) {
          gate.kill("SIGTERM");
          settle(error);
        }
      } else if (message?.type === "result") {
        result = message.result;
      }
    });
    gate.once("close", (code, signal) => {
      if (result === null) {
        settle(
          new Error(
            `Playwright child gate exited before reporting a result (${signal ?? code ?? "unknown"})`
          )
        );
        return;
      }
      settle();
    });
  });
}

export async function runPlaywright({
  root = projectRoot,
  args = process.argv.slice(2),
  environment = process.env,
  spawnImpl = spawn,
  playwrightCli = require.resolve("@playwright/test/cli"),
  verifier = resolve(projectRoot, "scripts/verify-playwright-evidence.mjs"),
} = {}) {
  const runLock = acquirePlaywrightRunLock({ root, environment });
  const childEnvironment = {
    ...environment,
    [PLAYWRIGHT_RUN_LOCK_TOKEN_ENV]: runLock.token,
    [EVIDENCE_PIPELINE_TOKEN_ENV]: runLock.token,
  };
  try {
    const playwright = await runChild(
      process.execPath,
      [playwrightCli, "test", ...args],
      {
        cwd: root,
        env: childEnvironment,
        spawnImpl,
      }
    );
    if (playwright.code !== 0 || playwright.signal !== null) {
      return playwright.code ?? 1;
    }
    if (environment.PLAYWRIGHT_EVIDENCE !== "1") return 0;

    // The verifier is a reentrant child of the same outer lock. There is no
    // unlock/relock window in which another writer can replace reporter bytes.
    const verification = await runChild(process.execPath, [verifier], {
      cwd: root,
      env: childEnvironment,
      spawnImpl,
    });
    return verification.code === 0 && verification.signal === null
      ? 0
      : (verification.code ?? 1);
  } finally {
    runLock();
  }
}

async function runChildGate(root) {
  const pipelineLock = acquireEvidencePipelineLock(
    root,
    "Playwright child gate",
    { allowInheritedToken: true }
  );
  process.on("exit", pipelineLock);
  let started = false;
  let activeChild = null;
  let childLease = null;

  const disconnectAfterSend = (message) => {
    if (!process.connected) return;
    process.send(message, () => {
      if (process.connected) process.disconnect();
    });
  };
  process.on("disconnect", () => {
    if (!started) {
      pipelineLock();
      process.exit(1);
    }
    // Once started, the gate and real child leases keep the outer lock live.
    // The gate therefore finishes supervising even if its wrapper is SIGKILLed.
  });
  process.once("message", (message) => {
    if (message?.type !== "run") return;
    started = true;
    activeChild = spawn(message.executable, message.args ?? [], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    activeChild.once("error", (error) => {
      disconnectAfterSend({
        type: "result",
        result: {
          code: 1,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
    try {
      childLease = pipelineLock.trackActiveChild(activeChild.pid);
    } catch (error) {
      activeChild.kill("SIGTERM");
      disconnectAfterSend({
        type: "result",
        result: {
          code: 1,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    activeChild.once("close", (code, signal) => {
      if (childLease) pipelineLock.untrackActiveChild(childLease);
      pipelineLock();
      disconnectAfterSend({ type: "result", result: { code, signal } });
      process.exitCode = code ?? 1;
    });
  });
  if (process.connected) process.send({ type: "ready" });
}

export async function main() {
  process.exitCode = await runPlaywright();
}

if (
  process.argv[1] &&
  scriptPath === process.argv[1] &&
  process.argv[2] === CHILD_GATE_ARGUMENT
) {
  await runChildGate(resolve(process.argv[3]));
} else if (process.argv[1] && scriptPath === process.argv[1]) {
  await main();
}
