import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { AIEPH_MEMORY_SERVER_NAME } from "./register-claude-code.js";

/**
 * Registers the local personal-memory MCP server in Cursor's GLOBAL config
 * (`~/.cursor/mcp.json`), never the project's `.cursor/mcp.json` — same
 * reasoning as Claude Code: this is a personal store, not something to push
 * onto every teammate's Cursor via a committed project config.
 */
export type StdioCursorMcpEntry = {
  command: string;
  args: string[];
};

export function aiephMemoryCursorEntry(): StdioCursorMcpEntry {
  return { command: "aieph", args: ["memory", "serve"] };
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

type CursorMcpConfig = {
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

export function mergeCursorMcpServers(existing: CursorMcpConfig | null): CursorMcpConfig {
  const base: CursorMcpConfig = existing && typeof existing === "object" ? { ...existing } : {};
  const servers = { ...(base.mcpServers ?? {}) };
  servers[AIEPH_MEMORY_SERVER_NAME] = aiephMemoryCursorEntry();
  base.mcpServers = servers;
  return base;
}

export function uninstallCursorMcpServers(existing: CursorMcpConfig | null): CursorMcpConfig | null {
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
  return path.join(homeDir, ".cursor", "mcp.json");
}

export async function installCursorMemoryMcp(homeDir: string): Promise<void> {
  const file = configPath(homeDir);
  let existing: CursorMcpConfig | null = null;
  if (await pathExists(file)) {
    const raw = await readFile(file, "utf8");
    const trimmed = raw.trim();
    existing = trimmed.length > 0 ? (JSON.parse(trimmed) as CursorMcpConfig) : {};
  }
  const next = mergeCursorMcpServers(existing);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function uninstallCursorMemoryMcp(homeDir: string): Promise<void> {
  const file = configPath(homeDir);
  if (!(await pathExists(file))) return;
  const raw = await readFile(file, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const existing = JSON.parse(trimmed) as CursorMcpConfig;
  const next = uninstallCursorMcpServers(existing);
  if (next === null) return;
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}
