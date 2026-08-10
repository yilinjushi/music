import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  npmInvocation,
  projectRoot,
  sha256File,
  writeJson,
} from "./evidence-utils.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";

const releasePipelineLock = acquireEvidencePipelineLock(
  projectRoot,
  "SBOM evidence",
  { allowInheritedToken: true }
);
process.on("exit", releasePipelineLock);

const artifacts = join(projectRoot, "artifacts");
const sbomPath = join(artifacts, "sbom.cdx.json");
const npmTreePath = join(artifacts, "npm-ls-production.json");
const verificationPath = join(artifacts, "sbom-verification.json");
const cli = join(
  projectRoot,
  "node_modules",
  "@cyclonedx",
  "cyclonedx-npm",
  "bin",
  "cyclonedx-npm-cli.js"
);

mkdirSync(artifacts, { recursive: true });

if (!existsSync(cli)) {
  console.error("CycloneDX CLI is not installed; run npm ci first");
  process.exit(1);
}

const generation = spawnSync(
  process.execPath,
  [
    cli,
    "--omit",
    "dev",
    "--spec-version",
    "1.6",
    "--output-format",
    "JSON",
    "--output-file",
    sbomPath,
    "--output-reproducible",
    "--validate",
    "--mc-type",
    "application",
    "package.json",
  ],
  { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);
if (generation.stdout) process.stdout.write(generation.stdout);
if (generation.stderr) process.stderr.write(generation.stderr);
if (generation.error || generation.status !== 0) {
  console.error(generation.error?.message ?? "CycloneDX generation failed");
  process.exit(generation.status ?? 1);
}

const npm = npmInvocation([
  "ls",
  "--omit=dev",
  "--all",
  "--workspaces",
  "--include-workspace-root",
  "--json",
  "--long",
]);
const listed = spawnSync(npm.command, npm.args, {
  cwd: projectRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (listed.stderr) process.stderr.write(listed.stderr);

let tree;
try {
  tree = JSON.parse(listed.stdout || "");
} catch (error) {
  console.error(
    `npm ls did not return valid JSON: ${error instanceof Error ? error.message : error}`
  );
  process.exit(1);
}
writeJson(npmTreePath, tree);
if (listed.error || listed.status !== 0) {
  console.error(listed.error?.message ?? "npm ls reported an invalid tree");
  process.exit(listed.status ?? 1);
}

function collectNpmClosure(root) {
  const packages = new Set();
  const visit = (node, fallbackName) => {
    if (!node || typeof node !== "object") return;
    const name = typeof node.name === "string" ? node.name : fallbackName;
    if (name && typeof node.version === "string") {
      packages.add(`${name}@${node.version}`);
    }
    for (const [dependencyName, dependency] of Object.entries(
      node.dependencies ?? {}
    )) {
      visit(dependency, dependencyName);
    }
  };
  visit(root, root.name);
  return packages;
}

function collectSbomComponents(sbom) {
  const packages = new Set();
  const add = (component) => {
    if (component?.name && component?.version) {
      const name = component.group
        ? `${component.group}/${component.name}`
        : component.name;
      packages.add(`${name}@${component.version}`);
    }
    for (const child of component?.components ?? []) add(child);
  };
  add(sbom.metadata?.component);
  for (const component of sbom.components ?? []) add(component);
  return packages;
}

const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
const closure = collectNpmClosure(tree);
const components = collectSbomComponents(sbom);
const missing = [...closure].filter((pkg) => !components.has(pkg)).sort();
const verification = {
  ok: missing.length === 0,
  generator: "@cyclonedx/cyclonedx-npm@6.0.0",
  workspaceAware: true,
  scope:
    "production npm closure (workspace root + all workspaces, dev omitted)",
  npmClosurePackages: closure.size,
  sbomPackages: components.size,
  missing,
  sbom: {
    file: relative(projectRoot, sbomPath),
    sha256: sha256File(sbomPath),
    specVersion: sbom.specVersion,
  },
};
writeJson(verificationPath, verification);
console.log(JSON.stringify(verification, null, 2));
if (!verification.ok) process.exit(1);
