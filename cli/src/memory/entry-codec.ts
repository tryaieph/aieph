import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import type { MemoryEntry, MemoryScope, MemoryTier } from "./types.js";

const TIERS: MemoryTier[] = ["pinned", "working", "consolidated"];
const SCOPES: MemoryScope[] = ["user", "project"];

function asStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asTier(value: string | string[] | undefined): MemoryTier {
  const v = Array.isArray(value) ? value[0] : value;
  return TIERS.includes(v as MemoryTier) ? (v as MemoryTier) : "working";
}

function asScope(value: string | string[] | undefined, fallback: MemoryScope): MemoryScope {
  const v = Array.isArray(value) ? value[0] : value;
  return SCOPES.includes(v as MemoryScope) ? (v as MemoryScope) : fallback;
}

/** Encodes a MemoryEntry as a Markdown+frontmatter document (file contents). */
export function encodeEntry(entry: MemoryEntry): string {
  const fields: Record<string, string | string[]> = {
    id: entry.id,
    created: entry.created,
    updated: entry.updated,
    verified: entry.verified,
    tier: entry.tier,
    tags: entry.tags,
    scope: entry.scope,
    source_agent: entry.sourceAgent ?? "",
    supersedes: entry.supersedes,
  };
  return stringifyFrontmatter(fields, entry.body);
}

/**
 * Decodes a Markdown+frontmatter document back into a MemoryEntry.
 * `fallbackScope` and `fallbackId` are used when the document is malformed/missing
 * fields (e.g. hand-edited files) so a read never throws on a single bad file.
 */
export function decodeEntry(
  raw: string,
  fallbackScope: MemoryScope,
  fallbackId: string,
): MemoryEntry {
  const doc = parseFrontmatter(raw);
  if (!doc) {
    const epoch = new Date(0).toISOString();
    return {
      id: fallbackId,
      created: epoch,
      updated: epoch,
      verified: epoch,
      tier: "working",
      tags: [],
      scope: fallbackScope,
      sourceAgent: null,
      supersedes: [],
      body: raw,
    };
  }
  const { fields, body } = doc;
  const idField = fields.id;
  const id = typeof idField === "string" && idField.length > 0 ? idField : fallbackId;
  const created = typeof fields.created === "string" ? fields.created : new Date(0).toISOString();
  const updated = typeof fields.updated === "string" ? fields.updated : created;
  // Backward compat: entries written before `verified` existed fall back to
  // `created` (treated as verified-at-creation).
  const verified = typeof fields.verified === "string" ? fields.verified : created;
  const sourceAgentField = fields.source_agent;
  const sourceAgent =
    typeof sourceAgentField === "string" && sourceAgentField.length > 0 ? sourceAgentField : null;

  return {
    id,
    created,
    updated,
    verified,
    tier: asTier(fields.tier),
    tags: asStringArray(fields.tags),
    scope: asScope(fields.scope, fallbackScope),
    sourceAgent,
    supersedes: asStringArray(fields.supersedes),
    body,
  };
}
