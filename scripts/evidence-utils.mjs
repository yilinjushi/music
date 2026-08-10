import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function filesUnder(directory) {
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) result.push(...filesUnder(path));
    else if (stats.isFile()) result.push(path);
  }
  return result;
}

export function hashDirectory(directory) {
  const files = filesUnder(directory);
  const hash = createHash("sha256");
  let bytes = 0;
  const entries = files.map((path) => {
    const contents = readFileSync(path);
    const file = relative(directory, path).replaceAll("\\", "/");
    const digest = sha256(contents);
    bytes += contents.length;
    hash.update(file);
    hash.update("\0");
    hash.update(digest);
    hash.update("\0");
    return { file, bytes: contents.length, sha256: digest };
  });
  return { files: entries.length, bytes, sha256: hash.digest("hex"), entries };
}

export function npmInvocation(args) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, ...args],
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
  };
}
