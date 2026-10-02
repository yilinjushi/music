import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { npmInvocation, projectRoot, writeJson } from "./evidence-utils.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";
import {
  loadAuditExceptions,
  unexcusedVulnerabilities,
} from "./audit-exceptions.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outputArg = option("--output");
const level = option("--level") ?? "low";
const omitDev = process.argv.includes("--omit-dev");
const allowedLevels = new Set(["low", "moderate", "high", "critical"]);

if (!outputArg || !allowedLevels.has(level)) {
  console.error(
    "Usage: node scripts/run-audit.mjs [--omit-dev] --level <low|moderate|high|critical> --output <path>"
  );
  process.exit(2);
}

const releasePipelineLock = acquireEvidencePipelineLock(
  projectRoot,
  "Dependency audit evidence",
  { allowInheritedToken: true }
);
process.on("exit", releasePipelineLock);

const output = resolve(projectRoot, outputArg);
const args = ["audit", "--json", `--audit-level=${level}`];
if (omitDev) args.push("--omit=dev");
const npm = npmInvocation(args);
const audit = spawnSync(npm.command, npm.args, {
  cwd: projectRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    npm_config_cache:
      process.env.MUSIC_NPM_CACHE ?? `${tmpdir()}/music-pwa-npm-audit-cache`,
  },
});

let payload;
try {
  payload = JSON.parse(audit.stdout || "");
} catch (error) {
  payload = {
    error: "npm audit did not return valid JSON",
    parseError: error instanceof Error ? error.message : String(error),
    exitCode: audit.status,
    stdout: audit.stdout,
    stderr: audit.stderr,
  };
}
writeJson(output, payload);

if (audit.stderr) process.stderr.write(audit.stderr);
const vulnerabilities = payload?.metadata?.vulnerabilities ?? null;
const unexcused =
  payload?.vulnerabilities && !payload.error
    ? unexcusedVulnerabilities(payload, loadAuditExceptions(projectRoot))
    : null;
const passed =
  audit.status === 0 || (Array.isArray(unexcused) && unexcused.length === 0);
console.log(
  JSON.stringify(
    {
      ok: passed,
      scope: omitDev ? "production" : "complete",
      auditLevel: level,
      output: outputArg,
      vulnerabilities,
      unexcused,
    },
    null,
    2
  )
);

if (audit.error) {
  console.error(audit.error.message);
  process.exit(1);
}
if (!passed) process.exit(audit.status || 1);
