import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  filesUnder,
  projectRoot,
  sha256,
  writeJson,
} from "./evidence-utils.mjs";
import {
  candidateIdentityMatches,
  createCandidateIdentity,
  createNodeIdentity,
  nodeIdentityMatches,
} from "./candidate-identity.mjs";
import { findProviderCryptographyArtifacts } from "./release-artifact-policy.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";

const releasePipelineLock = acquireEvidencePipelineLock(
  projectRoot,
  "Release policy evidence",
  { allowInheritedToken: true }
);
process.on("exit", releasePipelineLock);

const distRoot = join(projectRoot, "dist");
const failures = [];
const findings = [];
const candidateBefore = createCandidateIdentity({ root: projectRoot });
const nodeBefore = createNodeIdentity();
if (!candidateBefore.complete) {
  failures.push(
    `initial release candidate identity is incomplete: ${candidateBefore.errors.join("; ")}`
  );
}

for (const forbiddenPath of [
  "android",
  "capacitor.config.ts",
  ".github/workflows/release-mobile.yml",
  "public/release",
]) {
  const path = join(projectRoot, forbiddenPath);
  const containsReleaseMaterial =
    existsSync(path) &&
    (!statSync(path).isDirectory() || filesUnder(path).length > 0);
  if (containsReleaseMaterial) {
    failures.push(`retired native/release path exists: ${forbiddenPath}`);
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function runtimeFiles(root) {
  return filesUnder(root).filter((path) => {
    const rel = relative(projectRoot, path).replaceAll("\\", "/");
    return (
      [".ts", ".tsx", ".js", ".jsx", ".json", ".html"].includes(
        extname(path)
      ) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel) &&
      !rel.includes("/test/") &&
      !rel.endsWith(".d.ts")
    );
  });
}

const browserSourceFiles = [
  ...runtimeFiles(join(projectRoot, "src")),
  ...runtimeFiles(join(projectRoot, "shared", "src")),
  join(projectRoot, "vite.config.ts"),
  join(projectRoot, "pwa.config.ts"),
  join(projectRoot, "index.html"),
];
const functionSourceFiles = runtimeFiles(join(projectRoot, "functions"));
const runtimeSourceFiles = [...browserSourceFiles, ...functionSourceFiles];

// The shared root barrel also exports provider crypto helpers. Importing one
// of the small canonical-sensitive-field helpers through that barrel once
// pulled node-forge and the complete provider graph into the browser bootstrap.
// Keep every runtime consumer on the dependency-free narrow entrypoint.
for (const path of runtimeSourceFiles) {
  const rel = relative(projectRoot, path).replaceAll("\\", "/");
  const contents = readFileSync(path, "utf8");
  if (
    /\b(?:classifyCanonicalSensitiveAssignments|containsCanonicalSensitiveAssignment|isCanonicalCapabilityFieldName|isCanonicalSensitiveFieldName|sensitiveDecodeVariants)\b/.test(
      contents
    ) &&
    /from\s+["']@otter-music\/shared["']/.test(contents)
  ) {
    failures.push(
      `runtime source ${rel} must import canonical sensitive helpers from @shared/utils/sensitive-fields`
    );
  }
}

const consoleAllowlist = new Set([
  "src/lib/logger.ts",
  "functions/utils/security-logger.ts",
]);
for (const path of runtimeSourceFiles) {
  const rel = relative(projectRoot, path).replaceAll("\\", "/");
  if (consoleAllowlist.has(rel)) continue;
  const contents = readFileSync(path, "utf8");
  const directConsoleCalls = contents.matchAll(
    /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g
  );
  for (const occurrence of directConsoleCalls) {
    const number = contents.slice(0, occurrence.index).split(/\r?\n/).length;
    failures.push(
      `runtime source ${rel}:${number} bypasses the approved sanitized logger`
    );
  }
}

function scanFiles(files, policies, scope) {
  for (const path of files) {
    const rel = relative(projectRoot, path).replaceAll("\\", "/");
    const contents = `${rel}\n${readFileSync(path, "utf8")}`;
    for (const [label, pattern] of policies) {
      if (pattern.test(contents)) {
        const finding = `${scope} ${rel} contains ${label}`;
        findings.push(finding);
        failures.push(finding);
      }
    }
  }
}

const retiredRuntimePolicies = [
  [
    "Capacitor/native runtime",
    /@capacitor\/|capacitor-(?:android|core|cli)|\bCapacitor(?:Plugin|Bridge|\.isNativePlatform)/i,
  ],
  [
    "APK/AAB build or updater",
    /\.(?:apk|aab)\b|assembleRelease|release-mobile\.ya?ml|\/update\/(?:check|download)/i,
  ],
  [
    "retired Podcast feature",
    /\bpodcast(?:-api|Routes?|Store|Provider|Player)?\b|\/podcast\//i,
  ],
  [
    "retired RSS relay",
    /\b(?:rssRoutes|streamParseRss|RSS_FETCH_TIMEOUT_MS)\b|utils\/rss/i,
  ],
  [
    "retired AList feature",
    /\balist(?:-api|Store|Provider|Browser)?\b|\/alist\//i,
  ],
  [
    "retired Apple Music importer",
    /\bapple[ -]?music\b|music\.apple\.com|apple-playlist-importer/i,
  ],
];
const trackingPolicies = [
  [
    "Google Analytics/Tag Manager",
    /google-analytics\.com|googletagmanager\.com|\bgtag\s*\(/i,
  ],
  [
    "advertising network",
    /doubleclick\.net|adservice\.google\.|googleads\.|adsystem\./i,
  ],
  ["PostHog", /posthog(?:\.com|\.capture|\.init)/i],
  ["Sentry telemetry endpoint", /(?:https?:\/\/[^\s"']+)?sentry\.io/i],
  ["Mixpanel", /mixpanel(?:\.com|\.track|\.init)/i],
  ["Amplitude analytics", /amplitude(?:\.com|\.track|\.init)/i],
  ["Segment analytics", /segment\.com|analytics\.js/i],
];

scanFiles(runtimeSourceFiles, retiredRuntimePolicies, "runtime source");
scanFiles(runtimeSourceFiles, trackingPolicies, "runtime source");
const credentialImplementationAllowlist = new Set([
  "shared/src/utils/music/netease-api.ts",
]);
scanFiles(
  browserSourceFiles.filter(
    (path) =>
      !credentialImplementationAllowlist.has(
        relative(projectRoot, path).replaceAll("\\", "/")
      )
  ),
  [
    ["NetEase credential marker", /\bMUSIC_U\b/i],
    ["legacy credential forwarding header", /x-real-cookie/i],
  ],
  "browser source"
);

const serverCredentialOccurrences = [
  ...functionSourceFiles,
  ...browserSourceFiles,
]
  .filter((path) =>
    /\bMUSIC_U\b|x-real-cookie/i.test(readFileSync(path, "utf8"))
  )
  .map((path) => relative(projectRoot, path).replaceAll("\\", "/"));
for (const path of serverCredentialOccurrences) {
  assert(
    path.startsWith("functions/") ||
      credentialImplementationAllowlist.has(path),
    `credential implementation marker is outside the server allowlist: ${path}`
  );
}

const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8")
);
const declaredPackages = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
};
for (const name of Object.keys(declaredPackages)) {
  for (const [label, pattern] of retiredRuntimePolicies) {
    if (pattern.test(name))
      failures.push(`package.json dependency ${name} contains ${label}`);
  }
}

const lock = JSON.parse(
  readFileSync(join(projectRoot, "package-lock.json"), "utf8")
);
const productionPackages = [];
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || metadata.dev === true || metadata.link === true) continue;
  if (path === "functions" || path === "shared") continue;
  const name = path.replace(/^.*node_modules\//, "");
  productionPackages.push({ name, version: metadata.version ?? null, path });
}
const forbiddenProductionDependencies = [
  /^(?:@capacitor\/|capacitor-)/i,
  /^(?:@sentry\/|sentry$)/i,
  /^(?:@amplitude\/|amplitude(?:-js)?$)/i,
  /^(?:@segment\/analytics|analytics-node$|analytics-browser$)/i,
  /^(?:posthog|posthog-js|mixpanel|react-ga|react-ga4|google-analytics|firebase-analytics)$/i,
  /^(?:admob|adsense|doubleclick|plausible-tracker|matomo-tracker|umami)$/i,
  /(?:^|[-/])(?:podcast|alist|apple-music)(?:$|[-/])/i,
];
for (const dependency of productionPackages) {
  if (
    forbiddenProductionDependencies.some((pattern) =>
      pattern.test(dependency.name)
    )
  ) {
    failures.push(
      `production dependency is forbidden: ${dependency.name}@${dependency.version}`
    );
  }
}

let distFiles = [];
try {
  distFiles = filesUnder(distRoot);
} catch {
  failures.push("dist/ does not exist; run npm run build first");
}
const distTextFiles = distFiles.filter((path) =>
  [".js", ".css", ".html", ".json", ".webmanifest", ".md", ""].includes(
    extname(path)
  )
);

const distJavascriptFiles = distFiles.filter((path) => extname(path) === ".js");
for (const path of findProviderCryptographyArtifacts(distJavascriptFiles)) {
  failures.push(
    `production artifact contains provider cryptography: ${relative(
      distRoot,
      path
    ).replaceAll("\\", "/")}`
  );
}
scanFiles(
  distTextFiles,
  [
    ...retiredRuntimePolicies,
    ...trackingPolicies,
    ["NetEase credential marker", /\bMUSIC_U\b/i],
    ["legacy credential forwarding header", /x-real-cookie/i],
  ],
  "production artifact"
);

function rootHeaders(contents) {
  const result = new Map();
  const lines = contents.split(/\r?\n/);
  let inRoot = false;
  for (const line of lines) {
    if (!/^\s/.test(line) && line.trim()) {
      if (inRoot) break;
      inRoot = line.trim() === "/*";
      continue;
    }
    if (!inRoot) continue;
    const match = line.match(/^\s+([^:]+):\s*(.*)$/);
    if (match) result.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return result;
}

function verifySecurityHeaders() {
  let contents;
  try {
    contents = readFileSync(join(distRoot, "_headers"), "utf8");
  } catch {
    failures.push("dist/_headers is missing");
    return;
  }
  const headers = rootHeaders(contents);
  assert(
    /\/assets\/\*\s*\r?\n\s+Cache-Control:\s*public,\s*max-age=31536000,\s*immutable\s*(?:\r?\n|$)/i.test(
      contents
    ),
    "_headers must give hashed /assets/* a one-year immutable cache policy"
  );
  const csp = headers.get("content-security-policy") ?? "";
  const directives = new Map();
  for (const part of csp
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [rawName, ...sources] = part.split(/\s+/);
    const name = rawName.toLowerCase();
    assert(!directives.has(name), `CSP contains a duplicate ${name} directive`);
    if (!directives.has(name)) directives.set(name, sources);
  }
  const exact = new Map([
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["font-src", ["'self'", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
  ]);
  for (const [name, expected] of exact) {
    assert(
      JSON.stringify(directives.get(name)) === JSON.stringify(expected),
      `CSP ${name} must be exactly ${expected.join(" ")}`
    );
  }
  for (const name of ["img-src", "media-src", "connect-src"]) {
    const sources = directives.get(name);
    assert(Boolean(sources?.length), `CSP is missing ${name}`);
    for (const source of sources ?? []) {
      assert(
        source !== "*" &&
          !source.includes("unsafe-") &&
          !source.startsWith("http://") &&
          !(
            /^[a-z][a-z0-9+.-]*:$/i.test(source) &&
            source !== "data:" &&
            source !== "blob:"
          ),
        `CSP ${name} contains an unsafe broad source: ${source}`
      );
    }
  }
  const requiredFlexibleSources = new Map([
    ["img-src", ["'self'", "data:", "blob:"]],
    ["media-src", ["'self'", "blob:"]],
    ["connect-src", ["'self'", "blob:"]],
  ]);
  for (const [name, required] of requiredFlexibleSources) {
    for (const source of required) {
      assert(
        (directives.get(name) ?? []).includes(source),
        `CSP ${name} must include ${source}`
      );
    }
  }
  assert(
    directives.has("upgrade-insecure-requests") &&
      directives.get("upgrade-insecure-requests").length === 0,
    "CSP must include an empty upgrade-insecure-requests directive"
  );
  assert(
    !(directives.get("style-src") ?? []).includes("'unsafe-eval'"),
    "CSP style-src must not allow unsafe-eval"
  );

  const hsts = headers.get("strict-transport-security") ?? "";
  const maxAge = Number(hsts.match(/(?:^|;)\s*max-age=(\d+)/i)?.[1] ?? 0);
  assert(maxAge >= 31536000, "HSTS max-age must be at least 31536000 seconds");
  assert(
    /(?:^|;)\s*includeSubDomains(?:;|$)/i.test(hsts),
    "HSTS must include subdomains"
  );
  assert(
    headers.get("x-content-type-options") === "nosniff",
    "X-Content-Type-Options must be nosniff"
  );
  assert(
    headers.get("x-frame-options") === "DENY",
    "X-Frame-Options must be DENY"
  );
  assert(
    headers.get("referrer-policy") === "no-referrer",
    "Referrer-Policy must be no-referrer"
  );

  const permissions = (headers.get("permissions-policy") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const requiredPermissions = [
    "camera",
    "microphone",
    "geolocation",
    "payment",
    "usb",
  ];
  assert(
    permissions.every((part) => /^[a-z-]+=\(\)$/.test(part)),
    "Permissions-Policy entries must all deny access with ()"
  );
  for (const feature of requiredPermissions) {
    assert(
      permissions.includes(`${feature}=()`),
      `Permissions-Policy must deny ${feature}`
    );
  }
}

verifySecurityHeaders();

for (const path of distFiles.filter((path) =>
  relative(distRoot, path).replaceAll("\\", "/").startsWith("assets/")
)) {
  assert(
    /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(basename(path)),
    `dist asset is not content-hashed but would receive immutable caching: ${relative(
      distRoot,
      path
    ).replaceAll("\\", "/")}`
  );
}

const javascriptBytes = distJavascriptFiles.reduce(
  (total, path) => total + statSync(path).size,
  0
);
assert(
  javascriptBytes <= 4 * 1024 * 1024,
  `uncompressed JavaScript exceeds 4 MiB (${javascriptBytes} bytes)`
);

const runtimeSourceSha256 = sha256(
  runtimeSourceFiles
    .map((path) => `${relative(projectRoot, path)}\0${readFileSync(path)}`)
    .join("\0")
);
const candidateAfter = createCandidateIdentity({ root: projectRoot });
const nodeAfter = createNodeIdentity();
const candidateStable = candidateIdentityMatches(
  candidateBefore,
  candidateAfter
);
const nodeStable = nodeIdentityMatches(nodeBefore, nodeAfter);
if (!candidateAfter.complete) {
  failures.push(
    `final release candidate identity is incomplete: ${candidateAfter.errors.join("; ")}`
  );
}
if (!candidateStable) {
  failures.push(
    "git, source, package lock, or dist changed while release policy verification was running"
  );
}
if (!nodeStable) {
  failures.push(
    "Node executable identity changed while release policy verification was running"
  );
}
const report = {
  schemaVersion: 2,
  ok: failures.length === 0,
  candidate: candidateAfter,
  candidateWindow: {
    before: candidateBefore,
    after: candidateAfter,
    stable: candidateStable,
    distStable:
      candidateBefore.dist?.sha256 === candidateAfter.dist?.sha256 &&
      candidateBefore.dist?.fileCount === candidateAfter.dist?.fileCount,
  },
  node: {
    before: nodeBefore,
    after: nodeAfter,
    stable: nodeStable,
  },
  scopes: {
    runtimeSourceFiles: runtimeSourceFiles.length,
    browserSourceFiles: browserSourceFiles.length,
    functionSourceFiles: functionSourceFiles.length,
    productionDependencies: productionPackages.length,
    distFiles: distFiles.length,
  },
  // This public source digest is the unified all-source candidate snapshot;
  // the narrower runtime-only scan remains separately named for diagnostics.
  sourceSha256: candidateAfter.source?.sha256 ?? null,
  runtimeSourceSha256,
  serverCredentialMarkerFiles: serverCredentialOccurrences,
  javascriptBytes,
  findings,
  failures,
};
writeJson(join(projectRoot, "artifacts", "release-verification.json"), report);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
