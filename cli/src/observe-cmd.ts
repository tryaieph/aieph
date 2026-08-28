import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  findRulesDir,
  loadRules,
  matchFiles,
  type MigrationRule,
} from "./rule-match.js";
import {
  enqueueHitEvents,
  enqueueMissEvents,
  enqueueResolvedEvents,
  isQueueDisabled,
  readObserveState,
  writeObserveState,
  type ObserveState,
} from "./observe.js";

export const OBSERVE_KINDS: ReadonlySet<string> = new Set([
  "source",
  "config",
]);
/** @deprecated Use OBSERVE_KINDS — kept for call-site clarity during transition. */
export const OBSERVE_SOURCE_KINDS = OBSERVE_KINDS;

const OBSERVE_LOG_FILE = ".aieph/observe.log";
const OBSERVE_LOG_MAX_LINES = 100;

export type ObserveCmdOptions = {
  cwd: string;
  files: string[];
  rulesDir?: string;
  now?: Date;
  noTelemetry?: boolean;
  quiet?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

export type ObserveCmdResult = {
  hits: MigrationRule[];
  misses: MigrationRule[];
  exitCode: 0;
};

function fileStateKey(cwd: string, absFile: string): string {
  const rel = path.relative(cwd, absFile);
  return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : absFile;
}

function targetFileLabel(cwd: string, files: string[]): string {
  if (files.length === 0) return "-";
  const labels = files.map((f) => {
    const abs = path.resolve(cwd, f);
    const base = path.basename(abs);
    return base || abs;
  });
  return labels.join(",");
}

/**
 * Append one observe run line. Fail-open. Not sent / not queued.
 * Format: ISO / filename / hitCount / exitCode
 */
export async function appendObserveLog(opts: {
  cwd: string;
  files: string[];
  hitCount: number;
  exitCode: number;
  now?: Date;
}): Promise<void> {
  const cwd = path.resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const line = `${now.toISOString()} / ${targetFileLabel(cwd, opts.files)} / ${opts.hitCount} / ${opts.exitCode}`;
  const dir = path.join(cwd, ".aieph");
  const file = path.join(cwd, OBSERVE_LOG_FILE);
  await mkdir(dir, { recursive: true });
  let prev = "";
  try {
    prev = await readFile(file, "utf8");
  } catch {
    prev = "";
  }
  const existing =
    prev.length > 0
      ? prev
          .replace(/\n$/, "")
          .split("\n")
          .filter((l) => l.length > 0)
      : [];
  const next = [...existing, line].slice(-OBSERVE_LOG_MAX_LINES);
  await writeFile(file, next.join("\n") + "\n", "utf8");
}

/**
 * Match source/config rules against explicit file args only (no tree walk, no network).
 * Record-only: always exit 0; never write match notes to the agent.
 * Enqueues hit/miss/resolved events via existing dedup (does not send).
 */
export async function runObserve(
  opts: ObserveCmdOptions,
): Promise<ObserveCmdResult> {
  const cwd = path.resolve(opts.cwd);
  const files = opts.files.map((f) => path.resolve(cwd, f));
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const rulesDir =
    opts.rulesDir ?? (await findRulesDir(cwd)) ?? undefined;
  const rules = rulesDir ? await loadRules(rulesDir) : [];

  const allHits: MigrationRule[] = [];
  const allMisses: MigrationRule[] = [];
  const resolvedIds: string[] = [];
  const hitById = new Map<string, MigrationRule>();
  const missById = new Map<string, MigrationRule>();

  let state: ObserveState = await readObserveState(cwd);

  for (const abs of files) {
    const { applicable, hits } = await matchFiles(cwd, [abs], {
      rulesDir,
      rules,
      kinds: OBSERVE_KINDS,
    });
    const hitIds = new Set(hits.map((h) => h.id));
    const misses = applicable.filter((r) => !hitIds.has(r.id));

    for (const h of hits) {
      hitById.set(h.id, h);
      missById.delete(h.id);
    }
    for (const m of misses) {
      if (!hitById.has(m.id)) missById.set(m.id, m);
    }

    const key = fileStateKey(cwd, abs);
    const prevFile = state[key] ?? {};
    const nextFile: ObserveState[string] = { ...prevFile };

    for (const rule of applicable) {
      const result: "hit" | "miss" = hitIds.has(rule.id) ? "hit" : "miss";
      const prev = prevFile[rule.id];
      if (prev?.last_result === "hit" && result === "miss") {
        resolvedIds.push(rule.id);
      }
      nextFile[rule.id] = { last_result: result, date: today };
    }
    state = { ...state, [key]: nextFile };
  }

  allHits.push(...hitById.values());
  allMisses.push(...missById.values());

  try {
    if (!isQueueDisabled()) {
      await writeObserveState(cwd, state);
    }
  } catch {
    /* fail-open: still exit 0 */
  }

  const { isTelemetryEnabled } = await import("./config.js");
  const telemetryOn = await isTelemetryEnabled(cwd, opts.noTelemetry === true);
  if (telemetryOn && !isQueueDisabled()) {
    if (allHits.length > 0) {
      await enqueueHitEvents({ cwd, rules: allHits, now });
    }
    if (allMisses.length > 0) {
      await enqueueMissEvents({ cwd, rules: allMisses, now });
    }
    if (resolvedIds.length > 0) {
      await enqueueResolvedEvents({
        cwd,
        ruleIds: [...new Set(resolvedIds)],
        now,
      });
    }
  }

  const exitCode = 0 as const;
  try {
    await appendObserveLog({
      cwd,
      files,
      hitCount: allHits.length,
      exitCode,
      now,
    });
  } catch {
    /* fail-open: log is instrumentation only */
  }

  return { hits: allHits, misses: allMisses, exitCode };
}
