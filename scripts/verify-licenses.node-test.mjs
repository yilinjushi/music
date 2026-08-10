import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLicenseExpression } from "./verify-licenses.mjs";

test("accepts explicitly allowlisted SPDX expressions", () => {
  assert.equal(evaluateLicenseExpression("MIT").allowed, true);
  assert.equal(
    evaluateLicenseExpression("(BSD-3-Clause OR GPL-2.0)").allowed,
    true
  );
  assert.equal(evaluateLicenseExpression("MIT AND Apache-2.0").allowed, true);
  assert.equal(
    evaluateLicenseExpression("MIT OR (Apache-2.0 AND GPL-3.0-only)").allowed,
    true
  );
});

test("rejects unknown, proprietary, referenced, and copyleft-only licenses", () => {
  for (const license of [
    "",
    "Proprietary",
    "SEE LICENSE IN LICENSE",
    "Unknown-Custom-License",
    "GPL-3.0-only",
    "MIT AND GPL-3.0-only",
    "(MIT OR Apache-2.0) AND GPL-3.0-only",
    "MIT WITH Classpath-exception-2.0",
    "UNLICENSED",
  ]) {
    assert.equal(evaluateLicenseExpression(license).allowed, false, license);
  }
});
