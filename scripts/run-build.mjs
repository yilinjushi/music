import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./evidence-utils.mjs";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
} from "./exclusive-run-lock.mjs";

const COMMAND_GATE_ARGUMENT = "--locked-build-command-gate";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];
const FORCE_KILL_AFTER_MS = 5_000;
const scriptPath = fileURLToPath(import.meta.url);

function defaultBuildCommands(root) {
  return [
    {
      label: "TypeScript project build",
      executable: process.execPath,
      arguments: [resolve(root, "node_modules/typescript/bin/tsc"), "-b"],
    },
    {
      label: "Vite production build",
      executable: process.execPath,
      arguments: [resolve(root, "node_modules/vite/bin/vite.js"), "build"],
    },
  ];
}

class BuildInterruptedError extends Error {
  constructor(signal) {
    super(`Production build interrupted by ${signal}`);
    this.signal = signal;
  }
}

function childOutcome(command, result) {
  if (result?.error) return `${command.label} failed: ${result.error}`;
  if (result?.signal) {
    return `${command.label} failed with signal ${result.signal}`;
  }
  if (result?.status !== 0) {
    return `${command.label} failed with exit code ${result?.status ?? "unknown"}`;
  }
  return null;
}

function executeThroughGate({
  root,
  command,
  pipelineLock,
  interruptedSignal,
  setActiveGate,
}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const gate = spawn(
      process.execPath,
      [scriptPath, COMMAND_GATE_ARGUMENT, root],
      {
        cwd: root,
        env: {
          ...process.env,
          [EVIDENCE_PIPELINE_TOKEN_ENV]: pipelineLock.token,
        },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      }
    );
    setActiveGate(gate);

    let gateLease;
    let result = null;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      setActiveGate(null);
      if (gateLease) {
        try {
          pipelineLock.untrackActiveChild(gateLease);
        } catch (leaseError) {
          error ??= leaseError;
        }
      }
      if (error) rejectCommand(error);
      else resolveCommand(result);
    };

    gate.on("error", (error) => settle(error));
    gate.on("message", (message) => {
      if (message?.type === "ready") {
        try {
          gateLease = pipelineLock.trackActiveChild(gate.pid);
          const signal = interruptedSignal();
          if (signal) {
            gate.kill(signal);
            return;
          }
          gate.send({ type: "run", command, gateLease });
        } catch (error) {
          gate.kill("SIGTERM");
          settle(error);
        }
      } else if (message?.type === "result") {
        result = message.result;
      }
    });
    gate.on("close", (code, signal) => {
      const interruption = interruptedSignal();
      if (interruption) {
        settle(new BuildInterruptedError(interruption));
        return;
      }
      if (result === null) {
        settle(
          new Error(
            `${command.label} command gate exited before reporting a result (${signal ?? code ?? "unknown"})`
          )
        );
        return;
      }
      const failure = childOutcome(command, result);
      settle(failure ? new Error(failure) : null);
    });
  });
}

export async function runProductionBuild({
  root = projectRoot,
  commands = defaultBuildCommands(root),
  processRef = process,
} = {}) {
  const normalizedRoot = resolve(root);
  const pipelineLock = acquireEvidencePipelineLock(
    normalizedRoot,
    "Production build",
    { allowInheritedToken: true }
  );
  processRef.on("exit", pipelineLock);

  let activeGate = null;
  let receivedSignal = null;
  const signalHandlers = new Map(
    FORWARDED_SIGNALS.map((signal) => [
      signal,
      () => {
        receivedSignal ??= signal;
        if (activeGate && activeGate.exitCode === null) {
          activeGate.kill(signal);
        }
      },
    ])
  );
  for (const [signal, handler] of signalHandlers) {
    processRef.on(signal, handler);
  }

  try {
    for (const command of commands) {
      if (receivedSignal) throw new BuildInterruptedError(receivedSignal);
      await executeThroughGate({
        root: normalizedRoot,
        command,
        pipelineLock,
        interruptedSignal: () => receivedSignal,
        setActiveGate: (gate) => {
          activeGate = gate;
        },
      });
    }
    if (receivedSignal) throw new BuildInterruptedError(receivedSignal);
  } finally {
    for (const [signal, handler] of signalHandlers) {
      processRef.off(signal, handler);
    }
    processRef.off("exit", pipelineLock);
    pipelineLock();
  }
}

async function runCommandGate(root) {
  const pipelineLock = acquireEvidencePipelineLock(
    root,
    "Production build command gate",
    { allowInheritedToken: true }
  );
  process.on("exit", pipelineLock);
  let gateLease = null;
  let childLease = null;
  let activeChild = null;
  let started = false;
  let forwardedSignal = null;
  let forceKillTimer = null;

  const disconnectAfterSend = (message) => {
    if (!process.connected) return;
    process.send(message, () => {
      if (process.connected) process.disconnect();
    });
  };

  const untrack = (lease) => {
    if (!lease) return;
    try {
      pipelineLock.untrackActiveChild(lease);
    } catch {
      // A parent that still owns the lock performs the same nonce-bound
      // cleanup. If the parent died, a live child lease remains fail-closed.
    }
  };
  const forwardSignal = (signal) => {
    forwardedSignal ??= signal;
    if (!activeChild || activeChild.exitCode !== null) return;
    activeChild.kill(signal);
    forceKillTimer ??= setTimeout(() => {
      if (activeChild?.exitCode === null) activeChild.kill("SIGKILL");
    }, FORCE_KILL_AFTER_MS);
  };
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => forwardSignal(signal));
  }

  process.on("disconnect", () => {
    if (!started) {
      untrack(gateLease);
      pipelineLock();
      process.exit(1);
    }
    // Once the command starts, continue supervising it. Its active lease keeps
    // the lock live even when the wrapper was killed with SIGKILL.
  });

  process.on("message", (message) => {
    if (message?.type !== "run" || started) return;
    started = true;
    gateLease = message.gateLease;
    if (forwardedSignal) {
      untrack(gateLease);
      pipelineLock();
      process.exitCode = 1;
      if (process.connected) process.disconnect();
      return;
    }

    const command = message.command;
    activeChild = spawn(command.executable, command.arguments ?? [], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    activeChild.on("error", (error) => {
      disconnectAfterSend({
        type: "result",
        result: {
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
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    activeChild.on("close", (status, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      untrack(childLease);
      untrack(gateLease);
      pipelineLock();
      disconnectAfterSend({ type: "result", result: { status, signal } });
      process.exitCode = status === 0 && signal === null ? 0 : 1;
    });
  });

  if (process.connected) process.send({ type: "ready" });
}

const isMain =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === scriptPath;

if (isMain && process.argv[2] === COMMAND_GATE_ARGUMENT) {
  await runCommandGate(resolve(process.argv[3]));
} else if (isMain) {
  try {
    await runProductionBuild();
  } catch (error) {
    if (error instanceof BuildInterruptedError) {
      process.kill(process.pid, error.signal);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
