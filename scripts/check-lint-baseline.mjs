import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative as pathRelative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eslintBin = resolve(root, "node_modules/eslint/bin/eslint.js");
const baseline = JSON.parse(
  readFileSync(resolve(root, "scripts/eslint-warning-baseline.json"), "utf8")
);
const run = spawnSync(process.execPath, [eslintBin, ".", "--format", "json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (!run.stdout) {
  process.stderr.write(run.stderr || "ESLint produced no report\n");
  process.exit(run.status || 1);
}

const report = JSON.parse(run.stdout);
const current = {};
const errors = [];
for (const file of report) {
  const relative = pathRelative(root, file.filePath).replaceAll("\\", "/");
  for (const message of file.messages) {
    if (message.severity === 2) {
      errors.push(
        `${relative}:${message.line}:${message.column} ${message.ruleId}: ${message.message}`
      );
      continue;
    }
    if (message.severity !== 1) continue;
    const key = `${relative}::${message.ruleId}`;
    current[key] = (current[key] || 0) + 1;
  }
}

const excess = [];
for (const [key, count] of Object.entries(current)) {
  const allowed = baseline[key] || 0;
  if (count > allowed)
    excess.push(`${key}: ${count} current > ${allowed} baseline`);
}

const currentTotal = Object.values(current).reduce(
  (sum, count) => sum + count,
  0
);
const baselineTotal = Object.values(baseline).reduce(
  (sum, count) => sum + count,
  0
);
console.log(
  JSON.stringify(
    {
      ok: errors.length === 0 && excess.length === 0,
      errors: errors.length,
      currentWarnings: currentTotal,
      baselineWarnings: baselineTotal,
      newOrIncreasedWarnings: excess,
    },
    null,
    2
  )
);

if (errors.length) process.stderr.write(`${errors.join("\n")}\n`);
if (excess.length) process.stderr.write(`${excess.join("\n")}\n`);
if (errors.length || excess.length) process.exit(1);
