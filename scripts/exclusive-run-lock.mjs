import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INITIALIZATION_GRACE_MS = 30_000;
export const EVIDENCE_PIPELINE_TOKEN_ENV = "MUSIC_EVIDENCE_PIPELINE_LOCK_TOKEN";

function linuxProcessIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    return {
      platform: "linux",
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      startTimeTicks: fields[19],
    };
  } catch (error) {
    // This helper is called only after kill(pid, 0) proved that the PID is
    // live. /proc can still be hidden by a container/PID namespace, so every
    // read failure is "identity unavailable", never proof of process death.
    return null;
  }
}

function processIdentity(pid = process.pid) {
  return (
    linuxProcessIdentity(pid) || {
      platform: process.platform,
      pidReuseGuard: "unavailable",
    }
  );
}

function processIsAlive(owner) {
  const pid = typeof owner === "number" ? owner : owner?.pid;
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM proves that a process owns this PID. Other inspection failures are
    // also fail-closed: an unverifiable owner must never be deleted as stale.
    if (error?.code !== "EPERM") return true;
  }
  if (
    owner?.processIdentity?.platform === "linux" &&
    typeof owner.processIdentity.bootId === "string" &&
    typeof owner.processIdentity.startTimeTicks === "string"
  ) {
    const current = linuxProcessIdentity(pid);
    if (current === null) return true;
    return (
      current.bootId === owner.processIdentity.bootId &&
      current.startTimeTicks === owner.processIdentity.startTimeTicks
    );
  }
  return true;
}

function ownerIsAlive(owner) {
  return (
    processIsAlive(owner) ||
    owner?.activeChildren?.some((child) => processIsAlive(child)) === true
  );
}

function readOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeOwnerAtomically(lockDirectory, owner) {
  const temporary = join(
    lockDirectory,
    `.owner-${process.pid}-${randomUUID()}.json`
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(owner)}\n`);
    renameSync(temporary, join(lockDirectory, "owner.json"));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readLockSnapshot(lockDirectory) {
  const stats = statSync(lockDirectory);
  let rawOwner = null;
  try {
    rawOwner = readFileSync(join(lockDirectory, "owner.json"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let owner = null;
  try {
    owner = rawOwner === null ? null : JSON.parse(rawOwner);
  } catch {
    owner = null;
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        rawOwner,
        device: stats.dev.toString(),
        inode: stats.ino.toString(),
        birthtimeMs: stats.birthtimeMs,
      })
    )
    .digest("hex");
  return { owner, fingerprint, ageMs: Date.now() - stats.mtimeMs };
}

function acquireRecoveryMarker(lockDirectory, fingerprint, label) {
  const markerDirectory = join(lockDirectory, `.recovery-${fingerprint}`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(markerDirectory);
      writeOwnerAtomically(markerDirectory, {
        pid: process.pid,
        processIdentity: processIdentity(),
        token,
        startedAt: new Date().toISOString(),
      });
      return {
        markerDirectory,
        token,
        release() {
          const markerOwner = readOwner(markerDirectory);
          if (
            markerOwner?.pid === process.pid &&
            markerOwner?.token === token
          ) {
            rmSync(markerDirectory, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const marker = readLockSnapshot(markerDirectory);
      if (ownerIsAlive(marker.owner)) {
        throw new Error(`${label} stale-lock recovery is already running`);
      }
      if (marker.owner === null && marker.ageMs < INITIALIZATION_GRACE_MS) {
        throw new Error(`${label} stale-lock recovery is still initializing`);
      }
      const parked = `${markerDirectory}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(markerDirectory, parked);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      const claimed = readLockSnapshot(parked);
      if (claimed.fingerprint !== marker.fingerprint) {
        try {
          renameSync(parked, markerDirectory);
        } catch {
          // Keep both directories as fail-closed forensic state rather than
          // deleting a recovery marker whose ownership changed mid-claim.
        }
        throw new Error(`${label} stale-lock recovery ownership changed`);
      }
      rmSync(parked, { recursive: true, force: true });
    }
  }
  throw new Error(`${label} stale-lock recovery did not converge`);
}

function createLockHandle(
  lockDirectory,
  token,
  { ownsDirectory, trackCurrentProcess = false }
) {
  let released = false;
  let selfLease = null;
  const updateOwner = (update) => {
    if (released) throw new Error("cannot update a released run lock");
    const owner = readOwner(lockDirectory);
    if (owner?.token !== token || !ownerIsAlive(owner)) {
      throw new Error(
        `run lock ownership changed before child update (tokenMatch=${owner?.token === token}, ownerAlive=${ownerIsAlive(owner)})`
      );
    }
    const updated = update(owner);
    writeOwnerAtomically(lockDirectory, updated);
    return updated;
  };

  const release = () => {
    if (released) return;
    if (selfLease) {
      updateOwner((owner) => ({
        ...owner,
        activeChildren: (owner.activeChildren ?? []).filter(
          (candidate) =>
            candidate?.pid !== selfLease.pid ||
            candidate?.nonce !== selfLease.nonce
        ),
      }));
      selfLease = null;
    }
    released = true;
    if (!ownsDirectory) return;
    const owner = readOwner(lockDirectory);
    if (owner?.pid !== process.pid || owner?.token !== token) return;

    // A nested build can outlive the process that originally acquired the
    // pipeline lock (for example, if that process receives SIGKILL). Keep the
    // directory until every recorded child is dead so a new writer cannot
    // mistake an orphaned dist writer for a stale lock.
    const liveChild = owner.activeChildren?.some((child) =>
      processIsAlive(child)
    );
    if (!liveChild) rmSync(lockDirectory, { recursive: true, force: true });
  };
  release.token = token;
  release.trackActiveChild = (pid) => {
    if (!processIsAlive(pid)) {
      throw new Error(`cannot track inactive child pid ${pid}`);
    }
    const child = {
      pid,
      processIdentity: processIdentity(pid),
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    updateOwner((owner) => ({
      ...owner,
      activeChildren: [...(owner.activeChildren ?? []), child],
    }));
    return child;
  };
  release.untrackActiveChild = (child) => {
    let removed = false;
    updateOwner((owner) => ({
      ...owner,
      activeChildren: (owner.activeChildren ?? []).filter((candidate) => {
        const matches =
          candidate?.pid === child?.pid && candidate?.nonce === child?.nonce;
        if (matches) removed = true;
        return !matches;
      }),
    }));
    return removed;
  };
  if (trackCurrentProcess) {
    selfLease = release.trackActiveChild(process.pid);
  }
  return release;
}

export function exclusiveRunLockIsOwnedBy(
  lockDirectory,
  { pid = process.pid, token } = {}
) {
  const owner = readOwner(lockDirectory);
  return (
    (pid === null || owner?.pid === pid) &&
    typeof token === "string" &&
    token.length > 0 &&
    owner?.token === token &&
    ownerIsAlive(owner)
  );
}

export function acquireExclusiveRunLock(
  lockDirectory,
  label,
  { reentrantTokenEnvironment = null, recoveryHooks = null } = {}
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
        processIdentity: processIdentity(),
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
      const snapshot = readLockSnapshot(lockDirectory);
      const owner = snapshot.owner;
      if (
        inheritedToken &&
        owner?.token === inheritedToken &&
        ownerIsAlive(owner)
      ) {
        return createLockHandle(lockDirectory, inheritedToken, {
          ownsDirectory: false,
          trackCurrentProcess: true,
        });
      }
      if (ownerIsAlive(owner)) {
        throw new Error(
          `${label} is already running (pid ${owner.pid}, started ${owner.startedAt ?? "at an unknown time"})`
        );
      }

      if (owner === null && snapshot.ageMs < INITIALIZATION_GRACE_MS) {
        throw new Error(`${label} lock is still initializing`);
      }

      // The primary directory never disappears during recovery. Contenders for
      // this exact owner snapshot serialize through a fingerprinted marker,
      // then revalidate before atomically replacing owner.json. Consequently a
      // delayed stale recovery can neither rename nor delete a replacement
      // owner's live lock (the classic path-based ABA race).
      const marker = acquireRecoveryMarker(
        lockDirectory,
        snapshot.fingerprint,
        label
      );
      try {
        recoveryHooks?.afterMarkerAcquired?.({
          lockDirectory,
          markerDirectory: marker.markerDirectory,
          snapshot,
        });
        const current = readLockSnapshot(lockDirectory);
        if (current.fingerprint !== snapshot.fingerprint) continue;
        writeOwnerAtomically(lockDirectory, {
          pid: process.pid,
          processIdentity: processIdentity(),
          token,
          startedAt: new Date().toISOString(),
        });
        acquired = true;
      } finally {
        marker.release();
      }
    }
  }
  if (!acquired) throw new Error(`${label} lock acquisition did not converge`);

  return createLockHandle(lockDirectory, token, { ownsDirectory: true });
}

export function evidencePipelineLockPath(root) {
  const checkout = realpathSync.native(resolve(root));
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
