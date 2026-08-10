import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot, sha256File, writeJson } from "./evidence-utils.mjs";
import {
  candidateIdentityMatches,
  createChromiumIdentity,
  createCandidateIdentity,
  createNodeIdentity,
} from "./candidate-identity.mjs";
import { snapshotDist, snapshotsMatch } from "./lighthouse-dist-snapshot.mjs";
import { withPlaywrightRunLockHeld } from "./playwright-evidence-lock.mjs";

const contextPath = join(projectRoot, "artifacts", "playwright-context.json");
const junitPath = join(projectRoot, "artifacts", "playwright-junit.xml");

function browserIdentity(config) {
  const configured = config.projects[0]?.use?.launchOptions?.executablePath;
  const environmentPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  return createChromiumIdentity({
    configuredExecutablePath: configured,
    pathSource:
      typeof environmentPath === "string" &&
      typeof configured === "string" &&
      resolve(environmentPath) === resolve(configured)
        ? "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
        : "playwright-config-default",
  });
}

function currentJunitRecord() {
  if (!existsSync(junitPath) || !statSync(junitPath).isFile()) {
    return {
      file: "artifacts/playwright-junit.xml",
      present: false,
      bytes: null,
      sha256: null,
    };
  }
  return {
    file: "artifacts/playwright-junit.xml",
    present: true,
    bytes: statSync(junitPath).size,
    sha256: sha256File(junitPath),
  };
}

export default class PlaywrightEvidenceReporter {
  startedAt = null;
  candidateBefore = null;
  distBefore = null;
  browser = null;
  node = null;
  expectedTests = null;
  evidenceMode = false;
  reuseExistingServer = null;
  setupError = null;

  onBegin(config, suite) {
    withPlaywrightRunLockHeld(() => {
      rmSync(contextPath, { force: true });
      rmSync(junitPath, { force: true });
    });
    this.startedAt = new Date().toISOString();
    this.evidenceMode = config.metadata?.evidenceMode === true;
    this.reuseExistingServer = config.metadata?.reuseExistingServer === true;
    this.expectedTests = suite.allTests().length;
    try {
      this.candidateBefore = createCandidateIdentity({ root: projectRoot });
      this.distBefore = snapshotDist(join(projectRoot, "dist"));
      this.browser = browserIdentity(config);
      this.node = createNodeIdentity();
      if (!this.candidateBefore.complete) {
        throw new Error(
          `candidate identity is incomplete: ${this.candidateBefore.errors.join("; ")}`
        );
      }
    } catch (error) {
      this.setupError = error instanceof Error ? error.message : String(error);
    }
  }

  onEnd(result) {
    let candidateAfter = null;
    let distAfter = null;
    let finalError = this.setupError;
    try {
      candidateAfter = createCandidateIdentity({ root: projectRoot });
      distAfter = snapshotDist(join(projectRoot, "dist"));
    } catch (error) {
      finalError = error instanceof Error ? error.message : String(error);
    }

    const candidateStable = candidateIdentityMatches(
      this.candidateBefore,
      candidateAfter
    );
    const distStable =
      this.distBefore !== null &&
      distAfter !== null &&
      snapshotsMatch(this.distBefore, distAfter);
    const junit = currentJunitRecord();
    const ok =
      this.evidenceMode &&
      this.reuseExistingServer === false &&
      result.status === "passed" &&
      this.browser !== null &&
      this.node !== null &&
      this.candidateBefore !== null &&
      candidateAfter !== null &&
      candidateStable &&
      distStable &&
      junit.present &&
      finalError === null;

    const automatedCandidateEligible =
      ok && this.browser?.automatedEligible === true;
    const localOnly = ok && !automatedCandidateEligible;
    withPlaywrightRunLockHeld(() => {
      writeJson(contextPath, {
        schemaVersion: 2,
        ok,
        scope:
          "exact Playwright process, runtime, browser binary, candidate, JUnit, and dist binding",
        evidenceMode: this.evidenceMode,
        reuseExistingServer: this.reuseExistingServer,
        startedAt: this.startedAt,
        completedAt: new Date().toISOString(),
        status: result.status,
        expectedTests: this.expectedTests,
        node: this.node,
        browser: this.browser,
        candidate: {
          before: this.candidateBefore,
          after: candidateAfter,
          stable: candidateStable,
        },
        dist: {
          before: this.distBefore,
          after: distAfter,
          stable: distStable,
        },
        junit,
        executionEvidenceValid: ok,
        releaseGrade: automatedCandidateEligible,
        localOnly,
        automatedCandidateEligible,
        error: finalError,
      });
    });
  }
}
