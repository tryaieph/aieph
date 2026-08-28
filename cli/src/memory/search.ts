import { closeIndexDb, openIndexDb, rebuildIndex, searchIndex } from "./index-db.js";
import { bothScopeRoots, projectScopeRoot, userScopeRoot, type ScopeRoot } from "./paths.js";
import { readAllEntries } from "./store.js";
import type { MemoryEntry, MemoryScope } from "./types.js";

export type SearchScope = MemoryScope | "both";

export type SearchOptions = {
  tags?: string[];
  scope?: SearchScope;
  limit?: number;
};

export type SearchHit = MemoryEntry & { rank: number };

function scopeRootsFor(cwd: string, scope: SearchScope): ScopeRoot[] {
  if (scope === "user") return [userScopeRoot()];
  if (scope === "project") return [projectScopeRoot(cwd)];
  return bothScopeRoots(cwd);
}

async function searchOneScope(root: ScopeRoot, query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const entries = await readAllEntries(root);
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const db = await openIndexDb(root);
  try {
    rebuildIndex(db, entries);
    const hits = searchIndex(db, query, { tags: opts.tags, limit: opts.limit });
    const results: SearchHit[] = [];
    for (const hit of hits) {
      const entry = byId.get(hit.id);
      if (entry) results.push({ ...entry, rank: hit.rank });
    }
    return results;
  } finally {
    closeIndexDb(db);
  }
}

/**
 * Searches user + project scopes (per SearchOptions.scope, default "both") and
 * merges the results. Project-scope hits are placed before user-scope hits when
 * ranks tie, per the spec's scope-merge order. Entries that another result's
 * `supersedes` list names are dropped (a working entry that has already been
 * folded into a consolidated one should not also show up verbatim).
 */
export async function searchMemory(cwd: string, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const scope = opts.scope ?? "both";
  const roots = scopeRootsFor(cwd, scope);
  const perScope = await Promise.all(roots.map((root) => searchOneScope(root, query, opts)));
  const merged = perScope.flat();

  const superseded = new Set<string>();
  for (const hit of merged) {
    for (const id of hit.supersedes) superseded.add(id);
  }

  const deduped = merged.filter((hit) => !superseded.has(hit.id));
  deduped.sort((a, b) => a.rank - b.rank);

  const limit = opts.limit ?? 50;
  return deduped.slice(0, limit);
}

/** Lists entries (no ranking) across the requested scope(s), most recently updated first. */
export async function listMemory(
  cwd: string,
  opts: { scope?: SearchScope; tier?: MemoryEntry["tier"]; tag?: string } = {},
): Promise<MemoryEntry[]> {
  const scope = opts.scope ?? "both";
  const roots = scopeRootsFor(cwd, scope);
  const perScope = await Promise.all(roots.map((root) => readAllEntries(root)));
  let all = perScope.flat();
  if (opts.tier) all = all.filter((e) => e.tier === opts.tier);
  if (opts.tag) all = all.filter((e) => e.tags.includes(opts.tag!));
  all.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return all;
}
