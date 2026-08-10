import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filesUnder,
  npmInvocation,
  projectRoot,
  sha256,
  sha256File,
  writeJson,
} from "./evidence-utils.mjs";
import { analyzeSyntheticStaticDelivery } from "./lighthouse-static-delivery.mjs";
import { snapshotDist } from "./lighthouse-dist-snapshot.mjs";
import { verifyPlaywrightEvidence } from "./verify-playwright-evidence.mjs";
import {
  candidateBindingReasons,
  candidateIdentityMatches,
  createCandidateIdentity,
  gitSnapshot,
  verifyChromiumIdentity,
  verifyNodeIdentity,
} from "./candidate-identity.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";

export const CANONICAL_CI_STEPS = [
  "Lint",
  "Frontend typecheck",
  "Functions typecheck",
  "Unit and component tests",
  "Evidence policy tests",
  "Build",
  "PWA artifact contract",
  "Release policy",
  "License policy",
  "Production audit",
  "Complete dependency audit",
  "Workspace-aware production SBOM",
];
const CANONICAL_CI_OUTPUTS = [
  "artifacts/vitest-junit.xml",
  "artifacts/pwa-verification.json",
  "artifacts/release-verification.json",
  "artifacts/licenses-production.json",
  "artifacts/audit-production.json",
  "artifacts/audit-complete.json",
  "artifacts/sbom.cdx.json",
  "artifacts/npm-ls-production.json",
  "artifacts/sbom-verification.json",
];

function command(root, executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function dirtySnapshot(root = projectRoot) {
  const git = gitSnapshot(root);
  return {
    gitHead: git.head,
    branch: git.branch,
    clean: git.clean,
    state: git.state,
    snapshotComplete: git.snapshotComplete,
    entryCount: git.entryCount,
    diffSha256: git.diffSha256,
  };
}

function fileRecord(root, file) {
  const path = join(root, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { file, present: false, bytes: null, sha256: null };
  }
  return {
    file,
    present: true,
    bytes: statSync(path).size,
    sha256: sha256File(path),
  };
}

function jsonEvidence(root, file) {
  const record = fileRecord(root, file);
  if (!record.present) {
    return { record, value: null, error: `${file} is missing` };
  }
  try {
    return {
      record: { ...record, parsed: true },
      value: JSON.parse(readFileSync(join(root, file), "utf8")),
      error: null,
    };
  } catch (error) {
    return {
      record: { ...record, parsed: false },
      value: null,
      error: `${file} is not valid JSON: ${error.message}`,
    };
  }
}

function xmlInteger(tag, name) {
  const value = tag.match(new RegExp(`\\b${name}=(?:"(\\d+)"|'(\\d+)')`, "i"));
  return value ? Number(value[1] ?? value[2]) : null;
}

function playwrightJUnit(root) {
  const file = "artifacts/playwright-junit.xml";
  const record = fileRecord(root, file);
  if (!record.present) {
    return { record, totals: null, error: `${file} is missing` };
  }
  const xml = readFileSync(join(root, file), "utf8");
  const rootTag = xml.match(/<testsuites\b[^>]*>/i)?.[0] ?? "";
  const tests = xmlInteger(rootTag, "tests");
  const failures = xmlInteger(rootTag, "failures");
  const skipped = xmlInteger(rootTag, "skipped");
  const errors = xmlInteger(rootTag, "errors");
  if ([tests, failures, skipped, errors].some((value) => value === null)) {
    return {
      record: { ...record, parsed: false },
      totals: null,
      error: `${file} has invalid or missing root totals`,
    };
  }
  const executed = tests - skipped;
  return {
    record: { ...record, parsed: true },
    totals: {
      tests,
      failures,
      skipped,
      errors,
      executed,
      passed: executed - failures - errors,
    },
    error: null,
  };
}

function simpleOkGate(root, id, file, extraCheck = () => []) {
  const evidence = jsonEvidence(root, file);
  const reasons = [];
  if (evidence.error) reasons.push(evidence.error);
  if (evidence.value?.ok !== true)
    reasons.push(`${file} does not report ok:true`);
  reasons.push(...extraCheck(evidence.value));
  return {
    id,
    ok: reasons.length === 0,
    files: [evidence.record],
    reasons,
  };
}

function auditGate(root, id, file) {
  const evidence = jsonEvidence(root, file);
  const reasons = [];
  if (evidence.error) reasons.push(evidence.error);
  const counts = evidence.value?.metadata?.vulnerabilities;
  const keys = ["info", "low", "moderate", "high", "critical", "total"];
  if (
    !counts ||
    keys.some((key) => !Number.isInteger(counts[key]) || counts[key] !== 0) ||
    Object.keys(evidence.value?.vulnerabilities ?? {}).length !== 0
  ) {
    reasons.push(`${file} must contain a zero-vulnerability npm audit result`);
  }
  return {
    id,
    ok: reasons.length === 0,
    files: [evidence.record],
    reasons,
  };
}

function sbomGate(root) {
  const verification = jsonEvidence(root, "artifacts/sbom-verification.json");
  const sbom = jsonEvidence(root, "artifacts/sbom.cdx.json");
  const reasons = [];
  if (verification.error) reasons.push(verification.error);
  if (sbom.error) reasons.push(sbom.error);
  const report = verification.value;
  if (
    report?.ok !== true ||
    report?.generator !== "@cyclonedx/cyclonedx-npm@6.0.0" ||
    report?.workspaceAware !== true ||
    !Array.isArray(report?.missing) ||
    report.missing.length !== 0 ||
    !Number.isInteger(report?.npmClosurePackages) ||
    report.npmClosurePackages < 1 ||
    report.npmClosurePackages !== report?.sbomPackages
  ) {
    reasons.push(
      "SBOM verification does not prove complete workspace production closure coverage"
    );
  }
  if (
    sbom.value?.bomFormat !== "CycloneDX" ||
    sbom.value?.specVersion !== "1.6" ||
    !Array.isArray(sbom.value?.components)
  ) {
    reasons.push("SBOM document is not a parsed CycloneDX 1.6 JSON document");
  }
  if (
    sbom.record.sha256 === null ||
    report?.sbom?.file !== "artifacts/sbom.cdx.json" ||
    report?.sbom?.sha256 !== sbom.record.sha256
  ) {
    reasons.push(
      "SBOM verification hash does not bind the current SBOM document"
    );
  }
  return {
    id: "productionSbom",
    ok: reasons.length === 0,
    files: [verification.record, sbom.record],
    reasons,
  };
}

function sameFullDistSnapshot(left, right) {
  return (
    left?.fileCount === right?.fileCount &&
    left?.sha256 === right?.sha256 &&
    JSON.stringify(left?.files) === JSON.stringify(right?.files)
  );
}

function playwrightGate(
  root,
  currentCandidate,
  { managedBrowserExecutablePath = undefined } = {}
) {
  const verification = jsonEvidence(
    root,
    "artifacts/playwright-verification.json"
  );
  const context = jsonEvidence(root, "artifacts/playwright-context.json");
  const junit = playwrightJUnit(root);
  const reasons = [];
  if (verification.error) reasons.push(verification.error);
  if (context.error) reasons.push(context.error);
  if (junit.error) reasons.push(junit.error);
  const report = verification.value;
  const recomputed = verifyPlaywrightEvidence({
    root,
    candidate: currentCandidate,
    managedBrowserExecutablePath,
  });
  if (
    recomputed.ok !== true ||
    JSON.stringify(report) !== JSON.stringify(recomputed)
  ) {
    reasons.push(
      "Playwright verification does not exactly match a fresh fail-closed recomputation"
    );
  }
  if (recomputed.automatedCandidateEligible !== true) {
    reasons.push(
      "Playwright execution evidence is local-only and not release-grade"
    );
  }
  if (
    report?.schemaVersion !== 3 ||
    report?.ok !== true ||
    report?.executionEvidenceValid !== true
  ) {
    reasons.push("Playwright verification does not report ok:true");
  }
  if (
    report?.releaseGrade !== true ||
    report?.localOnly !== false ||
    report?.automatedCandidateEligible !== true
  ) {
    reasons.push("Playwright verification is local-only and not release-grade");
  }
  if (
    !junit.totals ||
    junit.totals.executed < 1 ||
    junit.totals.failures !== 0 ||
    junit.totals.errors !== 0
  ) {
    reasons.push(
      "Playwright JUnit does not prove a successful executed browser suite"
    );
  }
  for (const key of [
    "tests",
    "failures",
    "skipped",
    "errors",
    "executed",
    "passed",
  ]) {
    if (junit.totals && report?.totals?.[key] !== junit.totals[key]) {
      reasons.push(`Playwright verification ${key} does not match JUnit`);
    }
  }
  if (
    junit.record.sha256 === null ||
    report?.junit?.file !== "artifacts/playwright-junit.xml" ||
    report?.junit?.bytes !== junit.record.bytes ||
    report?.junit?.sha256 !== junit.record.sha256
  ) {
    reasons.push(
      "Playwright verification hash does not bind the current JUnit file"
    );
  }
  if (
    context.record.sha256 === null ||
    report?.context?.file !== "artifacts/playwright-context.json" ||
    report?.context?.bytes !== context.record.bytes ||
    report?.context?.sha256 !== context.record.sha256 ||
    context.value?.schemaVersion !== 2 ||
    context.value?.ok !== true ||
    context.value?.executionEvidenceValid !== true ||
    context.value?.status !== "passed" ||
    context.value?.evidenceMode !== true ||
    context.value?.reuseExistingServer !== false ||
    context.value?.candidate?.stable !== true ||
    context.value?.dist?.stable !== true
  ) {
    reasons.push(
      "Playwright verification does not bind an isolated passing browser context"
    );
  }
  if (
    context.value?.releaseGrade !== true ||
    context.value?.localOnly !== false ||
    context.value?.automatedCandidateEligible !== true
  ) {
    reasons.push("Playwright context is local-only and not release-grade");
  }
  reasons.push(
    ...candidateBindingReasons(
      report?.candidate,
      currentCandidate,
      "Playwright verification"
    ),
    ...candidateBindingReasons(
      context.value?.candidate?.before,
      currentCandidate,
      "Playwright initial context"
    ),
    ...candidateBindingReasons(
      context.value?.candidate?.after,
      currentCandidate,
      "Playwright final context"
    )
  );
  try {
    const currentDist = snapshotDist(join(root, "dist"));
    if (
      !sameFullDistSnapshot(report?.dist, currentDist) ||
      !sameFullDistSnapshot(context.value?.dist?.before, currentDist) ||
      !sameFullDistSnapshot(context.value?.dist?.after, currentDist)
    ) {
      reasons.push(
        "Playwright verification/context does not bind the complete current dist"
      );
    }
  } catch (error) {
    reasons.push(`Current dist snapshot failed: ${error.message}`);
  }
  if (
    report?.identityChecks?.browserMatches !== true ||
    report?.identityChecks?.nodeMatches !== true ||
    report?.browser?.name !== "chromium" ||
    JSON.stringify(report?.browser) !==
      JSON.stringify(context.value?.browser) ||
    !/\b(?:Chromium|Chrome)\b/i.test(report?.browser?.version ?? "") ||
    typeof report?.browser?.executablePath !== "string" ||
    ![
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
      "playwright-config-default",
    ].includes(report?.browser?.pathSource)
  ) {
    reasons.push("Playwright evidence has no exact Chromium binary identity");
  }
  const browserVerification = verifyChromiumIdentity(
    report?.browser,
    managedBrowserExecutablePath === undefined
      ? undefined
      : { managedExecutablePath: managedBrowserExecutablePath }
  );
  reasons.push(
    ...browserVerification.failures.map(
      (failure) => `Playwright Chromium identity: ${failure}`
    )
  );
  const nodeVerification = verifyNodeIdentity(report?.node);
  reasons.push(
    ...nodeVerification.failures.map(
      (failure) => `Playwright Node identity: ${failure}`
    )
  );
  if (
    browserVerification.automatedEligible !== true ||
    nodeVerification.matches !== true ||
    JSON.stringify(report?.node) !== JSON.stringify(context.value?.node)
  ) {
    reasons.push(
      "Playwright evidence is not bound to the current automated browser and Node binaries"
    );
  }
  return {
    id: "playwrightBrowser",
    ok: reasons.length === 0,
    localBrowserRunPassed:
      report?.ok === true &&
      recomputed.ok === true &&
      context.value?.ok === true,
    automatedCandidateEligible:
      report?.automatedCandidateEligible === true &&
      recomputed.automatedCandidateEligible === true,
    files: [verification.record, context.record, junit.record],
    parsedJUnitTotals: junit.totals,
    reasons,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sameNumber(left, right) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <=
      Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8
  );
}

function expectedLighthouseReportFile(url, run) {
  try {
    const pathname = new URL(url).pathname;
    const slug = pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-z0-9_-]+/gi, "-");
    if (!slug) return null;
    return `artifacts/lighthouse/${slug}-run-${run}.json`;
  } catch {
    return null;
  }
}

function lighthouseEntryAssets(root) {
  const record = fileRecord(root, "dist/index.html");
  if (!record.present) {
    return { record, assets: [], error: "dist/index.html is missing" };
  }

  const html = readFileSync(join(root, "dist/index.html"), "utf8");
  const assets = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) || []) {
    const source = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
    if (source?.endsWith(".js")) assets.push(source);
    if (href?.endsWith(".css") && rel?.toLowerCase() === "stylesheet") {
      assets.push(href);
    }
  }
  return {
    record,
    assets,
    error: assets.some((asset) => asset.endsWith(".js"))
      ? null
      : "dist/index.html has no JavaScript entry asset",
  };
}

function lighthouseGate(
  root,
  currentCandidate,
  { managedBrowserExecutablePath = undefined } = {}
) {
  const summary = jsonEvidence(root, "artifacts/lighthouse/summary.json");
  const entryEvidence = lighthouseEntryAssets(root);
  const pwaEvidence = fileRecord(root, "artifacts/pwa-verification.json");
  const reasons = [];
  const files = [summary.record, entryEvidence.record, pwaEvidence];
  if (summary.error) reasons.push(summary.error);
  if (entryEvidence.error) reasons.push(entryEvidence.error);
  const value = summary.value;
  if (
    value?.schemaVersion !== 3 ||
    value?.ok !== true ||
    value?.executionEvidenceValid !== true
  ) {
    reasons.push("artifacts/lighthouse/summary.json does not report ok:true");
  }
  if (
    value?.releaseGrade !== true ||
    value?.localOnly !== false ||
    value?.automatedCandidateEligible !== true
  ) {
    reasons.push(
      "Lighthouse execution evidence is local-only and not release-grade"
    );
  }
  if (value?.localQualitySummaryMerged !== false) {
    reasons.push(
      "Lighthouse summary must remain separate from the local CI summary"
    );
  }
  reasons.push(
    ...candidateBindingReasons(
      value?.candidate,
      currentCandidate,
      "Lighthouse summary"
    ),
    ...candidateBindingReasons(
      value?.candidateAfter,
      currentCandidate,
      "Lighthouse final context"
    )
  );
  if (value?.candidateStable !== true) {
    reasons.push("Lighthouse did not keep the candidate identity stable");
  }
  const browserMajor = value?.browser?.version?.match(/\b(\d+)\./)?.[1];
  if (
    value?.browser?.name !== "chromium" ||
    value?.browser?.pathSource !== "CHROME_PATH" ||
    typeof value?.browser?.executablePath !== "string" ||
    !value.browser.executablePath ||
    !/^[a-f0-9]{64}$/i.test(value?.browser?.executableSha256 ?? "") ||
    !browserMajor
  ) {
    reasons.push("Lighthouse summary has no exact Chromium binary identity");
  }
  const browserVerification = verifyChromiumIdentity(
    value?.browser,
    managedBrowserExecutablePath === undefined
      ? undefined
      : { managedExecutablePath: managedBrowserExecutablePath }
  );
  reasons.push(
    ...browserVerification.failures.map(
      (failure) => `Lighthouse Chromium identity: ${failure}`
    )
  );
  const nodeVerification = verifyNodeIdentity(value?.node);
  reasons.push(
    ...nodeVerification.failures.map(
      (failure) => `Lighthouse Node identity: ${failure}`
    )
  );
  if (
    browserVerification.automatedEligible !== true ||
    nodeVerification.matches !== true ||
    value?.browserVerification?.matches !== true ||
    value?.browserVerification?.automatedEligible !== true ||
    JSON.stringify(value?.browserVerification?.current) !==
      JSON.stringify(browserVerification.current) ||
    value?.nodeStable !== true ||
    JSON.stringify(value?.nodeAfter) !== JSON.stringify(value?.node)
  ) {
    reasons.push(
      "Lighthouse evidence is not bound to the current automated browser and Node binaries"
    );
  }
  if (
    value?.syntheticStaticDelivery?.contentEncoding !== "gzip" ||
    value?.syntheticStaticDelivery?.immutableHashedAssets !== true ||
    value?.syntheticStaticDelivery?.productionDeploymentProven !== false
  ) {
    reasons.push(
      "Lighthouse synthetic delivery claim must prove hashed local assets without claiming production deployment"
    );
  }
  if (
    value?.pwaEquivalent?.report?.file !== "artifacts/pwa-verification.json" ||
    value?.pwaEquivalent?.report?.present !== true ||
    value?.pwaEquivalent?.report?.bytes !== pwaEvidence.bytes ||
    value?.pwaEquivalent?.report?.sha256 !== pwaEvidence.sha256
  ) {
    reasons.push(
      "Lighthouse summary does not bind the exact PWA verification bytes"
    );
  }
  try {
    const currentDistSnapshot = snapshotDist(join(root, "dist"));
    if (
      value?.distSnapshot?.stable !== true ||
      value?.distSnapshot?.fileCount !== currentDistSnapshot.fileCount ||
      value?.distSnapshot?.sha256 !== currentDistSnapshot.sha256 ||
      JSON.stringify(value?.distSnapshot?.files) !==
        JSON.stringify(currentDistSnapshot.files)
    ) {
      reasons.push(
        "Lighthouse summary does not bind the complete current dist contents"
      );
    }
  } catch (error) {
    reasons.push(`Current dist snapshot failed: ${error.message}`);
  }

  const pages = Array.isArray(value?.pages) ? value.pages : [];
  const measurements = Array.isArray(value?.measurements)
    ? value.measurements
    : [];
  const thresholds = value?.thresholds;
  const runsPerUrl = value?.runsPerUrl;
  const categoryNames = ["performance", "accessibility", "best-practices"];
  const expectedMeasurements =
    Number.isInteger(runsPerUrl) && runsPerUrl > 0
      ? runsPerUrl * pages.length
      : 0;
  if (
    expectedMeasurements < 1 ||
    measurements.length !== expectedMeasurements ||
    !Array.isArray(value?.failures) ||
    value.failures.length !== 0 ||
    value?.pwaEquivalent?.ok !== true ||
    !thresholds ||
    categoryNames.some(
      (category) =>
        !Number.isFinite(thresholds[category]) || thresholds[category] <= 0
    )
  ) {
    reasons.push(
      "Lighthouse summary does not contain the complete successful run matrix"
    );
  }
  if (
    browserMajor &&
    measurements.some(
      (measurement) =>
        !new RegExp(`(?:Headless)?Chrome/${browserMajor}\\.`).test(
          measurement?.chromeUserAgent ?? ""
        )
    )
  ) {
    reasons.push(
      "Lighthouse raw measurements do not match the recorded Chromium major version"
    );
  }

  const pageUrls = pages.map((page) => page?.url);
  if (
    pageUrls.some((url) => typeof url !== "string") ||
    new Set(pageUrls).size !== pageUrls.length
  ) {
    reasons.push("Lighthouse pages must contain unique valid URL strings");
  }

  const seen = new Set();
  const rawRecords = new Map();
  for (const measurement of measurements) {
    const key = `${measurement?.url}#${measurement?.run}`;
    if (
      typeof measurement?.url !== "string" ||
      !pageUrls.includes(measurement.url) ||
      !Number.isInteger(measurement?.run) ||
      measurement.run < 1 ||
      measurement.run > runsPerUrl ||
      seen.has(key)
    ) {
      reasons.push(
        `Lighthouse measurement identity is invalid or duplicated: ${key}`
      );
      continue;
    }
    seen.add(key);

    const expectedFile = expectedLighthouseReportFile(
      measurement.url,
      measurement.run
    );
    const declaredFile = measurement?.rawReport?.file;
    if (!expectedFile || declaredFile !== expectedFile) {
      reasons.push(
        `Lighthouse measurement ${key} does not name its exact raw LHR file`
      );
      continue;
    }
    const raw = jsonEvidence(root, declaredFile);
    rawRecords.set(declaredFile, raw.record);
    if (raw.error) {
      reasons.push(raw.error);
      continue;
    }
    if (
      raw.record.sha256 === null ||
      measurement?.rawReport?.bytes !== raw.record.bytes ||
      measurement?.rawReport?.sha256 !== raw.record.sha256
    ) {
      reasons.push(
        `Lighthouse measurement ${key} hash does not bind its raw LHR`
      );
    }

    const lhr = raw.value;
    if (
      lhr?.requestedUrl !== measurement.url ||
      lhr?.finalUrl !== measurement.url
    ) {
      reasons.push(`Lighthouse raw LHR URL does not match measurement ${key}`);
    }
    if (lhr?.runtimeError) {
      reasons.push(`Lighthouse raw LHR contains a runtime error for ${key}`);
    }
    if (
      !Array.isArray(lhr?.runWarnings) ||
      lhr.runWarnings.length !== 0 ||
      !Array.isArray(measurement?.runWarnings) ||
      measurement.runWarnings.length !== 0
    ) {
      reasons.push(
        `Lighthouse raw LHR or summary contains warnings for ${key}`
      );
    }
    if (
      typeof lhr?.lighthouseVersion !== "string" ||
      lhr.lighthouseVersion !== measurement?.lighthouseVersion
    ) {
      reasons.push(`Lighthouse version does not match for ${key}`);
    }
    const rawUserAgent = lhr?.environment?.hostUserAgent ?? lhr?.userAgent;
    if (
      typeof rawUserAgent !== "string" ||
      rawUserAgent !== measurement?.chromeUserAgent
    ) {
      reasons.push(`Chrome user agent does not match for ${key}`);
    }
    for (const category of categoryNames) {
      if (
        !sameNumber(
          lhr?.categories?.[category]?.score,
          measurement?.scores?.[category]
        )
      ) {
        reasons.push(
          `Lighthouse ${category} score does not match raw LHR for ${key}`
        );
      }
    }

    const consoleAudit = lhr?.audits?.["errors-in-console"];
    const rawConsoleItems = consoleAudit?.details?.items;
    const rawConsoleErrors = Array.isArray(rawConsoleItems)
      ? rawConsoleItems.length
      : null;
    if (
      !Array.isArray(rawConsoleItems) ||
      consoleAudit?.score !== 1 ||
      rawConsoleErrors !== measurement?.consoleErrors ||
      rawConsoleErrors !== 0
    ) {
      reasons.push(
        `Lighthouse console evidence is not clean or does not match for ${key}`
      );
    }

    const networkRequests = lhr?.audits?.["network-requests"]?.details?.items;
    const requiredEntryAssets =
      measurement?.syntheticStaticCompression?.requiredEntryAssets;
    if (
      !Array.isArray(networkRequests) ||
      !Array.isArray(requiredEntryAssets)
    ) {
      reasons.push(
        `Lighthouse network/compression evidence is missing for ${key}`
      );
      continue;
    }
    if (
      JSON.stringify(requiredEntryAssets) !==
      JSON.stringify(entryEvidence.assets)
    ) {
      reasons.push(
        `Lighthouse required entry assets do not match the current dist/index.html for ${key}`
      );
    }
    const loadedApplicationScript = networkRequests.some(
      (request) =>
        typeof request?.url === "string" &&
        request.url.startsWith(`${new URL(measurement.url).origin}/assets/`) &&
        request.url.endsWith(".js") &&
        request.statusCode === 200
    );
    if (
      measurement?.applicationScriptLoaded !== true ||
      !loadedApplicationScript
    ) {
      reasons.push(
        `Lighthouse application script evidence does not match for ${key}`
      );
    }
    try {
      const compression = analyzeSyntheticStaticDelivery({
        networkRequests,
        baseUrl: new URL(measurement.url).origin,
        requiredEntryAssets,
      });
      const measured = compression.measuredLargeApplicationAssets;
      const recordedMeasured =
        measurement.syntheticStaticCompression?.measuredLargeApplicationAssets;
      if (
        JSON.stringify(measured.scope) !==
          JSON.stringify(recordedMeasured?.scope) ||
        measured.requestCount !== recordedMeasured?.requestCount
      ) {
        reasons.push(
          `Lighthouse measured-large-asset scope does not match raw LHR for ${key}`
        );
      }
      for (const field of [
        "decodedBytes",
        "transferredBytes",
        "aggregateCompressionRatio",
      ]) {
        if (!sameNumber(measured[field], recordedMeasured?.[field])) {
          reasons.push(
            `Lighthouse measured-large-asset ${field} does not match raw LHR for ${key}`
          );
        }
      }
      const observed = compression.observedAllSameOriginJavaScriptAndCss;
      const recordedObserved =
        measurement.syntheticStaticCompression
          ?.observedAllSameOriginJavaScriptAndCss;
      if (JSON.stringify(observed) !== JSON.stringify(recordedObserved)) {
        reasons.push(
          `Lighthouse all-same-origin JavaScript/CSS observation does not match raw LHR for ${key}`
        );
      }
    } catch (error) {
      reasons.push(
        `Lighthouse raw compression check failed for ${key}: ${error.message}`
      );
    }
  }
  files.push(
    ...[...rawRecords.values()].sort((left, right) =>
      left.file.localeCompare(right.file)
    )
  );

  if (
    seen.size !== expectedMeasurements ||
    rawRecords.size !== expectedMeasurements
  ) {
    reasons.push(
      "Lighthouse gate is missing one or more distinct raw LHR files"
    );
  }
  for (const page of pages) {
    const pageRuns = measurements.filter(
      (measurement) => measurement?.url === page?.url
    );
    for (const category of categoryNames) {
      const rawScores = pageRuns.map(
        (measurement) => measurement?.scores?.[category]
      );
      if (
        rawScores.some((score) => !Number.isFinite(score)) ||
        !sameNumber(median(rawScores), page?.scores?.[category]) ||
        !sameNumber(Math.min(...rawScores), page?.minimumScores?.[category]) ||
        Math.min(...rawScores) < thresholds?.[category] ||
        page?.scores?.[category] < thresholds?.[category]
      ) {
        reasons.push(
          `Lighthouse page minimum/median/threshold does not match for ${page?.url} ${category}`
        );
      }
    }
  }

  return {
    id: "lighthouseBrowser",
    ok: reasons.length === 0,
    localBrowserRunPassed:
      value?.ok === true &&
      value?.executionEvidenceValid === true &&
      value?.candidateStable === true &&
      value?.nodeStable === true &&
      value?.browserVerification?.matches === true,
    automatedCandidateEligible:
      value?.automatedCandidateEligible === true &&
      browserVerification.automatedEligible === true,
    files,
    reasons,
  };
}

export function evaluateRequiredEvidence(
  root = projectRoot,
  candidateOverride = null,
  options = {}
) {
  const currentCandidate =
    candidateOverride ?? createCandidateIdentity({ root });
  const gates = [
    simpleOkGate(
      root,
      "canonicalCiSummary",
      "artifacts/ci-summary.json",
      (value) => {
        const reasons = [];
        if (
          value?.schemaVersion !== 4 ||
          value?.canonical !== true ||
          value?.immutableAfterWrite !== true
        ) {
          reasons.push(
            "CI summary is not marked as the sealed canonical schema v4 summary"
          );
        }
        const names = Array.isArray(value?.steps)
          ? value.steps.map((step) => step?.name)
          : [];
        if (
          JSON.stringify(names) !== JSON.stringify(CANONICAL_CI_STEPS) ||
          value?.steps?.some((step) => step?.status !== "passed")
        ) {
          reasons.push(
            "canonical CI summary does not contain the exact passed local gate sequence"
          );
        }
        if (
          value?.browserChecks?.included !== false ||
          value?.browserChecks?.status !== "separate"
        ) {
          reasons.push(
            "canonical CI summary must keep browser evidence explicitly separate"
          );
        }
        if (
          value?.candidateChecks?.gitStable !== true ||
          value?.candidateChecks?.sourceStable !== true ||
          value?.candidateChecks?.lockStable !== true ||
          value?.candidateChecks?.distPresent !== true ||
          value?.candidateChecks?.candidateStable !== true ||
          value?.candidateChecks?.distStable !== true ||
          value?.candidateChecks?.nodeStable !== true ||
          value?.candidateWindow?.stable !== true ||
          value?.candidateWindow?.dist?.stable !== true ||
          value?.sourceSnapshot?.stable !== true ||
          value?.sourceSnapshot?.sha256 !== currentCandidate.source?.sha256 ||
          value?.sourceSnapshot?.after?.sha256 !==
            currentCandidate.source?.sha256
        ) {
          reasons.push(
            "canonical CI summary does not bind a stable current source snapshot"
          );
        }
        reasons.push(
          ...candidateBindingReasons(
            value?.candidate,
            currentCandidate,
            "canonical CI summary"
          ),
          ...candidateBindingReasons(
            value?.candidateWindow?.before,
            currentCandidate,
            "canonical CI post-build context"
          ),
          ...candidateBindingReasons(
            value?.candidateWindow?.after,
            currentCandidate,
            "canonical CI final context"
          )
        );
        try {
          const currentDist = snapshotDist(join(root, "dist"));
          if (
            !sameFullDistSnapshot(
              value?.candidateWindow?.dist?.before,
              currentDist
            ) ||
            !sameFullDistSnapshot(
              value?.candidateWindow?.dist?.after,
              currentDist
            )
          ) {
            reasons.push(
              "canonical CI summary does not bind an unchanged complete current dist"
            );
          }
        } catch (error) {
          reasons.push(`Current dist snapshot failed: ${error.message}`);
        }
        const ciNode = verifyNodeIdentity(value?.node);
        reasons.push(
          ...ciNode.failures.map(
            (failure) => `canonical CI Node identity: ${failure}`
          )
        );
        const outputs = Array.isArray(value?.outputs) ? value.outputs : [];
        if (
          JSON.stringify(outputs.map((output) => output?.file)) !==
          JSON.stringify(CANONICAL_CI_OUTPUTS)
        ) {
          reasons.push(
            "canonical CI summary does not list the exact required output set"
          );
        }
        for (const expected of CANONICAL_CI_OUTPUTS) {
          const output = outputs.find((item) => item?.file === expected);
          const current = fileRecord(root, expected);
          if (
            output?.present !== true ||
            current.present !== true ||
            output.bytes !== current.bytes ||
            output.sha256 !== current.sha256
          ) {
            reasons.push(`canonical CI output hash mismatch: ${expected}`);
          }
        }
        return reasons;
      }
    ),
    simpleOkGate(
      root,
      "pwaArtifacts",
      "artifacts/pwa-verification.json",
      (value) => {
        const reasons = [];
        if (
          !Array.isArray(value?.failures) ||
          value.failures.length !== 0 ||
          !value?.checks ||
          Object.values(value.checks).some((check) => check !== true)
        ) {
          reasons.push(
            "PWA verification must contain only passing static artifact checks"
          );
        }
        return reasons;
      }
    ),
    simpleOkGate(
      root,
      "releasePolicy",
      "artifacts/release-verification.json",
      (value) => {
        const reasons = [];
        if (
          !Array.isArray(value?.failures) ||
          value.failures.length !== 0 ||
          !value?.scopes ||
          Object.values(value.scopes).some(
            (count) => !Number.isInteger(count) || count < 1
          )
        ) {
          reasons.push(
            "release verification must contain non-empty scanned scopes and no failures"
          );
        }
        reasons.push(
          ...candidateBindingReasons(
            value?.candidate,
            currentCandidate,
            "release verification"
          ),
          ...candidateBindingReasons(
            value?.candidateWindow?.before,
            currentCandidate,
            "release initial context"
          ),
          ...candidateBindingReasons(
            value?.candidateWindow?.after,
            currentCandidate,
            "release final context"
          )
        );
        if (
          value?.schemaVersion !== 2 ||
          value?.candidateWindow?.stable !== true ||
          value?.candidateWindow?.distStable !== true ||
          value?.sourceSha256 !== currentCandidate.source?.sha256
        ) {
          reasons.push(
            "release sourceSha256 does not match the unified current candidate source digest"
          );
        }
        const releaseNode = verifyNodeIdentity(value?.node?.after);
        reasons.push(
          ...releaseNode.failures.map(
            (failure) => `release Node identity: ${failure}`
          )
        );
        if (
          value?.node?.stable !== true ||
          releaseNode.matches !== true ||
          JSON.stringify(value?.node?.before) !==
            JSON.stringify(value?.node?.after)
        ) {
          reasons.push(
            "release verification is not bound to one stable current Node executable"
          );
        }
        return reasons;
      }
    ),
    simpleOkGate(
      root,
      "productionLicenses",
      "artifacts/licenses-production.json",
      (value) => {
        const reasons = [];
        if (
          value?.policy?.mode !== "explicit-allowlist" ||
          !Array.isArray(value?.failures) ||
          value.failures.length !== 0 ||
          !Array.isArray(value?.reviewed) ||
          value.reviewed.length < 1 ||
          value?.productionPackagesReviewed !== value.reviewed.length ||
          value.reviewed.some((item) => item?.allowed !== true)
        ) {
          reasons.push(
            "license verification must bind a non-empty explicitly allowlisted production set"
          );
        }
        return reasons;
      }
    ),
    auditGate(root, "productionAudit", "artifacts/audit-production.json"),
    auditGate(root, "completeAudit", "artifacts/audit-complete.json"),
    sbomGate(root),
    playwrightGate(root, currentCandidate, options),
    lighthouseGate(root, currentCandidate, options),
  ];
  return {
    ok: gates.every((gate) => gate.ok),
    candidate: currentCandidate,
    gates,
  };
}

function availableEvidence(root) {
  const directory = join(root, "artifacts");
  if (!existsSync(directory)) return [];
  return filesUnder(directory)
    .filter(
      (path) =>
        relative(directory, path).replaceAll("\\", "/") !==
        "evidence-manifest.json"
    )
    .map((path) => ({
      file: relative(root, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: sha256File(path),
    }));
}

function runtimeVersions(root) {
  const npm = npmInvocation(["--version"]);
  let npmVersion = null;
  try {
    npmVersion = command(root, npm.command, npm.args);
  } catch {
    // The manifest must still describe missing/failed install evidence.
  }
  return {
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    architecture: process.arch,
  };
}

export function createEvidenceManifest({
  root = projectRoot,
  candidate: candidateOverride = null,
  generatedAt = new Date().toISOString(),
  runtime: runtimeOverride = null,
  managedBrowserExecutablePath = undefined,
  afterInitialEvidenceSnapshot = null,
} = {}) {
  const currentCandidate =
    candidateOverride ?? createCandidateIdentity({ root });
  const lock = fileRecord(root, "package-lock.json");
  let dist = null;
  try {
    dist = snapshotDist(join(root, "dist"));
  } catch {
    // The manifest remains writable as negative evidence.
  }
  const initialRequiredEvidence = evaluateRequiredEvidence(
    root,
    currentCandidate,
    {
      managedBrowserExecutablePath,
    }
  );
  const initialEvidenceFiles = availableEvidence(root);
  afterInitialEvidenceSnapshot?.();
  const finalCandidate = candidateOverride ?? createCandidateIdentity({ root });
  const finalLock = fileRecord(root, "package-lock.json");
  let finalDist = null;
  try {
    finalDist = snapshotDist(join(root, "dist"));
  } catch {
    // The manifest remains writable as negative evidence.
  }
  const requiredEvidence = evaluateRequiredEvidence(root, finalCandidate, {
    managedBrowserExecutablePath,
  });
  const evidenceFiles = availableEvidence(root);
  const requiredEvidenceStable =
    JSON.stringify(initialRequiredEvidence) ===
    JSON.stringify(requiredEvidence);
  const evidenceFilesStable =
    JSON.stringify(initialEvidenceFiles) === JSON.stringify(evidenceFiles);
  const evidenceStable = requiredEvidenceStable && evidenceFilesStable;
  const candidateStable = candidateIdentityMatches(
    currentCandidate,
    finalCandidate
  );
  const distStable =
    dist !== null &&
    finalDist !== null &&
    sameFullDistSnapshot(dist, finalDist);
  const inputsComplete =
    currentCandidate.complete === true &&
    finalCandidate.complete === true &&
    candidateStable &&
    lock.present &&
    finalLock.present &&
    lock.sha256 === currentCandidate.packageLock?.sha256 &&
    finalLock.sha256 === finalCandidate.packageLock?.sha256 &&
    lock.bytes === finalLock.bytes &&
    lock.sha256 === finalLock.sha256 &&
    dist !== null &&
    finalDist !== null &&
    distStable &&
    evidenceStable &&
    dist.fileCount > 0 &&
    dist.sha256 === currentCandidate.dist?.sha256 &&
    finalDist.sha256 === finalCandidate.dist?.sha256;
  const releaseCandidateEligible =
    currentCandidate.git?.clean === true &&
    inputsComplete &&
    requiredEvidence.ok;
  const blockers = [];
  if (currentCandidate.git?.clean !== true) {
    blockers.push(
      currentCandidate.git?.state === "dirty"
        ? "git worktree is dirty"
        : "git candidate state is unavailable"
    );
  }
  if (!inputsComplete) {
    blockers.push(
      "candidate, source snapshot, package lock, or dist was missing or changed while the manifest was generated"
    );
  }
  if (!evidenceStable) {
    blockers.push(
      "required evidence files changed while the manifest was generated"
    );
  }
  for (const gate of requiredEvidence.gates.filter((item) => !item.ok)) {
    blockers.push(`${gate.id}: ${gate.reasons.join("; ")}`);
  }

  return {
    schemaVersion: 4,
    generatedAt,
    candidate: {
      ...currentCandidate,
      executionWindow: {
        before: currentCandidate,
        after: finalCandidate,
        stable: candidateStable,
      },
      releaseCandidateEligible,
      automatedReleaseCandidateEligible: releaseCandidateEligible,
      eligibilityScope:
        "Automated clean-checkout, local quality, artifact, dependency, Playwright, and synthetic Lighthouse evidence only.",
      blockers,
      note: releaseCandidateEligible
        ? "Clean candidate and every required local/browser evidence gate are hash-bound and passing."
        : "This manifest was generated successfully, but the candidate is not release-eligible until every listed blocker is resolved.",
    },
    inputs: {
      complete: inputsComplete,
      sourceTree: currentCandidate.source,
      packageLock: finalLock,
      packageLockWindow: {
        before: lock,
        after: finalLock,
        stable:
          lock.sha256 === finalLock.sha256 && lock.bytes === finalLock.bytes,
      },
      dist: finalDist,
      distWindow: { before: dist, after: finalDist, stable: distStable },
      evidenceWindow: {
        beforeSha256: sha256(JSON.stringify(initialEvidenceFiles)),
        afterSha256: sha256(JSON.stringify(evidenceFiles)),
        requiredBeforeSha256: sha256(JSON.stringify(initialRequiredEvidence)),
        requiredAfterSha256: sha256(JSON.stringify(requiredEvidence)),
        stable: evidenceStable,
      },
    },
    runtime: runtimeOverride ?? runtimeVersions(root),
    requiredEvidence,
    finalRealDeviceAcceptance: {
      required: true,
      evaluatedByThisManifest: false,
      status: "separate",
      passed: null,
      note: "Real Android Chrome playback observations, independent video/network records, and product-owner acceptance remain separate. Structured playback JSON alone cannot prove that observation occurred.",
    },
    availableEvidence: evidenceFiles,
    exclusions: [
      "artifacts/evidence-manifest.json (self-reference; this file is always regenerated last)",
    ],
  };
}

export function main() {
  const releasePipelineLock = acquireEvidencePipelineLock(
    projectRoot,
    "Evidence manifest",
    { allowInheritedToken: true }
  );
  process.on("exit", releasePipelineLock);
  const manifest = createEvidenceManifest();
  writeJson(join(projectRoot, "artifacts", "evidence-manifest.json"), manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
