import { describe, expect, it } from "vitest";

import { parseGrokInterjectResponse } from "../src/grok-interject.js";

describe("Grok interject response", () => {
  it("accepts queued acknowledgements and rejects unknown payloads", () => {
    expect(parseGrokInterjectResponse({ queued: true })).toEqual({ queued: true });
    expect(parseGrokInterjectResponse({ result: { queued: false } })).toEqual({ queued: false });
    expect(parseGrokInterjectResponse({ result: { status: "queued" } })).toEqual({ queued: true });
    expect(parseGrokInterjectResponse({ status: "queued" })).toEqual({ queued: true });
    expect(parseGrokInterjectResponse({ status: "rejected" })).toEqual({ queued: false });
    expect(parseGrokInterjectResponse({})).toBeNull();
    expect(parseGrokInterjectResponse(null)).toBeNull();
  });
});
