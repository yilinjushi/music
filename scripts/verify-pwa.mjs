import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";
import { filesUnder, projectRoot, writeJson } from "./evidence-utils.mjs";

function pngDimensions(path) {
  const bytes = readFileSync(path);
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  ) {
    throw new Error(`${path} is not a complete PNG header`);
  }
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`${path} does not start with a PNG IHDR chunk`);
  }
  if (!bytes.includes(Buffer.from("IEND"))) {
    throw new Error(`${path} has no PNG IEND chunk`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function verifyPwaArtifacts(distRoot = join(projectRoot, "dist")) {
  const failures = [];
  const checks = {};
  const assert = (condition, message) => {
    if (!condition) failures.push(message);
    return Boolean(condition);
  };

  let manifest;
  let index = "";
  let serviceWorker = "";
  let headers = "";
  try {
    manifest = JSON.parse(
      readFileSync(join(distRoot, "manifest.webmanifest"), "utf8")
    );
    index = readFileSync(join(distRoot, "index.html"), "utf8");
    serviceWorker = readFileSync(join(distRoot, "sw.js"), "utf8");
    headers = readFileSync(join(distRoot, "_headers"), "utf8");
  } catch (error) {
    failures.push(
      `required PWA artifact is missing or invalid: ${error.message}`
    );
    return {
      ok: false,
      scope: "static production PWA equivalence checks",
      failures,
      checks,
    };
  }

  checks.identity = [
    assert(manifest.id === "/", "manifest id must be /"),
    assert(manifest.start_url === "/", "manifest start_url must be /"),
    assert(manifest.scope === "/", "manifest scope must be /"),
    assert(
      manifest.display === "standalone",
      "manifest display must be standalone"
    ),
    assert(
      typeof manifest.name === "string" && manifest.name.trim(),
      "manifest needs a name"
    ),
    assert(
      typeof manifest.short_name === "string" && manifest.short_name.trim(),
      "manifest needs a short_name"
    ),
    assert(
      /^#[0-9a-f]{6}$/i.test(manifest.theme_color),
      "manifest needs a hex theme_color"
    ),
    assert(
      /^#[0-9a-f]{6}$/i.test(manifest.background_color),
      "manifest needs a hex background_color"
    ),
  ].every(Boolean);

  const requiredIcons = new Map([
    ["192x192:any", 192],
    ["512x512:any", 512],
    ["512x512:maskable", 512],
  ]);
  for (const icon of manifest.icons ?? []) {
    for (const purpose of String(icon.purpose || "any").split(/\s+/)) {
      const key = `${icon.sizes}:${purpose}`;
      if (!requiredIcons.has(key)) continue;
      const size = requiredIcons.get(key);
      const iconPath = join(distRoot, String(icon.src).replace(/^\/+/, ""));
      try {
        const dimensions = pngDimensions(iconPath);
        assert(
          dimensions.width === size && dimensions.height === size,
          `${icon.src} must be ${size}x${size}`
        );
        assert(
          statSync(iconPath).size >= 256,
          `${icon.src} is implausibly small`
        );
        requiredIcons.delete(key);
      } catch (error) {
        failures.push(error.message);
      }
    }
  }
  checks.icons = assert(
    requiredIcons.size === 0,
    `manifest is missing icons: ${[...requiredIcons.keys()].join(", ")}`
  );

  const viewport = index.match(
    /<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i
  )?.[1];
  checks.document = [
    assert(
      /<link[^>]+rel=["']manifest["'][^>]+manifest\.webmanifest/i.test(index),
      "index must link the manifest"
    ),
    assert(Boolean(viewport), "index must define a viewport meta tag"),
    assert(
      !/maximum-scale|user-scalable\s*=\s*no/i.test(viewport ?? ""),
      "viewport must preserve zoom"
    ),
    assert(
      /name=["']theme-color["']/i.test(index),
      "index must declare theme-color"
    ),
  ].every(Boolean);

  const javascript = filesUnder(distRoot)
    .filter((path) => extname(path) === ".js")
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  checks.serviceWorker = [
    assert(serviceWorker.length > 1000, "sw.js is implausibly small"),
    assert(
      serviceWorker.includes("index.html"),
      "sw.js must precache the application shell"
    ),
    assert(
      serviceWorker.includes("SKIP_WAITING"),
      "sw.js must support user-confirmed activation"
    ),
    assert(
      serviceWorker.includes("music-api"),
      "sw.js must exclude API routes from navigation fallback"
    ),
    assert(
      javascript.includes('"/sw.js"'),
      "the production client must register /sw.js"
    ),
    assert(
      /\/sw\.js\s*\n\s*Cache-Control:\s*[^\n]*no-cache[^\n]*no-store/i.test(
        headers
      ),
      "_headers must prevent caching sw.js"
    ),
  ].every(Boolean);

  checks.offlineDeepLinkContract =
    checks.serviceWorker && serviceWorker.includes("index.html");
  checks.installabilityEquivalent =
    checks.identity && checks.icons && checks.document && checks.serviceWorker;

  return {
    ok: failures.length === 0,
    scope: "static production PWA equivalence checks",
    claimBoundary:
      "These checks replace the removed Lighthouse PWA category with manifest, icon, registration, update, and offline-shell artifact contracts. They do not prove real Chrome installation, standalone launch, or offline behavior on a device.",
    checks,
    failures,
  };
}

export function writePwaReport() {
  const report = verifyPwaArtifacts();
  writeJson(join(projectRoot, "artifacts", "pwa-verification.json"), report);
  return report;
}

export function main() {
  const releasePipelineLock = acquireEvidencePipelineLock(
    projectRoot,
    "PWA evidence",
    { allowInheritedToken: true }
  );
  process.on("exit", releasePipelineLock);
  const report = writePwaReport();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
