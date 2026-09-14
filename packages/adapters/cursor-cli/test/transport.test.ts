import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorTransport, type CursorCallbacks } from "../src/transport.js";

const state = vi.hoisted(() => ({ scenario: "normal" }));
vi.mock("../src/command.js", () => ({
  cursorInvocation: () => ({
    command: process.execPath,
    arguments: [path.resolve("packages/adapters/cursor-cli/test/fixtures/acp.mjs"), state.scenario],
    windowsVerbatimArguments: false,
  }),
}));
const transports: CursorTransport[] = [];
function transport(timeoutMs = 2_000) {
  const result = new CursorTransport({ cwd: process.cwd(), environment: process.env, timeoutMs });
  transports.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  state.scenario = "normal";
});
const callbacks: CursorCallbacks = {
  update: () => {},
  permission: async () => ({ outcome: { outcome: "selected", optionId: "deny" } }),
  extension: async () => ({ outcome: { outcome: "cancelled" } }),
};
describe("Cursor ACP process boundary", () => {
  it("loads history without a remote model catalog and forbids mutations", async () => {
    state.scenario = "parameters-empty";
    const native = transport();
    await native.open("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { historyOnly: true });
    await expect(native.configure("model", "grok-4.6")).rejects.toThrow("history replay");
    await expect(native.prompt("must not run", callbacks)).rejects.toThrow("history replay");
    await expect(native.cancel()).rejects.toThrow("history replay");
    expect(native.closed).toBe(false);
  });
  it("rejects history replay without an existing native session before launch", async () => {
    const native = transport();
    await expect(native.open(undefined, { historyOnly: true })).rejects.toThrow(
      "native session ID",
    );
    await native.open();
  });
  it("does not change a live session mode when reopening is rejected", async () => {
    const native = transport();
    await native.open();
    await expect(
      native.open("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { historyOnly: true }),
    ).rejects.toThrow("reopened");
    await expect(native.prompt("synthetic", callbacks)).resolves.toEqual({
      stopReason: "end_turn",
    });
  });
  it("uses confirmed exact native parameters without redundant remote writes", async () => {
    state.scenario = "parameters-selected";
    const native = transport();
    await native.open();
    const selected = await native.configure("model", "grok-4.6[effort=xhigh,fast=false]");
    expect(selected.configOptions.find((option) => option.id === "model")?.currentValue).toBe(
      "grok-4.6[effort=xhigh,fast=false]",
    );
    expect(native.closed).toBe(false);
  });
  it("reports the failing ACP stage and sanitized native details, then closes", async () => {
    state.scenario = "auth-socket-error";
    const native = transport();
    await expect(native.open()).rejects.toThrow(
      "Cursor ACP authenticate: [aborted] socket hang up; access_token=[redacted]",
    );
    expect(native.closed).toBe(true);
  });
  it("refetches an empty native directory once without fabricating models", async () => {
    state.scenario = "parameters-first-empty";
    const native = transport();
    expect(
      (await native.open()).configOptions?.find((option) => option.id === "model")?.currentValue,
    ).toBe("grok-4.6[effort=high,fast=true]");
  });
  it("rejects a persistently empty directory and closes native resources", async () => {
    state.scenario = "parameters-empty";
    const native = transport();
    await expect(native.open()).rejects.toThrow("Cursor returned no parameterized models");
    expect(native.closed).toBe(true);
  });
  it("bootstraps exact selection when native startup omits actual current parameters", async () => {
    state.scenario = "parameters-base-only";
    const native = transport();
    const info = await native.open();
    expect(info.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("");
    const configured = await native.configure("model", "grok-4.6[effort=xhigh,fast=false]");
    expect(configured.configOptions.find((option) => option.id === "model")?.currentValue).toBe(
      "grok-4.6[effort=xhigh,fast=false]",
    );
  });
  it("negotiates parameter catalogs and confirms exact xhigh non-fast selection", async () => {
    state.scenario = "parameters";
    const native = transport();
    const info = await native.open();
    const model = info.configOptions?.find((option) => option.id === "model");
    expect(model).toMatchObject({ currentValue: "grok-4.6[effort=high,fast=true]" });
    const selected = await native.configure("model", "grok-4.6[effort=xhigh,fast=false]");
    expect(selected.configOptions.find((option) => option.id === "model")?.currentValue).toBe(
      "grok-4.6[effort=xhigh,fast=false]",
    );
    expect(native.closed).toBe(false);
  });
  it("retires a partially configured model after a native parameter rejection", async () => {
    state.scenario = "parameters-reject";
    const native = transport();
    await native.open();
    await expect(native.configure("model", "grok-4.6[effort=xhigh,fast=false]")).rejects.toThrow(
      "Native rejected fast",
    );
    expect(native.closed).toBe(true);
    await expect(
      native.prompt("must not execute under partial selection", callbacks),
    ).rejects.toThrow(/closed/);
  });
  it("uses real stdio framing for handshake, native permission and terminal response", async () => {
    const native = transport();
    await native.open();
    const permission = vi.fn(callbacks.permission);
    expect(await native.prompt("synthetic", { ...callbacks, permission })).toEqual({
      stopReason: "end_turn",
    });
    expect(permission).toHaveBeenCalledTimes(1);
    await native.close();
    await native.close();
    await expect(native.prompt("closed", callbacks)).rejects.toThrow();
  });
  it("settles prompt when the owned process exits", async () => {
    state.scenario = "exit";
    const native = transport();
    await native.open();
    await expect(native.prompt("synthetic", callbacks)).rejects.toThrow();
  });
  it("bounds and closes a CLI that never initializes", async () => {
    state.scenario = "hang-startup";
    const native = transport(200);
    await expect(native.open()).rejects.toThrow(/timed out|closed/u);
    await expect(native.open()).rejects.toThrow("reopened");
  });
  it("poisons a timed-out configuration so a late response cannot affect another turn", async () => {
    state.scenario = "hang-config";
    const native = transport(1_000);
    await native.open();
    await expect(native.configure("mode", "plan")).rejects.toThrow(/timed out|closed/u);
    await expect(native.prompt("must not run", callbacks)).rejects.toThrow();
  });
});
