import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "./evidence-utils.mjs";
import {
  EVIDENCE_PIPELINE_TOKEN_ENV,
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
  exclusiveRunLockIsOwnedBy,
} from "./exclusive-run-lock.mjs";

export const PLAYWRIGHT_RUN_LOCK_TOKEN_ENV = "MUSIC_PLAYWRIGHT_RUN_LOCK_TOKEN";

function canonicalRoot(root) {
  return realpathSync.native(resolve(root));
}

export function acquirePlaywrightRunLock({
  root = projectRoot,
  environment = process.env,
} = {}) {
  const normalizedRoot = canonicalRoot(root);
  const releaseExclusiveLock = acquireEvidencePipelineLock(
    normalizedRoot,
    "Playwright canonical output"
  );
  const previousPlaywrightToken = environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV];
  const previousPipelineToken = environment[EVIDENCE_PIPELINE_TOKEN_ENV];
  environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV] = releaseExclusiveLock.token;
  environment[EVIDENCE_PIPELINE_TOKEN_ENV] = releaseExclusiveLock.token;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseExclusiveLock();
    if (previousPlaywrightToken === undefined) {
      delete environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV];
    } else {
      environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV] = previousPlaywrightToken;
    }
    if (previousPipelineToken === undefined) {
      delete environment[EVIDENCE_PIPELINE_TOKEN_ENV];
    } else {
      environment[EVIDENCE_PIPELINE_TOKEN_ENV] = previousPipelineToken;
    }
  };
  release.token = releaseExclusiveLock.token;
  release.root = normalizedRoot;
  release.trackActiveChild = releaseExclusiveLock.trackActiveChild;
  release.untrackActiveChild = releaseExclusiveLock.untrackActiveChild;
  return release;
}

export function assertPlaywrightRunLockHeld({
  root = projectRoot,
  environment = process.env,
} = {}) {
  const normalizedRoot = canonicalRoot(root);
  const token = environment[PLAYWRIGHT_RUN_LOCK_TOKEN_ENV];
  if (
    !exclusiveRunLockIsOwnedBy(evidencePipelineLockPath(normalizedRoot), {
      pid: null,
      token,
    })
  ) {
    throw new Error(
      "Playwright canonical output write attempted without its live outer pipeline lock"
    );
  }
  return { root: normalizedRoot, token };
}

export function withPlaywrightRunLockHeld(callback, options) {
  assertPlaywrightRunLockHeld(options);
  try {
    return callback();
  } finally {
    // Reporter writes are synchronous. Rechecking after the callback proves
    // the outer wrapper still owns the lock at the final filesystem mutation.
    assertPlaywrightRunLockHeld(options);
  }
}
