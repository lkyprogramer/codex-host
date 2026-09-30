import { describe, expect, it } from "vitest";
import {
  formatDelegationMentionLink,
  formatHarnessCommandMentionLink,
  harnessCommandCatalogSchema,
} from "@codexhost/shared-contracts";
import {
  decodeExternalComposerText,
  matchExternalCommand,
} from "../src/external-command-routing.js";
import {
  rewriteDelegationMentionInput,
  rewriteDelegationMentionText,
} from "../src/delegation-mention-rewrite.js";

const delegate = formatDelegationMentionLink({ harnessId: "pi", label: "Pi" });
const command = formatHarnessCommandMentionLink({
  harnessId: "pi",
  invocation: "/review",
  label: "Review",
});
const catalog = harnessCommandCatalogSchema.parse({
  commands: [
    { id: "review", invocation: "/review", label: "Review", argumentMode: "text" },
    { id: "compact", invocation: "/compact", label: "Compact", argumentMode: "none" },
  ],
});

describe("Composer command admission", () => {
  it("preserves tabs, indentation and trailing argument bytes", () => {
    const decoded = decodeExternalComposerText(`${command} \t  first\n    second  `, "pi");
    expect(decoded.explicitCommand).toBe(true);
    expect(matchExternalCommand(decoded.text, catalog)?.arguments).toEqual({
      text: "\t  first\n    second  ",
    });
    expect(matchExternalCommand("/review\n\n  line  ", catalog)?.arguments).toEqual({
      text: "\n  line  ",
    });
    expect(matchExternalCommand("/review-other", catalog)).toBeNull();
  });
  it("rejects cross-Harness, mixed and multiple command chips", () => {
    expect(() => decodeExternalComposerText(command, "omp")).toThrow("another Harness");
    expect(() => decodeExternalComposerText(`${command} ${delegate}`, "pi")).toThrow(
      "cannot be combined",
    );
    expect(() => decodeExternalComposerText(`${command} ${command}`, "pi")).toThrow("one command");
    expect(() => matchExternalCommand("/compact unwanted", catalog)).toThrow("does not accept");
  });
  it("leaves ordinary prompts and quoted carriers intact", () => {
    for (const text of ["hello #world  ", `\`${command}\``, `\`${delegate}\``]) {
      expect(decodeExternalComposerText(text, "pi")).toEqual({ text, explicitCommand: false });
      expect(rewriteDelegationMentionText(text, () => false)).toBe(text);
    }
  });
});

describe("Delegation mention forwarding", () => {
  it("preserves native attachments, text metadata and all draft bytes outside carriers", () => {
    const image = { type: "localImage", path: "/tmp/image.png" };
    const input = [
      { type: "text", text: `  ${delegate}\t task  `, text_elements: [{ start: 0 }] },
      image,
    ];
    const result = rewriteDelegationMentionInput(input, (id) => id === "pi", {
      name: "codexhost-delegation",
      path: "/skill/SKILL.md",
    });
    expect(result?.[0]).toMatchObject({
      text: expect.stringContaining("  @Pi\t task  \n\n"),
      text_elements: [{ start: 0 }],
    });
    expect(result?.[1]).toBe(image);
    expect(result?.[2]).toEqual({
      type: "skill",
      name: "codexhost-delegation",
      path: "/skill/SKILL.md",
    });
  });
  it("deduplicates targets and an existing skill without creating another delegation mechanism", () => {
    const skill = { type: "skill", name: "codexhost-delegation", path: "/skill/SKILL.md" };
    const result = rewriteDelegationMentionInput(
      [{ type: "text", text: delegate }, { type: "text", text: delegate }, skill],
      () => true,
      skill,
    );
    expect(result).toHaveLength(3);
    expect(JSON.stringify(result).match(/existing codexhost delegate workflow/g)).toHaveLength(1);
    expect(result?.[2]).toBe(skill);
  });
  it("rejects unavailable delegation targets and command carriers on official Codex", () => {
    expect(() =>
      rewriteDelegationMentionInput([{ type: "text", text: delegate }], () => false),
    ).toThrow("unavailable");
    expect(() =>
      rewriteDelegationMentionInput([{ type: "text", text: command }], () => true),
    ).toThrow("external Harness");
    expect(
      rewriteDelegationMentionInput([{ type: "text", text: "ordinary" }], () => false),
    ).toBeNull();
  });
});
