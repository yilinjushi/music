import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256File } from "./evidence-utils.mjs";
import {
  candidateIdentityMatches,
  createCandidateIdentity,
  createNodeIdentity,
  gitSnapshot,
  nodeIdentityMatches,
} from "./candidate-identity.mjs";
import { snapshotDist, snapshotsMatch } from "./lighthouse-dist-snapshot.mjs";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
} from "./exclusive-run-lock.mjs";
import {
  snapshotSourceTree,
  sourceSnapshotIdentity,
  sourceSnapshotsMatch,
} from "./source-tree-snapshot.mjs";

const releasePipelineLock = acquireEvidencePipelineLock(
  process.cwd(),
  "Canonical CI evidence"
);
process.on("exit", releasePipelineLock);

const sourceSnapshotBefore = snapshotSourceTree(process.cwd());
const gitSnapshotBefore = gitSnapshot(process.cwd());
const lockSha256Before = sha256File(join(process.cwd(), "package-lock.json"));
const nodeIdentityBefore = createNodeIdentity();
const artifactsDir = join(process.cwd(), "artifacts");
rmSync(artifactsDir, { recursive: true, force: true });
mkdirSync(artifactsDir, { recursive: true });

const steps = [
  { name: "Lint", cmd: "npm run lint" },
  { name: "Frontend typecheck", cmd: "npm run typecheck" },
  { name: "Functions typecheck", cmd: "npm run typecheck:functions" },
  {
    name: "Unit and component tests",
    cmd: "npx --no-install vitest run --reporter=default --reporter=junit --outputFile.junit=artifacts/vitest-junit.xml",
  },
  { name: "Evidence policy tests", cmd: "npm run test:evidence" },
  {
    name: "Build",
    cmd: "npm run build",
    nestedEvidenceWriter: true,
  },
  {
    name: "PWA artifact contract",
    cmd: "npm run verify:pwa",
    nestedEvidenceWriter: true,
  },
  {
    name: "Release policy",
    cmd: "npm run verify:release",
    nestedEvidenceWriter: true,
  },
  {
    name: "License policy",
    cmd: "npm run verify:licenses",
    nestedEvidenceWriter: true,
  },
  {
    name: "Production audit",
    cmd: "npm run audit:prod",
    nestedEvidenceWriter: true,
  },
  {
    name: "Complete dependency audit",
    cmd: "npm run audit:all",
    nestedEvidenceWriter: true,
  },
  {
    name: "Workspace-aware production SBOM",
    cmd: "npm run sbom:prod",
    nestedEvidenceWriter: true,
  },
];
const canonicalOutputs = [
  "vitest-junit.xml",
  "pwa-verification.json",
  "release-verification.json",
  "licenses-production.json",
  "audit-production.json",
  "audit-complete.json",
  "sbom.cdx.json",
  "npm-ls-production.json",
  "sbom-verification.json",
];

let failed = false;
const report = {
  schemaVersion: 4,
  scope:
    "local quality, build, artifact, dependency, and evidence-policy checks",
  generatedAt: new Date().toISOString(),
  node: nodeIdentityBefore,
  canonical: true,
  immutableAfterWrite: true,
  candidate: null,
  candidateWindow: null,
  candidateChecks: null,
  sourceSnapshot: {
    ...sourceSnapshotIdentity(sourceSnapshotBefore),
    stable: null,
  },
  browserChecks: {
    included: false,
    status: "separate",
    evidence: [
      "artifacts/playwright-junit.xml",
      "artifacts/playwright-verification.json",
      "artifacts/lighthouse/summary.json",
    ],
    note: "A green local summary never implies that Playwright, Lighthouse, HTTPS deployment, or real-device checks passed.",
  },
  steps: [],
};

let candidateAfterBuild = null;
let distAfterBuild = null;

function runStep(step) {
  console.log(`\n▶ ${step.name}`);
  console.log("─".repeat(40));
  const startedAt = Date.now();
  try {
    execSync(step.cmd, {
      stdio: "inherit",
      env: step.nestedEvidenceWriter
        ? {
            ...process.env,
            [EVIDENCE_PIPELINE_TOKEN_ENV]: releasePipelineLock.token,
          }
        : process.env,
    });
    console.log(`✅ ${step.name} passed`);
    report.steps.push({
      name: step.name,
      command: step.cmd,
      status: "passed",
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch {
    console.error(`❌ ${step.name} failed`);
    report.steps.push({
      name: step.name,
      command: step.cmd,
      status: "failed",
      durationMs: Date.now() - startedAt,
    });
    return false;
  }
}

for (const step of steps) {
  if (!runStep(step)) {
    failed = true;
    break;
  }
  if (step.name === "Build") {
    try {
      distAfterBuild = snapshotDist(join(process.cwd(), "dist"));
      candidateAfterBuild = createCandidateIdentity({
        root: process.cwd(),
        distSnapshot: distAfterBuild,
      });
      if (!candidateAfterBuild.complete) {
        throw new Error(
          `post-build candidate is incomplete: ${candidateAfterBuild.errors.join("; ")}`
        );
      }
    } catch (error) {
      failed = true;
      console.error(
        `❌ Post-build candidate snapshot failed: ${error instanceof Error ? error.message : String(error)}`
      );
      break;
    }
  }
}

try {
  const sourceSnapshotAfter = snapshotSourceTree(process.cwd());
  const candidate = createCandidateIdentity({ root: process.cwd() });
  const distAfter = snapshotDist(join(process.cwd(), "dist"));
  const nodeIdentityAfter = createNodeIdentity();
  const gitStable =
    JSON.stringify(gitSnapshotBefore) === JSON.stringify(candidate.git);
  const lockStable = candidate.packageLock?.sha256 === lockSha256Before;
  const candidateStable = candidateIdentityMatches(
    candidateAfterBuild,
    candidate
  );
  const distStable =
    distAfterBuild !== null && snapshotsMatch(distAfterBuild, distAfter);
  const nodeStable = nodeIdentityMatches(nodeIdentityBefore, nodeIdentityAfter);
  report.sourceSnapshot = {
    ...sourceSnapshotIdentity(sourceSnapshotBefore),
    stable: sourceSnapshotsMatch(sourceSnapshotBefore, sourceSnapshotAfter),
    after: sourceSnapshotIdentity(sourceSnapshotAfter),
  };
  if (!report.sourceSnapshot.stable) {
    failed = true;
    console.error("❌ Source tree changed while canonical CI was running");
  }
  report.candidate = candidate;
  report.candidateWindow = {
    scope:
      "post-build candidate through all artifact, dependency, and summary checks",
    before: candidateAfterBuild,
    after: candidate,
    stable: candidateStable,
    dist: {
      before: distAfterBuild,
      after: distAfter,
      stable: distStable,
    },
  };
  report.candidateChecks = {
    gitStable,
    sourceStable: report.sourceSnapshot.stable,
    lockStable,
    distPresent: typeof candidate.dist?.sha256 === "string",
    candidateStable,
    distStable,
    nodeStable,
  };
  if (
    !candidate.complete ||
    !gitStable ||
    !lockStable ||
    !candidateStable ||
    !distStable ||
    !nodeStable
  ) {
    failed = true;
    console.error(
      "❌ Git, lockfile, source, or dist candidate changed while canonical CI was running"
    );
  }
} catch (error) {
  failed = true;
  report.sourceSnapshot = {
    ...sourceSnapshotIdentity(sourceSnapshotBefore),
    stable: false,
    error: error instanceof Error ? error.message : String(error),
  };
  console.error("❌ Final source-tree snapshot failed");
}

report.outputs = canonicalOutputs.map((file) => {
  const path = join(artifactsDir, file);
  const present = existsSync(path) && statSync(path).isFile();
  if (!present) failed = true;
  return {
    file: `artifacts/${file}`,
    present,
    bytes: present ? statSync(path).size : null,
    sha256: present ? sha256File(path) : null,
  };
});

report.ok = !failed;
report.completedAt = new Date().toISOString();
writeFileSync(
  join(artifactsDir, "ci-summary.json"),
  `${JSON.stringify(report, null, 2)}\n`
);

// The canonical summary is now sealed and must never be rewritten. Generate
// the manifest only afterwards so its hash binds these final summary bytes.
let manifestFailed = false;
console.log("\n▶ Evidence manifest (post-summary binding)");
console.log("─".repeat(40));
try {
  execSync("npm run evidence:manifest", {
    stdio: "inherit",
    env: {
      ...process.env,
      [EVIDENCE_PIPELINE_TOKEN_ENV]: releasePipelineLock.token,
    },
  });
  console.log("✅ Evidence manifest generated");
} catch {
  manifestFailed = true;
  console.error("❌ Evidence manifest generation failed");
}

if (failed || manifestFailed) {
  process.exit(1);
} else {
  console.log("\n✅ Local quality and artifact checks passed");
  console.log(
    "ℹ Browser, deployed HTTPS, and real-device evidence remain separate gates."
  );
}
