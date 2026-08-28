// Minimal JSON-RPC 2.0 types + stdio framing for MCP.
// Per spec (2025-06-18, basic/transports#stdio): messages are newline-delimited
// JSON-RPC, MUST NOT contain embedded newlines, and stdout MUST carry nothing
// but valid MCP messages (all logging goes to stderr).

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
};

export type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification;

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function isRequest(msg: JsonRpcInbound): msg is JsonRpcRequest {
  return "id" in msg && msg.id !== undefined;
}

export function makeSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Parses one line of stdin into a JSON-RPC request/notification, or null if malformed. */
export function parseInboundLine(line: string): JsonRpcInbound | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0" || typeof obj.method !== "string") return null;
  if ("id" in obj && obj.id !== undefined) {
    if (typeof obj.id !== "string" && typeof obj.id !== "number") return null;
    return { jsonrpc: "2.0", id: obj.id, method: obj.method, params: obj.params };
  }
  return { jsonrpc: "2.0", method: obj.method, params: obj.params };
}

/** Serializes an outbound message as one newline-terminated JSON line (never embeds a raw newline). */
export function serializeOutbound(msg: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): string {
  return `${JSON.stringify(msg)}\n`;
}
