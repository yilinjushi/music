import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";
import { projectRoot, writeJson } from "./evidence-utils.mjs";

export const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

export function evaluateLicenseExpression(expression) {
  const license = String(expression ?? "").trim();
  if (!license || /SEE LICENSE|Proprietary|UNLICENSED/i.test(license)) {
    return { allowed: false, selectedAlternative: null };
  }

  const tokens =
    license.match(
      /\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+:-]*/gi
    ) ?? [];
  if (tokens.join("") !== license.replace(/\s+/g, "")) {
    return { allowed: false, selectedAlternative: null };
  }
  let cursor = 0;
  const peek = () => tokens[cursor]?.toUpperCase();
  const consume = (value) => {
    if (peek() !== value) throw new Error(`expected ${value}`);
    cursor += 1;
  };
  const parsePrimary = () => {
    if (peek() === "(") {
      consume("(");
      const nested = parseOr();
      consume(")");
      return nested;
    }
    const identifier = tokens[cursor++];
    if (
      !identifier ||
      ["AND", "OR", "WITH", ")"].includes(identifier.toUpperCase())
    ) {
      throw new Error("expected SPDX license identifier");
    }
    if (peek() === "WITH") {
      cursor += 1;
      const exception = tokens[cursor++];
      if (
        !exception ||
        ["AND", "OR", "WITH", "(", ")"].includes(exception.toUpperCase())
      ) {
        throw new Error("expected SPDX exception identifier");
      }
      return { allowed: false, selectedAlternative: null };
    }
    return {
      allowed: ALLOWED_LICENSES.has(identifier),
      selectedAlternative: ALLOWED_LICENSES.has(identifier) ? identifier : null,
    };
  };
  const parseAnd = () => {
    let value = parsePrimary();
    while (peek() === "AND") {
      cursor += 1;
      const right = parsePrimary();
      value = {
        allowed: value.allowed && right.allowed,
        selectedAlternative:
          value.allowed && right.allowed
            ? `${value.selectedAlternative} AND ${right.selectedAlternative}`
            : null,
      };
    }
    return value;
  };
  function parseOr() {
    let value = parseAnd();
    while (peek() === "OR") {
      cursor += 1;
      const right = parseAnd();
      value = value.allowed ? value : right;
    }
    return value;
  }

  try {
    const result = parseOr();
    if (cursor !== tokens.length)
      return { allowed: false, selectedAlternative: null };
    return result;
  } catch {
    return { allowed: false, selectedAlternative: null };
  }
}

function packageNameFromLockPath(path) {
  return path.split("node_modules/").at(-1);
}

export function verifyProductionLicenses(lock) {
  const failures = [];
  const reviewed = [];
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    if (!path || metadata.dev === true || metadata.link === true) continue;
    if (path === "functions" || path === "shared") continue;

    const license = String(metadata.license ?? "").trim();
    const evaluation = evaluateLicenseExpression(license);
    const item = {
      path,
      name: packageNameFromLockPath(path),
      version: metadata.version ?? null,
      license,
      allowed: evaluation.allowed,
      selectedAlternative: evaluation.selectedAlternative,
    };
    reviewed.push(item);
    if (!evaluation.allowed) {
      failures.push(
        `${path} uses a missing, unknown, or non-allowlisted license expression: ${license || "<missing>"}`
      );
    }
  }
  return {
    ok: failures.length === 0,
    policy: {
      mode: "explicit-allowlist",
      allowedSpdxIdentifiers: [...ALLOWED_LICENSES].sort(),
      orExpressions:
        "accepted only when at least one complete alternative is allowlisted",
      unknownLicenses: "fail",
    },
    productionPackagesReviewed: reviewed.length,
    reviewed,
    failures,
  };
}

export function main() {
  const releasePipelineLock = acquireEvidencePipelineLock(
    projectRoot,
    "License evidence",
    { allowInheritedToken: true }
  );
  process.on("exit", releasePipelineLock);
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
  );
  const report = verifyProductionLicenses(lock);
  writeJson(join(projectRoot, "artifacts", "licenses-production.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
