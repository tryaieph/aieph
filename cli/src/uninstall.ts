import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uninstallClaudeCodeHooks } from "./claude-code.js";
import { uninstallCursorHooks } from "./cursor.js";
import {
  DELIVERY_FILE,
  applyManagedBlock,
  removeAiephGitignore,
} from "./delivery.js";
import { uninstallGitHooks } from "./init.js";

export type UninstallOptions = {
  cwd: string;
  /** When false (default), list planned actions only. */
  yes?: boolean;
  out?: (line: string) => void;
};

type PlannedAction = {
  id: string;
  description: string;
  rel?: string;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function planUninstall(cwd: string): Promise<PlannedAction[]> {
  const root = path.resolve(cwd);
  const actions: PlannedAction[] = [];

  for (const name of ["post-merge", "post-checkout"] as const) {
    const rel = path.join(".git", "hooks", name);
    const p = path.join(root, rel);
    if (!(await pathExists(p))) continue;
    const text = await readFile(p, "utf8");
    if (text.includes("# aieph:start")) {
      actions.push({
        id: `git-hook:${name}`,
        description: `Remove # aieph:start…# aieph:end from ${rel}`,
        rel,
      });
    }
  }

  const cursorRel = path.join(".cursor", "hooks.json");
  const cursorPath = path.join(root, cursorRel);
  if (await pathExists(cursorPath)) {
    const text = await readFile(cursorPath, "utf8");
    if (text.includes("aieph observe")) {
      actions.push({
        id: "cursor-hooks",
        description: `Remove aieph afterFileEdit entry from ${cursorRel}`,
        rel: cursorRel,
      });
    }
  }

  const claudeRel = path.join(".claude", "settings.json");
  const claudePath = path.join(root, claudeRel);
  if (await pathExists(claudePath)) {
    const text = await readFile(claudePath, "utf8");
    if (text.includes("aieph observe") || text.includes("aieph guard")) {
      actions.push({
        id: "claude-settings",
        description: `Remove aieph PostToolUse handler from ${claudeRel}`,
        rel: claudeRel,
      });
    }
  }

  const agentsPath = path.join(root, DELIVERY_FILE);
  if (await pathExists(agentsPath)) {
    const text = await readFile(agentsPath, "utf8");
    if (text.includes("<!-- aieph:start -->")) {
      actions.push({
        id: "agents-block",
        description: `Remove <!-- aieph:start -->…<!-- aieph:end --> from ${DELIVERY_FILE}`,
        rel: DELIVERY_FILE,
      });
    }
  }

  const giRel = ".gitignore";
  const giPath = path.join(root, giRel);
  if (await pathExists(giPath)) {
    const text = await readFile(giPath, "utf8");
    if (removeAiephGitignore(text) !== null) {
      actions.push({
        id: "gitignore",
        description: `Remove .aieph/ line from ${giRel}`,
        rel: giRel,
      });
    }
  }

  if (await pathExists(path.join(root, ".aieph"))) {
    actions.push({
      id: "aieph-dir",
      description: "Remove project .aieph/ directory (CLI-owned state/cache)",
      rel: ".aieph",
    });
  }

  return actions;
}

async function backupFile(
  backupRoot: string,
  cwd: string,
  rel: string,
): Promise<void> {
  const src = path.join(cwd, rel);
  if (!(await pathExists(src))) return;
  const dest = path.join(backupRoot, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

async function removeAgentsBlock(cwd: string): Promise<void> {
  const p = path.join(cwd, DELIVERY_FILE);
  if (!(await pathExists(p))) return;
  const existing = await readFile(p, "utf8");
  const result = applyManagedBlock(existing, null);
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (result.changed && result.content !== null) {
    await writeFile(p, result.content, "utf8");
  }
}

async function removeGitignoreLine(cwd: string): Promise<void> {
  const p = path.join(cwd, ".gitignore");
  if (!(await pathExists(p))) return;
  const existing = await readFile(p, "utf8");
  const next = removeAiephGitignore(existing);
  if (next !== null) {
    await writeFile(p, next, "utf8");
  }
}

/**
 * Reverse CLI-owned project writes. Default dry-run; --yes applies.
 * Does not touch MCP configs, npm global, or home-directory files.
 */
export async function runUninstall(opts: UninstallOptions): Promise<void> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const cwd = path.resolve(opts.cwd);
  const actions = await planUninstall(cwd);

  if (actions.length === 0) {
    out("Nothing to remove (already clean or never installed here).");
    out(
      "Manual leftovers (MCP / npm global / AIEPH_* env): see docs/UNINSTALL.md.",
    );
    return;
  }

  out("Planned removals (CLI-confirmed project paths only):");
  for (const a of actions) {
    out(`  - ${a.description}`);
  }
  out(
    "Not touched: MCP configs, npm global bin, home ~/.cursor|~/.claude, env AIEPH_*.",
  );

  if (!opts.yes) {
    out("Dry-run only. Re-run with --yes to apply.");
    return;
  }

  const backupRoot = path.join(
    tmpdir(),
    `aieph-uninstall-${Date.now()}-${process.pid}`,
  );
  await mkdir(backupRoot, { recursive: true });
  for (const a of actions) {
    if (!a.rel) continue;
    if (a.id === "aieph-dir") {
      await cp(path.join(cwd, ".aieph"), path.join(backupRoot, ".aieph"), {
        recursive: true,
      });
    } else {
      await backupFile(backupRoot, cwd, a.rel);
    }
  }
  out(`Backup: ${backupRoot}`);

  await uninstallGitHooks(cwd);
  await uninstallCursorHooks(cwd);
  await uninstallClaudeCodeHooks(cwd);
  await removeAgentsBlock(cwd);
  await removeGitignoreLine(cwd);

  const aiephDir = path.join(cwd, ".aieph");
  if (await pathExists(aiephDir)) {
    await rm(aiephDir, { recursive: true, force: true });
  }

  out("Uninstall applied.");
}
