import readline from "node:readline";
const scenario = process.argv[2];
const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
let promptId;
let directoryReads = 0;
const parameterized = scenario.startsWith("parameters");
let effort = "high",
  fast = "true";
if (scenario === "parameters-selected") {
  effort = "xhigh";
  fast = "false";
}
const parameters = () => [
  {
    id: "effort",
    name: "Effort",
    type: "select",
    currentValue: effort,
    options: ["high", "xhigh"].map((value) => ({ value, name: value })),
  },
  {
    id: "fast",
    name: "Fast",
    type: "select",
    currentValue: fast,
    options: ["false", "true"].map((value) => ({ value, name: value })),
  },
];
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "grok-4.6",
    options: [{ value: "grok-4.6", name: "Grok 4.6" }],
  },
  ...parameters(),
];
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (
      parameterized &&
      message.params.clientCapabilities?._meta?.parameterizedModelPicker !== true
    )
      process.exit(9);
    if (scenario === "hang-startup") return;
    send({
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
    });
  } else if (message.method === "authenticate") {
    if (scenario === "auth-socket-error")
      send({
        id: message.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: "[aborted] socket hang up; access_token=fixture-secret" },
        },
      });
    else send({ id: message.id, result: {} });
  } else if (message.method === "cursor/list_available_models") {
    directoryReads++;
    if (
      scenario === "parameters-empty" ||
      (scenario === "parameters-first-empty" && directoryReads === 1)
    ) {
      send({ id: message.id, result: { models: [] } });
      return;
    }
    send(
      parameterized
        ? {
            id: message.id,
            result: {
              models: [{ value: "grok-4.6", name: "Grok 4.6", configOptions: parameters() }],
            },
          }
        : { id: message.id, error: { code: -32601, message: "Method not found" } },
    );
  } else if (message.method === "session/new" || message.method === "session/load") {
    send({
      id: message.id,
      result: {
        sessionId,
        configOptions:
          scenario === "parameters-base-only"
            ? [{ ...configOptions()[0], options: [] }]
            : parameterized
              ? configOptions()
              : [],
      },
    });
  } else if (message.method === "session/set_config_option") {
    if (scenario === "parameters-selected") {
      send({
        id: message.id,
        error: { code: -32603, message: "Already selected values must not be rewritten" },
      });
      return;
    }
    if (parameterized) {
      const { configId, value } = message.params;
      if (configId === "fast" && scenario === "parameters-reject") {
        send({
          id: message.id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: { message: "Native rejected fast" },
          },
        });
      } else {
        if (configId === "effort") effort = value;
        if (configId === "fast") fast = value;
        send({ id: message.id, result: { configOptions: configOptions() } });
      }
    } else if (scenario !== "hang-config") send({ id: message.id, result: { configOptions: [] } });
  } else if (message.method === "session/prompt") {
    if (scenario === "exit") {
      process.exit(7);
    }
    promptId = message.id;
    send({
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "shell-1", title: "Synthetic shell" },
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
      },
    });
  } else if (message.method === "session/cancel") {
    send({ id: promptId, result: { stopReason: "cancelled" } });
  } else if (message.id === "permission") {
    if (message.result?.outcome?.optionId !== "deny") process.exit(8);
    send({ id: promptId, result: { stopReason: "end_turn" } });
  }
});
lines.on("close", () => process.exit(0));
