import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./evidence-utils.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";

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

export function runProductionBuild({
  root = projectRoot,
  commands = defaultBuildCommands(root),
  processRef = process,
} = {}) {
  const normalizedRoot = resolve(root);
  const releasePipelineLock = acquireEvidencePipelineLock(
    normalizedRoot,
    "Production build",
    { allowInheritedToken: true }
  );
  processRef.on("exit", releasePipelineLock);

  try {
    for (const command of commands) {
      const result = spawnSync(command.executable, command.arguments ?? [], {
        cwd: normalizedRoot,
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const outcome = result.signal
          ? `signal ${result.signal}`
          : `exit code ${result.status ?? "unknown"}`;
        throw new Error(`${command.label} failed with ${outcome}`);
      }
    }
  } finally {
    processRef.off("exit", releasePipelineLock);
    releasePipelineLock();
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    runProductionBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
