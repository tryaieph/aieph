export type MemoryTier = "pinned" | "working" | "consolidated";
export type MemoryScope = "user" | "project";

export type MemoryEntry = {
  id: string;
  created: string; // ISO 8601
  updated: string; // ISO 8601
  /**
   * ISO 8601 timestamp of the last time this entry's claim was checked against
   * reality (the repo / the world), NOT just when it was last written. A fresh
   * write is verified-by-construction, so it defaults to `created`. `updated`
   * moves on any edit; `verified` moves only when someone re-confirms the claim
   * still holds — this is the signal that separates "recently touched" from
   * "recently confirmed true", i.e. how we detect a memory that has gone stale
   * relative to the repo.
   */
  verified: string; // ISO 8601
  tier: MemoryTier;
  tags: string[];
  scope: MemoryScope;
  sourceAgent: string | null;
  supersedes: string[];
  body: string;
};

export type MemoryEntryInput = {
  text: string;
  tags?: string[];
  tier?: MemoryTier;
  scope?: MemoryScope;
  sourceAgent?: string | null;
  supersedes?: string[];
};

export type ConsolidateCandidateGroup = {
  tag: string;
  scope: MemoryScope;
  entries: MemoryEntry[];
};
