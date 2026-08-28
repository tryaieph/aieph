import { DEFAULT_CONSOLIDATE_AFTER_DAYS, findConsolidateCandidates } from "./consolidate.js";
import { bothScopeRoots, projectScopeRoot, userScopeRoot, type ScopeRoot } from "./paths.js";
import { listMemory, searchMemory, type SearchScope } from "./search.js";
import { archiveEntry, deleteEntry, findEntry, readAllEntries, saveEntry, verifyEntry, writeEntry } from "./store.js";
import type { ToolContext } from "./session.js";
import { ageInDays, DEFAULT_STALE_AFTER_DAYS, findStaleEntries } from "./stale.js";
import type { MemoryEntry, MemoryScope, MemoryTier } from "./types.js";

export type ToolContent = { type: "text"; text: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

export { DEFAULT_STALE_AFTER_DAYS };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function asScope(value: unknown): MemoryScope | undefined {
  return value === "user" || value === "project" ? value : undefined;
}

function asSearchScope(value: unknown): SearchScope | undefined {
  return value === "user" || value === "project" || value === "both" ? value : undefined;
}

function asTier(value: unknown): MemoryTier | undefined {
  return value === "pinned" || value === "working" || value === "consolidated" ? value : undefined;
}

/** Resolves the roots to try when a tool call gives an explicit scope, or both in project-first order. */
function rootsForLookup(cwd: string, scope: MemoryScope | undefined): ScopeRoot[] {
  if (scope) return [scope === "user" ? userScopeRoot() : projectScopeRoot(cwd)];
  return bothScopeRoots(cwd);
}

const writeTool: ToolDef = {
  name: "memory.write",
  description:
    "Save a fact, decision, or preference to the local personal memory so any AI client sharing this store can recall it later. Never store secrets (API keys, tokens, passwords).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The memory content." },
      tags: { type: "array", items: { type: "string" }, description: "Tags for later recall." },
      tier: {
        type: "string",
        enum: ["pinned", "working", "consolidated"],
        description: "pinned = never decays; working = default, decays after ~7 days; consolidated = a summary of older working entries.",
      },
      scope: {
        type: "string",
        enum: ["user", "project"],
        description: "user = follows you everywhere; project = this project only. Defaults to project.",
      },
      source_agent: { type: "string", description: "Name of the AI/client writing this memory." },
      supersedes: {
        type: "array",
        items: { type: "string" },
        description: "IDs of working entries this consolidated entry summarizes.",
      },
    },
    required: ["text"],
  },
  handler: async (args, { cwd }) => {
    const text = args.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail("memory.write requires a non-empty 'text' string.");
    }
    const scope = asScope(args.scope) ?? "project";
    const root = scope === "user" ? userScopeRoot() : projectScopeRoot(cwd);
    const entry = await writeEntry(root, {
      text,
      tags: asStringArray(args.tags),
      tier: asTier(args.tier),
      scope,
      sourceAgent: typeof args.source_agent === "string" ? args.source_agent : null,
      supersedes: asStringArray(args.supersedes),
    });
    return ok({ id: entry.id, scope: entry.scope, tier: entry.tier });
  },
};

const searchTool: ToolDef = {
  name: "memory.search",
  description:
    "Recall memories by free-text query and/or tags, merged across user and project scope by default.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search query. Empty string with tags = tag-only browse." },
      tags: { type: "array", items: { type: "string" } },
      scope: { type: "string", enum: ["user", "project", "both"], description: "Defaults to both." },
      limit: { type: "number" },
    },
  },
  handler: async (args, { cwd, session }) => {
    const query = typeof args.query === "string" ? args.query : "";
    const hits = await searchMemory(cwd, query, {
      tags: asStringArray(args.tags),
      scope: asSearchScope(args.scope),
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    session.recordTouched(hits.map((h) => h.id));
    return ok({ hits });
  },
};

const listTool: ToolDef = {
  name: "memory.list",
  description: "List memories (no ranking), optionally filtered by scope, tier, or a single tag.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["user", "project", "both"] },
      tier: { type: "string", enum: ["pinned", "working", "consolidated"] },
      tag: { type: "string" },
    },
  },
  handler: async (args, { cwd, session }) => {
    const entries = await listMemory(cwd, {
      scope: asSearchScope(args.scope),
      tier: asTier(args.tier),
      tag: typeof args.tag === "string" ? args.tag : undefined,
    });
    session.recordTouched(entries.map((e) => e.id));
    return ok({ entries });
  },
};

const pinTool: ToolDef = {
  name: "memory.pin",
  description: "Promote a working/consolidated entry to pinned (never decays).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      scope: { type: "string", enum: ["user", "project"], description: "Optional hint; searches both if omitted." },
    },
    required: ["id"],
  },
  handler: async (args, { cwd }) => {
    const id = args.id;
    if (typeof id !== "string" || id.length === 0) return fail("memory.pin requires an 'id' string.");
    for (const root of rootsForLookup(cwd, asScope(args.scope))) {
      const entry = await findEntry(root, id);
      if (entry) {
        const updated = { ...entry, tier: "pinned" as const, updated: new Date().toISOString() };
        await saveEntry(root, updated);
        return ok({ id, tier: "pinned", scope: root.scope });
      }
    }
    return fail(`No memory found with id ${id}.`);
  },
};

const forgetTool: ToolDef = {
  name: "memory.forget",
  description: "Remove an entry: archives it by default, or permanently deletes it when hard=true.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      scope: { type: "string", enum: ["user", "project"] },
      hard: { type: "boolean", description: "true = permanently delete instead of archiving." },
    },
    required: ["id"],
  },
  handler: async (args, { cwd }) => {
    const id = args.id;
    if (typeof id !== "string" || id.length === 0) return fail("memory.forget requires an 'id' string.");
    const hard = args.hard === true;
    for (const root of rootsForLookup(cwd, asScope(args.scope))) {
      const removed = hard ? await deleteEntry(root, id) : await archiveEntry(root, id);
      if (removed) return ok({ id, scope: root.scope, hard });
    }
    return fail(`No memory found with id ${id}.`);
  },
};

const consolidateTool: ToolDef = {
  name: "memory.consolidate",
  description:
    `Find working-tier entries older than ${DEFAULT_CONSOLIDATE_AFTER_DAYS} days (default), grouped by tag. ` +
    "Does NOT summarize anything itself — the calling AI should read the returned groups, write one " +
    "memory.write(tier='consolidated', supersedes=[...ids]) per group summarizing it, then " +
    "memory.forget each original id.",
  inputSchema: {
    type: "object",
    properties: {
      older_than_days: { type: "number" },
      scope: { type: "string", enum: ["user", "project", "both"] },
    },
  },
  handler: async (args, { cwd }) => {
    const groups = await findConsolidateCandidates(cwd, {
      olderThanDays: typeof args.older_than_days === "number" ? args.older_than_days : undefined,
      scope: asSearchScope(args.scope),
    });
    return ok({ groups });
  },
};

type ReviewCandidate = {
  id: string;
  scope: MemoryScope;
  tier: MemoryTier;
  tags: string[];
  body: string;
  verified: string;
  verifiedAgeDays: number;
  reason: "touched" | "stale";
};

function toCandidate(entry: MemoryEntry, now: number, reason: "touched" | "stale"): ReviewCandidate {
  return {
    id: entry.id,
    scope: entry.scope,
    tier: entry.tier,
    tags: entry.tags,
    body: entry.body,
    verified: entry.verified,
    verifiedAgeDays: Math.round(ageInDays(entry.verified, now) * 10) / 10,
    reason,
  };
}

const reviewTool: ToolDef = {
  name: "memory.review",
  description:
    "Return entries that may have gone stale relative to the repo, for the AI to re-check against " +
    "current reality. By default returns the entries surfaced during THIS session (memory.search/list) " +
    "— the natural set to re-verify at session-end. Set touched_only=false to instead sweep all entries " +
    "not verified within stale_after_days. Does NOT decide staleness itself: for each returned entry, " +
    "the AI should compare it to the current repo, then call memory.verify with status current/stale/obsolete.",
  inputSchema: {
    type: "object",
    properties: {
      touched_only: {
        type: "boolean",
        description: "Default true: only entries surfaced this session. false: sweep by verified age.",
      },
      stale_after_days: {
        type: "number",
        description: `Only entries last verified more than this many days ago (default ${DEFAULT_STALE_AFTER_DAYS}).`,
      },
      scope: { type: "string", enum: ["user", "project", "both"] },
    },
  },
  handler: async (args, { cwd, session }) => {
    const now = Date.now();
    const touchedOnly = args.touched_only !== false;
    const scope = asSearchScope(args.scope) ?? "both";

    if (touchedOnly) {
      // Only apply a staleness age filter here if the caller explicitly asked for one.
      const minAge = typeof args.stale_after_days === "number" ? args.stale_after_days : 0;
      const touched = new Set(session.getTouched());
      const roots =
        scope === "user" ? [userScopeRoot()] : scope === "project" ? [projectScopeRoot(cwd)] : bothScopeRoots(cwd);
      const candidates: ReviewCandidate[] = [];
      for (const root of roots) {
        for (const entry of await readAllEntries(root)) {
          if (!touched.has(entry.id)) continue;
          if (ageInDays(entry.verified, now) < minAge) continue;
          candidates.push(toCandidate(entry, now, "touched"));
        }
      }
      return ok({ candidates });
    }

    const stale = await findStaleEntries(cwd, {
      staleAfterDays: typeof args.stale_after_days === "number" ? args.stale_after_days : undefined,
      scope,
    });
    const candidates: ReviewCandidate[] = stale.map((c) => ({ ...c, reason: "stale" as const }));
    return ok({ candidates });
  },
};

const verifyTool: ToolDef = {
  name: "memory.verify",
  description:
    "Record the outcome of re-checking an entry against the current repo/reality. " +
    "status='current' bumps its verified timestamp (still true). status='stale' rewrites the body with " +
    "replacement_text and bumps verified (claim changed). status='obsolete' archives it (no longer relevant).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: {
        type: "string",
        enum: ["current", "stale", "obsolete"],
        description: "current = still true; stale = rewrite with replacement_text; obsolete = archive.",
      },
      replacement_text: { type: "string", description: "New body, required when status='stale'." },
      scope: { type: "string", enum: ["user", "project"], description: "Optional hint; searches both if omitted." },
    },
    required: ["id", "status"],
  },
  handler: async (args, { cwd }) => {
    const id = args.id;
    if (typeof id !== "string" || id.length === 0) return fail("memory.verify requires an 'id' string.");
    const status = args.status;
    if (status !== "current" && status !== "stale" && status !== "obsolete") {
      return fail("memory.verify requires status = current | stale | obsolete.");
    }
    const replacementText = typeof args.replacement_text === "string" ? args.replacement_text : undefined;
    if (status === "stale" && (replacementText === undefined || replacementText.trim().length === 0)) {
      return fail("memory.verify status='stale' requires a non-empty 'replacement_text'.");
    }

    for (const root of rootsForLookup(cwd, asScope(args.scope))) {
      if (status === "obsolete") {
        const removed = await archiveEntry(root, id);
        if (removed) return ok({ id, status, scope: root.scope });
        continue;
      }
      const updated = await verifyEntry(root, id, status === "stale" ? { replacementText } : {});
      if (updated) {
        return ok({ id, status, scope: root.scope, verified: updated.verified });
      }
    }
    return fail(`No memory found with id ${id}.`);
  },
};

export const TOOLS: ToolDef[] = [
  writeTool,
  searchTool,
  listTool,
  pinTool,
  forgetTool,
  consolidateTool,
  reviewTool,
  verifyTool,
];
