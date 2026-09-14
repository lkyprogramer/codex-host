import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { build } from "esbuild";
import { harnessPluginManifestSchema } from "@codexhost/shared-contracts";

async function resource(root, relative) {
  const resolved = await realpath(path.join(root, relative));
  const fromRoot = path.relative(root, resolved);
  if (
    !fromRoot ||
    path.isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${path.sep}`) ||
    !(await stat(resolved)).isFile()
  ) {
    throw new Error("Plugin build resource must be a regular file inside its package");
  }
  return resolved;
}

/** Build one relocatable plugin, with no runtime references to workspace packages. */
export async function buildHarnessPlugin({ pluginRoot, outputRoot, allowedRuntimePackages }) {
  const root = await realpath(pluginRoot);
  const manifest = harnessPluginManifestSchema.parse(
    JSON.parse(await readFile(await resource(root, "manifest.json"), "utf8")),
  );
  const entry = await resource(root, manifest.entry);
  await mkdir(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, "plugin.mjs");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    metafile: true,
    treeShaking: true,
    charset: "utf8",
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __codexhostCreateRequire } from "node:module"; const require = __codexhostCreateRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  const runtimePackages = new Set();
  const runtimeVersions = new Map();
  const runtimeLicenses = new Map();
  const metadataByPackageRoot = new Map();
  for (const input of inputs) {
    const normalized = `/${input.replaceAll("\\", "/")}/`;
    if (
      /\/(?:test|tests|tools)\//u.test(normalized) ||
      normalized.includes("/node_modules/@anthropic-ai/claude-agent-sdk-")
    ) {
      throw new Error(`Plugin Bundle contains forbidden input: ${input}`);
    }
    const marker = normalized.lastIndexOf("/node_modules/");
    if (marker < 0) continue;
    const segments = normalized.slice(marker + "/node_modules/".length).split("/");
    const packageName = segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!allowedRuntimePackages.has(packageName))
      throw new Error(`Plugin Bundle contains unreviewed runtime package: ${packageName}`);
    runtimePackages.add(packageName);
    const absoluteInput = path.resolve(root, input).replaceAll("\\", "/");
    const packageRoot =
      absoluteInput.slice(
        0,
        absoluteInput.lastIndexOf("/node_modules/") + "/node_modules/".length,
      ) + packageName;
    if (!metadataByPackageRoot.has(packageRoot)) {
      metadataByPackageRoot.set(
        packageRoot,
        JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")),
      );
    }
    const { version, license } = metadataByPackageRoot.get(packageRoot);
    const versions = runtimeVersions.get(packageName) ?? new Set();
    versions.add(version);
    runtimeVersions.set(packageName, versions);
    runtimeLicenses.set(`${packageName}@${version}`, typeof license === "string" ? license : null);
  }
  const source = await readFile(outputPath, "utf8");
  if (source.includes("sourceMappingURL="))
    throw new Error("Plugin Bundle contains a source map reference");
  if (manifest.icon) {
    const icon = await resource(root, manifest.icon);
    const destination = path.join(outputRoot, manifest.icon);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(icon, destination);
  }
  await writeFile(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ ...manifest, entry: "plugin.mjs" }, null, 2)}\n`,
  );
  const receipt = {
    formatVersion: 1,
    harnessId: manifest.id,
    adapterApiVersion: manifest.adapterApiVersion,
    pluginVersion: manifest.version,
    runtimeTarget: "node22",
    bundleSha256: createHash("sha256").update(source).digest("hex"),
    runtimePackages: Object.fromEntries(
      [...runtimeVersions]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, versions]) => [name, [...versions].sort()]),
    ),
    nativeVersion: null,
    runtimeLicenses: Object.fromEntries(
      [...runtimeLicenses].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await writeFile(
    path.join(outputRoot, "build-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return { id: manifest.id, inputs, runtimePackages: [...runtimePackages].sort(), receipt };
}
