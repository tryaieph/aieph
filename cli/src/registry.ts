import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RegistryPackage } from "./types.js";

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org";

/** Only period supported by npm's per-version downloads endpoint. */
export const DOWNLOADS_PERIOD = "last-week" as const;

/** Disk cache TTL for downloads API responses. */
export const DOWNLOADS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Retention floor for eviction: a cache file is removed only once it is BOTH
 * unused this run AND older than this. Keeps a partial sync from wiping fresh
 * caches of packages it happened not to touch.
 */
export const DOWNLOADS_CACHE_EVICT_MS = 7 * 24 * 60 * 60 * 1000;

export type FetchFn = typeof fetch;

export type RegistryResult =
  | { ok: true; data: RegistryPackage }
  | { ok: false; reason: "unavailable" };

export type VersionDownloadsResult =
  | {
      ok: true;
      period: typeof DOWNLOADS_PERIOD;
      downloads: Record<string, number>;
    }
  | { ok: false; reason: "unavailable" };

export type DownloadsFetchOptions = {
  fetchFn?: FetchFn;
  /** When set, successful responses are cached under this directory (TTL 24h). */
  cacheDir?: string;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
};

type CachePayload = {
  cachedAt: number;
  period: typeof DOWNLOADS_PERIOD;
  downloads: Record<string, number>;
};

function encodePackageName(name: string): string {
  if (name.startsWith("@")) {
    const i = name.indexOf("/");
    if (i === -1) return encodeURIComponent(name);
    return `${name.slice(0, i)}%2F${name.slice(i + 1)}`;
  }
  return encodeURIComponent(name);
}

function cacheFilePath(cacheDir: string, name: string): string {
  return path.join(cacheDir, `${encodeURIComponent(name)}.json`);
}

async function readDownloadsCache(
  cacheDir: string,
  name: string,
  nowMs: number,
): Promise<VersionDownloadsResult | null> {
  try {
    const raw = await readFile(cacheFilePath(cacheDir, name), "utf8");
    const parsed = JSON.parse(raw) as CachePayload;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.cachedAt !== "number" ||
      parsed.period !== DOWNLOADS_PERIOD ||
      !parsed.downloads ||
      typeof parsed.downloads !== "object"
    ) {
      return null;
    }
    if (nowMs - parsed.cachedAt > DOWNLOADS_CACHE_TTL_MS) return null;
    return {
      ok: true,
      period: DOWNLOADS_PERIOD,
      downloads: parsed.downloads,
    };
  } catch {
    return null;
  }
}

async function writeDownloadsCache(
  cacheDir: string,
  name: string,
  downloads: Record<string, number>,
  nowMs: number,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const payload: CachePayload = {
    cachedAt: nowMs,
    period: DOWNLOADS_PERIOD,
    downloads,
  };
  await writeFile(
    cacheFilePath(cacheDir, name),
    JSON.stringify(payload),
    "utf8",
  );
}

/**
 * Evict stale download-cache files. A `.json` entry is removed when it is older
 * than maxAgeMs AND (when `keep` is given) not among the packages requested this
 * run. Without `keep`, age alone decides. Fail-open: returns count removed, 0 on
 * any I/O error. Fresh files (rewritten this run) survive because their mtime is
 * new, so passing the run's package set as `keep` prunes only dropped deps.
 */
export async function pruneDownloadsCache(
  cacheDir: string,
  opts?: { now?: Date; maxAgeMs?: number; keep?: Iterable<string> },
): Promise<number> {
  const nowMs = (opts?.now ?? new Date()).getTime();
  const maxAge = opts?.maxAgeMs ?? DOWNLOADS_CACHE_EVICT_MS;
  const keep = opts?.keep
    ? new Set(
        [...opts.keep].map((n) =>
          path.basename(cacheFilePath(cacheDir, n)),
        ),
      )
    : null;
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (keep && keep.has(entry)) continue;
    const full = path.join(cacheDir, entry);
    try {
      const st = await stat(full);
      if (nowMs - st.mtimeMs <= maxAge) continue;
      await rm(full, { force: true });
      removed++;
    } catch {
      /* ignore unreadable / already-gone entries */
    }
  }
  return removed;
}

function parseDownloadsBody(
  data: { downloads?: Record<string, unknown> },
): Record<string, number> | null {
  if (!data || typeof data !== "object" || !data.downloads) return null;
  const downloads: Record<string, number> = {};
  for (const [ver, n] of Object.entries(data.downloads)) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
      downloads[ver] = n;
    }
  }
  return downloads;
}

export async function fetchPackage(
  name: string,
  fetchFn: FetchFn = fetch,
): Promise<RegistryResult> {
  const url = `${REGISTRY}/${encodePackageName(name)}`;
  try {
    const res = await fetchFn(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const data = (await res.json()) as RegistryPackage;
    if (!data || typeof data !== "object" || !data.versions || !data.time) {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Per-version download counts for the trailing week.
 * Endpoint: GET https://api.npmjs.org/versions/{package}/last-week
 * (last-month / last-day / date ranges return 404 — verified 2026-07-26)
 *
 * On 429/5xx: exponential backoff, up to maxAttempts (default 3).
 * Successful responses may be cached under cacheDir for 24h.
 */
export async function fetchVersionDownloads(
  name: string,
  fetchFnOrOpts: FetchFn | DownloadsFetchOptions = fetch,
): Promise<VersionDownloadsResult> {
  const opts: DownloadsFetchOptions =
    typeof fetchFnOrOpts === "function"
      ? { fetchFn: fetchFnOrOpts }
      : fetchFnOrOpts;
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;
  const nowMs = (opts.now ?? new Date()).getTime();

  if (opts.cacheDir) {
    const cached = await readDownloadsCache(opts.cacheDir, name, nowMs);
    if (cached) return cached;
  }

  const url = `${DOWNLOADS_API}/versions/${encodePackageName(name)}/${DOWNLOADS_PERIOD}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: { accept: "application/json" },
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) return { ok: false, reason: "unavailable" };
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) return { ok: false, reason: "unavailable" };
      const data = (await res.json()) as {
        downloads?: Record<string, unknown>;
      };
      const downloads = parseDownloadsBody(data);
      if (!downloads) return { ok: false, reason: "unavailable" };
      if (opts.cacheDir) {
        await writeDownloadsCache(opts.cacheDir, name, downloads, nowMs);
      }
      return { ok: true, period: DOWNLOADS_PERIOD, downloads };
    } catch {
      if (attempt >= maxAttempts) return { ok: false, reason: "unavailable" };
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, reason: "unavailable" };
}

/**
 * Run async work with max concurrency and a delay between task starts.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);

    const p = fn(items[i]!).then((r) => {
      results[i] = r;
    });
    const tracked: Promise<void> = p.then(() => {
      executing.delete(tracked);
    });
    executing.add(tracked);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}
