import { readFileSync } from "node:fs";

const PROVIDER_CRYPTOGRAPHY_PATTERN =
  /\b(?:BigInteger|jsbn|pkcs1|node-forge)\b|Encryption block is invalid/i;

/**
 * Provider cryptography belongs on the server. Check every emitted browser
 * JavaScript asset instead of relying on Rollup to preserve a particular
 * source-module chunk name.
 */
export function findProviderCryptographyArtifacts(javascriptFiles) {
  return javascriptFiles.filter((path) =>
    PROVIDER_CRYPTOGRAPHY_PATTERN.test(readFileSync(path, "utf8"))
  );
}
