import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ScopeRoot } from "./paths.js";
import type { MemoryEntry, MemoryTier } from "./types.js";

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
  id UNINDEXED,
  tier UNINDEXED,
  tags,
  body,
  created UNINDEXED,
  updated UNINDEXED
);
`;

/**
 * Opens (creating if needed) the rebuildable FTS5 index file for a scope root.
 * The index is a cache derived from the Markdown entries — never the canonical
 * store — so callers should treat it as disposable and call rebuildIndex to
 * repopulate it from disk.
 */
export async function openIndexDb(root: ScopeRoot): Promise<DatabaseSync> {
  await mkdir(root.aiephDir, { recursive: true });
  const db = new DatabaseSync(root.indexPath);
  db.exec(SCHEMA);
  return db;
}

/** Wipes and repopulates the index from the given entries (the source of truth). */
export function rebuildIndex(db: DatabaseSync, entries: MemoryEntry[]): void {
  db.exec("DELETE FROM entries;");
  const insert = db.prepare(
    "INSERT INTO entries (id, tier, tags, body, created, updated) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const entry of entries) {
    insert.run(entry.id, entry.tier, entry.tags.join(" "), entry.body, entry.created, entry.updated);
  }
}

/** Quotes each whitespace-separated token as an FTS5 phrase and ANDs them together. */
function escapeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export type IndexSearchHit = {
  id: string;
  tier: MemoryTier;
  rank: number;
};

export type IndexSearchOptions = {
  tags?: string[];
  limit?: number;
};

/**
 * Full-text search over body+tags, ranked by BM25 (lower = more relevant, per
 * SQLite's bm25() convention). An empty query with tags set falls back to a
 * tag-only filter (browsing by tag with no free-text term).
 */
export function searchIndex(db: DatabaseSync, query: string, opts: IndexSearchOptions = {}): IndexSearchHit[] {
  const limit = opts.limit ?? 50;
  const trimmedQuery = query.trim();
  const tagClauses = (opts.tags ?? []).map((t) => `"${t.replace(/"/g, '""')}"`);

  const matchParts: string[] = [];
  if (trimmedQuery.length > 0) matchParts.push(escapeFtsQuery(trimmedQuery));
  for (const t of tagClauses) matchParts.push(`tags:${t}`);

  if (matchParts.length === 0) {
    // Nothing to search on — return the most recently updated entries.
    const rows = db
      .prepare("SELECT id, tier FROM entries ORDER BY updated DESC LIMIT ?")
      .all(limit) as { id: string; tier: MemoryTier }[];
    return rows.map((r) => ({ id: r.id, tier: r.tier, rank: 0 }));
  }

  const matchExpr = matchParts.join(" AND ");
  const rows = db
    .prepare(
      "SELECT id, tier, bm25(entries) as rank FROM entries WHERE entries MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(matchExpr, limit) as { id: string; tier: MemoryTier; rank: number }[];
  return rows.map((r) => ({ id: r.id, tier: r.tier, rank: r.rank }));
}

export function closeIndexDb(db: DatabaseSync): void {
  db.close();
}
