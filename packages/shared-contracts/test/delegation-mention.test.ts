import { describe, expect, it } from "vitest";
import {
  decodeHarnessCommandMention,
  formatDelegationMentionLink,
  formatHarnessCommandMentionLink,
  stripDelegationMentions,
} from "../src/delegation-mention.js";

const command = () =>
  formatHarnessCommandMentionLink({
    harnessId: "pi",
    invocation: "/skill:review",
    label: "Review",
  });
describe("Composer mention carriers", () => {
  it("scopes command carriers and preserves all argument whitespace", () => {
    expect(decodeHarnessCommandMention(`${command()} \t  text\n  indent  `, "pi")).toEqual({
      text: "/skill:review \t  text\n  indent  ",
      command: { harnessId: "pi", invocation: "/skill:review" },
    });
    expect(() => decodeHarnessCommandMention(command(), "omp")).toThrow("another Harness");
  });
  it("rejects multiple commands rather than dropping one", () => {
    expect(() => decodeHarnessCommandMention(`${command()} a ${command()} b`)).toThrow(
      "one command",
    );
  });
  it("preserves ordinary text, code examples and escaped chips", () => {
    for (const text of [
      "ordinary # text",
      `\`${command()}\``,
      `\`\`\`md\n${command()}\n\`\`\``,
      `\\${command()}`,
    ]) {
      expect(decodeHarnessCommandMention(text)).toEqual({ text, command: null });
    }
  });
  it("keeps indented and fenced examples inert and accepts longer closing fences", () => {
    for (const text of [`    ${command()}`, `\t${command()}`, `~~~md\n${command()}\n~~~~`]) {
      expect(decodeHarnessCommandMention(text)).toEqual({ text, command: null });
    }
    const code = `~~~md\n${command()}\n~~~~\n`;
    expect(decodeHarnessCommandMention(`${code}${command()}`, "pi").command?.invocation).toBe(
      "/skill:review",
    );
    const pi = formatDelegationMentionLink({ harnessId: "pi", label: "Pi" });
    expect(stripDelegationMentions(`    ${pi}`).mentions).toEqual([]);
  });
  it("retains all delegation mentions and deduplicates only target identity", () => {
    const pi = formatDelegationMentionLink({ harnessId: "pi", label: "Pi" });
    const other = formatDelegationMentionLink({ harnessId: "omp", label: "OMP" });
    expect(stripDelegationMentions(`  ${pi} ${other}\t${pi}  `)).toEqual({
      text: "  @Pi @OMP\t@Pi  ",
      mentions: [
        { harnessId: "pi", label: "Pi" },
        { harnessId: "omp", label: "OMP" },
      ],
    });
  });
  it("rejects missing command scope", () => {
    expect(() => decodeHarnessCommandMention("[@x](subagent://codexhost-command.pi)")).toThrow(
      "scope",
    );
  });
  it("rejects malformed command encoding", () => {
    expect(() => decodeHarnessCommandMention("[@x](subagent://codexhost-command.%ZZ)")).toThrow(
      "encoding",
    );
  });
});
