import type { JsonObject, JsonRpcRequest } from "@codexhost/shared-contracts";

/** A response to `request`, keeping its JSON-RPC version marker when it has one. */
export function rpcEnvelope(request: JsonRpcRequest, value: JsonObject): JsonObject {
  return {
    ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
    id: request.id,
    ...value,
  };
}

export function rpcError(request: JsonRpcRequest, code: number, message: string): JsonObject {
  return rpcEnvelope(request, { error: { code, message } });
}

export function requestObject(request: JsonRpcRequest): JsonObject {
  const params = request.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(`${request.method} params must be an object`);
  }
  return params as JsonObject;
}
