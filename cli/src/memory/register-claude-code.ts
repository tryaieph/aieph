import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

/**
 * Registers the local personal-memory MCP server in Claude Code's USER-scope
 * config (`~/.claude.json`), never in a project-scope `.mcp.json`. This is a
 * personal, per-machine store — it must not get committed and pushed onto
 * every teammate who clones a repo where `aieph init` was run.
 */
export const AIEPH_MEMORY_SERVER_NAME = "aieph-memory";

export type StdioMcpServerEntry = {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function aiephMemoryServerEntry(): StdioMcpServerEntry {
  return { type: "stdio", command: "aieph", args: ["memory", "serve"], env: {} };
}

function isAiephMemoryEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { command?: unknown; args?: unknown };
  return (
    e.command === "aieph" &&
    Array.isArray(e.args) &&
    e.args[0] === "memory" &&
    e.args[1] === "serve"
  );
}

type ClaudeUserConfig = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Merges/overwrites only the aieph-memory entry under mcpServers; every other key is untouched. */
export function mergeClaudeCodeMcpServers(existing: ClaudeUserConfig | null): ClaudeUserConfig {
  const base: ClaudeUserConfig = existing && typeof existing === "object" ? { ...existing } : {};
  const servers = { ...(base.mcpServers ?? {}) };
  servers[AIEPH_MEMORY_SERVER_NAME] = aiephMemoryServerEntry();
  base.mcpServers = servers;
  return base;
}

/** Removes only the aieph-memory entry; leaves every other mcpServers entry and root key intact. */
export function uninstallClaudeCodeMcpServers(existing: ClaudeUserConfig | null): ClaudeUserConfig | null {
  if (!existing || typeof existing !== "object") return existing;
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") return existing;
  const servers = existing.mcpServers as Record<string, unknown>;
  const entryName = AIEPH_MEMORY_SERVER_NAME in servers
    ? AIEPH_MEMORY_SERVER_NAME
    : Object.keys(servers).find((k) => isAiephMemoryEntry(servers[k]));
  if (!entryName) return existing;
  const { [entryName]: _drop, ...rest } = servers;
  return { ...existing, mcpServers: rest };
}

function configPath(homeDir: string): string {
  return path.join(homeDir, ".claude.json");
}

export async function installClaudeCodeMemoryMcp(homeDir: string): Promise<void> {
  const file = configPath(homeDir);
  let existing: ClaudeUserConfig | null = null;
  if (await pathExists(file)) {
    const raw = await readFile(file, "utf8");
    const trimmed = raw.trim();
    existing = trimmed.length > 0 ? (JSON.parse(trimmed) as ClaudeUserConfig) : {};
  }
  const next = mergeClaudeCodeMcpServers(existing);
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function uninstallClaudeCodeMemoryMcp(homeDir: string): Promise<void> {
  const file = configPath(homeDir);
  if (!(await pathExists(file))) return;
  const raw = await readFile(file, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const existing = JSON.parse(trimmed) as ClaudeUserConfig;
  const next = uninstallClaudeCodeMcpServers(existing);
  if (next === null) return;
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}
