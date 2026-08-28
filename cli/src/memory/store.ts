import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeEntry, encodeEntry } from "./entry-codec.js";
import { generateUlid } from "./ulid.js";
import type { ScopeRoot } from "./paths.js";
import { ensureScopeDirs } from "./paths.js";
import type { MemoryEntry, MemoryEntryInput } from "./types.js";

function entryPath(root: ScopeRoot, id: string): string {
  return path.join(root.entriesDir, `${id}.md`);
}

function archivePath(root: ScopeRoot, id: string): string {
  return path.join(root.archiveDir, `${id}.md`);
}

/** Writes a new entry (or overwrite of an existing id) to `root`. Returns the stored entry. */
export async function writeEntry(root: ScopeRoot, input: MemoryEntryInput): Promise<MemoryEntry> {
  await ensureScopeDirs(root);
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: generateUlid(),
    created: now,
    updated: now,
    verified: now, // a fresh write is verified-by-construction
    tier: input.tier ?? "working",
    tags: input.tags ?? [],
    scope: root.scope,
    sourceAgent: input.sourceAgent ?? null,
    supersedes: input.supersedes ?? [],
    body: input.text,
  };
  await writeFile(entryPath(root, entry.id), encodeEntry(entry), "utf8");
  return entry;
}

/**
 * Records the outcome of re-checking an entry against current reality (the repo).
 * Always bumps `verified` to now. When `replacementText` is given, the claim was
 * stale and is rewritten (also bumps `updated`). Returns the updated entry, or
 * null if the id is not found in this root.
 */
export async function verifyEntry(
  root: ScopeRoot,
  id: string,
  opts: { replacementText?: string } = {},
): Promise<MemoryEntry | null> {
  const existing = await findEntry(root, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: MemoryEntry = {
    ...existing,
    verified: now,
    ...(opts.replacementText !== undefined
      ? { body: opts.replacementText, updated: now }
      : {}),
  };
  await saveEntry(root, updated);
  return updated;
}

/** Overwrites an existing entry in place (used by pin/consolidate bookkeeping). */
export async function saveEntry(root: ScopeRoot, entry: MemoryEntry): Promise<void> {
  await ensureScopeDirs(root);
  await writeFile(entryPath(root, entry.id), encodeEntry(entry), "utf8");
}

/** Reads every non-archived entry in `root`. Corrupt/malformed files are skipped, not thrown. */
export async function readAllEntries(root: ScopeRoot): Promise<MemoryEntry[]> {
  let names: string[];
  try {
    names = await readdir(root.entriesDir, { withFileTypes: false });
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    try {
      const raw = await readFile(path.join(root.entriesDir, name), "utf8");
      entries.push(decodeEntry(raw, root.scope, id));
    } catch {
      // Skip unreadable files rather than fail the whole read.
    }
  }
  return entries;
}

export async function findEntry(root: ScopeRoot, id: string): Promise<MemoryEntry | null> {
  try {
    const raw = await readFile(entryPath(root, id), "utf8");
    return decodeEntry(raw, root.scope, id);
  } catch {
    return null;
  }
}

/** Moves an entry's file into `archive/` (used by consolidate + forget-with-history). */
export async function archiveEntry(root: ScopeRoot, id: string): Promise<boolean> {
  await ensureScopeDirs(root);
  try {
    await rename(entryPath(root, id), archivePath(root, id));
    return true;
  } catch {
    return false;
  }
}

/** Permanently deletes an entry's file (no archive copy). */
export async function deleteEntry(root: ScopeRoot, id: string): Promise<boolean> {
  try {
    await rm(entryPath(root, id));
    return true;
  } catch {
    return false;
  }
}
