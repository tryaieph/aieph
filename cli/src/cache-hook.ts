/**
 * `aieph cache-hook` — Claude Code PreToolUse hook for WebSearch / WebFetch.
 *
 * Before the assistant reaches out to the web, this asks the shared aieph cache
 * whether a good answer is already known. On a hit it hands the answer back and
 * the web call is skipped; on a miss, timeout, or any error it stays silent so
 * the original tool call runs untouched. Strictly fail-open.
 *
 * Reads the hook payload as JSON on stdin; on a hit, writes a PreToolUse
 * decision to stdout. Configuration (both optional):
 *   AIEPH_API_BASE      cache endpoint (default: https://aieph.dev)
 *   LOOKUP_TIMEOUT_MS   time budget in ms before stepping aside (default: 800)
 */
import { randomUUID } from "node:crypto";

const DEFAULT_API_BASE = "https://aieph.dev";
const DEFAULT_TIMEOUT_MS = 800;
const TARGET_TOOLS = new Set(["WebSearch", "WebFetch"]);

function apiBase(): string {
  return (process.env.AIEPH_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
}

function timeoutMs(): number {
  const raw = process.env.LOOKUP_TIMEOUT_MS;
  const n = raw ? Number(raw) : DEFAULT_TIMEOUT_MS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function extractQuery(toolName: string, input: unknown): string {
  const o =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (toolName === "WebSearch") return String(o.query ?? o.search_term ?? "");
  if (toolName === "WebFetch") return String(o.url ?? "");
  return "";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

type LookupResult = { hit?: boolean; agent_message?: string };

/** Run the hook. Never throws; silence means "let the original call run". */
export async function runCacheHook(): Promise<void> {
  const raw = await readStdin();
  let payload: {
    tool_name?: string;
    tool_input?: unknown;
    session_id?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = payload?.tool_name ?? "";
  if (!TARGET_TOOLS.has(toolName)) return;

  const query = extractQuery(toolName, payload.tool_input);
  if (!query.trim()) return;

  const sessionKey =
    typeof payload.session_id === "string" && payload.session_id.trim()
      ? payload.session_id
      : randomUUID();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let data: LookupResult | null = null;
  try {
    const res = await fetch(`${apiBase()}/v1/hook/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_key: sessionKey,
        query,
        source_tool: toolName,
      }),
      signal: controller.signal,
    });
    data = (await res.json()) as LookupResult;
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }

  if (
    !data ||
    data.hit !== true ||
    typeof data.agent_message !== "string" ||
    !data.agent_message.trim()
  ) {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: data.agent_message,
      },
    }),
  );
}
