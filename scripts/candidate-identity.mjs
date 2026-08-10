import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { projectRoot, sha256, sha256File } from "./evidence-utils.mjs";
import {
  snapshotSourceTree,
  sourceSnapshotIdentity,
} from "./source-tree-snapshot.mjs";
import { snapshotDist } from "./lighthouse-dist-snapshot.mjs";

export const CANDIDATE_IDENTITY_SCHEMA_VERSION = 1;
export const GIT_DIFF_ALGORITHM = "git-head-diff-untracked-sha256-v1";
export const BROWSER_IDENTITY_SCHEMA_VERSION = 1;
export const NODE_IDENTITY_SCHEMA_VERSION = 1;

const require = createRequire(import.meta.url);
const playwrightPackage = JSON.parse(
  readFileSync(require.resolve("@playwright/test/package.json"), "utf8")
);

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function playwrightRegistryRoot(executablePath) {
  let current = dirname(resolve(executablePath));
  while (dirname(current) !== current) {
    if (/^(?:chromium|chromium_headless_shell)-\d+$/i.test(basename(current))) {
      return dirname(current);
    }
    current = dirname(current);
  }
  return null;
}

function executableVersion(executablePath) {
  const version = execFileSync(executablePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
  if (!/\b(?:Chromium|Chrome)\b/i.test(version)) {
    throw new Error(`unexpected Chromium version output: ${version}`);
  }
  return version;
}

export function createNodeIdentity() {
  const configuredExecutablePath = resolve(process.execPath);
  const executablePath = realpathSync(configuredExecutablePath);
  const metadata = statSync(executablePath);
  if (!metadata.isFile()) throw new Error("Node executable is not a file");
  accessSync(executablePath, constants.R_OK | constants.X_OK);
  return {
    schemaVersion: NODE_IDENTITY_SCHEMA_VERSION,
    version: process.version,
    configuredExecutablePath,
    executablePath,
    executableBytes: metadata.size,
    executableSha256: sha256File(executablePath),
    platform: process.platform,
    architecture: process.arch,
  };
}

export function nodeIdentityMatches(left, right) {
  return (
    left?.schemaVersion === NODE_IDENTITY_SCHEMA_VERSION &&
    right?.schemaVersion === NODE_IDENTITY_SCHEMA_VERSION &&
    left.version === right.version &&
    left.configuredExecutablePath === right.configuredExecutablePath &&
    left.executablePath === right.executablePath &&
    left.executableBytes === right.executableBytes &&
    left.executableSha256 === right.executableSha256 &&
    left.platform === right.platform &&
    left.architecture === right.architecture
  );
}

export function verifyNodeIdentity(recorded) {
  try {
    const current = createNodeIdentity();
    const matches = nodeIdentityMatches(recorded, current);
    return {
      present: true,
      matches,
      current,
      failures: matches
        ? []
        : ["recorded Node runtime does not match the current executable bytes"],
    };
  } catch (error) {
    return {
      present: false,
      matches: false,
      current: null,
      failures: [
        `current Node runtime could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export function createChromiumIdentity({
  configuredExecutablePath,
  pathSource,
  managedExecutablePath = chromium.executablePath(),
} = {}) {
  if (
    typeof configuredExecutablePath !== "string" ||
    configuredExecutablePath.length === 0
  ) {
    throw new Error("resolved Chromium executable path is missing");
  }
  const configuredPath = resolve(configuredExecutablePath);
  const executablePath = realpathSync(configuredPath);
  const metadata = statSync(executablePath);
  if (!metadata.isFile()) throw new Error("Chromium executable is not a file");
  accessSync(executablePath, constants.R_OK | constants.X_OK);

  const managedConfiguredPath = resolve(managedExecutablePath);
  let managedRealPath = null;
  try {
    managedRealPath = realpathSync(managedConfiguredPath);
  } catch {
    // A custom/local browser can still produce honest local evidence when the
    // Playwright-managed artifact is not installed. It is never automated.
  }
  const registryRoot = playwrightRegistryRoot(
    managedRealPath ?? managedConfiguredPath
  );
  const matchesManagedExecutable =
    managedRealPath !== null && executablePath === managedRealPath;
  const insideManagedRegistry =
    registryRoot !== null && isInside(registryRoot, executablePath);
  const temporary =
    isInside(tmpdir(), executablePath) ||
    (registryRoot !== null && isInside(tmpdir(), registryRoot));
  const automatedEligible =
    matchesManagedExecutable && insideManagedRegistry && !temporary;

  return {
    schemaVersion: BROWSER_IDENTITY_SCHEMA_VERSION,
    name: "chromium",
    version: executableVersion(executablePath),
    versionSource: "executable --version",
    configuredExecutablePath: configuredPath,
    executablePath,
    executableBytes: metadata.size,
    executableSha256: sha256File(executablePath),
    pathSource:
      typeof pathSource === "string" && pathSource.length > 0
        ? pathSource
        : "configuration",
    playwright: {
      package: "@playwright/test",
      version: playwrightPackage.version,
      managedConfiguredExecutablePath: managedConfiguredPath,
      managedExecutablePath: managedRealPath,
      registryRoot,
    },
    matchesManagedExecutable,
    insideManagedRegistry,
    temporary,
    provenance: automatedEligible ? "playwright-managed" : "custom-local",
    automatedEligible,
  };
}

export function verifyChromiumIdentity(
  recorded,
  { managedExecutablePath = chromium.executablePath() } = {}
) {
  if (typeof recorded?.executablePath !== "string") {
    return {
      present: false,
      matches: false,
      automatedEligible: false,
      current: null,
      failures: ["recorded Chromium executable path is missing"],
    };
  }
  if (!existsSync(recorded.executablePath)) {
    return {
      present: false,
      matches: false,
      automatedEligible: false,
      current: null,
      failures: ["recorded Chromium executable no longer exists"],
    };
  }
  try {
    const current = createChromiumIdentity({
      configuredExecutablePath:
        typeof recorded.configuredExecutablePath === "string"
          ? recorded.configuredExecutablePath
          : recorded.executablePath,
      pathSource: recorded.pathSource,
      managedExecutablePath,
    });
    const matches =
      recorded?.schemaVersion === BROWSER_IDENTITY_SCHEMA_VERSION &&
      recorded.name === current.name &&
      recorded.version === current.version &&
      recorded.versionSource === current.versionSource &&
      recorded.configuredExecutablePath === current.configuredExecutablePath &&
      recorded.executablePath === current.executablePath &&
      recorded.executableBytes === current.executableBytes &&
      recorded.executableSha256 === current.executableSha256 &&
      recorded.pathSource === current.pathSource &&
      recorded.playwright?.package === current.playwright.package &&
      recorded.playwright?.version === current.playwright.version &&
      recorded.playwright?.managedConfiguredExecutablePath ===
        current.playwright.managedConfiguredExecutablePath &&
      recorded.playwright?.managedExecutablePath ===
        current.playwright.managedExecutablePath &&
      recorded.playwright?.registryRoot === current.playwright.registryRoot &&
      recorded.matchesManagedExecutable === current.matchesManagedExecutable &&
      recorded.insideManagedRegistry === current.insideManagedRegistry &&
      recorded.temporary === current.temporary &&
      recorded.provenance === current.provenance &&
      recorded.automatedEligible === current.automatedEligible;
    return {
      present: true,
      matches,
      automatedEligible: matches && current.automatedEligible,
      current,
      failures: matches
        ? []
        : [
            "recorded Chromium identity does not match the current binary bytes or provenance",
          ],
    };
  } catch (error) {
    return {
      present: true,
      matches: false,
      automatedEligible: false,
      current: null,
      failures: [
        `current Chromium binary could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function command(root, executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function gitValue(root, args) {
  try {
    return command(root, "git", args);
  } catch {
    return null;
  }
}

export function gitSnapshot(root = projectRoot) {
  const hash = createHash("sha256");
  hash.update(GIT_DIFF_ALGORITHM);
  hash.update("\0");

  let status = null;
  let untracked = null;
  let diffReadable = true;
  try {
    status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    hash.update(status);
    hash.update("\0");
  } catch {
    hash.update("git-status-unavailable\0");
  }

  try {
    const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    hash.update(diff);
    hash.update("\0");
  } catch {
    diffReadable = false;
    hash.update("git-diff-unavailable\0");
  }

  try {
    const raw = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    untracked = raw
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    for (const file of untracked) {
      const path = join(root, file);
      hash.update(file);
      hash.update("\0");
      if (existsSync(path) && lstatSync(path).isFile()) {
        hash.update(readFileSync(path));
      }
      hash.update("\0");
    }
  } catch {
    hash.update("git-untracked-unavailable\0");
  }

  const gitHead = gitValue(root, ["rev-parse", "HEAD"]);
  const branchValue = gitValue(root, ["branch", "--show-current"]);
  const snapshotComplete =
    status !== null &&
    untracked !== null &&
    diffReadable &&
    typeof gitHead === "string" &&
    /^[a-f0-9]{40,64}$/i.test(gitHead);
  const entries =
    status === null ? [] : status.toString("utf8").split("\0").filter(Boolean);
  const clean = snapshotComplete && entries.length === 0;
  return {
    algorithm: GIT_DIFF_ALGORITHM,
    head: gitHead,
    branch: branchValue || null,
    clean,
    state: snapshotComplete ? (clean ? "clean" : "dirty") : "unknown",
    snapshotComplete,
    entryCount: entries.length,
    diffSha256: hash.digest("hex"),
  };
}

function packageLockIdentity(root) {
  const file = "package-lock.json";
  const path = join(root, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { file, present: false, bytes: null, sha256: null };
  }
  return {
    file,
    present: true,
    bytes: statSync(path).size,
    sha256: sha256File(path),
  };
}

export function distSnapshotIdentity(snapshot) {
  if (!snapshot) return null;
  return {
    fileCount: snapshot.fileCount,
    sha256: snapshot.sha256,
  };
}

export function candidateDigestPayload(candidate) {
  return {
    schemaVersion: CANDIDATE_IDENTITY_SCHEMA_VERSION,
    complete: candidate?.complete === true,
    git: {
      algorithm: candidate?.git?.algorithm ?? null,
      head: candidate?.git?.head ?? null,
      branch: candidate?.git?.branch ?? null,
      clean: candidate?.git?.clean === true,
      state: candidate?.git?.state ?? null,
      snapshotComplete: candidate?.git?.snapshotComplete === true,
      entryCount: candidate?.git?.entryCount ?? null,
      diffSha256: candidate?.git?.diffSha256 ?? null,
    },
    source: {
      algorithm: candidate?.source?.algorithm ?? null,
      fileCount: candidate?.source?.fileCount ?? null,
      bytes: candidate?.source?.bytes ?? null,
      sha256: candidate?.source?.sha256 ?? null,
    },
    packageLock: {
      file: candidate?.packageLock?.file ?? null,
      present: candidate?.packageLock?.present === true,
      bytes: candidate?.packageLock?.bytes ?? null,
      sha256: candidate?.packageLock?.sha256 ?? null,
    },
    dist: {
      fileCount: candidate?.dist?.fileCount ?? null,
      sha256: candidate?.dist?.sha256 ?? null,
    },
    errors: Array.isArray(candidate?.errors) ? candidate.errors : null,
  };
}

export function candidateSha256(candidate) {
  return sha256(JSON.stringify(candidateDigestPayload(candidate)));
}

export function createCandidateIdentity({
  root = projectRoot,
  git: gitOverride = null,
  source: sourceOverride = null,
  packageLock: lockOverride = null,
  distSnapshot: distOverride = null,
} = {}) {
  const errors = [];
  let git = gitOverride;
  let source = sourceOverride;
  let distSnapshot = distOverride;

  if (git === null) {
    try {
      git = gitSnapshot(root);
    } catch (error) {
      errors.push(`git snapshot failed: ${error.message}`);
      git = null;
    }
  }
  if (source === null) {
    try {
      source = sourceSnapshotIdentity(snapshotSourceTree(root));
    } catch (error) {
      errors.push(`source snapshot failed: ${error.message}`);
      source = null;
    }
  } else if (Array.isArray(source.entries)) {
    source = sourceSnapshotIdentity(source);
  }

  const packageLock = lockOverride ?? packageLockIdentity(root);
  if (packageLock.present !== true) errors.push("package-lock.json is missing");

  if (distSnapshot === null) {
    try {
      distSnapshot = snapshotDist(join(root, "dist"));
    } catch (error) {
      errors.push(`dist snapshot failed: ${error.message}`);
      distSnapshot = null;
    }
  }
  const dist = distSnapshotIdentity(distSnapshot);

  const complete =
    git?.snapshotComplete === true &&
    typeof source?.sha256 === "string" &&
    packageLock.present === true &&
    typeof packageLock.sha256 === "string" &&
    typeof dist?.sha256 === "string";
  const candidate = {
    schemaVersion: CANDIDATE_IDENTITY_SCHEMA_VERSION,
    complete,
    git,
    source,
    packageLock,
    dist,
    errors,
  };
  return { ...candidate, sha256: candidateSha256(candidate) };
}

export function candidateIdentityMatches(left, right) {
  return (
    left?.schemaVersion === CANDIDATE_IDENTITY_SCHEMA_VERSION &&
    right?.schemaVersion === CANDIDATE_IDENTITY_SCHEMA_VERSION &&
    left?.complete === true &&
    right?.complete === true &&
    left.sha256 === candidateSha256(left) &&
    right.sha256 === candidateSha256(right) &&
    left.sha256 === right.sha256
  );
}

export function candidateBindingReasons(value, current, label) {
  if (current?.complete !== true) {
    return ["current candidate identity is incomplete"];
  }
  if (value?.complete !== true || value?.sha256 !== candidateSha256(value)) {
    return [`${label} contains an invalid or incomplete candidate identity`];
  }
  return candidateIdentityMatches(value, current)
    ? []
    : [`${label} belongs to a different candidate`];
}
