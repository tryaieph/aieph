/**
 * Client-side ranking blob: fetch, disk cache (24h TTL), sort helpers.
 * Fail-open: any fetch/parse error → null (caller keeps local order).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_RANKING_TRIALS_THRESHOLD = 20;
export const RANKING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const RANKING_FETCH_TIMEOUT_MS = 3000;
export const RANKING_CACHE_FILE = "ranking-cache.json";

export type RankingRuleStats = {
  hits: number;
  trials: number;
  resolved?: number;
};

export type RankingBlob = {
  schema: 1;
  generated_at: string;
  rules: Record<string, RankingRuleStats>;
};

type CacheFile = {
  fetched_at: string; // ISO
  blob: RankingBlob;
};

export function rankingUrlFromEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    u.pathname = "/v1/ranking";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return endpoint
      .replace(/\/v1\/observe\/?(\?.*)?$/, "/v1/ranking")
      .replace(/\?.*$/, "");
  }
}

export function totalTrials(blob: RankingBlob): number {
  let n = 0;
  for (const s of Object.values(blob.rules)) {
    n += s.trials;
  }
  return n;
}

export function parseRankingBlob(raw: unknown): RankingBlob | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "schema" && k !== "generated_at" && k !== "rules") return null;
  }
  if (o.schema !== 1) return null;
  if (
    typeof o.generated_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(o.generated_at)
  ) {
    return null;
  }
  if (o.rules === null || typeof o.rules !== "object" || Array.isArray(o.rules)) {
    return null;
  }
  const rules: Record<string, RankingRuleStats> = {};
  for (const [ruleId, stats] of Object.entries(
    o.rules as Record<string, unknown>,
  )) {
    if (!ruleId) return null;
    if (stats === null || typeof stats !== "object" || Array.isArray(stats)) {
      return null;
    }
    const s = stats as Record<string, unknown>;
    // Unknown fields on rule stats are ignored (forward-compatible).
    if (typeof s.hits !== "number" || !Number.isInteger(s.hits) || s.hits < 0) {
      return null;
    }
    if (
      typeof s.trials !== "number" ||
      !Number.isInteger(s.trials) ||
      s.trials < 0
    ) {
      return null;
    }
    if (s.hits > s.trials) return null;
    const entry: RankingRuleStats = { hits: s.hits, trials: s.trials };
    if (
      typeof s.resolved === "number" &&
      Number.isInteger(s.resolved) &&
      s.resolved >= 0
    ) {
      entry.resolved = s.resolved;
    }
    rules[ruleId] = entry;
  }
  return { schema: 1, generated_at: o.generated_at, rules };
}

/** Parse rule_id `package:from->to:slug` (scoped packages allowed). */
export function parseRuleIdPackageMajor(
  ruleId: string,
): { package: string; from_major: number } | null {
  const m = ruleId.match(/^(.+):(\d+)->(\d+):(.+)$/);
  if (!m) return null;
  return { package: m[1]!, from_major: parseInt(m[2]!, 10) };
}

/**
 * Best hit rate among rules matching row with trials >= threshold.
 * null → treat as unranked (local pinnedShare order).
 */
export function rankingRateForRow(
  row: { name: string; inUseMajor: number },
  ranking: RankingBlob | null | undefined,
  trialsThreshold: number = DEFAULT_RANKING_TRIALS_THRESHOLD,
): number | null {
  if (!ranking) return null;
  let best: number | null = null;
  for (const [id, stats] of Object.entries(ranking.rules)) {
    if (stats.trials < trialsThreshold || stats.trials <= 0) continue;
    const parsed = parseRuleIdPackageMajor(id);
    if (!parsed) continue;
    if (parsed.package !== row.name || parsed.from_major !== row.inUseMajor) {
      continue;
    }
    const rate = stats.hits / stats.trials;
    if (best === null || rate > best) best = rate;
  }
  return best;
}

function cachePath(cwd: string): string {
  return path.join(cwd, ".aieph", RANKING_CACHE_FILE);
}

export async function loadCachedRanking(
  cwd: string,
  now: Date = new Date(),
): Promise<RankingBlob | null> {
  try {
    const raw = await readFile(cachePath(cwd), "utf8");
    const obj = JSON.parse(raw) as Partial<CacheFile>;
    if (typeof obj.fetched_at !== "string") return null;
    const fetched = Date.parse(obj.fetched_at);
    if (!Number.isFinite(fetched)) return null;
    if (now.getTime() - fetched > RANKING_CACHE_TTL_MS) return null;
    return parseRankingBlob(obj.blob);
  } catch {
    return null;
  }
}

export async function saveCachedRanking(
  cwd: string,
  blob: RankingBlob,
  now: Date = new Date(),
): Promise<void> {
  const dir = path.join(cwd, ".aieph");
  await mkdir(dir, { recursive: true });
  const payload: CacheFile = {
    fetched_at: now.toISOString(),
    blob,
  };
  await writeFile(cachePath(cwd), `${JSON.stringify(payload)}\n`, "utf8");
}

export async function fetchRanking(opts: {
  endpoint: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<RankingBlob | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RANKING_FETCH_TIMEOUT_MS;
  const url = rankingUrlFromEndpoint(opts.endpoint);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseRankingBlob(data);
  } catch {
    return null;
  }
}

export type ResolveRankingOptions = {
  cwd: string;
  /** Full observe endpoint or null/undefined when unset. */
  endpoint?: string | null;
  fetchFn?: typeof fetch;
  now?: Date;
  /** When true (hook --no-write), skip network entirely. */
  noWrite?: boolean;
  timeoutMs?: number;
};

/**
 * Resolve ranking for sync: cache → fetch → cache write.
 * Returns null on skip/failure (caller uses local order).
 */
export async function resolveRankingForSync(
  opts: ResolveRankingOptions,
): Promise<RankingBlob | null> {
  if (opts.noWrite === true) return null;
  const endpoint = opts.endpoint;
  if (!endpoint) return null;
  const now = opts.now ?? new Date();
  const cached = await loadCachedRanking(opts.cwd, now);
  if (cached) return cached;
  const fetched = await fetchRanking({
    endpoint,
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs,
  });
  if (!fetched) return null;
  try {
    await saveCachedRanking(opts.cwd, fetched, now);
  } catch {
    // fail-open: still return fetched blob
  }
  return fetched;
}
