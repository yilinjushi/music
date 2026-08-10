import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectRoot } from "./evidence-utils.mjs";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
} from "./exclusive-run-lock.mjs";
import { runProductionBuild } from "./run-build.mjs";

test("the standard build holds the pipeline lock through every command", () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-lock-"));
  const verifier = join(root, "verify-lock.mjs");
  const marker = join(root, "verified.txt");
  const lockDirectory = evidencePipelineLockPath(root);
  try {
    writeFileSync(
      verifier,
      `import assert from "node:assert/strict";\n` +
        `import { readFileSync, writeFileSync } from "node:fs";\n` +
        `const owner = JSON.parse(readFileSync(${JSON.stringify(join(lockDirectory, "owner.json"))}, "utf8"));\n` +
        `assert.equal(owner.pid, process.ppid);\n` +
        `writeFileSync(${JSON.stringify(marker)}, owner.token);\n`
    );
    runProductionBuild({
      root,
      commands: [
        {
          label: "lock verifier",
          executable: process.execPath,
          arguments: [verifier],
        },
      ],
    });
    assert.ok(readFileSync(marker, "utf8").length > 0);
    assert.equal(existsSync(lockDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build conflicts fail closed while explicit CI token reentry stays owned", () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-reentry-"));
  const lockDirectory = evidencePipelineLockPath(root);
  const previousToken = process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
  delete process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
  const releaseOuter = acquireEvidencePipelineLock(root, "canonical CI");
  try {
    assert.throws(
      () => runProductionBuild({ root, commands: [] }),
      /already running/
    );
    process.env[EVIDENCE_PIPELINE_TOKEN_ENV] = releaseOuter.token;
    runProductionBuild({ root, commands: [] });
    assert.equal(existsSync(lockDirectory), true);
  } finally {
    releaseOuter();
    if (previousToken === undefined) {
      delete process.env[EVIDENCE_PIPELINE_TOKEN_ENV];
    } else {
      process.env[EVIDENCE_PIPELINE_TOKEN_ENV] = previousToken;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed build command releases the lock", () => {
  const root = mkdtempSync(join(tmpdir(), "production-build-failure-"));
  try {
    assert.throws(
      () =>
        runProductionBuild({
          root,
          commands: [
            {
              label: "intentional failure",
              executable: process.execPath,
              arguments: ["-e", "process.exit(7)"],
            },
          ],
        }),
      /exit code 7/
    );
    const release = acquireEvidencePipelineLock(root, "post-failure writer");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package and canonical CI use the locked standard build entry", () => {
  const packageJson = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8")
  );
  assert.equal(packageJson.scripts.build, "node scripts/run-build.mjs");
  assert.equal(packageJson.scripts["build:release"], "npm run build");

  const ci = readFileSync(join(projectRoot, "scripts/ci-test.js"), "utf8");
  assert.match(
    ci,
    /name: "Build",\s*cmd: "npm run build",\s*nestedEvidenceWriter: true,/
  );
});
