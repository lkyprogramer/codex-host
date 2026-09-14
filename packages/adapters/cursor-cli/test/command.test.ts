import { describe, expect, it } from "vitest";
import { cursorInvocation } from "../src/command.js";

describe("Cursor native invocation policy", () => {
  it("uses the native force option only for an explicit unattended transport", () => {
    expect(cursorInvocation(process.env, process.execPath).arguments).toEqual(["acp"]);
    expect(cursorInvocation(process.env, process.execPath, true).arguments).toEqual([
      "--force",
      "acp",
    ]);
  });
});
