import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INITIALIZATION_GRACE_MS = 30_000;
export const EVIDENCE_PIPELINE_TOKEN_ENV = "MUSIC_EVIDENCE_PIPELINE_LOCK_TOKEN";

function ownerIsAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM still proves that a process owns this PID.
    return true;
  }
}

function readOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

export function exclusiveRunLockIsOwnedBy(
  lockDirectory,
  { pid = process.pid, token } = {}
) {
  const owner = readOwner(lockDirectory);
  return (
    owner?.pid === pid &&
    typeof token === "string" &&
    token.length > 0 &&
    owner.token === token &&
    ownerIsAlive(owner)
  );
}

export function acquireExclusiveRunLock(
  lockDirectory,
  label,
  { reentrantTokenEnvironment = null } = {}
) {
  const inheritedToken = reentrantTokenEnvironment
    ? process.env[reentrantTokenEnvironment]
    : null;
  const token = inheritedToken || randomUUID();
  const create = () => {
    mkdirSync(lockDirectory);
    writeFileSync(
      join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      })}\n`
    );
  };

  let acquired = false;
  for (let attempt = 0; attempt < 4 && !acquired; attempt += 1) {
    try {
      create();
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readOwner(lockDirectory);
      if (
        inheritedToken &&
        owner?.token === inheritedToken &&
        ownerIsAlive(owner)
      ) {
        return () => {};
      }
      if (ownerIsAlive(owner)) {
        throw new Error(
          `${label} is already running (pid ${owner.pid}, started ${owner.startedAt ?? "at an unknown time"})`
        );
      }

      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockDirectory).mtimeMs;
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (owner === null && ageMs < INITIALIZATION_GRACE_MS) {
        throw new Error(`${label} lock is still initializing`);
      }

      // Atomically claim the stale directory before deleting it. A competing
      // recovery can either win this rename or observe the replacement lock,
      // but can never delete a newly acquired lock by path.
      const staleDirectory = `${lockDirectory}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(lockDirectory, staleDirectory);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      rmSync(staleDirectory, { recursive: true, force: true });
    }
  }
  if (!acquired) throw new Error(`${label} lock acquisition did not converge`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const owner = readOwner(lockDirectory);
    if (owner?.pid === process.pid && owner?.token === token) {
      rmSync(lockDirectory, { recursive: true, force: true });
    }
  };
  release.token = token;
  return release;
}

export function evidencePipelineLockPath(root) {
  const checkout = resolve(root);
  const digest = createHash("sha256")
    .update(checkout)
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), `music-evidence-pipeline-${digest}.lock`);
}

export function acquireEvidencePipelineLock(
  root,
  label,
  { allowInheritedToken = false } = {}
) {
  return acquireExclusiveRunLock(evidencePipelineLockPath(root), label, {
    reentrantTokenEnvironment: allowInheritedToken
      ? EVIDENCE_PIPELINE_TOKEN_ENV
      : null,
  });
}
