import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
} from "./exclusive-run-lock.mjs";
import {
  PLAYWRIGHT_RUN_LOCK_TOKEN_ENV,
  acquirePlaywrightRunLock,
  assertPlaywrightRunLockHeld,
  withPlaywrightRunLockHeld,
} from "./playwright-evidence-lock.mjs";

test("the outer Playwright lock is inherited, asserted, and released once", () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-outer-lock-"));
  const environment = {};
  try {
    const release = acquirePlaywrightRunLock({ root, environment });
    assert.equal(existsSync(evidencePipelineLockPath(root)), true);
    assert.equal(environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV], release.token);
    assert.deepEqual(assertPlaywrightRunLockHeld({ root, environment }), {
      root,
      token: release.token,
    });
    withPlaywrightRunLockHeld(
      () => {
        assert.throws(
          () => acquireEvidencePipelineLock(root, "competing writer"),
          /already running/
        );
      },
      { root, environment }
    );
    release();
    assert.equal(existsSync(evidencePipelineLockPath(root)), false);
    assert.equal(environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV], undefined);
    assert.throws(
      () => assertPlaywrightRunLockHeld({ root, environment }),
      /without its live outer pipeline lock/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forged or stale inherited token never authorizes reporter writes", () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-forged-lock-"));
  try {
    assert.throws(
      () =>
        assertPlaywrightRunLockHeld({
          root,
          environment: { [PLAYWRIGHT_RUN_LOCK_TOKEN_ENV]: "forged" },
        }),
      /without its live outer pipeline lock/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
