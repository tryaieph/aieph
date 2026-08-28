import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { MemoryScope } from "./types.js";

export type ScopeRoot = {
  scope: MemoryScope;
  /** `<root>/.aieph` */
  aiephDir: string;
  /** `<root>/.aieph/memory` — canonical entry files live here. */
  entriesDir: string;
  /** `<root>/.aieph/memory/archive` — superseded/forgotten entries land here. */
  archiveDir: string;
  /** `<root>/.aieph/memory.index` — rebuildable SQLite FTS5 cache (never synced). */
  indexPath: string;
};

function buildScopeRoot(scope: MemoryScope, root: string): ScopeRoot {
  const aiephDir = path.join(root, ".aieph");
  return {
    scope,
    aiephDir,
    entriesDir: path.join(aiephDir, "memory"),
    archiveDir: path.join(aiephDir, "memory", "archive"),
    indexPath: path.join(aiephDir, "memory.index"),
  };
}

/** User-wide scope root: `~/.aieph/memory`. Follows you across every project. */
export function userScopeRoot(): ScopeRoot {
  return buildScopeRoot("user", homedir());
}

/**
 * Project scope root: `<cwd>/.aieph/memory`. Mirrors the rest of the aieph CLI
 * (config.ts, observe, sync), which all treat `cwd` as the project root rather
 * than walking up to a git/workspace root.
 */
export function projectScopeRoot(cwd: string): ScopeRoot {
  return buildScopeRoot("project", path.resolve(cwd));
}

export async function ensureScopeDirs(root: ScopeRoot): Promise<void> {
  await mkdir(root.entriesDir, { recursive: true });
  await mkdir(root.archiveDir, { recursive: true });
}

/** Both scope roots, in merge order (project first, then user). */
export function bothScopeRoots(cwd: string): ScopeRoot[] {
  return [projectScopeRoot(cwd), userScopeRoot()];
}
