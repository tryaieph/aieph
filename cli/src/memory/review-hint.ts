import type { StaleCandidate } from "./stale.js";

/**
 * Formats stale candidates as a short plain-text hint for a SessionStart hook.
 * SessionStart hook stdout is the one hook output Claude Code actually injects
 * as context the model can see and act on (SessionEnd stdout is not — it only
 * reaches a debug log), so this is deliberately printed at the START of the
 * next session, not the end of the one that touched them. Returns "" (nothing
 * to print, hook stays silent) when there are no candidates — fail-open, no
 * noise on every session.
 */
export function formatReviewHint(candidates: StaleCandidate[], limit = 5): string {
  if (candidates.length === 0) return "";
  const shown = candidates.slice(0, limit);
  const lines = shown.map((c) => `  - [${c.id}] (${Math.round(c.verifiedAgeDays)}d) ${c.body.slice(0, 80)}`);
  const more = candidates.length > shown.length ? `\n  ...and ${candidates.length - shown.length} more.` : "";
  return (
    `aieph-memory: ${candidates.length} memor${candidates.length === 1 ? "y" : "ies"} not re-verified against ` +
    `the repo in a while:\n${lines.join("\n")}${more}\n` +
    "Consider calling memory.review then memory.verify on these before trusting them."
  );
}
