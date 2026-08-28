import { bothScopeRoots, projectScopeRoot, userScopeRoot } from "./paths.js";
import { readAllEntries } from "./store.js";
import type { MemoryEntry, MemoryScope, MemoryTier } from "./types.js";
import type { SearchScope } from "./search.js";

export const DEFAULT_STALE_AFTER_DAYS = 7;

export type StaleCandidate = {
  id: string;
  scope: MemoryScope;
  tier: MemoryTier;
  tags: string[];
  body: string;
  verified: string;
  verifiedAgeDays: number;
};

export function ageInDays(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / (1000 * 60 * 60 * 24);
}

function toCandidate(entry: MemoryEntry, now: number): StaleCandidate {
  return {
    id: entry.id,
    scope: entry.scope,
    tier: entry.tier,
    tags: entry.tags,
    body: entry.body,
    verified: entry.verified,
    verifiedAgeDays: Math.round(ageInDays(entry.verified, now) * 10) / 10,
  };
}

/**
 * Sweeps every entry (regardless of session) and returns those not re-verified
 * against the repo within `staleAfterDays`. Shared by memory.review
 * (touched_only=false) and the `aieph memory review-hint` CLI (used by the
 * SessionStart hook, which has no session/touched-entry context to draw on).
 */
export async function findStaleEntries(
  cwd: string,
  opts: { staleAfterDays?: number; scope?: SearchScope } = {},
): Promise<StaleCandidate[]> {
  const now = Date.now();
  const staleAfter = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const scope = opts.scope ?? "both";
  const roots =
    scope === "user" ? [userScopeRoot()] : scope === "project" ? [projectScopeRoot(cwd)] : bothScopeRoots(cwd);

  const candidates: StaleCandidate[] = [];
  for (const root of roots) {
    for (const entry of await readAllEntries(root)) {
      if (ageInDays(entry.verified, now) < staleAfter) continue;
      candidates.push(toCandidate(entry, now));
    }
  }
  candidates.sort((a, b) => b.verifiedAgeDays - a.verifiedAgeDays);
  return candidates;
}
