import { describe, expect, it } from "vitest";

import {
  installReasoningTranscriptSoftWrap,
  readReasoningTranscriptSoftWrap,
  setReasoningTranscriptSoftWrap,
} from "../src/renderer-transcript-dom.js";

describe("Reasoning transcript soft wrap", () => {
  it("does not install styling when the owner document has no Window", () => {
    const dispose = installReasoningTranscriptSoftWrap({
      defaultView: null,
    } as unknown as Document);

    expect(dispose).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });

  it("keeps the session preference usable when local storage is unavailable", () => {
    const events: Event[] = [];
    const ownerWindow = {
      get localStorage(): Storage {
        throw new DOMException("Access denied", "SecurityError");
      },
      dispatchEvent(event: Event): boolean {
        events.push(event);
        return true;
      },
    } as unknown as Window;

    expect(readReasoningTranscriptSoftWrap(ownerWindow)).toBe(false);
    setReasoningTranscriptSoftWrap(ownerWindow, true);
    expect(readReasoningTranscriptSoftWrap(ownerWindow)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["codexhost:reasoning-soft-wrap-changed"]);
  });
});
