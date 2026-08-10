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
import test from "node:test";
import { projectRoot, sha256 } from "./evidence-utils.mjs";
import { snapshotDist } from "./lighthouse-dist-snapshot.mjs";
import {
  GIT_DIFF_ALGORITHM,
  createChromiumIdentity,
  createCandidateIdentity,
  createNodeIdentity,
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

function executedJUnit() {
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

function fakeChromium(parent) {
  const browserRoot = mkdtempSync(join(parent, "music-playwright-browser-"));
  const directory = join(browserRoot, "chromium-1234", "chrome-linux64");
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "chrome");
  writeFileSync(executable, "#!/bin/sh\nprintf 'Chromium 149.0.0.0\\n'\n");
  chmodSync(executable, 0o755);
  return { browserRoot, executable };
}

function fixture({ temporaryBrowser = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "music-playwright-evidence-"));
  mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
  const browserFixture = fakeChromium(
    temporaryBrowser ? tmpdir() : join(projectRoot, "node_modules")
  );
  json(root, "package-lock.json", { lockfileVersion: 3 });
  write(root, "src/app.ts", "export const fixture = true;\n");
  write(root, "dist/index.html", "<main>fixture</main>\n");
  const source = sourceSnapshotIdentity(
    snapshotSourceFiles(root, ["package-lock.json", "src/app.ts"])
  );
  const candidate = createCandidateIdentity({ root, git: cleanGit, source });
  const dist = snapshotDist(join(root, "dist"));
  write(root, "artifacts/playwright-junit.xml", executedJUnit());
  const browser = createChromiumIdentity({
    configuredExecutablePath: browserFixture.executable,
    managedExecutablePath: browserFixture.executable,
    pathSource: "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  });
  json(root, "artifacts/playwright-context.json", {
    schemaVersion: 2,
    ok: true,
    evidenceMode: true,
    reuseExistingServer: false,
    status: "passed",
    expectedTests: PLAYWRIGHT_EXPECTED_TOTALS.tests,
    node: createNodeIdentity(),
    browser,
    candidate: { before: candidate, after: candidate, stable: true },
    dist: { before: dist, after: dist, stable: true },
    junit: record(root, "artifacts/playwright-junit.xml"),
    executionEvidenceValid: true,
    releaseGrade: !temporaryBrowser,
    localOnly: temporaryBrowser,
    automatedCandidateEligible: !temporaryBrowser,
  });
  return {
    root,
    candidate,
    managedBrowserExecutablePath: browserFixture.executable,
    browserRoot: browserFixture.browserRoot,
  };
}

function destroy(value) {
  rmSync(value.root, { recursive: true, force: true });
  rmSync(value.browserRoot, { recursive: true, force: true });
}

test("verifier cross-binds exact JUnit, browser context, candidate, and dist", () => {
  const value = fixture();
  const { root } = value;
  try {
    const report = verifyPlaywrightEvidence(value);
    assert.equal(report.ok, true);
    assert.equal(report.executionEvidenceValid, true);
    assert.equal(report.releaseGrade, true);
    assert.equal(report.localOnly, false);
    assert.equal(report.automatedCandidateEligible, true);
    assert.deepEqual(report.identityChecks, {
      browserMatches: true,
      nodeMatches: true,
    });
    assert.deepEqual(report.totals, {
      ...PLAYWRIGHT_EXPECTED_TOTALS,
      failures: 0,
      errors: 0,
    });
    assert.equal(
      report.context.sha256,
      record(root, report.context.file).sha256
    );
  } finally {
    destroy(value);
  }
});

test("a /tmp Chromium is honestly accepted only as local evidence", () => {
  const value = fixture({ temporaryBrowser: true });
  try {
    const report = verifyPlaywrightEvidence(value);
    assert.equal(report.ok, true);
    assert.equal(report.executionEvidenceValid, true);
    assert.equal(report.releaseGrade, false);
    assert.equal(report.localOnly, true);
    assert.equal(report.automatedCandidateEligible, false);
    assert.match(report.claimBoundary, /local-only/i);
  } finally {
    destroy(value);
  }
});

test("missing and different browser contexts fail closed", () => {
  const missing = fixture();
  try {
    rmSync(join(missing.root, "artifacts/playwright-context.json"));
    const report = verifyPlaywrightEvidence(missing);
    assert.equal(report.ok, false);
    assert.match(report.failures.join("\n"), /context.*missing/i);
  } finally {
    destroy(missing);
  }

  const different = fixture();
  try {
    const file = join(different.root, "artifacts/playwright-context.json");
    const context = JSON.parse(readFileSync(file, "utf8"));
    context.candidate.after = {
      ...context.candidate.after,
      sha256: "f".repeat(64),
    };
    writeFileSync(file, `${JSON.stringify(context, null, 2)}\n`);
    const report = verifyPlaywrightEvidence(different);
    assert.equal(report.ok, false);
    assert.match(report.failures.join("\n"), /invalid|different candidate/i);
  } finally {
    destroy(different);
  }
});

test("list-only JUnit cannot become passing browser evidence", () => {
  const fixtureValue = fixture();
  try {
    const junit = `<testsuites tests="${PLAYWRIGHT_EXPECTED_TOTALS.tests}" failures="0" skipped="${PLAYWRIGHT_EXPECTED_TOTALS.tests}" errors="0"></testsuites>\n`;
    write(fixtureValue.root, "artifacts/playwright-junit.xml", junit);
    const contextFile = "artifacts/playwright-context.json";
    const context = JSON.parse(
      readFileSync(join(fixtureValue.root, contextFile), "utf8")
    );
    context.junit = record(fixtureValue.root, "artifacts/playwright-junit.xml");
    json(fixtureValue.root, contextFile, context);
    const report = verifyPlaywrightEvidence(fixtureValue);
    assert.equal(report.ok, false);
    assert.match(report.failures.join("\n"), /executed|suite|testcase/i);
  } finally {
    destroy(fixtureValue);
  }
});

test("a changed Chromium binary invalidates the recorded browser context", () => {
  const value = fixture();
  try {
    writeFileSync(
      value.managedBrowserExecutablePath,
      "#!/bin/sh\nprintf 'Chromium 149.0.0.1\\n'\n"
    );
    chmodSync(value.managedBrowserExecutablePath, 0o755);
    const report = verifyPlaywrightEvidence(value);
    assert.equal(report.ok, false);
    assert.equal(report.automatedCandidateEligible, false);
    assert.match(report.failures.join("\n"), /Chromium identity/i);
  } finally {
    destroy(value);
  }
});
