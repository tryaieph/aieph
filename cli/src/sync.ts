import { readFile, mkdir, writeFile, access, unlink } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_WINDOW_MONTHS,
  classifyMatch,
  firstReleaseOfMajor,
  formatDate,
  isMajorityMismatch,
  latestStableMajor,
  majorityFromDownloads,
  notesForPackage,
  pinnedShareFromMajor,
} from "./analyze.js";
import {
  appendAiephGitignore,
  applyManagedBlock,
  DELIVERY_FILE,
} from "./delivery.js";
import {
  buildEmbedBlock,
  buildMarkdown,
  formatSkipBreakdown,
} from "./markdown.js";
import {
  resolveRankingForSync,
  totalTrials,
  type RankingBlob,
} from "./ranking.js";
import { extractMajor } from "./parse-version.js";
import {
  findRulesDir,
  loadRules,
  type MigrationRule,
} from "./rule-match.js";
import {
  fetchPackage,
  fetchVersionDownloads,
  mapPool,
  pruneDownloadsCache,
  type FetchFn,
} from "./registry.js";
import type {
  MatchRow,
  SkipReason,
  SyncJsonOutput,
  SyncJsonPackage,
  SyncResult,
} from "./types.js";
import {
  collectDepsFromPkg,
  formatScanningLine,
  loadWorkspacePatterns,
  resolveWorkspaceTargets,
  type PackageJsonFields,
  type TargetPackage,
} from "./workspace.js";

export { collectDeps } from "./workspace.js";

export type SyncOptions = {
  cwd: string;
  dryRun: boolean;
  json?: boolean;
  check?: boolean;
  windowMonths?: number;
  fetchFn?: FetchFn;
  now?: Date;
  concurrency?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Capture stdout lines (tests). Defaults to console.log. */
  log?: (line: string) => void;
  quiet?: boolean;
  /** Skip AGENTS.md / versions.md writes; observe enqueue still runs. */
  noWrite?: boolean;
  send?: boolean;
  noTelemetry?: boolean;
  /** Override observe endpoint (tests). Defaults: env > config.json > https://aieph.dev. */
  endpoint?: string | null;
  observeFetchFn?: typeof fetch;
  /** Override ranking GET fetch (tests). Defaults to global fetch. */
  rankingFetchFn?: typeof fetch;
  /** Skip registry sync work (tests / quiet hook path for observe-only). */
  skipRegistry?: boolean;
  rulesDir?: string;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function exitError(message: string): never {
  console.error(message);
  const err = new Error(message) as Error & { exitCode: number };
  err.exitCode = 1;
  throw err;
}

type Fetchable = {
  name: string;
  major: number;
  usedIn: string[];
};

function mergeUsedIn(a: string[], b: string[]): string[] {
  const set = new Set(a);
  for (const x of b) set.add(x);
  return [...set];
}

/**
 * Deduplicate fetchable deps by name+major (merge usedIn).
 * Skipped deps are counted once per name+skip reason (merge usedIn).
 * Packages under @types/ are skipped (no migration guides).
 */
export function buildWorkItems(
  entries: { name: string; range: string; usedIn: string[] }[],
): {
  fetchable: Fetchable[];
  skipped: Record<SkipReason, number>;
} {
  const fetchMap = new Map<string, Fetchable>();
  const skipSeen = new Set<string>();
  const skipped: Record<SkipReason, number> = {
    workspace: 0,
    file: 0,
    link: 0,
    git: 0,
    ambiguous: 0,
    types: 0,
  };

  for (const d of entries) {
    if (d.name.startsWith("@types/")) {
      const key = `${d.name}\0types`;
      if (skipSeen.has(key)) continue;
      skipSeen.add(key);
      skipped.types++;
      continue;
    }

    const parsed = extractMajor(d.range);
    if ("skip" in parsed) {
      const key = `${d.name}\0${parsed.skip}`;
      if (skipSeen.has(key)) continue;
      skipSeen.add(key);
      skipped[parsed.skip]++;
      continue;
    }
    const key = `${d.name}\0${parsed.major}`;
    const existing = fetchMap.get(key);
    if (existing) {
      existing.usedIn = mergeUsedIn(existing.usedIn, d.usedIn);
    } else {
      fetchMap.set(key, {
        name: d.name,
        major: parsed.major,
        usedIn: [...d.usedIn],
      });
    }
  }

  return { fetchable: [...fetchMap.values()], skipped };
}

function toJsonOutput(
  scanned: number,
  packages: SyncJsonPackage[],
  skipped: Record<SkipReason, number>,
  skippedTotal: number,
  unavailable: number,
): SyncJsonOutput {
  return {
    scanned,
    found: packages.filter((p) => p.class !== null).length,
    skipped: { ...skipped, total: skippedTotal },
    unavailable,
    packages,
  };
}

function downloadsByMajorKeys(
  byMajor: Record<number, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(byMajor)) {
    out[String(k)] = v;
  }
  return out;
}

async function resolveTargets(cwd: string): Promise<TargetPackage[]> {
  const pkgPath = path.join(cwd, "package.json");

  if (!(await pathExists(pkgPath))) {
    exitError("no package.json found");
  }

  const raw = await readFile(pkgPath, "utf8");
  let rootPkg: PackageJsonFields;
  try {
    rootPkg = JSON.parse(raw) as PackageJsonFields;
  } catch {
    exitError("no package.json found");
  }

  const rootDeps = collectDepsFromPkg(rootPkg);
  const rootName =
    typeof rootPkg.name === "string" && rootPkg.name.length > 0
      ? rootPkg.name
      : path.basename(cwd);
  const rootRel = "package.json";

  if (rootDeps.length > 0) {
    return [
      {
        pkgPath: path.resolve(pkgPath),
        relPath: rootRel,
        displayName: rootName,
        pkg: rootPkg,
      },
    ];
  }

  const patterns = await loadWorkspacePatterns(cwd, rootPkg);
  if (!patterns) {
    exitError("no dependencies found");
  }

  const targets = await resolveWorkspaceTargets(cwd, patterns);
  if (targets.length === 0) {
    exitError("no dependencies found");
  }
  return targets;
}

type PlannedWrites = {
  versionsPath: string;
  versionsContent: string | null; // null = delete if exists
  versionsExists: boolean;
  versionsChanged: boolean;
  deliveryPath: string;
  deliveryContent: string | null; // null = file absent / leave absent
  deliveryExists: boolean;
  deliveryChanged: boolean;
  gitignorePath: string;
  gitignoreContent: string | null; // null = no change / no file
  gitignoreChanged: boolean;
};

async function loadMigrationRules(cwd: string): Promise<MigrationRule[]> {
  const dir = await findRulesDir(cwd);
  if (!dir) return [];
  const loaded = await loadRules(dir);
  return loaded.map((x) => x.rule);
}

async function planWrites(
  cwd: string,
  matches: MatchRow[],
  windowMonths: number,
  ranking: RankingBlob | null = null,
): Promise<PlannedWrites> {
  const versionsPath = path.join(cwd, ".aieph", "versions.md");
  const deliveryPath = path.join(cwd, DELIVERY_FILE);
  const gitignorePath = path.join(cwd, ".gitignore");

  const versionsExists = await pathExists(versionsPath);
  const deliveryExists = await pathExists(deliveryPath);
  const gitignoreExists = await pathExists(gitignorePath);

  const rankingOpts = ranking ? { ranking } : undefined;
  const rules = await loadMigrationRules(cwd);
  const knowledge = rules.length > 0 ? { rules } : undefined;
  const versionsContent =
    matches.length > 0
      ? buildMarkdown(matches, windowMonths, rankingOpts, knowledge)
      : null;
  const versionsChanged =
    matches.length > 0
      ? !versionsExists ||
        (await readFile(versionsPath, "utf8")) !== versionsContent
      : versionsExists;

  const desiredBlock =
    matches.length > 0
      ? buildEmbedBlock(matches, windowMonths, true, rankingOpts, knowledge)
      : null;

  const existingDelivery = deliveryExists
    ? await readFile(deliveryPath, "utf8")
    : null;
  const applied = applyManagedBlock(existingDelivery, desiredBlock);
  if (!applied.ok) {
    exitError(applied.error);
  }

  let gitignoreContent: string | null = null;
  let gitignoreChanged = false;
  if (gitignoreExists) {
    const gi = await readFile(gitignorePath, "utf8");
    const next = appendAiephGitignore(gi);
    if (next !== null) {
      gitignoreContent = next;
      gitignoreChanged = true;
    }
  }

  return {
    versionsPath,
    versionsContent,
    versionsExists,
    versionsChanged,
    deliveryPath,
    deliveryContent: applied.content,
    deliveryExists,
    deliveryChanged: applied.changed,
    gitignorePath,
    gitignoreContent,
    gitignoreChanged,
  };
}

function describeChanges(plan: PlannedWrites): string[] {
  const lines: string[] = [];
  if (plan.versionsChanged) {
    if (plan.versionsContent === null) {
      lines.push("Would delete .aieph/versions.md");
    } else if (!plan.versionsExists) {
      lines.push("Would write .aieph/versions.md");
    } else {
      lines.push("Would update .aieph/versions.md");
    }
  }
  if (plan.deliveryChanged) {
    if (plan.deliveryContent === null) {
      // unreachable: apply never returns null content when file existed
      lines.push(`Would update ${DELIVERY_FILE}`);
    } else if (!plan.deliveryExists) {
      lines.push(`Would create ${DELIVERY_FILE} with managed block`);
    } else if (
      plan.deliveryContent !== null &&
      !plan.deliveryContent.includes("<!-- aieph:start -->")
    ) {
      lines.push(`Would remove managed block from ${DELIVERY_FILE}`);
    } else {
      lines.push(`Would update managed block in ${DELIVERY_FILE}`);
    }
  }
  if (plan.gitignoreChanged) {
    lines.push("Would append .aieph/ to .gitignore");
  }
  return lines.slice(0, 3);
}

function logSummary(
  log: (line: string) => void,
  targetRels: string[],
  scanned: number,
  cwd: string,
  recentCount: number,
  minorityCount: number,
  windowMonths: number,
  skippedTotal: number,
  skipped: Record<SkipReason, number>,
  unavailable: number,
): void {
  log(formatScanningLine(targetRels));
  log(`Scanned ${scanned} deps in ${cwd}`);
  log(
    `Recent major ${recentCount} / Minority major ${minorityCount} (last ${windowMonths} months window)`,
  );
  log(`Skipped ${skippedTotal} (${formatSkipBreakdown(skipped)})`);
  log(`Unavailable ${unavailable}`);
}

async function runObserveSideEffects(
  opts: SyncOptions,
  cwd: string,
  found: MatchRow[] = [],
): Promise<void> {
  if (opts.dryRun || opts.check || opts.json) return;
  const { isTelemetryEnabled, resolveEndpoint } = await import("./config.js");
  const telemetryOn = await isTelemetryEnabled(cwd, opts.noTelemetry === true);
  if (!telemetryOn) return;
  const { isQueueDisabled } = await import("./observe.js");
  if (isQueueDisabled()) return;
  try {
    const {
      enqueueRuleEvents,
      enqueueCoverageEvents,
      enqueueResolvedEvents,
      recordSyncObserveTransitions,
      maybeShowTelemetryNotice,
      sendQueue,
    } = await import("./observe.js");
    await maybeShowTelemetryNotice(cwd);
    // State + resolved only when writing delivery (not --no-write).
    if (opts.noWrite !== true) {
      const resolvedIds = await recordSyncObserveTransitions({
        cwd,
        rulesDir: opts.rulesDir,
        now: opts.now,
        noTelemetry: false,
      });
      if (resolvedIds.length > 0) {
        await enqueueResolvedEvents({
          cwd,
          ruleIds: resolvedIds,
          now: opts.now,
          noTelemetry: false,
        });
      }
    }
    await enqueueRuleEvents({
      cwd,
      rulesDir: opts.rulesDir,
      now: opts.now,
      noTelemetry: false,
    });
    await enqueueCoverageEvents({
      cwd,
      found,
      now: opts.now,
      noTelemetry: false,
    });
    // POST only when --send; leave queue otherwise (default collect, opt-out via --no-telemetry)
    if (opts.send !== true) return;
    if (process.env.CI) {
      console.error(
        "aieph: skip observe send in CI (queue kept; use local --send outside CI)",
      );
      return;
    }
    const endpoint =
      opts.endpoint !== undefined
        ? opts.endpoint
        : await resolveEndpoint(cwd);
    if (!endpoint) return;
    await sendQueue({
      cwd,
      endpoint,
      fetchFn: opts.observeFetchFn,
    });
  } catch {
    // fail-open: observe must never break sync
  }
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const quiet = opts.quiet === true;
  const log =
    opts.log ??
    ((line: string) => {
      if (!quiet) console.log(line);
    });
  const cwd = path.resolve(opts.cwd);
  const jsonMode = opts.json === true;
  const checkMode = opts.check === true;
  const windowMonths = opts.windowMonths ?? DEFAULT_WINDOW_MONTHS;
  const noWrite = opts.dryRun || checkMode || jsonMode || opts.noWrite === true;

  if (opts.skipRegistry) {
    await runObserveSideEffects(opts, cwd, []);
    return {
      cwd,
      scanned: 0,
      found: [],
      skipped: {
        workspace: 0,
        file: 0,
        link: 0,
        git: 0,
        ambiguous: 0,
        types: 0,
      },
      skippedTotal: 0,
      unavailable: 0,
      markdown: null,
      writtenPath: null,
      writtenBytes: null,
      targets: [],
      json: toJsonOutput(
        0,
        [],
        {
          workspace: 0,
          file: 0,
          link: 0,
          git: 0,
          ambiguous: 0,
          types: 0,
        },
        0,
        0,
      ),
    };
  }

  const targets = await resolveTargets(cwd);
  const targetRels = targets.map((t) => t.relPath);

  const located: { name: string; range: string; usedIn: string[] }[] = [];
  for (const t of targets) {
    for (const d of collectDepsFromPkg(t.pkg)) {
      located.push({ name: d.name, range: d.range, usedIn: [t.displayName] });
    }
  }

  const { fetchable, skipped } = buildWorkItems(located);
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const scanned = fetchable.length + skippedTotal;

  // One registry request per unique package name
  const byName = new Map<string, Fetchable[]>();
  for (const item of fetchable) {
    const list = byName.get(item.name) ?? [];
    list.push(item);
    byName.set(item.name, list);
  }
  const uniqueNames = [...byName.keys()];

  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? new Date();
  const concurrency = opts.concurrency ?? 5;
  const delayMs = opts.delayMs ?? 50;

  const fetchResults = await mapPool(
    uniqueNames,
    concurrency,
    delayMs,
    async (name) => {
      const res = await fetchPackage(name, fetchFn);
      return { name, res };
    },
    opts.sleep,
  );

  const registryOkNames = fetchResults
    .filter((r) => r.res.ok)
    .map((r) => r.name);
  const cacheDir = path.join(cwd, ".aieph", "cache");
  const downloadResults = await mapPool(
    registryOkNames,
    concurrency,
    delayMs,
    async (name) => {
      const res = await fetchVersionDownloads(name, {
        fetchFn,
        cacheDir,
        now,
        sleep: opts.sleep,
      });
      return { name, res };
    },
    opts.sleep,
  );
  const downloadsByName = new Map(
    downloadResults.map((r) => [r.name, r.res]),
  );

  // Evict cache files for deps no longer requested (fail-open, best-effort).
  await pruneDownloadsCache(cacheDir, { keep: registryOkNames, now }).catch(
    () => 0,
  );

  const dlFailedNames = downloadResults
    .filter((r) => !r.res.ok)
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));

  let unavailable = 0;
  const found: MatchRow[] = [];
  const jsonPackages: SyncJsonPackage[] = [];

  for (const { name, res } of fetchResults) {
    const items = byName.get(name) ?? [];
    if (!res.ok) {
      unavailable += items.length;
      continue;
    }
    const notes = notesForPackage(name, res.data.repository);
    const latest = latestStableMajor(res.data);
    const dl = downloadsByName.get(name);
    const downloadsOk = !!(dl && dl.ok);
    if (!downloadsOk) {
      unavailable += items.length;
    }
    const majority = downloadsOk
      ? majorityFromDownloads(dl!.downloads)
      : {
          majorityMajor: null as number | null,
          majorityShare: null as number | null,
          downloadsByMajor: {} as Record<number, number>,
          total: 0,
        };
    const downloadsPeriod = downloadsOk ? dl!.period : null;
    const downloadsByMajor = downloadsByMajorKeys(majority.downloadsByMajor);

    for (const item of items) {
      const pinnedShare = downloadsOk
        ? pinnedShareFromMajor(
            item.major,
            majority.downloadsByMajor,
            majority.total,
          )
        : null;
      const row = classifyMatch({
        name: item.name,
        inUseMajor: item.major,
        pkg: res.data,
        now,
        notesUrl: notes,
        windowMonths,
        majorityMajor: majority.majorityMajor,
        majorityShare: majority.majorityShare,
        pinnedShare,
        downloadsOk,
      });
      if (row) {
        row.usedIn = [...item.usedIn].sort((a, b) => a.localeCompare(b));
        found.push(row);
      }

      const inUseFirst = firstReleaseOfMajor(res.data, item.major);
      const recentAt = row?.which === "recent";
      const majorityMismatch = isMajorityMismatch(
        item.major,
        majority.majorityMajor,
      );
      const newerMajorExists = (latest ?? item.major) > item.major;
      const cls = row?.which ?? null;

      jsonPackages.push({
        name: item.name,
        currentMajor: item.major,
        latestMajor: latest ?? item.major,
        releasedAt:
          row?.released || (inUseFirst ? formatDate(inUseFirst) : null),
        which: cls,
        class: cls,
        recentAt: recentAt === true,
        majorityMismatch,
        pinnedMajor: item.major,
        pinnedShare,
        majorityMajor: majority.majorityMajor,
        majorityShare: majority.majorityShare,
        newerMajorExists,
        downloadsPeriod,
        downloadsByMajor,
      });
    }
  }

  const recent = found.filter((r) => r.which === "recent");
  const minority = found.filter((r) => r.which === "minority");

  const { resolveConfiguredEndpoint } = await import("./config.js");
  const rankingEndpoint =
    opts.endpoint !== undefined
      ? opts.endpoint
      : await resolveConfiguredEndpoint(cwd);
  let ranking: RankingBlob | null = null;
  try {
    ranking = await resolveRankingForSync({
      cwd,
      endpoint: rankingEndpoint,
      fetchFn: opts.rankingFetchFn ?? fetch,
      now,
      noWrite: opts.noWrite === true,
    });
  } catch {
    ranking = null;
  }
  if (ranking) {
    log(`Ranking trials: ${totalTrials(ranking)}`);
  }

  const rankingOpts = ranking ? { ranking } : undefined;
  const rules = await loadMigrationRules(cwd);
  const knowledge = rules.length > 0 ? { rules } : undefined;
  const markdown =
    found.length > 0
      ? buildMarkdown(found, windowMonths, rankingOpts, knowledge)
      : null;
  let writtenPath: string | null = null;
  let writtenBytes: number | null = null;

  const json = toJsonOutput(
    scanned,
    jsonPackages,
    skipped,
    skippedTotal,
    unavailable,
  );

  if (dlFailedNames.length > 0) {
    console.error(
      `WARN: downloads unavailable after retries: ${dlFailedNames.join(", ")}`,
    );
  }

  const abortWrites = dlFailedNames.length > 0 && !opts.dryRun;

  if (jsonMode) {
    log(JSON.stringify(json));
    if (abortWrites) {
      const err = new Error(
        "downloads unavailable; refusing to write",
      ) as Error & { exitCode: number };
      err.exitCode = 2;
      throw err;
    }
    return {
      cwd,
      scanned,
      found,
      skipped,
      skippedTotal,
      unavailable,
      markdown,
      writtenPath: null,
      writtenBytes: null,
      targets: targetRels,
      json,
    };
  }

  if (abortWrites) {
    const err = new Error(
      "downloads unavailable; refusing to write",
    ) as Error & { exitCode: number };
    err.exitCode = 2;
    throw err;
  }

  const plan = await planWrites(cwd, found, windowMonths, ranking);
  const needsWrite =
    plan.versionsChanged || plan.deliveryChanged || plan.gitignoreChanged;

  if (checkMode) {
    if (needsWrite) {
      for (const line of describeChanges(plan)) log(line);
      const err = new Error("check failed: changes needed") as Error & {
        exitCode: number;
      };
      err.exitCode = 1;
      throw err;
    }
    logSummary(
      log,
      targetRels,
      scanned,
      cwd,
      recent.length,
      minority.length,
      windowMonths,
      skippedTotal,
      skipped,
      unavailable,
    );
    if (found.length === 0) log("No file written.");
    return {
      cwd,
      scanned,
      found,
      skipped,
      skippedTotal,
      unavailable,
      markdown,
      writtenPath: null,
      writtenBytes: null,
      targets: targetRels,
      json,
    };
  }

  logSummary(
    log,
    targetRels,
    scanned,
    cwd,
    recent.length,
    minority.length,
    windowMonths,
    skippedTotal,
    skipped,
    unavailable,
  );

  if (found.length === 0) {
    if (!noWrite) {
      if (plan.versionsExists) {
        await unlink(plan.versionsPath);
      }
      if (plan.deliveryChanged && plan.deliveryContent !== null) {
        await writeFile(plan.deliveryPath, plan.deliveryContent, "utf8");
      }
      if (plan.gitignoreChanged && plan.gitignoreContent !== null) {
        await writeFile(plan.gitignorePath, plan.gitignoreContent, "utf8");
      }
    }
    log("No file written.");
    await runObserveSideEffects(opts, cwd, found);
    return {
      cwd,
      scanned,
      found,
      skipped,
      skippedTotal,
      unavailable,
      markdown: null,
      writtenPath: null,
      writtenBytes: null,
      targets: targetRels,
      json,
    };
  }

  if (opts.dryRun) {
    log(markdown!);
  } else if (!noWrite) {
    const outDir = path.join(cwd, ".aieph");
    await mkdir(outDir, { recursive: true });
    await writeFile(plan.versionsPath, plan.versionsContent!, "utf8");
    writtenPath = plan.versionsPath;
    writtenBytes = Buffer.byteLength(plan.versionsContent!, "utf8");
    log(`Wrote .aieph/versions.md (${writtenBytes} bytes)`);

    if (plan.deliveryChanged && plan.deliveryContent !== null) {
      await writeFile(plan.deliveryPath, plan.deliveryContent, "utf8");
    }
    if (plan.gitignoreChanged && plan.gitignoreContent !== null) {
      await writeFile(plan.gitignorePath, plan.gitignoreContent, "utf8");
    }
  }

  await runObserveSideEffects(opts, cwd, found);
  return {
    cwd,
    scanned,
    found,
    skipped,
    skippedTotal,
    unavailable,
    markdown,
    writtenPath,
    writtenBytes,
    targets: targetRels,
    json,
  };
}
