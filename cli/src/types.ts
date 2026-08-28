export type SkipReason =
  | "workspace"
  | "file"
  | "link"
  | "git"
  | "ambiguous"
  | "types";

export type MatchWhich = "recent" | "minority";

export type DepEntry = {
  name: string;
  range: string;
};

export type ParsedDep =
  | { name: string; range: string; major: number }
  | { name: string; range: string; skip: SkipReason };

export type RegistryPackage = {
  versions: Record<string, unknown>;
  time: Record<string, string>;
  repository?: string | { url?: string; type?: string; directory?: string };
};

export type MatchRow = {
  name: string;
  inUseMajor: number;
  latestMajor: number;
  released: string; // YYYY-MM-DD (in-use major first stable)
  notes: string;
  /** Workspace package names that depend on this package@major */
  usedIn: string[];
  which: MatchWhich;
  pinnedShare: number | null;
  majorityMajor: number | null;
  majorityShare: number | null;
  newerMajorExists: boolean;
};

export type SyncJsonPackage = {
  name: string;
  currentMajor: number;
  latestMajor: number;
  releasedAt: string | null;
  which: MatchWhich | null;
  /** Output class: recent wins when both recent and minority apply. */
  class: MatchWhich | null;
  /** In-use major first stable release is within --window-months. */
  recentAt: boolean;
  majorityMismatch: boolean;
  pinnedMajor: number;
  /** pinned major's share of last-week downloads (0–1), or null. */
  pinnedShare: number | null;
  majorityMajor: number | null;
  majorityShare: number | null;
  newerMajorExists: boolean;
  /** Aggregation window for version downloads (npm only exposes last-week). */
  downloadsPeriod: "last-week" | null;
  /** Major → download count in downloadsPeriod. */
  downloadsByMajor: Record<string, number>;
};

export type SyncJsonOutput = {
  scanned: number;
  found: number;
  skipped: Record<SkipReason, number> & { total: number };
  unavailable: number;
  packages: SyncJsonPackage[];
};

export type SyncResult = {
  cwd: string;
  scanned: number;
  found: MatchRow[];
  skipped: Record<SkipReason, number>;
  skippedTotal: number;
  unavailable: number;
  markdown: string | null;
  writtenPath: string | null;
  writtenBytes: number | null;
  /** Relative package.json paths that were scanned */
  targets: string[];
  json: SyncJsonOutput;
};
