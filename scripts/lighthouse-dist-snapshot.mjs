import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Bind a Lighthouse run to every byte in the production directory. Symlinks
 * and non-regular entries fail closed so a changing external target cannot be
 * hidden behind an otherwise stable directory listing.
 */
export function snapshotDist(directory) {
  const files = [];

  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const absolute = join(current, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Lighthouse dist snapshot rejects symlink: ${absolute}`
        );
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(
          `Lighthouse dist snapshot rejects non-file entry: ${absolute}`
        );
      }
      const bytes = readFileSync(absolute);
      files.push({
        file: relative(directory, absolute).split(sep).join("/"),
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }

  visit(directory);
  if (files.length === 0) {
    throw new Error("Lighthouse dist snapshot found no production files");
  }

  return {
    fileCount: files.length,
    sha256: sha256(JSON.stringify(files)),
    files,
  };
}

export function snapshotsMatch(before, after) {
  return before.fileCount === after.fileCount && before.sha256 === after.sha256;
}
