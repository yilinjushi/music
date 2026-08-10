import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot, sha256File, writeJson } from "./evidence-utils.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";
import {
  candidateBindingReasons,
  createCandidateIdentity,
  verifyChromiumIdentity,
  verifyNodeIdentity,
} from "./candidate-identity.mjs";
import { snapshotDist, snapshotsMatch } from "./lighthouse-dist-snapshot.mjs";

export const PLAYWRIGHT_PROJECTS = [
  "mobile-360x640",
  "mobile-390x844",
  "mobile-412x915",
  "mobile-landscape-844x390",
];
export const PLAYWRIGHT_BASELINE_PROJECT = "mobile-390x844";
export const PLAYWRIGHT_ALL_PROJECT_TESTS = [
  "/search passes mobile a11y, overflow, and touch-target checks",
  "/mine passes mobile a11y, overflow, and touch-target checks",
  "/settings passes mobile a11y, overflow, and touch-target checks",
  "search uses a deterministic same-origin NetEase fixture",
  "keyboard focus reaches the primary navigation",
];
export const PLAYWRIGHT_BASELINE_TESTS = [
  "200% browser zoom keeps primary controls usable",
  "simulated server session safely restores the browser account view",
  "a simulated 401 expires persisted UI state without exposing credentials",
  "simulated logout calls the same-origin endpoint and clears the UI",
  "playing a playlist adds every fixture track to the queue",
  "primary source failure auto-matches the correct secondary recording and plays it",
  "repeated playback failure stops after the bounded fallback budget",
  "a waiting service-worker update never interrupts active playback",
  "a previously visited deep route reloads from the offline app shell",
];
export const PLAYWRIGHT_REQUIRED_TESTS = [
  ...PLAYWRIGHT_ALL_PROJECT_TESTS,
  ...PLAYWRIGHT_BASELINE_TESTS,
];
export const PLAYWRIGHT_EXPECTED_TOTALS = {
  tests: PLAYWRIGHT_REQUIRED_TESTS.length * PLAYWRIGHT_PROJECTS.length,
  executed:
    PLAYWRIGHT_ALL_PROJECT_TESTS.length * PLAYWRIGHT_PROJECTS.length +
    PLAYWRIGHT_BASELINE_TESTS.length,
  passed:
    PLAYWRIGHT_ALL_PROJECT_TESTS.length * PLAYWRIGHT_PROJECTS.length +
    PLAYWRIGHT_BASELINE_TESTS.length,
  skipped: PLAYWRIGHT_BASELINE_TESTS.length * (PLAYWRIGHT_PROJECTS.length - 1),
};

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

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(tag) {
  const values = new Map();
  for (const match of tag.matchAll(/\b([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
    values.set(match[1].toLowerCase(), decodeXml(match[2] ?? match[3] ?? ""));
  }
  return values;
}

function exactNumber(attrs, name, context, failures) {
  const raw = attrs.get(name);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    failures.push(`${context} is missing an integer ${name} attribute`);
    return null;
  }
  return Number(raw);
}

function parseJUnit(xml, failures) {
  const rootTag = xml.match(/<testsuites\b[^>]*>/i)?.[0];
  if (!rootTag) throw new Error("Playwright JUnit root totals are missing");
  const rootAttrs = attributes(rootTag);
  const tests = exactNumber(
    rootAttrs,
    "tests",
    "Playwright JUnit root",
    failures
  );
  const failed = exactNumber(
    rootAttrs,
    "failures",
    "Playwright JUnit root",
    failures
  );
  const skipped = exactNumber(
    rootAttrs,
    "skipped",
    "Playwright JUnit root",
    failures
  );
  const errors = exactNumber(
    rootAttrs,
    "errors",
    "Playwright JUnit root",
    failures
  );
  let totals = null;
  if ([tests, failed, skipped, errors].every((value) => value !== null)) {
    totals = {
      tests,
      failures: failed,
      skipped,
      errors,
      executed: tests - skipped,
      passed: tests - skipped - failed - errors,
    };
    for (const [key, value] of Object.entries(PLAYWRIGHT_EXPECTED_TOTALS)) {
      if (totals[key] !== value) {
        failures.push(`expected exactly ${value} ${key}, found ${totals[key]}`);
      }
    }
    if (failed !== 0 || errors !== 0) {
      failures.push(
        `Playwright reported ${failed} failures and ${errors} errors`
      );
    }
  }

  const suites = [
    ...xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/gi),
  ].map((match) => ({ attrs: attributes(match[1]), body: match[2] }));
  const seenProjects = suites.map(
    ({ attrs: suiteAttrs }) => suiteAttrs.get("hostname") ?? ""
  );
  if (
    seenProjects.length !== PLAYWRIGHT_PROJECTS.length ||
    PLAYWRIGHT_PROJECTS.some(
      (project) => seenProjects.filter((seen) => seen === project).length !== 1
    )
  ) {
    failures.push(
      `expected exactly one JUnit suite for each mobile project (${PLAYWRIGHT_PROJECTS.join(", ")}); found ${seenProjects.join(", ")}`
    );
  }

  for (const { attrs: suiteAttrs, body } of suites) {
    const project = suiteAttrs.get("hostname") ?? "<missing-hostname>";
    for (const [name, expected] of [
      ["tests", PLAYWRIGHT_REQUIRED_TESTS.length],
      ["failures", 0],
      ["errors", 0],
      [
        "skipped",
        project === PLAYWRIGHT_BASELINE_PROJECT
          ? 0
          : PLAYWRIGHT_BASELINE_TESTS.length,
      ],
    ]) {
      const actual = exactNumber(
        suiteAttrs,
        name,
        `JUnit suite ${project}`,
        failures
      );
      if (actual !== null && actual !== expected) {
        failures.push(
          `JUnit suite ${project} expected ${name}=${expected}, found ${actual}`
        );
      }
    }

    const cases = [
      ...body.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/gi),
    ].map((match) => ({
      name: attributes(match[1]).get("name") ?? "",
      skipped: /<skipped\b/i.test(match[2]),
      failed: /<(?:failure|error)\b/i.test(match[2]),
    }));
    if (cases.length !== PLAYWRIGHT_REQUIRED_TESTS.length) {
      failures.push(
        `JUnit suite ${project} must contain exactly ${PLAYWRIGHT_REQUIRED_TESTS.length} testcase elements, found ${cases.length}`
      );
    }
    for (const name of PLAYWRIGHT_REQUIRED_TESTS) {
      const matches = cases.filter((testcase) => testcase.name === name);
      if (matches.length !== 1) {
        failures.push(
          `JUnit suite ${project} must contain exactly one testcase named ${name}`
        );
        continue;
      }
      const shouldSkip =
        PLAYWRIGHT_BASELINE_TESTS.includes(name) &&
        project !== PLAYWRIGHT_BASELINE_PROJECT;
      if (matches[0].skipped !== shouldSkip) {
        failures.push(
          `JUnit testcase ${project} / ${name} must be ${shouldSkip ? "skipped" : "executed"}`
        );
      }
      if (matches[0].failed) {
        failures.push(
          `JUnit testcase ${project} / ${name} contains a failure or error`
        );
      }
    }
    for (const testcase of cases) {
      if (!PLAYWRIGHT_REQUIRED_TESTS.includes(testcase.name)) {
        failures.push(
          `JUnit suite ${project} contains unexpected testcase ${testcase.name}`
        );
      }
    }
  }
  return totals;
}

function sameCompleteDist(left, right) {
  return (
    left &&
    right &&
    snapshotsMatch(left, right) &&
    JSON.stringify(left.files) === JSON.stringify(right.files)
  );
}

export function verifyPlaywrightEvidence({
  root = projectRoot,
  candidate: candidateOverride = null,
  managedBrowserExecutablePath = undefined,
} = {}) {
  const failures = [];
  let browserVerification = null;
  let nodeVerification = null;
  const currentCandidate =
    candidateOverride ?? createCandidateIdentity({ root });
  if (currentCandidate.complete !== true) {
    failures.push(
      `Current candidate identity is incomplete: ${currentCandidate.errors.join("; ")}`
    );
  }

  let currentDist = null;
  try {
    currentDist = snapshotDist(join(root, "dist"));
  } catch (error) {
    failures.push(`Current dist snapshot failed: ${error.message}`);
  }

  const contextFile = "artifacts/playwright-context.json";
  const contextRecord = fileRecord(root, contextFile);
  let context = null;
  if (!contextRecord.present) {
    failures.push(`${contextFile} is missing`);
  } else {
    try {
      context = JSON.parse(readFileSync(join(root, contextFile), "utf8"));
    } catch (error) {
      failures.push(`${contextFile} is invalid JSON: ${error.message}`);
    }
  }

  const junitFile = "artifacts/playwright-junit.xml";
  const junitRecord = fileRecord(root, junitFile);
  let totals = null;
  if (!junitRecord.present) {
    failures.push(`${junitFile} is missing`);
  } else {
    try {
      totals = parseJUnit(
        readFileSync(join(root, junitFile), "utf8"),
        failures
      );
    } catch (error) {
      failures.push(`Playwright JUnit is invalid: ${error.message}`);
    }
  }

  if (context) {
    if (
      context.schemaVersion !== 2 ||
      context.ok !== true ||
      context.executionEvidenceValid !== true ||
      context.evidenceMode !== true ||
      context.reuseExistingServer !== false ||
      context.status !== "passed" ||
      context.expectedTests !== PLAYWRIGHT_EXPECTED_TOTALS.tests ||
      context.candidate?.stable !== true ||
      context.dist?.stable !== true ||
      context.releaseGrade !== context.automatedCandidateEligible ||
      context.localOnly !== !context.releaseGrade
    ) {
      failures.push(
        "Playwright context is not a passing isolated evidence-mode execution"
      );
    }
    failures.push(
      ...candidateBindingReasons(
        context.candidate?.before,
        currentCandidate,
        "Playwright initial context"
      ),
      ...candidateBindingReasons(
        context.candidate?.after,
        currentCandidate,
        "Playwright final context"
      )
    );
    if (
      currentDist &&
      (!sameCompleteDist(context.dist?.before, currentDist) ||
        !sameCompleteDist(context.dist?.after, currentDist))
    ) {
      failures.push(
        "Playwright context does not bind an unchanged complete current dist"
      );
    }
    if (
      context.junit?.file !== junitFile ||
      context.junit?.present !== true ||
      context.junit?.bytes !== junitRecord.bytes ||
      context.junit?.sha256 !== junitRecord.sha256
    ) {
      failures.push(
        "Playwright context does not bind the exact current JUnit bytes"
      );
    }
    const browser = context.browser;
    browserVerification = verifyChromiumIdentity(
      browser,
      managedBrowserExecutablePath === undefined
        ? undefined
        : { managedExecutablePath: managedBrowserExecutablePath }
    );
    failures.push(
      ...browserVerification.failures.map(
        (failure) => `Playwright Chromium identity: ${failure}`
      )
    );
    if (
      browser?.schemaVersion !== 1 ||
      browser?.name !== "chromium" ||
      !/\b(?:Chromium|Chrome)\b/i.test(browser?.version ?? "") ||
      browser?.versionSource !== "executable --version" ||
      typeof browser?.configuredExecutablePath !== "string" ||
      typeof browser?.executablePath !== "string" ||
      !Number.isInteger(browser?.executableBytes) ||
      browser.executableBytes < 1 ||
      !/^[a-f0-9]{64}$/i.test(browser?.executableSha256 ?? "") ||
      ![
        "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
        "playwright-config-default",
      ].includes(browser?.pathSource) ||
      !["playwright-managed", "custom-local"].includes(browser?.provenance) ||
      browser?.automatedEligible !==
        (browser?.provenance === "playwright-managed") ||
      context.automatedCandidateEligible !== browser?.automatedEligible ||
      context.releaseGrade !== browser?.automatedEligible ||
      context.localOnly === browser?.automatedEligible
    ) {
      failures.push(
        "Playwright context has no honest Node/Chromium binary identity"
      );
    }
    nodeVerification = verifyNodeIdentity(context.node);
    failures.push(
      ...nodeVerification.failures.map(
        (failure) => `Playwright Node identity: ${failure}`
      )
    );
    if (nodeVerification.matches !== true) {
      failures.push(
        "Playwright context does not identify the current Node runtime"
      );
    }
  }

  const executionEvidenceValid = failures.length === 0;
  const releaseGrade =
    failures.length === 0 &&
    browserVerification?.automatedEligible === true &&
    context?.automatedCandidateEligible === true;
  return {
    schemaVersion: 3,
    ok: executionEvidenceValid,
    executionEvidenceValid,
    releaseGrade,
    localOnly: executionEvidenceValid && !releaseGrade,
    scope:
      "exact Playwright mobile-project execution evidence (separate from local CI summary)",
    candidate: currentCandidate,
    context: contextRecord,
    browser: context?.browser ?? null,
    node: context?.node ?? null,
    dist: currentDist,
    expectedProjects: PLAYWRIGHT_PROJECTS,
    expectedTestNames: PLAYWRIGHT_REQUIRED_TESTS,
    expectedTotals: PLAYWRIGHT_EXPECTED_TOTALS,
    junit: junitRecord,
    totals,
    identityChecks: {
      browserMatches: browserVerification?.matches === true,
      nodeMatches: nodeVerification?.matches === true,
    },
    automatedCandidateEligible: releaseGrade,
    claimBoundary:
      browserVerification?.automatedEligible !== true
        ? "The Chromium executable is temporary or is not the exact Playwright-managed binary; this is local-only browser evidence and cannot establish automated release eligibility."
        : "The recorded executable and candidate are eligible for automated evidence when every manifest gate also passes.",
    failures,
  };
}

export function main() {
  const releasePipelineLock = acquireEvidencePipelineLock(
    projectRoot,
    "Playwright evidence verification"
  );
  process.on("exit", releasePipelineLock);
  const report = verifyPlaywrightEvidence();
  writeJson(
    join(projectRoot, "artifacts", "playwright-verification.json"),
    report
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
