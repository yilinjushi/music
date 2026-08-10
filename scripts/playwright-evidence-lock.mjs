import { resolve } from "node:path";
import { projectRoot } from "./evidence-utils.mjs";
import {
  acquireEvidencePipelineLock,
  evidencePipelineLockPath,
  exclusiveRunLockIsOwnedBy,
} from "./exclusive-run-lock.mjs";

const PLAYWRIGHT_LOCK_STATE = Symbol.for(
  "otter-music.playwright-canonical-output-lock"
);

function currentState(processRef) {
  return processRef[PLAYWRIGHT_LOCK_STATE] ?? null;
}

export function acquirePlaywrightRunLock({
  root = projectRoot,
  processRef = process,
} = {}) {
  const normalizedRoot = resolve(root);
  const active = currentState(processRef);
  if (active && !active.released) {
    if (active.root !== normalizedRoot) {
      throw new Error(
        `Playwright canonical output lock already protects ${active.root}`
      );
    }
    return active;
  }

  const releaseExclusiveLock = acquireEvidencePipelineLock(
    normalizedRoot,
    "Playwright canonical output"
  );
  const state = {
    root: normalizedRoot,
    lockDirectory: evidencePipelineLockPath(normalizedRoot),
    pid: process.pid,
    token: releaseExclusiveLock.token,
    released: false,
    releaseOnProcessExit: null,
  };

  const releaseOnProcessExit = () => {
    if (state.released) return;
    releaseExclusiveLock();
    state.released = true;
    if (currentState(processRef) === state) {
      delete processRef[PLAYWRIGHT_LOCK_STATE];
    }
  };
  state.releaseOnProcessExit = releaseOnProcessExit;
  processRef[PLAYWRIGHT_LOCK_STATE] = state;
  processRef.once("exit", releaseOnProcessExit);
  return state;
}

export function assertPlaywrightRunLockHeld({
  root = projectRoot,
  processRef = process,
} = {}) {
  const state = currentState(processRef);
  const normalizedRoot = resolve(root);
  if (
    !state ||
    state.released ||
    state.root !== normalizedRoot ||
    !exclusiveRunLockIsOwnedBy(state.lockDirectory, {
      pid: state.pid,
      token: state.token,
    })
  ) {
    throw new Error(
      "Playwright canonical output write attempted without its live pipeline lock"
    );
  }
  return state;
}

export function withPlaywrightRunLockHeld(callback, options) {
  assertPlaywrightRunLockHeld(options);
  try {
    return callback();
  } finally {
    // The callback is intentionally synchronous: this second ownership check
    // binds the final filesystem write itself, not merely reporter startup.
    assertPlaywrightRunLockHeld(options);
  }
}
