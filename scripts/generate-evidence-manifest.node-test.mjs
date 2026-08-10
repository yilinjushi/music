import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import {
  CANONICAL_CI_STEPS,
  createEvidenceManifest,
  dirtySnapshot,
  evaluateRequiredEvidence,
} from "./generate-evidence-manifest.mjs";
import { projectRoot, sha256 } from "./evidence-utils.mjs";
import { snapshotDist } from "./lighthouse-dist-snapshot.mjs";
import {
  GIT_DIFF_ALGORITHM,
  createChromiumIdentity,
  createCandidateIdentity,
  createNodeIdentity,
  verifyChromiumIdentity,
} from "./candidate-identity.mjs";
import {
  snapshotSourceFiles,
  sourceSnapshotIdentity,
} from "./source-tree-snapshot.mjs";
import {
  PLAYWRIGHT_BASELINE_PROJECT,
  PLAYWRIGHT_BASELINE_TESTS,
  PLAYWRIGHT_EXPECTED_TOTALS,
  PLAYWRIGHT_PROJECTS,
  PLAYWRIGHT_REQUIRED_TESTS,
  verifyPlaywrightEvidence,
} from "./verify-playwright-evidence.mjs";

const cleanGit = {
  algorithm: GIT_DIFF_ALGORITHM,
  head: "0123456789abcdef0123456789abcdef01234567",
  branch: "main",
  clean: true,
  state: "clean",
  snapshotComplete: true,
  entryCount: 0,
  diffSha256: "a".repeat(64),
};
const runtime = {
  node: "v22.19.0",
  npm: "11.9.0",
  platform: "linux",
  architecture: "x64",
};
const ciOutputs = [
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
const fixtureCandidates = new Map();

mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
const browserRoot = mkdtempSync(
  join(projectRoot, "node_modules", "music-manifest-browser-")
);
const browserDirectory = join(browserRoot, "chromium-1234", "chrome-linux64");
mkdirSync(browserDirectory, { recursive: true });
const managedBrowserExecutablePath = join(browserDirectory, "chrome");
writeFileSync(
  managedBrowserExecutablePath,
  "#!/bin/sh\nprintf 'Chromium 149.0.0.0\\n'\n"
);
chmodSync(managedBrowserExecutablePath, 0o755);
const playwrightBrowser = createChromiumIdentity({
  configuredExecutablePath: managedBrowserExecutablePath,
  managedExecutablePath: managedBrowserExecutablePath,
  pathSource: "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
});
const lighthouseBrowser = createChromiumIdentity({
  configuredExecutablePath: managedBrowserExecutablePath,
  managedExecutablePath: managedBrowserExecutablePath,
  pathSource: "CHROME_PATH",
});
const nodeIdentity = createNodeIdentity();
const lighthouseBrowserVerification = verifyChromiumIdentity(
  lighthouseBrowser,
  { managedExecutablePath: managedBrowserExecutablePath }
);
after(() => rmSync(browserRoot, { recursive: true, force: true }));

function write(root, file, contents) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function json(root, file, value) {
  write(root, file, `${JSON.stringify(value, null, 2)}\n`);
}

function record(root, file) {
  const bytes = readFileSync(join(root, file));
  return { file, present: true, bytes: bytes.length, sha256: sha256(bytes) };
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function executedPlaywrightJUnit() {
  const suites = PLAYWRIGHT_PROJECTS.map((project) => {
    const skipped =
      project === PLAYWRIGHT_BASELINE_PROJECT
        ? 0
        : PLAYWRIGHT_BASELINE_TESTS.length;
    const cases = PLAYWRIGHT_REQUIRED_TESTS.map((name) => {
      const shouldSkip =
        PLAYWRIGHT_BASELINE_TESTS.includes(name) &&
        project !== PLAYWRIGHT_BASELINE_PROJECT;
      return `<testcase name="${xmlEscape(name)}">${shouldSkip ? "<skipped/>" : ""}</testcase>`;
    }).join("");
    return `<testsuite hostname="${project}" tests="${PLAYWRIGHT_REQUIRED_TESTS.length}" failures="0" skipped="${skipped}" errors="0">${cases}</testsuite>`;
  }).join("");
  return `<testsuites tests="${PLAYWRIGHT_EXPECTED_TOTALS.tests}" failures="0" skipped="${PLAYWRIGHT_EXPECTED_TOTALS.skipped}" errors="0">${suites}</testsuites>\n`;
}

function sourceFor(root) {
  return sourceSnapshotIdentity(
    snapshotSourceFiles(root, ["package-lock.json", "src/app.ts"])
  );
}

function candidateFor(root, git = cleanGit) {
  return createCandidateIdentity({ root, git, source: sourceFor(root) });
}

function validFixture(git = cleanGit) {
  const root = mkdtempSync(join(tmpdir(), "music-evidence-manifest-"));
  json(root, "package-lock.json", { lockfileVersion: 3 });
  write(root, "src/app.ts", "export const fixture = true;\n");
  write(
    root,
    "dist/index.html",
    '<!doctype html><script type="module" src="/assets/index-fixture123.js"></script><link rel="stylesheet" href="/assets/index-fixture123.css">'
  );
  const candidate = candidateFor(root, git);
  fixtureCandidates.set(root, candidate);
  const distSnapshot = snapshotDist(join(root, "dist"));

  json(root, "artifacts/pwa-verification.json", {
    ok: true,
    checks: { identity: true, serviceWorker: true },
    failures: [],
  });
  json(root, "artifacts/release-verification.json", {
    schemaVersion: 2,
    ok: true,
    candidate,
    candidateWindow: {
      before: candidate,
      after: candidate,
      stable: true,
      distStable: true,
    },
    node: { before: nodeIdentity, after: nodeIdentity, stable: true },
    sourceSha256: candidate.source.sha256,
    scopes: { runtimeSourceFiles: 1, productionDependencies: 1, distFiles: 1 },
    failures: [],
  });
  json(root, "artifacts/licenses-production.json", {
    ok: true,
    policy: { mode: "explicit-allowlist" },
    productionPackagesReviewed: 1,
    reviewed: [{ name: "fixture", allowed: true }],
    failures: [],
  });
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
  json(root, "artifacts/audit-production.json", audit);
  json(root, "artifacts/audit-complete.json", audit);
  write(root, "artifacts/vitest-junit.xml", '<testsuites tests="1"/>\n');
  json(root, "artifacts/npm-ls-production.json", { name: "fixture" });

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: [{ type: "library", name: "fixture", version: "1.0.0" }],
  };
  json(root, "artifacts/sbom.cdx.json", sbom);
  json(root, "artifacts/sbom-verification.json", {
    ok: true,
    generator: "@cyclonedx/cyclonedx-npm@6.0.0",
    workspaceAware: true,
    npmClosurePackages: 1,
    sbomPackages: 1,
    missing: [],
    sbom: {
      file: "artifacts/sbom.cdx.json",
      sha256: record(root, "artifacts/sbom.cdx.json").sha256,
      specVersion: "1.6",
    },
  });

  write(root, "artifacts/playwright-junit.xml", executedPlaywrightJUnit());
  json(root, "artifacts/playwright-context.json", {
    schemaVersion: 2,
    ok: true,
    evidenceMode: true,
    reuseExistingServer: false,
    status: "passed",
    expectedTests: PLAYWRIGHT_EXPECTED_TOTALS.tests,
    node: nodeIdentity,
    browser: playwrightBrowser,
    candidate: { before: candidate, after: candidate, stable: true },
    dist: { before: distSnapshot, after: distSnapshot, stable: true },
    junit: record(root, "artifacts/playwright-junit.xml"),
    executionEvidenceValid: true,
    releaseGrade: true,
    localOnly: false,
    automatedCandidateEligible: true,
  });
  json(
    root,
    "artifacts/playwright-verification.json",
    verifyPlaywrightEvidence({
      root,
      candidate,
      managedBrowserExecutablePath,
    })
  );

  const lighthouseUrl = "https://example.test/search";
  const lighthouseReportFile = "artifacts/lighthouse/search-run-1.json";
  const lighthouseReport = {
    lighthouseVersion: "13.4.1",
    requestedUrl: lighthouseUrl,
    finalUrl: lighthouseUrl,
    userAgent: "HeadlessChrome/149.0.0.0",
    environment: { hostUserAgent: "HeadlessChrome/149.0.0.0" },
    runWarnings: [],
    categories: {
      performance: { score: 0.9 },
      accessibility: { score: 1 },
      "best-practices": { score: 1 },
    },
    audits: {
      "errors-in-console": { score: 1, details: { items: [] } },
      "network-requests": {
        details: {
          items: [
            {
              url: "https://example.test/assets/index-fixture123.js",
              statusCode: 200,
              cache: "none",
              resourceSize: 2_000,
              transferSize: 500,
            },
            {
              url: "https://example.test/assets/index-fixture123.css",
              statusCode: 200,
              cache: "none",
              resourceSize: 2_000,
              transferSize: 500,
            },
          ],
        },
      },
    },
  };
  const lighthouseReportBytes = JSON.stringify(lighthouseReport);
  write(root, lighthouseReportFile, lighthouseReportBytes);
  json(root, "artifacts/lighthouse/summary.json", {
    schemaVersion: 3,
    ok: true,
    executionEvidenceValid: true,
    releaseGrade: true,
    localOnly: false,
    automatedCandidateEligible: true,
    localQualitySummaryMerged: false,
    candidate,
    candidateAfter: candidate,
    candidateStable: true,
    browser: lighthouseBrowser,
    browserVerification: lighthouseBrowserVerification,
    node: nodeIdentity,
    nodeAfter: nodeIdentity,
    nodeStable: true,
    syntheticStaticDelivery: {
      contentEncoding: "gzip",
      immutableHashedAssets: true,
      productionDeploymentProven: false,
    },
    runsPerUrl: 1,
    thresholds: {
      performance: 0.85,
      accessibility: 0.95,
      "best-practices": 0.95,
    },
    distSnapshot: { ...distSnapshot, stable: true },
    pages: [
      {
        url: lighthouseUrl,
        scores: {
          performance: 0.9,
          accessibility: 1,
          "best-practices": 1,
        },
        minimumScores: {
          performance: 0.9,
          accessibility: 1,
          "best-practices": 1,
        },
      },
    ],
    measurements: [
      {
        url: lighthouseUrl,
        run: 1,
        rawReport: {
          file: lighthouseReportFile,
          bytes: Buffer.byteLength(lighthouseReportBytes),
          sha256: sha256(lighthouseReportBytes),
        },
        scores: {
          performance: 0.9,
          accessibility: 1,
          "best-practices": 1,
        },
        applicationScriptLoaded: true,
        syntheticStaticCompression: {
          requiredEntryAssets: [
            "/assets/index-fixture123.js",
            "/assets/index-fixture123.css",
          ],
          measuredLargeApplicationAssets: {
            scope: {
              origin: "https://example.test",
              pathnamePrefix: "/assets/",
              fileExtensions: [".css", ".js"],
              statusCode: 200,
              cache: "none",
              minimumDecodedBytesExclusive: 1_024,
              minimumTransferredBytesExclusive: 0,
              usedForCompressionGate: true,
            },
            requestCount: 2,
            decodedBytes: 4_000,
            transferredBytes: 1_000,
            aggregateCompressionRatio: 0.25,
          },
          observedAllSameOriginJavaScriptAndCss: {
            scope: {
              origin: "https://example.test",
              pathnamePrefix: "/",
              fileExtensions: [".css", ".js"],
              statusCode: 200,
              cache: "any",
              minimumDecodedBytesExclusive: null,
              minimumTransferredBytesExclusive: null,
              usedForCompressionGate: false,
            },
            requestCount: 2,
            decodedBytes: 4_000,
            transferredBytes: 1_000,
            decodedBytesComplete: true,
            transferredBytesComplete: true,
          },
        },
        consoleErrors: 0,
        runWarnings: [],
        chromeUserAgent: "HeadlessChrome/149.0.0.0",
        lighthouseVersion: "13.4.1",
      },
    ],
    pwaEquivalent: {
      ok: true,
      report: record(root, "artifacts/pwa-verification.json"),
    },
    failures: [],
  });

  json(root, "artifacts/ci-summary.json", {
    schemaVersion: 4,
    canonical: true,
    immutableAfterWrite: true,
    ok: true,
    node: nodeIdentity,
    candidate,
    candidateWindow: {
      before: candidate,
      after: candidate,
      stable: true,
      dist: {
        before: distSnapshot,
        after: distSnapshot,
        stable: true,
      },
    },
    candidateChecks: {
      gitStable: true,
      sourceStable: true,
      lockStable: true,
      distPresent: true,
      candidateStable: true,
      distStable: true,
      nodeStable: true,
    },
    sourceSnapshot: {
      ...candidate.source,
      stable: true,
      after: candidate.source,
    },
    browserChecks: { included: false, status: "separate" },
    steps: CANONICAL_CI_STEPS.map((name) => ({ name, status: "passed" })),
    outputs: ciOutputs.map((file) => record(root, file)),
  });
  return root;
}

function manifest(root, candidate = fixtureCandidates.get(root)) {
  return createEvidenceManifest({
    root,
    candidate,
    generatedAt: "2026-08-09T00:00:00.000Z",
    runtime,
    managedBrowserExecutablePath,
  });
}

function gate(root, id, candidate = fixtureCandidates.get(root)) {
  return evaluateRequiredEvidence(root, candidate, {
    managedBrowserExecutablePath,
  }).gates.find((item) => item.id === id);
}

test("a clean candidate with complete cross-bound evidence is eligible", () => {
  const root = validFixture();
  try {
    const result = manifest(root);
    assert.equal(result.schemaVersion, 4);
    assert.equal(
      result.requiredEvidence.ok,
      true,
      JSON.stringify(result.requiredEvidence.gates, null, 2)
    );
    assert.equal(result.candidate.releaseCandidateEligible, true);
    assert.equal(result.candidate.automatedReleaseCandidateEligible, true);
    assert.equal(
      result.inputs.packageLock.sha256,
      result.candidate.packageLock.sha256
    );
    assert.equal(result.inputs.dist.sha256, result.candidate.dist.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest eligibility fails closed when evidence changes mid-snapshot", () => {
  const root = validFixture();
  try {
    const candidate = fixtureCandidates.get(root);
    const result = createEvidenceManifest({
      root,
      candidate,
      generatedAt: "2026-08-09T00:00:00.000Z",
      runtime,
      managedBrowserExecutablePath,
      afterInitialEvidenceSnapshot: () => {
        const path = join(root, "artifacts", "pwa-verification.json");
        const report = JSON.parse(readFileSync(path, "utf8"));
        report.snapshotNonce = "changed-after-validation";
        json(root, "artifacts/pwa-verification.json", report);
      },
    });
    assert.equal(result.inputs.evidenceWindow.stable, false);
    assert.equal(result.inputs.complete, false);
    assert.equal(result.candidate.releaseCandidateEligible, false);
    assert.match(
      result.candidate.blockers.join("\n"),
      /evidence files changed/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local Chromium execution stays valid but cannot become release-grade", () => {
  const root = validFixture();
  const localRoot = mkdtempSync(join(tmpdir(), "music-local-browser-"));
  const localDirectory = join(localRoot, "chromium-1234", "chrome-linux64");
  mkdirSync(localDirectory, { recursive: true });
  const localExecutable = join(localDirectory, "chrome");
  writeFileSync(localExecutable, "#!/bin/sh\nprintf 'Chromium 149.0.0.0\\n'\n");
  chmodSync(localExecutable, 0o755);
  try {
    const candidate = fixtureCandidates.get(root);
    const localPlaywrightBrowser = createChromiumIdentity({
      configuredExecutablePath: localExecutable,
      managedExecutablePath: managedBrowserExecutablePath,
      pathSource: "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
    });
    const contextFile = "artifacts/playwright-context.json";
    const context = JSON.parse(readFileSync(join(root, contextFile), "utf8"));
    context.browser = localPlaywrightBrowser;
    context.releaseGrade = false;
    context.localOnly = true;
    context.automatedCandidateEligible = false;
    json(root, contextFile, context);
    const verification = verifyPlaywrightEvidence({
      root,
      candidate,
      managedBrowserExecutablePath,
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.executionEvidenceValid, true);
    assert.equal(verification.localOnly, true);
    assert.equal(verification.releaseGrade, false);
    json(root, "artifacts/playwright-verification.json", verification);

    const playwright = gate(root, "playwrightBrowser", candidate);
    assert.equal(playwright.ok, false);
    assert.equal(playwright.localBrowserRunPassed, true);
    assert.equal(playwright.automatedCandidateEligible, false);
    assert.match(playwright.reasons.join("\n"), /local-only/i);

    const summaryFile = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(readFileSync(join(root, summaryFile), "utf8"));
    summary.browser = createChromiumIdentity({
      configuredExecutablePath: localExecutable,
      managedExecutablePath: managedBrowserExecutablePath,
      pathSource: "CHROME_PATH",
    });
    summary.browserVerification = verifyChromiumIdentity(summary.browser, {
      managedExecutablePath: managedBrowserExecutablePath,
    });
    summary.releaseGrade = false;
    summary.localOnly = true;
    summary.automatedCandidateEligible = false;
    json(root, summaryFile, summary);

    const lighthouse = gate(root, "lighthouseBrowser", candidate);
    assert.equal(lighthouse.ok, false);
    assert.equal(lighthouse.localBrowserRunPassed, true);
    assert.equal(lighthouse.automatedCandidateEligible, false);
    assert.match(lighthouse.reasons.join("\n"), /local-only/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test("a fully bound dirty candidate is valid evidence but never release eligible", () => {
  const dirtyGit = {
    ...cleanGit,
    clean: false,
    state: "dirty",
    entryCount: 3,
    diffSha256: "b".repeat(64),
  };
  const root = validFixture(dirtyGit);
  try {
    const result = manifest(root);
    assert.equal(
      result.requiredEvidence.ok,
      true,
      JSON.stringify(result.requiredEvidence.gates, null, 2)
    );
    assert.equal(result.candidate.complete, true);
    assert.equal(result.candidate.releaseCandidateEligible, false);
    assert.match(result.candidate.blockers.join("\n"), /worktree is dirty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable git snapshot fails closed instead of appearing clean", () => {
  const root = mkdtempSync(join(tmpdir(), "music-evidence-no-git-"));
  try {
    const snapshot = dirtySnapshot(root);
    assert.equal(snapshot.clean, false);
    assert.equal(snapshot.state, "unknown");
    assert.equal(snapshot.snapshotComplete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old source evidence cannot be reused for a new source candidate", () => {
  const root = validFixture();
  try {
    write(root, "src/app.ts", "export const fixture = 'changed';\n");
    const changedCandidate = candidateFor(root);
    const result = manifest(root, changedCandidate);
    assert.equal(result.candidate.releaseCandidateEligible, false);
    for (const id of [
      "canonicalCiSummary",
      "releasePolicy",
      "playwrightBrowser",
      "lighthouseBrowser",
    ]) {
      assert.equal(gate(root, id, changedCandidate).ok, false, id);
    }
    assert.match(
      gate(root, "releasePolicy", changedCandidate).reasons.join("\n"),
      /different candidate|sourceSha256/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old dist evidence cannot be reused after dist bytes change", () => {
  const root = validFixture();
  try {
    write(root, "dist/late-replacement.txt", "changed after browsers");
    const changedCandidate = candidateFor(root);
    assert.equal(gate(root, "playwrightBrowser", changedCandidate).ok, false);
    const lighthouse = gate(root, "lighthouseBrowser", changedCandidate);
    assert.equal(lighthouse.ok, false);
    assert.match(
      lighthouse.reasons.join("\n"),
      /different candidate|complete current dist contents/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old evidence cannot be reused after the lockfile changes", () => {
  const root = validFixture();
  try {
    json(root, "package-lock.json", { lockfileVersion: 4 });
    const changedCandidate = candidateFor(root);
    const result = manifest(root, changedCandidate);
    assert.equal(
      result.inputs.packageLock.sha256,
      changedCandidate.packageLock.sha256
    );
    assert.equal(result.candidate.releaseCandidateEligible, false);
    assert.equal(gate(root, "canonicalCiSummary", changedCandidate).ok, false);
    assert.equal(gate(root, "releasePolicy", changedCandidate).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old evidence cannot be reused after the git candidate changes", () => {
  const root = validFixture();
  try {
    const changedCandidate = candidateFor(root, {
      ...cleanGit,
      clean: false,
      state: "dirty",
      entryCount: 1,
      diffSha256: "c".repeat(64),
    });
    for (const id of [
      "canonicalCiSummary",
      "releasePolicy",
      "playwrightBrowser",
      "lighthouseBrowser",
    ]) {
      assert.equal(gate(root, id, changedCandidate).ok, false, id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical CI v4 and release v2 schemas fail closed", () => {
  const root = validFixture();
  try {
    const ciFile = "artifacts/ci-summary.json";
    const ci = JSON.parse(readFileSync(join(root, ciFile), "utf8"));
    ci.schemaVersion = 3;
    json(root, ciFile, ci);
    assert.equal(gate(root, "canonicalCiSummary").ok, false);

    const releaseFile = "artifacts/release-verification.json";
    const release = JSON.parse(readFileSync(join(root, releaseFile), "utf8"));
    release.schemaVersion = 1;
    json(root, releaseFile, release);
    assert.equal(gate(root, "releasePolicy").ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release sourceSha256 must equal the unified candidate source digest", () => {
  const root = validFixture();
  try {
    const file = "artifacts/release-verification.json";
    const report = JSON.parse(readFileSync(join(root, file), "utf8"));
    report.sourceSha256 = "f".repeat(64);
    json(root, file, report);
    const release = gate(root, "releasePolicy");
    assert.equal(release.ok, false);
    assert.match(release.reasons.join("\n"), /sourceSha256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Playwright evidence rejects a missing or different browser context", () => {
  const missingRoot = validFixture();
  try {
    rmSync(join(missingRoot, "artifacts/playwright-context.json"));
    const playwright = gate(missingRoot, "playwrightBrowser");
    assert.equal(playwright.ok, false);
    assert.match(playwright.reasons.join("\n"), /context.*missing/i);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }

  const differentRoot = validFixture();
  try {
    const file = "artifacts/playwright-context.json";
    const context = JSON.parse(readFileSync(join(differentRoot, file), "utf8"));
    context.candidate.before = {
      ...context.candidate.before,
      sha256: "e".repeat(64),
    };
    json(differentRoot, file, context);
    const verificationFile = "artifacts/playwright-verification.json";
    const verification = JSON.parse(
      readFileSync(join(differentRoot, verificationFile), "utf8")
    );
    verification.context = record(differentRoot, file);
    json(differentRoot, verificationFile, verification);
    const playwright = gate(differentRoot, "playwrightBrowser");
    assert.equal(playwright.ok, false);
    assert.match(playwright.reasons.join("\n"), /invalid|different candidate/i);
  } finally {
    rmSync(differentRoot, { recursive: true, force: true });
  }
});

test("list-only JUnit remains negative evidence", () => {
  const root = validFixture();
  try {
    const listOnly =
      '<testsuites tests="56" failures="0" skipped="56" errors="0"></testsuites>\n';
    write(root, "artifacts/playwright-junit.xml", listOnly);
    const contextFile = "artifacts/playwright-context.json";
    const context = JSON.parse(readFileSync(join(root, contextFile), "utf8"));
    context.junit = record(root, "artifacts/playwright-junit.xml");
    json(root, contextFile, context);
    const verificationFile = "artifacts/playwright-verification.json";
    const verification = JSON.parse(
      readFileSync(join(root, verificationFile), "utf8")
    );
    verification.context = record(root, contextFile);
    verification.junit = record(root, "artifacts/playwright-junit.xml");
    verification.totals = {
      tests: 56,
      failures: 0,
      skipped: 56,
      errors: 0,
      executed: 0,
      passed: 0,
    };
    json(root, verificationFile, verification);
    const playwright = gate(root, "playwrightBrowser");
    assert.equal(playwright.ok, false);
    assert.match(playwright.reasons.join("\n"), /executed browser suite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw Lighthouse reports remain hash, score, and console bound", () => {
  const missingRoot = validFixture();
  try {
    rmSync(join(missingRoot, "artifacts/lighthouse/search-run-1.json"));
    assert.equal(gate(missingRoot, "lighthouseBrowser").ok, false);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }

  const scoreRoot = validFixture();
  try {
    const rawFile = "artifacts/lighthouse/search-run-1.json";
    const raw = JSON.parse(readFileSync(join(scoreRoot, rawFile), "utf8"));
    raw.categories.performance.score = 0.86;
    const bytes = JSON.stringify(raw);
    write(scoreRoot, rawFile, bytes);
    const summaryFile = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(
      readFileSync(join(scoreRoot, summaryFile), "utf8")
    );
    summary.measurements[0].rawReport.sha256 = sha256(bytes);
    json(scoreRoot, summaryFile, summary);
    const lighthouse = gate(scoreRoot, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(
      lighthouse.reasons.join("\n"),
      /score does not match raw LHR/i
    );
  } finally {
    rmSync(scoreRoot, { recursive: true, force: true });
  }

  const consoleRoot = validFixture();
  try {
    const rawFile = "artifacts/lighthouse/search-run-1.json";
    const raw = JSON.parse(readFileSync(join(consoleRoot, rawFile), "utf8"));
    delete raw.audits["errors-in-console"];
    const bytes = JSON.stringify(raw);
    write(consoleRoot, rawFile, bytes);
    const summaryFile = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(
      readFileSync(join(consoleRoot, summaryFile), "utf8")
    );
    summary.measurements[0].rawReport.sha256 = sha256(bytes);
    json(consoleRoot, summaryFile, summary);
    const lighthouse = gate(consoleRoot, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(lighthouse.reasons.join("\n"), /console evidence/i);
  } finally {
    rmSync(consoleRoot, { recursive: true, force: true });
  }
});

test("Lighthouse binds the scoped gate metrics and all-asset observations", () => {
  const measuredRoot = validFixture();
  try {
    const file = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(readFileSync(join(measuredRoot, file), "utf8"));
    summary.measurements[0].syntheticStaticCompression.measuredLargeApplicationAssets.transferredBytes = 999;
    json(measuredRoot, file, summary);
    const lighthouse = gate(measuredRoot, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(
      lighthouse.reasons.join("\n"),
      /measured-large-asset transferredBytes/i
    );
  } finally {
    rmSync(measuredRoot, { recursive: true, force: true });
  }

  const observedRoot = validFixture();
  try {
    const file = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(readFileSync(join(observedRoot, file), "utf8"));
    summary.measurements[0].syntheticStaticCompression.observedAllSameOriginJavaScriptAndCss.requestCount = 1;
    json(observedRoot, file, summary);
    const lighthouse = gate(observedRoot, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(
      lighthouse.reasons.join("\n"),
      /all-same-origin JavaScript\/CSS observation/i
    );
  } finally {
    rmSync(observedRoot, { recursive: true, force: true });
  }
});

test("Lighthouse rejects the ambiguous schema v2 transfer summary", () => {
  const root = validFixture();
  try {
    const file = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(readFileSync(join(root, file), "utf8"));
    summary.schemaVersion = 2;
    json(root, file, summary);
    const lighthouse = gate(root, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(lighthouse.reasons.join("\n"), /does not report ok:true/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Lighthouse rejects below-threshold runs and omitted entry assets", () => {
  const thresholdRoot = validFixture();
  try {
    const file = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(readFileSync(join(thresholdRoot, file), "utf8"));
    summary.pages[0].minimumScores.performance = 0.8;
    summary.measurements[0].scores.performance = 0.8;
    json(thresholdRoot, file, summary);
    const lighthouse = gate(thresholdRoot, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(lighthouse.reasons.join("\n"), /minimum\/median\/threshold/i);
  } finally {
    rmSync(thresholdRoot, { recursive: true, force: true });
  }

  const entryRoot = validFixture();
  try {
    const file = "artifacts/lighthouse/summary.json";
    const summary = JSON.parse(readFileSync(join(entryRoot, file), "utf8"));
    summary.measurements[0].syntheticStaticCompression.requiredEntryAssets = [
      "/assets/index-fixture123.js",
    ];
    json(entryRoot, file, summary);
    const lighthouse = gate(entryRoot, "lighthouseBrowser");
    assert.equal(lighthouse.ok, false);
    assert.match(lighthouse.reasons.join("\n"), /current dist\/index\.html/);
  } finally {
    rmSync(entryRoot, { recursive: true, force: true });
  }
});
