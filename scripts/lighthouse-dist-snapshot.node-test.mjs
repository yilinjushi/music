import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotDist, snapshotsMatch } from "./lighthouse-dist-snapshot.mjs";

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "music-lighthouse-dist-"));
  try {
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<main>fixture</main>");
    writeFileSync(join(directory, "assets", "index-12345678.js"), "ok");
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("creates a stable, sorted snapshot for every dist file", () => {
  withFixture((directory) => {
    const first = snapshotDist(directory);
    const second = snapshotDist(directory);
    assert.equal(first.fileCount, 2);
    assert.deepEqual(
      first.files.map(({ file }) => file),
      ["assets/index-12345678.js", "index.html"]
    );
    assert.equal(snapshotsMatch(first, second), true);
  });
});

test("detects content replacement even when the file name is unchanged", () => {
  withFixture((directory) => {
    const before = snapshotDist(directory);
    writeFileSync(join(directory, "index.html"), "<main>changed</main>");
    const after = snapshotDist(directory);
    assert.equal(before.fileCount, after.fileCount);
    assert.equal(snapshotsMatch(before, after), false);
  });
});

test("detects a new or removed production file", () => {
  withFixture((directory) => {
    const before = snapshotDist(directory);
    writeFileSync(join(directory, "manifest.webmanifest"), "{}");
    const after = snapshotDist(directory);
    assert.equal(snapshotsMatch(before, after), false);
  });
});
