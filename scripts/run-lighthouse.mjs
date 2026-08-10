import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import { writePwaReport } from "./verify-pwa.mjs";
import { analyzeSyntheticStaticDelivery } from "./lighthouse-static-delivery.mjs";
import { snapshotDist, snapshotsMatch } from "./lighthouse-dist-snapshot.mjs";
import {
  candidateIdentityMatches,
  createChromiumIdentity,
  createCandidateIdentity,
  createNodeIdentity,
  nodeIdentityMatches,
  verifyChromiumIdentity,
} from "./candidate-identity.mjs";
import { sha256File } from "./evidence-utils.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const outputDir = join(root, "artifacts", "lighthouse");
const releaseRunLock = acquireEvidencePipelineLock(root, "Lighthouse evidence");
process.on("exit", releaseRunLock);
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;
const urls = [`${baseUrl}/search`, `${baseUrl}/settings`];
const runsPerUrl = 3;
const thresholds = {
  performance: 0.85,
  accessibility: 0.95,
  "best-practices": 0.95,
};
const configuredChromePath = process.env.CHROME_PATH;
if (!configuredChromePath) {
  throw new Error(
    "CHROME_PATH is required so Lighthouse evidence identifies the exact browser binary"
  );
}
const browserIdentity = createChromiumIdentity({
  configuredExecutablePath: configuredChromePath,
  pathSource: "CHROME_PATH",
});
const chromeExecutablePath = browserIdentity.executablePath;
const nodeIdentity = createNodeIdentity();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".webmanifest",
]);
const gzipCache = new Map();

function acceptsGzip(header) {
  return header
    .split(",")
    .map((value) => value.trim().split(";"))
    .some(
      ([coding, ...parameters]) =>
        coding?.toLowerCase() === "gzip" &&
        !parameters.some((parameter) =>
          /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter)
        )
    );
}

function indexEntryAssets() {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const assets = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) || []) {
    const source = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
    if (source?.endsWith(".js")) assets.push(source);
    if (href?.endsWith(".css") && rel?.toLowerCase() === "stylesheet") {
      assets.push(href);
    }
  }
  if (!assets.some((asset) => asset.endsWith(".js"))) {
    throw new Error("Built index.html has no JavaScript entry asset");
  }
  return assets;
}

const requiredEntryAssets = indexEntryAssets();

function allAssetsContentHashed(directory = join(dist, "assets")) {
  return readdirSync(directory, { withFileTypes: true }).every((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? allAssetsContentHashed(path)
      : /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(entry.name);
  });
}

const immutableHashedAssets = allAssetsContentHashed();
if (!immutableHashedAssets) {
  throw new Error("dist/assets contains a file without a content hash");
}

function productionHeaders() {
  const lines = readFileSync(join(dist, "_headers"), "utf8").split(/\r?\n/);
  const headers = {};
  let inRoot = false;
  for (const line of lines) {
    if (!/^\s/.test(line) && line.trim()) {
      if (inRoot) break;
      inRoot = line.trim() === "/*";
      continue;
    }
    if (!inRoot) continue;
    const match = line.match(/^\s+([^:]+):\s*(.*)$/);
    if (match) headers[match[1].trim()] = match[2].trim();
  }
  return headers;
}

const securityHeaders = productionHeaders();

function apiResponse(pathname) {
  if (pathname.endsWith("/session/me")) return { authenticated: false };
  if (pathname.endsWith("/toplist")) return { data: { list: [] } };
  if (pathname.endsWith("/playlists")) return { data: { playlists: [] } };
  return { data: {} };
}

function createStaticServer() {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", baseUrl);
    if (requestUrl.pathname.startsWith("/music-api/netease/")) {
      response.writeHead(200, {
        ...securityHeaders,
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(apiResponse(requestUrl.pathname)));
      return;
    }

    let relativePath;
    try {
      relativePath = normalize(decodeURIComponent(requestUrl.pathname)).replace(
        /^(?:\.\.[/\\])+|^[/\\]+/,
        ""
      );
    } catch {
      response.writeHead(400, securityHeaders).end("Bad path");
      return;
    }
    let file = resolve(dist, relativePath || "index.html");
    if (!file.startsWith(`${dist}/`)) {
      response.writeHead(400, securityHeaders).end("Bad path");
      return;
    }

    try {
      if (!statSync(file).isFile()) file = join(dist, "index.html");
    } catch {
      file = join(dist, "index.html");
    }

    const body = readFileSync(file);
    const useGzip =
      acceptsGzip(request.headers["accept-encoding"] || "") &&
      compressibleExtensions.has(extname(file));
    let responseBody = body;
    if (useGzip) {
      responseBody = gzipCache.get(file) || gzipSync(body, { level: 9 });
      gzipCache.set(file, responseBody);
    }
    const isImmutableAsset =
      file.startsWith(`${join(dist, "assets")}${sep}`) &&
      /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(basename(file));
    response.writeHead(200, {
      ...securityHeaders,
      "cache-control": file.endsWith("sw.js")
        ? "no-cache, no-store, must-revalidate"
        : isImmutableAsset
          ? "public, max-age=31536000, immutable"
          : "public, max-age=60",
      ...(compressibleExtensions.has(extname(file))
        ? { vary: "Accept-Encoding" }
        : {}),
      ...(useGzip ? { "content-encoding": "gzip" } : {}),
      "content-length": responseBody.length,
      "content-type": mimeTypes[extname(file)] || "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : responseBody);
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function writeSummary(summary) {
  writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  console.log(JSON.stringify(summary, null, 2));
}

function fileRecord(file) {
  const path = join(root, file);
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`${file} is not a regular file`);
  return {
    file,
    present: true,
    bytes: metadata.size,
    sha256: sha256File(path),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
statSync(join(dist, "index.html"));
const distSnapshotBefore = snapshotDist(dist);
const candidateBefore = createCandidateIdentity({
  root,
  distSnapshot: distSnapshotBefore,
});
if (!candidateBefore.complete) {
  throw new Error(
    `Lighthouse candidate identity is incomplete: ${candidateBefore.errors.join("; ")}`
  );
}

const pwaEquivalent = writePwaReport();
const pwaEvidence = fileRecord("artifacts/pwa-verification.json");
if (!pwaEquivalent.ok) {
  writeSummary({
    schemaVersion: 3,
    ok: false,
    executionEvidenceValid: false,
    releaseGrade: false,
    localOnly: false,
    automatedCandidateEligible: false,
    scope: "synthetic mobile browser checks",
    candidate: candidateBefore,
    browser: browserIdentity,
    node: nodeIdentity,
    error: "PWA artifact-equivalence checks failed",
    pwaEquivalent: { ...pwaEquivalent, report: pwaEvidence },
  });
  process.exit(1);
}

const server = createStaticServer();
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolveListen);
});

const measurements = [];
let runError = null;
const cleanupErrors = [];
let distSnapshotAfter = null;
let candidateAfter = null;
let nodeIdentityAfter = null;
let browserVerification = null;
try {
  for (const url of urls) {
    for (let run = 1; run <= runsPerUrl; run += 1) {
      let runChrome;
      try {
        runChrome = await launch({
          chromePath: chromeExecutablePath,
          chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu"],
        });
        const result = await lighthouse(url, {
          port: runChrome.port,
          output: "json",
          logLevel: "error",
          formFactor: "mobile",
          onlyCategories: Object.keys(thresholds),
          screenEmulation: {
            mobile: true,
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            disabled: false,
          },
        });
        if (!result)
          throw new Error(`Lighthouse returned no result for ${url}`);
        const reportName = `${new URL(url).pathname.slice(1)}-run-${run}.json`;
        const reportFile = `artifacts/lighthouse/${reportName}`;
        const reportBytes =
          typeof result.report === "string"
            ? result.report
            : JSON.stringify(result.lhr);
        writeFileSync(join(outputDir, reportName), reportBytes);
        const runWarnings = result.lhr.runWarnings ?? [];
        if (runWarnings.length > 0) {
          throw new Error(
            `Lighthouse reported run warnings for ${url} run ${run}: ${runWarnings.join(" | ")}`
          );
        }
        if (result.lhr.runtimeError) {
          throw new Error(
            `Lighthouse runtime error for ${url}: ${result.lhr.runtimeError.message}`
          );
        }

        const networkRequests =
          result.lhr.audits["network-requests"]?.details?.items ?? [];
        const loadedApplicationScript = networkRequests.some(
          (request) =>
            typeof request.url === "string" &&
            request.url.startsWith(baseUrl) &&
            request.url.includes("/assets/") &&
            request.url.endsWith(".js") &&
            request.statusCode === 200
        );
        if (!loadedApplicationScript) {
          throw new Error(
            `Lighthouse did not load a production application script for ${url}`
          );
        }
        const syntheticStaticCompression = analyzeSyntheticStaticDelivery({
          networkRequests,
          baseUrl,
          requiredEntryAssets,
        });
        const consoleAudit = result.lhr.audits["errors-in-console"];
        if (consoleAudit && consoleAudit.score !== 1) {
          throw new Error(`Browser console errors were reported for ${url}`);
        }

        const scores = Object.fromEntries(
          Object.keys(thresholds).map((category) => [
            category,
            result.lhr.categories[category]?.score ?? 0,
          ])
        );
        measurements.push({
          url,
          run,
          rawReport: {
            file: reportFile,
            bytes: Buffer.byteLength(reportBytes),
            sha256: sha256(reportBytes),
          },
          scores,
          applicationScriptLoaded: true,
          syntheticStaticCompression: {
            requiredEntryAssets,
            ...syntheticStaticCompression,
          },
          consoleErrors: consoleAudit?.details?.items?.length ?? 0,
          runWarnings,
          chromeUserAgent: result.lhr.environment?.hostUserAgent ?? null,
          lighthouseVersion: result.lhr.lighthouseVersion,
        });
      } finally {
        if (runChrome) {
          try {
            await runChrome.kill();
          } catch (error) {
            cleanupErrors.push(
              `Chrome cleanup failed for ${url} run ${run}: ${error.message}`
            );
          }
        }
      }
    }
  }
} catch (error) {
  runError = error;
} finally {
  try {
    server.closeAllConnections?.();
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  } catch (error) {
    cleanupErrors.push(`Static server cleanup failed: ${error.message}`);
  }
  try {
    distSnapshotAfter = snapshotDist(dist);
    if (!snapshotsMatch(distSnapshotBefore, distSnapshotAfter)) {
      cleanupErrors.push(
        "Production dist changed while Lighthouse measurements were running"
      );
    }
  } catch (error) {
    cleanupErrors.push(`Final dist snapshot failed: ${error.message}`);
  }
  try {
    candidateAfter = createCandidateIdentity({
      root,
      distSnapshot: distSnapshotAfter,
    });
    if (!candidateIdentityMatches(candidateBefore, candidateAfter)) {
      cleanupErrors.push(
        "Git, source, lockfile, or dist candidate changed while Lighthouse measurements were running"
      );
    }
  } catch (error) {
    cleanupErrors.push(`Final candidate snapshot failed: ${error.message}`);
  }
  try {
    nodeIdentityAfter = createNodeIdentity();
    if (!nodeIdentityMatches(nodeIdentity, nodeIdentityAfter)) {
      cleanupErrors.push(
        "Node executable changed while Lighthouse measurements were running"
      );
    }
  } catch (error) {
    cleanupErrors.push(`Final Node identity failed: ${error.message}`);
  }
  browserVerification = verifyChromiumIdentity(browserIdentity);
  if (browserVerification.matches !== true) {
    cleanupErrors.push(
      `Chromium identity changed while Lighthouse measurements were running: ${browserVerification.failures.join("; ")}`
    );
  }
}

if (runError || cleanupErrors.length > 0) {
  const error =
    runError instanceof Error ? runError.message : String(runError ?? "");
  writeSummary({
    schemaVersion: 3,
    ok: false,
    executionEvidenceValid: false,
    releaseGrade: false,
    localOnly: false,
    automatedCandidateEligible: false,
    scope: "synthetic mobile browser checks",
    localQualitySummaryMerged: false,
    error,
    cleanupErrors,
    candidate: candidateBefore,
    candidateAfter,
    candidateStable: candidateIdentityMatches(candidateBefore, candidateAfter),
    browser: browserIdentity,
    browserVerification,
    node: nodeIdentity,
    nodeAfter: nodeIdentityAfter,
    nodeStable: nodeIdentityMatches(nodeIdentity, nodeIdentityAfter),
    distSnapshot: {
      before: distSnapshotBefore,
      after: distSnapshotAfter,
      stable:
        distSnapshotAfter !== null &&
        snapshotsMatch(distSnapshotBefore, distSnapshotAfter),
    },
    measurements,
    pwaEquivalent: {
      ok: true,
      report: pwaEvidence,
      claimBoundary: pwaEquivalent.claimBoundary,
    },
  });
  process.exit(1);
}

const pages = urls.map((url) => {
  const pageRuns = measurements.filter(
    (measurement) => measurement.url === url
  );
  const scores = Object.fromEntries(
    Object.keys(thresholds).map((category) => [
      category,
      median(pageRuns.map((measurement) => measurement.scores[category])),
    ])
  );
  const minimumScores = Object.fromEntries(
    Object.keys(thresholds).map((category) => [
      category,
      Math.min(...pageRuns.map((measurement) => measurement.scores[category])),
    ])
  );
  return { url, scores, minimumScores };
});
const failures = pages.flatMap(({ url, scores, minimumScores }) => [
  ...Object.entries(thresholds)
    .filter(([category, threshold]) => scores[category] < threshold)
    .map(
      ([category, threshold]) =>
        `${url} median ${category} ${scores[category]} is below ${threshold}`
    ),
  ...Object.entries(thresholds)
    .filter(([category, threshold]) => minimumScores[category] < threshold)
    .map(
      ([category, threshold]) =>
        `${url} minimum ${category} ${minimumScores[category]} is below ${threshold}`
    ),
]);
const summary = {
  schemaVersion: 3,
  ok: failures.length === 0,
  executionEvidenceValid: failures.length === 0,
  releaseGrade:
    failures.length === 0 && browserIdentity.automatedEligible === true,
  localOnly:
    failures.length === 0 && browserIdentity.automatedEligible !== true,
  scope: "synthetic mobile browser checks",
  localQualitySummaryMerged: false,
  runsPerUrl,
  thresholds,
  candidate: candidateBefore,
  candidateAfter,
  candidateStable: candidateIdentityMatches(candidateBefore, candidateAfter),
  browser: browserIdentity,
  browserVerification,
  node: nodeIdentity,
  nodeAfter: nodeIdentityAfter,
  nodeStable: nodeIdentityMatches(nodeIdentity, nodeIdentityAfter),
  distSnapshot: {
    fileCount: distSnapshotBefore.fileCount,
    sha256: distSnapshotBefore.sha256,
    stable: true,
    files: distSnapshotBefore.files,
  },
  productionSecurityHeadersApplied: Object.keys(securityHeaders),
  syntheticStaticDelivery: {
    contentEncoding: "gzip",
    immutableHashedAssets,
    productionDeploymentProven: false,
    claimBoundary:
      "This verifies the local Lighthouse server only; deployed HTTPS encoding and caching require separate response-header evidence.",
  },
  pages,
  measurements,
  pwaEquivalent: {
    ok: true,
    report: pwaEvidence,
    claimBoundary: pwaEquivalent.claimBoundary,
  },
  failures,
};
summary.executionEvidenceValid =
  summary.ok &&
  summary.candidateStable &&
  summary.nodeStable &&
  browserVerification?.matches === true;
summary.releaseGrade =
  summary.executionEvidenceValid &&
  browserIdentity.automatedEligible === true &&
  browserVerification?.automatedEligible === true;
summary.localOnly = summary.executionEvidenceValid && !summary.releaseGrade;
summary.automatedCandidateEligible = summary.releaseGrade;
writeSummary(summary);
if (failures.length > 0) process.exit(1);
