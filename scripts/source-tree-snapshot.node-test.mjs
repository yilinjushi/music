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
  snapshotSourceFiles,
  sourceSnapshotIdentity,
  sourceSnapshotsMatch,
} from "./source-tree-snapshot.mjs";

function fixture(run) {
  const first = mkdtempSync(join(tmpdir(), "music-source-first-"));
  const second = mkdtempSync(join(tmpdir(), "music-source-second-"));
  try {
    for (const root of [first, second]) {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "package.json"), '{"private":true}\n');
    }
    return run(first, second);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
}

test("source hash is sorted and independent of the absolute checkout path", () => {
  fixture((first, second) => {
    const left = snapshotSourceFiles(first, ["src/app.ts", "package.json"]);
    const right = snapshotSourceFiles(second, ["package.json", "src/app.ts"]);
    assert.deepEqual(
      sourceSnapshotIdentity(left),
      sourceSnapshotIdentity(right)
    );
    assert.equal(sourceSnapshotsMatch(left, right), true);
  });
});

test("source hash changes for content, path, and executable-bit changes", () => {
  fixture((first) => {
    const baseline = snapshotSourceFiles(first, ["src/app.ts", "package.json"]);
    writeFileSync(join(first, "src", "app.ts"), "export const app = 2;\n");
    const changed = snapshotSourceFiles(first, ["src/app.ts", "package.json"]);
    assert.equal(sourceSnapshotsMatch(baseline, changed), false);

    chmodSync(join(first, "src", "app.ts"), 0o755);
    const executable = snapshotSourceFiles(first, [
      "src/app.ts",
      "package.json",
    ]);
    assert.equal(sourceSnapshotsMatch(changed, executable), false);

    const renamed = snapshotSourceFiles(first, ["package.json"]);
    assert.equal(sourceSnapshotsMatch(executable, renamed), false);
  });
});

test("missing tracked paths are represented by their absence", () => {
  fixture((first) => {
    const snapshot = snapshotSourceFiles(first, ["missing.ts", "package.json"]);
    assert.equal(snapshot.fileCount, 1);
    assert.equal(snapshot.entries[0].file, "package.json");
  });
});
