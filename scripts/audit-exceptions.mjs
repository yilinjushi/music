import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Load reviewed audit exceptions; expired entries are ignored. */
export function loadAuditExceptions(root, now = new Date()) {
  const entries = JSON.parse(
    readFileSync(join(root, "scripts/audit-exceptions.json"), "utf8")
  );
  return entries.filter(
    (entry) =>
      typeof entry.package === "string" &&
      /^GHSA-[a-z0-9-]+$/.test(entry.advisory) &&
      typeof entry.reason === "string" &&
      entry.reason.length > 0 &&
      new Date(`${entry.reviewBy}T23:59:59Z`) >= now
  );
}

/** Return audit findings not covered by an exact package + advisory exception. */
export function unexcusedVulnerabilities(audit, exceptions) {
  const covered = (pkg, via) =>
    typeof via === "object" &&
    via !== null &&
    exceptions.some(
      (entry) =>
        entry.package === pkg &&
        via.name === pkg &&
        typeof via.url === "string" &&
        via.url.endsWith(`/${entry.advisory}`)
    );
  return Object.entries(audit?.vulnerabilities ?? {})
    .filter(
      ([pkg, finding]) =>
        !Array.isArray(finding?.via) ||
        finding.via.length === 0 ||
        !finding.via.every((via) => covered(pkg, via))
    )
    .map(([pkg]) => pkg);
}
