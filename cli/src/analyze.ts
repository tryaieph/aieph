import semver from "semver";
import type { MatchRow, MatchWhich, RegistryPackage } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default predicate window: 6 months ≈ 182.5 days. */
export const DEFAULT_WINDOW_MONTHS = 6;

/** Day count for an N-month window (12 → 365, 24 → 730). */
export function windowMonthsToDays(windowMonths: number): number {
  return (windowMonths * 365) / 12;
}

export function isPrerelease(version: string): boolean {
  const parsed = semver.parse(version);
  return parsed !== null && parsed.prerelease.length > 0;
}

/** Stable (non-prerelease) versions only. */
export function listStableVersions(pkg: RegistryPackage): string[] {
  return Object.keys(pkg.versions).filter((v) => {
    if (!semver.valid(v)) return false;
    return !isPrerelease(v);
  });
}

/** Highest stable major present in the package metadata. */
export function latestStableMajor(pkg: RegistryPackage): number | null {
  let max: number | null = null;
  for (const v of listStableVersions(pkg)) {
    const m = semver.major(v);
    if (max === null || m > max) max = m;
  }
  return max;
}

/** Earliest publish time among stable versions of the given major. */
export function firstReleaseOfMajor(
  pkg: RegistryPackage,
  major: number,
): Date | null {
  let earliest: Date | null = null;
  for (const v of listStableVersions(pkg)) {
    if (semver.major(v) !== major) continue;
    const raw = pkg.time[v];
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    if (earliest === null || d < earliest) earliest = d;
  }
  return earliest;
}

/**
 * Earliest publish time among all version keys in pkg.time
 * (excludes npm metadata keys created/modified).
 */
export function firstReleaseOfPackage(pkg: RegistryPackage): Date | null {
  let earliest: Date | null = null;
  for (const [key, raw] of Object.entries(pkg.time)) {
    if (key === "created" || key === "modified") continue;
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    if (earliest === null || d < earliest) earliest = d;
  }
  return earliest;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** True when first is at most `days` days before now. */
export function isWithinDays(first: Date, now: Date, days: number): boolean {
  return now.getTime() - first.getTime() <= days * MS_PER_DAY;
}

function withinWindow(
  first: Date,
  now: Date,
  windowMonths: number,
): boolean {
  return isWithinDays(first, now, windowMonthsToDays(windowMonths));
}

/** True when in-use major's first stable release is within the window. */
export function isRecentMajor(
  pkg: RegistryPackage,
  inUseMajor: number,
  now: Date,
  windowMonths: number = DEFAULT_WINDOW_MONTHS,
): boolean {
  const inUseFirst = firstReleaseOfMajor(pkg, inUseMajor);
  return !!(inUseFirst && withinWindow(inUseFirst, now, windowMonths));
}

export type ClassifyInput = {
  name: string;
  inUseMajor: number;
  pkg: RegistryPackage;
  now: Date;
  notesUrl: string;
  windowMonths?: number;
  majorityMajor: number | null;
  majorityShare: number | null;
  pinnedShare: number | null;
  /** When false, minority is skipped (e.g. downloads API failed). */
  downloadsOk: boolean;
};

/**
 * Classify a dependency into recent | minority (or null).
 * - recent: in-use major first stable release within --window-months
 * - minority: pinnedMajor ≠ majorityMajor (downloads last-week)
 * - both → recent (knowledge gap is the stronger claim)
 */
export function classifyMatch(input: ClassifyInput): MatchRow | null {
  const windowMonths = input.windowMonths ?? DEFAULT_WINDOW_MONTHS;
  const latest = latestStableMajor(input.pkg);
  if (latest === null) return null;

  const inUseFirst = firstReleaseOfMajor(input.pkg, input.inUseMajor);
  const recent = !!(
    inUseFirst && withinWindow(inUseFirst, input.now, windowMonths)
  );
  const minority =
    input.downloadsOk &&
    isMajorityMismatch(input.inUseMajor, input.majorityMajor);

  if (!recent && !minority) return null;

  const which: MatchWhich = recent ? "recent" : "minority";
  return {
    name: input.name,
    inUseMajor: input.inUseMajor,
    latestMajor: latest,
    released: inUseFirst ? formatDate(inUseFirst) : "",
    notes: input.notesUrl,
    usedIn: [],
    which,
    pinnedShare: input.pinnedShare,
    majorityMajor: input.majorityMajor,
    majorityShare: input.majorityShare,
    newerMajorExists: latest > input.inUseMajor,
  };
}

/**
 * @deprecated Prefer classifyMatch. Kept for recent-only unit tests.
 * Returns a recent row, or null (no longer emits behind).
 */
export function evaluateMatch(
  name: string,
  inUseMajor: number,
  pkg: RegistryPackage,
  now: Date,
  notesUrl: string,
  windowMonths: number = DEFAULT_WINDOW_MONTHS,
): MatchRow | null {
  return classifyMatch({
    name,
    inUseMajor,
    pkg,
    now,
    notesUrl,
    windowMonths,
    majorityMajor: null,
    majorityShare: null,
    pinnedShare: null,
    downloadsOk: false,
  });
}

export function githubReleasesUrl(
  repository: RegistryPackage["repository"],
): string | null {
  if (!repository) return null;
  const url = typeof repository === "string" ? repository : repository.url;
  if (!url) return null;

  // Normalize common git URL shapes to https://github.com/owner/repo
  let u = url.trim();
  u = u.replace(/^git\+/, "");
  u = u.replace(/^ssh:\/\/git@/i, "https://");
  u = u.replace(/^git@github\.com:/i, "https://github.com/");
  u = u.replace(/^git:\/\//i, "https://");

  try {
    const parsed = new URL(u);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }
    const parts = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `https://github.com/${parts[0]}/${parts[1]}/releases`;
  } catch {
    return null;
  }
}

export function notesForPackage(
  name: string,
  repository: RegistryPackage["repository"],
): string {
  return (
    githubReleasesUrl(repository) ??
    `https://www.npmjs.com/package/${name}?activeTab=versions`
  );
}

/** Sum per-version download counts into major → total. */
export function aggregateDownloadsByMajor(
  downloads: Record<string, number>,
): Record<number, number> {
  const byMajor: Record<number, number> = {};
  for (const [ver, count] of Object.entries(downloads)) {
    if (!semver.valid(ver)) continue;
    const major = semver.major(ver);
    byMajor[major] = (byMajor[major] ?? 0) + count;
  }
  return byMajor;
}

export type MajorityResult = {
  majorityMajor: number | null;
  majorityShare: number | null;
  downloadsByMajor: Record<number, number>;
  total: number;
};

/**
 * Majority major = major with the highest download count.
 * Share = that major's downloads / all version downloads in the period.
 * Ties: prefer the higher major number.
 */
export function majorityFromDownloads(
  downloads: Record<string, number>,
): MajorityResult {
  const downloadsByMajor = aggregateDownloadsByMajor(downloads);
  let total = 0;
  let majorityMajor: number | null = null;
  let majorityCount = 0;
  for (const [majStr, count] of Object.entries(downloadsByMajor)) {
    const maj = Number(majStr);
    total += count;
    if (
      majorityMajor === null ||
      count > majorityCount ||
      (count === majorityCount && maj > majorityMajor)
    ) {
      majorityMajor = maj;
      majorityCount = count;
    }
  }
  if (total === 0 || majorityMajor === null) {
    return {
      majorityMajor: null,
      majorityShare: null,
      downloadsByMajor,
      total: 0,
    };
  }
  return {
    majorityMajor,
    majorityShare: majorityCount / total,
    downloadsByMajor,
    total,
  };
}

/** pinned major's download share (0–1), or null when total is 0. */
export function pinnedShareFromMajor(
  pinnedMajor: number,
  downloadsByMajor: Record<number, number>,
  total: number,
): number | null {
  if (total <= 0) return null;
  return (downloadsByMajor[pinnedMajor] ?? 0) / total;
}

/** True when pinned major differs from the download-majority major. */
export function isMajorityMismatch(
  pinnedMajor: number,
  majorityMajor: number | null,
): boolean {
  if (majorityMajor === null) return false;
  return pinnedMajor !== majorityMajor;
}
