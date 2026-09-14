import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preinstalledHarnessPlugins } from "../../scripts/release/harness-plugins.mjs";
import { buildHarnessPlugin } from "../../packages/harness-adapter/scripts/build-plugin.mjs";

describe("per-plugin distribution dependencies", () => {
  it("does not grant another plugin's SDK allowance", async () => {
    const { plugins } = preinstalledHarnessPlugins();
    const claude = plugins.find(({ manifest }) => manifest.id === "claude-code");
    const pi = plugins.find(({ manifest }) => manifest.id === "pi");
    expect(pi.allowedRuntimePackages.has("@anthropic-ai/claude-agent-sdk")).toBe(false);
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-dependency-test-"));
    try {
      await expect(
        buildHarnessPlugin({
          pluginRoot: claude.pluginRoot,
          outputRoot,
          allowedRuntimePackages: pi.allowedRuntimePackages,
        }),
      ).rejects.toThrow("unreviewed runtime package");
      const { receipt } = await buildHarnessPlugin({ ...claude, outputRoot });
      const source = await readFile(path.join(outputRoot, "plugin.mjs"));
      const recorded = JSON.parse(
        await readFile(path.join(outputRoot, "build-receipt.json"), "utf8"),
      );
      expect(recorded).toEqual(receipt);
      expect(recorded.bundleSha256).toBe(createHash("sha256").update(source).digest("hex"));
      expect(recorded.runtimePackages["@anthropic-ai/claude-agent-sdk"]).toEqual(["0.3.220"]);
      expect(recorded.nativeVersion).toBeNull();
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
