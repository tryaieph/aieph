import { createInterface } from "node:readline";
import {
  isRequest,
  JSON_RPC_ERRORS,
  makeError,
  makeSuccess,
  parseInboundLine,
  serializeOutbound,
  type JsonRpcError,
  type JsonRpcInbound,
  type JsonRpcSuccess,
} from "./protocol.js";
import { SessionState, type ToolContext } from "./session.js";
import { TOOLS } from "./tools.js";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "aieph-memory", version: "0.1.0" };
const INSTRUCTIONS =
  "Local, per-user, cross-agent memory. Write once with memory.write, recall with memory.search/list. " +
  "Working entries older than 7 days show up via memory.consolidate as candidates for you to summarize " +
  "into a consolidated entry — the server never summarizes on its own. At session-end, call memory.review " +
  "to get the entries you touched this session, re-check each against the current repo, and record the " +
  "outcome with memory.verify (current/stale/obsolete) so stale memories get rewritten instead of trusted.";

function toolSummaries() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function handleInitialize(id: JsonRpcSuccess["id"]): JsonRpcSuccess {
  // This server only ever supports PROTOCOL_VERSION, so per spec it's returned
  // unconditionally — clients that can't accept it are expected to disconnect.
  return makeSuccess(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  });
}

async function handleToolsCall(id: JsonRpcSuccess["id"], params: unknown, ctx: ToolContext): Promise<JsonRpcSuccess | JsonRpcError> {
  if (!params || typeof params !== "object") {
    return makeError(id, JSON_RPC_ERRORS.INVALID_PARAMS, "tools/call requires params");
  }
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string") {
    return makeError(id, JSON_RPC_ERRORS.INVALID_PARAMS, "tools/call requires a string 'name'");
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return makeError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }
  const toolArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  try {
    const result = await tool.handler(toolArgs, ctx);
    return makeSuccess(id, result);
  } catch (e) {
    // Unexpected exceptions become a tool execution error, not a protocol error —
    // the connecting AI can see and reason about it rather than the connection dying.
    return makeSuccess(id, {
      content: [{ type: "text", text: (e as Error).message ?? String(e) }],
      isError: true,
    });
  }
}

/**
 * Handles one inbound JSON-RPC message and returns the outbound message to
 * write (or null for notifications, which never get a response). Pure and
 * testable without a real stdio pipe. `ctx` carries the cwd plus the
 * per-connection SessionState (touched-entry tracking); tests may omit it and
 * get a fresh session bound to `process.cwd()`.
 */
export async function handleMessage(
  msg: JsonRpcInbound,
  ctxOrCwd: ToolContext | string,
): Promise<JsonRpcSuccess | JsonRpcError | null> {
  const ctx: ToolContext =
    typeof ctxOrCwd === "string"
      ? { cwd: ctxOrCwd, session: new SessionState() }
      : ctxOrCwd;

  if (!isRequest(msg)) {
    // Notifications (e.g. notifications/initialized) require no response.
    return null;
  }

  switch (msg.method) {
    case "initialize":
      return handleInitialize(msg.id);
    case "ping":
      return makeSuccess(msg.id, {});
    case "tools/list":
      return makeSuccess(msg.id, { tools: toolSummaries() });
    case "tools/call":
      return handleToolsCall(msg.id, msg.params, ctx);
    default:
      return makeError(msg.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/**
 * Runs the stdio MCP server loop: reads newline-delimited JSON-RPC from
 * `input`, writes responses to `output`. Malformed lines are dropped silently
 * (parse errors have no request id to reply to, per JSON-RPC framing here).
 * Never writes anything but valid MCP messages to `output` (logs go to stderr).
 */
export function runStdioServer(
  cwd: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const rl = createInterface({ input, terminal: false });
  // One SessionState for the whole connection so "touched this session" (used by
  // memory.review) accumulates across every search/list until the client leaves.
  const ctx: ToolContext = { cwd, session: new SessionState() };
  // Requests are processed strictly in arrival order, not fired off in parallel:
  // a client that pipelines memory.write then memory.search must see the write
  // reflected in the search, not race it (writeEntry does real file I/O).
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const msg = parseInboundLine(line);
    if (!msg) return;
    queue = queue.then(async () => {
      const response = await handleMessage(msg, ctx);
      if (response) output.write(serializeOutbound(response));
    });
  });
}
