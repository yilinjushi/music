import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { projectRoot, sha256 } from "./evidence-utils.mjs";

export const SOURCE_SNAPSHOT_ALGORITHM = "git-source-tree-sha256-v1";

function canonicalRelativePath(file) {
  const normalized = normalize(file).split(sep).join("/");
  if (
    !normalized ||
    isAbsolute(file) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid source snapshot path: ${file}`);
  }
  return normalized;
}

export function snapshotSourceFiles(root, files) {
  const absoluteRoot = resolve(root);
  const entries = [...new Set(files.map(canonicalRelativePath))]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((file) => {
      const absolute = resolve(absoluteRoot, file);
      if (relative(absoluteRoot, absolute).startsWith("..")) {
        throw new Error(`Source snapshot escaped root: ${file}`);
      }
      let metadata;
      try {
        metadata = lstatSync(absolute);
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(`Source snapshot rejects symlink: ${file}`);
      }
      if (!metadata.isFile()) return [];
      const contents = readFileSync(absolute);
      return [
        {
          file,
          bytes: contents.length,
          executable: (metadata.mode & 0o111) !== 0,
          sha256: sha256(contents),
        },
      ];
    });

  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  const digest = createHash("sha256")
    .update(SOURCE_SNAPSHOT_ALGORITHM)
    .update("\0")
    .update(JSON.stringify(entries))
    .digest("hex");
  return {
    algorithm: SOURCE_SNAPSHOT_ALGORITHM,
    fileCount: entries.length,
    bytes,
    sha256: digest,
    entries,
  };
}

export function sourceSnapshotIdentity(snapshot) {
  return {
    algorithm: snapshot.algorithm,
    fileCount: snapshot.fileCount,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
  };
}

export function snapshotSourceTree(root = projectRoot) {
  const output = execFileSync(
    "git",
    [
      "-C",
      resolve(root),
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const files = output.toString("utf8").split("\0").filter(Boolean);
  return snapshotSourceFiles(root, files);
}

export function sourceSnapshotsMatch(left, right) {
  return (
    left?.algorithm === SOURCE_SNAPSHOT_ALGORITHM &&
    right?.algorithm === SOURCE_SNAPSHOT_ALGORITHM &&
    left.fileCount === right.fileCount &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}
