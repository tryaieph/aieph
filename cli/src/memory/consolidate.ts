import { bothScopeRoots, projectScopeRoot, userScopeRoot, type ScopeRoot } from "./paths.js";
import { readAllEntries } from "./store.js";
import type { ConsolidateCandidateGroup, MemoryEntry, MemoryScope } from "./types.js";

export const DEFAULT_CONSOLIDATE_AFTER_DAYS = 7;
const UNTAGGED = "untagged";

function ageInDays(createdIso: string, now: number): number {
  const created = Date.parse(createdIso);
  if (Number.isNaN(created)) return 0;
  return (now - created) / (1000 * 60 * 60 * 24);
}

function scopeRootsFor(cwd: string, scope: MemoryScope | "both"): ScopeRoot[] {
  if (scope === "user") return [userScopeRoot()];
  if (scope === "project") return [projectScopeRoot(cwd)];
  return bothScopeRoots(cwd);
}

function groupByTag(entries: MemoryEntry[], scope: MemoryScope): ConsolidateCandidateGroup[] {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? entry.tags : [UNTAGGED];
    for (const tag of tags) {
      const list = groups.get(tag) ?? [];
      list.push(entry);
      groups.set(tag, list);
    }
  }
  return Array.from(groups.entries()).map(([tag, groupEntries]) => ({ tag, scope, entries: groupEntries }));
}

/**
 * Finds `working`-tier entries older than `olderThanDays` (default 7), grouped
 * by tag, per scope. This only *finds candidates* — it does not summarize or
 * write anything. The connected AI reads these groups, writes a new
 * `consolidated`-tier entry (via memory.write) summarizing each group with
 * `supersedes` set to the group's entry ids, then archives the originals
 * (via memory.forget) once the summary is written.
 */
export async function findConsolidateCandidates(
  cwd: string,
  opts: { olderThanDays?: number; scope?: MemoryScope | "both" } = {},
): Promise<ConsolidateCandidateGroup[]> {
  const olderThanDays = opts.olderThanDays ?? DEFAULT_CONSOLIDATE_AFTER_DAYS;
  const roots = scopeRootsFor(cwd, opts.scope ?? "both");
  const now = Date.now();

  const groups: ConsolidateCandidateGroup[] = [];
  for (const root of roots) {
    const entries = await readAllEntries(root);
    const stale = entries.filter((e) => e.tier === "working" && ageInDays(e.created, now) >= olderThanDays);
    if (stale.length === 0) continue;
    groups.push(...groupByTag(stale, root.scope));
  }
  return groups;
}
