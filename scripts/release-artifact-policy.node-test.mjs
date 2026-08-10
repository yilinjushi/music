import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findProviderCryptographyArtifacts } from "./release-artifact-policy.mjs";

function fixture(name, contents) {
  const directory = mkdtempSync(join(tmpdir(), "otter-release-policy-"));
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

test("accepts a build without provider cryptography regardless of chunk names", () => {
  const entry = fixture("index-abc12345.js", "const safe = true;");
  const sanitizer = fixture(
    "logger-def67890.js",
    "const sensitiveField = 'redacted';"
  );

  assert.deepEqual(findProviderCryptographyArtifacts([entry, sanitizer]), []);
});

test("rejects provider cryptography even when it is inlined into an unrelated chunk", () => {
  const inlined = fixture(
    "index-abc12345.js",
    "function bundled(){ return 'Encryption block is invalid'; }"
  );

  assert.deepEqual(findProviderCryptographyArtifacts([inlined]), [inlined]);
});

test("rejects provider cryptography in any emitted JavaScript asset", () => {
  const safe = fixture("route-abc12345.js", "export const route = true;");
  const provider = fixture(
    "lazy-def67890.js",
    "const implementation = 'node-forge pkcs1';"
  );

  assert.deepEqual(findProviderCryptographyArtifacts([safe, provider]), [
    provider,
  ]);
});
