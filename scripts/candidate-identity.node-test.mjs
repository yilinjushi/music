import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANDIDATE_IDENTITY_SCHEMA_VERSION,
  GIT_DIFF_ALGORITHM,
  candidateBindingReasons,
  candidateIdentityMatches,
  createChromiumIdentity,
  createCandidateIdentity,
  createNodeIdentity,
  verifyChromiumIdentity,
  verifyNodeIdentity,
} from "./candidate-identity.mjs";
import { projectRoot } from "./evidence-utils.mjs";
import {
  snapshotSourceFiles,
  sourceSnapshotIdentity,
} from "./source-tree-snapshot.mjs";

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

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "music-candidate-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
    writeFileSync(join(root, "dist", "index.html"), "<main>one</main>\n");
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function source(root) {
  return sourceSnapshotIdentity(
    snapshotSourceFiles(root, ["src/app.ts", "package-lock.json"])
  );
}

function candidate(root, git = cleanGit) {
  return createCandidateIdentity({ root, git, source: source(root) });
}

test("unified candidate binds git, source, lockfile, and dist", () => {
  fixture((root) => {
    const value = candidate(root);
    assert.equal(value.schemaVersion, CANDIDATE_IDENTITY_SCHEMA_VERSION);
    assert.equal(value.complete, true);
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    assert.equal(value.git.head, cleanGit.head);
    assert.equal(value.source.fileCount, 2);
    assert.match(value.packageLock.sha256, /^[a-f0-9]{64}$/);
    assert.match(value.dist.sha256, /^[a-f0-9]{64}$/);
    assert.equal(candidateIdentityMatches(value, value), true);
  });
});

test("any source, lockfile, dist, or dirty-diff change creates a new candidate", () => {
  fixture((root) => {
    const baseline = candidate(root);

    writeFileSync(join(root, "src", "app.ts"), "export const app = 2;\n");
    const changedSource = candidate(root);
    assert.notEqual(changedSource.sha256, baseline.sha256);

    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":4}\n');
    const changedLock = candidate(root);
    assert.notEqual(changedLock.sha256, changedSource.sha256);

    writeFileSync(join(root, "dist", "index.html"), "<main>two</main>\n");
    const changedDist = candidate(root);
    assert.notEqual(changedDist.sha256, changedLock.sha256);

    const dirty = candidate(root, {
      ...cleanGit,
      clean: false,
      state: "dirty",
      entryCount: 1,
      diffSha256: "b".repeat(64),
    });
    assert.equal(dirty.complete, true);
    assert.equal(dirty.git.clean, false);
    assert.notEqual(dirty.sha256, changedDist.sha256);
  });
});

test("candidate binding rejects evidence from another candidate", () => {
  fixture((root) => {
    const first = candidate(root);
    writeFileSync(join(root, "dist", "index.html"), "<main>stale</main>\n");
    const second = candidate(root);
    assert.equal(candidateIdentityMatches(first, second), false);
    assert.match(
      candidateBindingReasons(first, second, "fixture evidence").join("\n"),
      /different candidate/
    );
  });
});

function fakeChromium(parent) {
  const root = mkdtempSync(join(parent, "music-runtime-identity-"));
  const directory = join(root, "chromium-1234", "chrome-linux64");
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "chrome");
  writeFileSync(executable, "#!/bin/sh\nprintf 'Chromium 149.0.0.0\\n'\n");
  chmodSync(executable, 0o755);
  return { root, executable };
}

test("Node identity is bound to the current executable bytes", () => {
  const identity = createNodeIdentity();
  assert.equal(verifyNodeIdentity(identity).matches, true);
  assert.equal(
    verifyNodeIdentity({ ...identity, executableSha256: "f".repeat(64) })
      .matches,
    false
  );
});

test("only the exact non-temporary Playwright-managed Chromium is automated", () => {
  mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
  const managed = fakeChromium(join(projectRoot, "node_modules"));
  const temporary = fakeChromium(tmpdir());
  try {
    const identity = createChromiumIdentity({
      configuredExecutablePath: managed.executable,
      managedExecutablePath: managed.executable,
      pathSource: "test-managed",
    });
    assert.equal(identity.automatedEligible, true);
    assert.equal(
      verifyChromiumIdentity(identity, {
        managedExecutablePath: managed.executable,
      }).matches,
      true
    );

    const local = createChromiumIdentity({
      configuredExecutablePath: temporary.executable,
      managedExecutablePath: temporary.executable,
      pathSource: "test-temporary",
    });
    assert.equal(local.temporary, true);
    assert.equal(local.automatedEligible, false);

    writeFileSync(
      managed.executable,
      "#!/bin/sh\nprintf 'Chromium 149.0.0.1\\n'\n"
    );
    chmodSync(managed.executable, 0o755);
    const changed = verifyChromiumIdentity(identity, {
      managedExecutablePath: managed.executable,
    });
    assert.equal(changed.matches, false);
    assert.match(changed.failures.join("\n"), /does not match/i);
  } finally {
    rmSync(managed.root, { recursive: true, force: true });
    rmSync(temporary.root, { recursive: true, force: true });
  }
});
