/**
 * `aieph cache-serve` — a tiny stdio MCP server exposing one tool, `cache_lookup`.
 *
 * This is the cache path for MCP clients (e.g. Cursor) that can't transparently
 * intercept a web search the way Claude Code's PreToolUse hook can. The agent is
 * asked (via the tool description / a rule) to call `cache_lookup` before it runs
 * a web search: on a hit it gets a ready answer and can skip the web trip; on a
 * miss it's told to search as usual. Strictly fail-open — any error looks like a
 * miss, so the agent simply proceeds.
 *
 * Kept separate from `aieph memory serve` on purpose: memory is fully local and
 * promises nothing leaves your machine, whereas this one talks to the shared
 * cache over the network. Config: AIEPH_API_BASE, LOOKUP_TIMEOUT_MS.
 */
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
} from "./memory/protocol.js";

export const CACHE_PROTOCOL_VERSION = "2025-06-18";
export const CACHE_SERVER_INFO = { name: "aieph-cache", version: "0.1.0" };
const CACHE_INSTRUCTIONS =
  "Shared answer cache for coding questions. BEFORE running a web search or web " +
  "fetch, call cache_lookup with the same query first: on a hit it returns an " +
  "answer you can use directly (skip the web trip); on a miss it says so and you " +
  "should search as usual. Fail-open — a miss or error just means 'go search'.";

const DEFAULT_API_BASE = "https://aieph.dev";
const DEFAULT_TIMEOUT_MS = 800;

function apiBase(): string {
  return (process.env.AIEPH_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
}

function timeoutMs(): number {
  const raw = process.env.LOOKUP_TIMEOUT_MS;
  const n = raw ? Number(raw) : DEFAULT_TIMEOUT_MS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export const CACHE_LOOKUP_TOOL = {
  name: "cache_lookup",
  description:
    "Check the shared aieph answer cache for a coding question BEFORE doing a web " +
    "search or web fetch. On a hit, returns a ready answer you can use instead of " +
    "searching. On a miss, says so — then search the web as usual.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query or question you were about to look up on the web.",
      },
      source_tool: {
        type: "string",
        description:
          "Optional: the tool you would have used (e.g. WebSearch, WebFetch).",
      },
    },
    required: ["query"],
  },
} as const;

type LookupResult = { hit?: boolean; agent_message?: string };

async function lookup(
  query: string,
  sourceTool: string,
): Promise<LookupResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(`${apiBase()}/v1/hook/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_key: `mcp-${Date.now()}`,
        query,
        source_tool: sourceTool || "cache_lookup",
      }),
      signal: controller.signal,
    });
    return (await res.json()) as LookupResult;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleCacheLookup(
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) {
    return {
      content: [{ type: "text", text: "cache_lookup requires a non-empty 'query'." }],
      isError: true,
    };
  }
  const sourceTool = typeof args.source_tool === "string" ? args.source_tool : "";
  const data = await lookup(query, sourceTool);
  if (
    data &&
    data.hit === true &&
    typeof data.agent_message === "string" &&
    data.agent_message.trim()
  ) {
    return { content: [{ type: "text", text: data.agent_message }] };
  }
  return {
    content: [
      {
        type: "text",
        text: "No cached answer for this query. Go ahead and search the web as usual.",
      },
    ],
  };
}

/** Handle one inbound JSON-RPC message. Pure and testable (no stdio needed). */
export async function handleCacheMessage(
  msg: JsonRpcInbound,
): Promise<JsonRpcSuccess | JsonRpcError | null> {
  if (!isRequest(msg)) return null;

  switch (msg.method) {
    case "initialize":
      return makeSuccess(msg.id, {
        protocolVersion: CACHE_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: CACHE_SERVER_INFO,
        instructions: CACHE_INSTRUCTIONS,
      });
    case "ping":
      return makeSuccess(msg.id, {});
    case "tools/list":
      return makeSuccess(msg.id, { tools: [CACHE_LOOKUP_TOOL] });
    case "tools/call": {
      const params = msg.params;
      if (!params || typeof params !== "object") {
        return makeError(
          msg.id,
          JSON_RPC_ERRORS.INVALID_PARAMS,
          "tools/call requires params",
        );
      }
      const { name, arguments: a } = params as {
        name?: unknown;
        arguments?: unknown;
      };
      if (name !== CACHE_LOOKUP_TOOL.name) {
        return makeError(
          msg.id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Unknown tool: ${String(name)}`,
        );
      }
      const toolArgs =
        a && typeof a === "object" ? (a as Record<string, unknown>) : {};
      try {
        return makeSuccess(msg.id, await handleCacheLookup(toolArgs));
      } catch (e) {
        return makeSuccess(msg.id, {
          content: [{ type: "text", text: (e as Error).message ?? String(e) }],
          isError: true,
        });
      }
    }
    default:
      return makeError(
        msg.id,
        JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Method not found: ${msg.method}`,
      );
  }
}

/** Run the stdio MCP loop until the client disconnects (stdin closes). */
export function runCacheServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const rl = createInterface({ input, terminal: false });
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const msg = parseInboundLine(line);
    if (!msg) return;
    queue = queue.then(async () => {
      const response = await handleCacheMessage(msg);
      if (response) output.write(serializeOutbound(response));
    });
  });
}
