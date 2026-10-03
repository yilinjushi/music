import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Load reviewed audit exceptions; expired entries are ignored. */
export function loadAuditExceptions(root, now = new Date()) {
  const file = join(root, "scripts/audit-exceptions.json");
  if (!existsSync(file)) return [];
  const entries = JSON.parse(readFileSync(file, "utf8"));
  return entries.filter(
    (entry) =>
      typeof entry.package === "string" &&
      /^GHSA-[a-z0-9-]+$/.test(entry.advisory) &&
      typeof entry.reason === "string" &&
      entry.reason.length > 0 &&
      new Date(`${entry.reviewBy}T23:59:59Z`) >= now
  );
}

/**
 * Return audit findings not covered by an exact package + advisory exception.
 * A transitive finding (via other packages) is covered only when every
 * package it comes through is itself covered.
 */
export function unexcusedVulnerabilities(audit, exceptions) {
  const findings = audit?.vulnerabilities ?? {};
  const memo = new Map();
  const isCovered = (pkg, seen = new Set()) => {
    if (memo.has(pkg)) return memo.get(pkg);
    if (seen.has(pkg)) return false;
    seen.add(pkg);
    const via = findings[pkg]?.via;
    const ok =
      Array.isArray(via) &&
      via.length > 0 &&
      via.every((entry) =>
        typeof entry === "string"
          ? entry in findings && isCovered(entry, seen)
          : typeof entry === "object" &&
            entry !== null &&
            entry.name === pkg &&
            typeof entry.url === "string" &&
            exceptions.some(
              (exception) =>
                exception.package === pkg &&
                entry.url.endsWith(`/${exception.advisory}`)
            )
      );
    memo.set(pkg, ok);
    return ok;
  };
  return Object.keys(findings).filter((pkg) => !isCovered(pkg));
}
