import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "server-dist/index.mjs");

await rm(resolve(root, "server-dist"), { recursive: true, force: true });
await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, "server/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "bundle",
  external: ["node-forge", "node-forge/*"],
  metafile: true,
  sourcemap: "external",
  tsconfig: resolve(root, "tsconfig.server.json"),
  logLevel: "info",
});

const inputs = Object.keys(result.metafile?.inputs ?? {});
const imports = Object.values(result.metafile?.outputs ?? {})
  .flatMap((output) => output.imports ?? []);
if (inputs.some((path) => path.includes("node_modules/node-forge/"))) {
  throw new Error("node-forge was unexpectedly bundled into the server");
}
if (
  !imports.some(
    (item) =>
      item.external &&
      (item.path === "node-forge" || item.path.startsWith("node-forge/"))
  )
) {
  throw new Error("node-forge external import was not recorded");
}

await writeFile(
  resolve(root, "server-dist/metafile.json"),
  `${JSON.stringify(result.metafile, null, 2)}\n`,
  "utf8"
);
