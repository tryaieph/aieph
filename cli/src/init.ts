import { chmod, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
} from "./claude-code.js";
import { installCursorHooks, uninstallCursorHooks } from "./cursor.js";
import {
  ensureAiephConfig,
  ensureAiephGitignore,
  formatInitTelemetryNotice,
} from "./config.js";
import {
  installClaudeCodeMemoryMcp,
  uninstallClaudeCodeMemoryMcp,
} from "./memory/register-claude-code.js";
import {
  installCursorMemoryMcp,
  uninstallCursorMemoryMcp,
  installCursorCacheMcp,
  uninstallCursorCacheMcp,
} from "./memory/register-cursor.js";

export const HOOK_START = "# aieph:start";
export const HOOK_END = "# aieph:end";

const HOOK_NAMES = ["post-merge", "post-checkout"] as const;

const HOOK_BODY = `${HOOK_START}
# aieph — fail-open rule match sync (events only; no file writes)
aieph sync --quiet --no-write --send || true
exit 0
${HOOK_END}
`;

const CI_SNIPPET = `# aieph rule-match (print-only; do not write this file via aieph init)
name: aieph-sync
on:
  push:
    branches: [main, master]
  pull_request:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npx --yes aieph sync --check
`;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function applyHookMarkers(existing: string | null): string {
  if (existing === null || existing.length === 0) {
    return `#!/bin/sh\n${HOOK_BODY}`;
  }

  const startIdx = existing.indexOf(HOOK_START);
  const endIdx = existing.indexOf(HOOK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    let blockEnd = endIdx + HOOK_END.length;
    if (existing.startsWith("\n", blockEnd)) blockEnd += 1;
    const before = existing.slice(0, startIdx);
    const after = existing.slice(blockEnd);
    return before + HOOK_BODY + after;
  }

  const sep = existing.endsWith("\n") ? "" : "\n";
  return existing + sep + HOOK_BODY;
}

function removeHookMarkers(existing: string): string {
  const startIdx = existing.indexOf(HOOK_START);
  const endIdx = existing.indexOf(HOOK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return existing;
  }
  let blockEnd = endIdx + HOOK_END.length;
  if (existing.startsWith("\n", blockEnd)) blockEnd += 1;
  return existing.slice(0, startIdx) + existing.slice(blockEnd);
}

export async function installGitHooks(cwd: string): Promise<void> {
  const hooksDir = path.join(cwd, ".git", "hooks");
  if (!(await pathExists(path.join(cwd, ".git")))) {
    throw new Error("not a git repository (.git missing)");
  }
  await mkdir(hooksDir, { recursive: true });

  for (const name of HOOK_NAMES) {
    const p = path.join(hooksDir, name);
    let existing: string | null = null;
    if (await pathExists(p)) {
      existing = await readFile(p, "utf8");
    }
    const next = applyHookMarkers(existing);
    if (next !== existing) {
      await writeFile(p, next, "utf8");
    }
    await chmod(p, 0o755);
  }
}

export async function uninstallGitHooks(cwd: string): Promise<void> {
  const hooksDir = path.join(cwd, ".git", "hooks");
  for (const name of HOOK_NAMES) {
    const p = path.join(hooksDir, name);
    if (!(await pathExists(p))) continue;
    const existing = await readFile(p, "utf8");
    const next = removeHookMarkers(existing);
    // Keep file even if empty
    if (next !== existing) {
      await writeFile(p, next, "utf8");
    }
  }
}

export function printCiSnippet(
  out: (line: string) => void = (l) => console.log(l),
): void {
  out(CI_SNIPPET.trimEnd());
}

export type InitOptions = {
  cwd: string;
  uninstall?: boolean;
  printCi?: boolean;
  claudeCode?: boolean;
  cursor?: boolean;
  /** Override for tests only — defaults to the real home directory. */
  homeDir?: string;
  /** Capture init stdout lines (tests). Defaults to console.log. */
  out?: (line: string) => void;
};

export async function runInit(opts: InitOptions): Promise<void> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const homeDir = opts.homeDir ?? homedir();
  if (opts.printCi) {
    printCiSnippet(out);
    return;
  }
  if (opts.uninstall) {
    await uninstallGitHooks(opts.cwd);
    if (opts.claudeCode) {
      await uninstallClaudeCodeHooks(opts.cwd);
      await uninstallClaudeCodeMemoryMcp(homeDir);
    }
    if (opts.cursor) {
      await uninstallCursorHooks(opts.cwd);
      await uninstallCursorMemoryMcp(homeDir);
      await uninstallCursorCacheMcp(homeDir);
    }
    return;
  }
  await installGitHooks(opts.cwd);
  const memoryClients: string[] = [];
  if (opts.claudeCode) {
    await installClaudeCodeHooks(opts.cwd);
    await installClaudeCodeMemoryMcp(homeDir);
    memoryClients.push("Claude Code (~/.claude.json)");
  }
  if (opts.cursor) {
    await installCursorHooks(opts.cwd);
    await installCursorMemoryMcp(homeDir);
    await installCursorCacheMcp(homeDir);
    memoryClients.push("Cursor (~/.cursor/mcp.json)");
  }
  const cfg = await ensureAiephConfig(opts.cwd);
  await ensureAiephGitignore(opts.cwd);
  for (const line of formatInitTelemetryNotice(cfg)) {
    out(line);
  }
  if (memoryClients.length > 0) {
    out(
      `aieph-memory: local personal memory MCP registered for ${memoryClients.join(", ")}. ` +
        "Restart the client to connect (new sessions only).",
    );
  }
  if (opts.claudeCode) {
    out(
      "aieph-memory: SessionStart hook installed — Claude Code will see a hint at the start of the " +
        "next session if any memory hasn't been re-verified against the repo in 7+ days.",
    );
    out(
      "aieph-cache: shared-cache PreToolUse hook installed for Claude Code — WebSearch/WebFetch will " +
        "check the cache first (fail-open).",
    );
  }
  if (opts.cursor) {
    out(
      "aieph-cache: shared-cache MCP (cache-serve) registered for Cursor. Add a Cursor rule such as " +
        '"Before using web search, call the aieph cache_lookup tool first" so the agent checks the ' +
        "cache; then restart Cursor to connect.",
    );
  }
}
