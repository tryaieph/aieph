import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import {
  findRulesDir,
  loadIgnoreMatcher,
  loadRules,
  matchDirectory,
  type RuleWithMigration,
} from "./rule-match.js";
import type { MatchRow, MatchWhich } from "./types.js";
import {
  loadWorkspacePatterns,
  resolveWorkspaceTargets,
  type PackageJsonFields,
} from "./workspace.js";

export const ALLOWED_PAYLOAD_KEYS = [
  "schema",
  "rule_id",
  "package",
  "from_major",
  "result",
  "date",
] as const;

export const COVERAGE_PAYLOAD_KEYS = [
  "schema",
  "kind",
  "package",
  "major",
  "signal",
  "date",
] as const;

export const LIFECYCLE_PAYLOAD_KEYS = [
  "schema",
  "kind",
  "rule_id",
  "outcome",
  "date",
] as const;

export type RuleObservePayload = {
  schema: 1;
  rule_id: string;
  package: string;
  from_major: number;
  result: "hit" | "miss";
  date: string; // YYYY-MM-DD
};

export type CoveragePayload = {
  schema: 2;
  kind: "coverage";
  package: string;
  major: number;
  signal: MatchWhich;
  date: string;
};

export type LifecyclePayload = {
  schema: 3;
  kind: "lifecycle";
  rule_id: string;
  outcome: "resolved";
  date: string;
};

export type ObservePayload =
  | RuleObservePayload
  | CoveragePayload
  | LifecyclePayload;

export type SentMap = Record<string, string>; // dedup key -> YYYY-MM-DD

/** When AIEPH_DISABLE_QUEUE=1, never write queue.jsonl / sent.json / observe-state.json. */
export function isQueueDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.AIEPH_DISABLE_QUEUE === "1";
}

export type ObserveFileRuleState = {
  last_result: "hit" | "miss";
  date: string;
};

/** Local per-file observe results. Keys are cwd-relative paths. */
export type ObserveState = Record<
  string,
  Record<string, ObserveFileRuleState>
>;

const DEDUP_DAYS = 30;
export const QUEUE_MAX_LINES = 1000;
export const QUEUE_MAX_BYTES = 1024 * 1024; // 1 MiB
const NOTICE_FLAG = ".aieph/.telemetry-notice-shown";
const OBSERVE_STATE_FILE = ".aieph/observe-state.json";
/** Project-level key in observe-state.json for sync (avoids file-path collisions). */
export const SYNC_OBSERVE_STATE_KEY = "$sync";

export type QueueLimitOpts = {
  maxLines?: number;
  maxBytes?: number;
};

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sentKey(ruleId: string, result: "hit" | "miss"): string {
  return `${ruleId}\0${result}`;
}

function lifecycleSentKey(ruleId: string, outcome: "resolved"): string {
  return `lifecycle\0${ruleId}\0${outcome}`;
}

function coverageSentKey(
  pkg: string,
  major: number,
  signal: MatchWhich,
): string {
  return `coverage\0${pkg}\0${major}\0${signal}`;
}

function daysBetween(a: string, b: string): number {
  const ms =
    Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function buildPayload(
  rule: { id: string; package: string; from_major: number },
  result: "hit" | "miss",
  now: Date,
): RuleObservePayload {
  return {
    schema: 1,
    rule_id: rule.id,
    package: rule.package,
    from_major: rule.from_major,
    result,
    date: dateOnly(now),
  };
}

export function buildCoveragePayload(
  row: { name: string; inUseMajor: number; which: MatchWhich },
  now: Date,
): CoveragePayload {
  return {
    schema: 2,
    kind: "coverage",
    package: row.name,
    major: row.inUseMajor,
    signal: row.which,
    date: dateOnly(now),
  };
}

export function buildLifecyclePayload(
  ruleId: string,
  now: Date,
): LifecyclePayload {
  return {
    schema: 3,
    kind: "lifecycle",
    rule_id: ruleId,
    outcome: "resolved",
    date: dateOnly(now),
  };
}

export async function readObserveState(cwd: string): Promise<ObserveState> {
  const p = path.join(cwd, OBSERVE_STATE_FILE);
  try {
    const raw = await readFile(p, "utf8");
    const data = JSON.parse(raw) as ObserveState;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

export async function writeObserveState(
  cwd: string,
  state: ObserveState,
): Promise<void> {
  if (isQueueDisabled()) return;
  const dir = path.join(cwd, ".aieph");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(cwd, OBSERVE_STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

export async function readSent(cwd: string): Promise<SentMap> {
  const p = path.join(cwd, ".aieph", "sent.json");
  try {
    const raw = await readFile(p, "utf8");
    const data = JSON.parse(raw) as SentMap;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function writeSent(cwd: string, map: SentMap): Promise<void> {
  if (isQueueDisabled()) return;
  const dir = path.join(cwd, ".aieph");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "sent.json"),
    `${JSON.stringify(map, null, 2)}\n`,
    "utf8",
  );
}

export async function readQueue(cwd: string): Promise<ObservePayload[]> {
  const p = path.join(cwd, ".aieph", "queue.jsonl");
  try {
    const raw = await readFile(p, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ObservePayload);
  } catch {
    return [];
  }
}

/** Drop oldest JSONL lines until under both line and byte caps; keep newest. */
export function trimQueueContent(
  content: string,
  maxLines: number = QUEUE_MAX_LINES,
  maxBytes: number = QUEUE_MAX_BYTES,
): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let start = 0;
  const joinFrom = (i: number): string =>
    lines.length === 0 || i >= lines.length
      ? ""
      : lines.slice(i).join("\n") + "\n";

  while (start < lines.length) {
    const candidate = joinFrom(start);
    const overLines = lines.length - start > maxLines;
    const overBytes = Buffer.byteLength(candidate, "utf8") > maxBytes;
    if (!overLines && !overBytes) return candidate;
    start++;
  }
  return "";
}

export async function appendQueue(
  cwd: string,
  events: ObservePayload[],
  limits?: QueueLimitOpts,
): Promise<void> {
  if (isQueueDisabled()) return;
  if (events.length === 0) return;
  const dir = path.join(cwd, ".aieph");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, "queue.jsonl");
  const line = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const existing = (await pathExists(p)) ? await readFile(p, "utf8") : "";
  const maxLines = limits?.maxLines ?? QUEUE_MAX_LINES;
  const maxBytes = limits?.maxBytes ?? QUEUE_MAX_BYTES;
  const next = trimQueueContent(existing + line, maxLines, maxBytes);
  await writeFile(p, next, "utf8");
}

export async function writeQueue(
  cwd: string,
  events: ObservePayload[],
): Promise<void> {
  if (isQueueDisabled()) return;
  const dir = path.join(cwd, ".aieph");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, "queue.jsonl");
  if (events.length === 0) {
    await writeFile(p, "", "utf8");
    return;
  }
  await writeFile(
    p,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

function shouldSkip(
  sent: SentMap,
  ruleId: string,
  result: "hit" | "miss",
  today: string,
): boolean {
  const prev = sent[sentKey(ruleId, result)];
  if (!prev) return false;
  return daysBetween(prev, today) < DEDUP_DAYS;
}

function shouldSkipCoverage(
  sent: SentMap,
  pkg: string,
  major: number,
  signal: MatchWhich,
  today: string,
): boolean {
  const prev = sent[coverageSentKey(pkg, major, signal)];
  if (!prev) return false;
  return daysBetween(prev, today) < DEDUP_DAYS;
}

function shouldSkipLifecycle(
  sent: SentMap,
  ruleId: string,
  outcome: "resolved",
  today: string,
): boolean {
  const prev = sent[lifecycleSentKey(ruleId, outcome)];
  if (!prev) return false;
  return daysBetween(prev, today) < DEDUP_DAYS;
}

export type EnqueueOptions = {
  cwd: string;
  rulesDir?: string;
  now?: Date;
  noTelemetry?: boolean;
  rules?: RuleWithMigration[];
};

export type EnqueueCoverageOptions = {
  cwd: string;
  found: MatchRow[];
  now?: Date;
  noTelemetry?: boolean;
};

async function resolveMatchRoots(cwd: string): Promise<string[]> {
  const roots = [cwd];
  const pkgPath = path.join(cwd, "package.json");
  try {
    const rootPkg = JSON.parse(
      await readFile(pkgPath, "utf8"),
    ) as PackageJsonFields;
    const patterns = await loadWorkspacePatterns(cwd, rootPkg);
    if (patterns) {
      const targets = await resolveWorkspaceTargets(cwd, patterns);
      for (const t of targets) {
        const dir = path.dirname(t.pkgPath);
        if (!roots.includes(dir)) roots.push(dir);
      }
    }
  } catch {
    /* root package.json missing or invalid — match cwd only */
  }
  return roots;
}

async function matchRuleHitsMisses(opts: {
  cwd: string;
  rulesDir?: string;
  rules?: RuleWithMigration[];
}): Promise<{
  byId: Map<string, RuleWithMigration["rule"]>;
  hitIds: Set<string>;
  missIds: Set<string>;
}> {
  const cwd = path.resolve(opts.cwd);
  const rulesDir =
    opts.rulesDir ?? (await findRulesDir(cwd)) ?? undefined;
  const rules =
    opts.rules ?? (rulesDir ? await loadRules(rulesDir) : []);
  const byId = new Map(rules.map((r) => [r.rule.id, r.rule]));
  const hitIds = new Set<string>();
  const missIds = new Set<string>();
  if (rules.length === 0 && !rulesDir) {
    return { byId, hitIds, missIds };
  }
  const ignore = await loadIgnoreMatcher(cwd);
  for (const root of await resolveMatchRoots(cwd)) {
    const match = await matchDirectory(root, {
      rulesDir,
      rules,
      ignore,
      ignoreRoot: cwd,
    });
    for (const id of match.matchedRuleIds) hitIds.add(id);
    for (const id of match.missRuleIds) {
      if (!hitIds.has(id)) missIds.add(id);
    }
  }
  for (const id of hitIds) missIds.delete(id);
  return { byId, hitIds, missIds };
}

/**
 * Match rules and enqueue hit/miss events (deduped via .aieph/sent.json).
 * Updates sent.json for newly queued events so a second run within 30d skips.
 * Workspace packages under cwd are included (same roots sync scans).
 */
export async function enqueueRuleEvents(
  opts: EnqueueOptions,
): Promise<RuleObservePayload[]> {
  if (opts.noTelemetry || isQueueDisabled()) return [];

  const cwd = path.resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const today = dateOnly(now);

  const { byId, hitIds, missIds } = await matchRuleHitsMisses({
    cwd,
    rulesDir: opts.rulesDir,
    rules: opts.rules,
  });
  if (byId.size === 0) return [];

  const sent = await readSent(cwd);
  const toQueue: RuleObservePayload[] = [];

  for (const id of hitIds) {
    const rule = byId.get(id);
    if (!rule) continue;
    if (shouldSkip(sent, id, "hit", today)) continue;
    const payload = buildPayload(rule, "hit", now);
    toQueue.push(payload);
    sent[sentKey(id, "hit")] = today;
  }
  for (const id of missIds) {
    const rule = byId.get(id);
    if (!rule) continue;
    if (shouldSkip(sent, id, "miss", today)) continue;
    const payload = buildPayload(rule, "miss", now);
    toQueue.push(payload);
    sent[sentKey(id, "miss")] = today;
  }

  if (toQueue.length > 0) {
    await appendQueue(cwd, toQueue);
    await writeSent(cwd, sent);
  }
  return toQueue;
}

/**
 * Update project-level sync entries in observe-state.json and return rule ids
 * that transitioned hit→miss (resolved candidates). Fail-open on I/O.
 */
export async function recordSyncObserveTransitions(
  opts: EnqueueOptions,
): Promise<string[]> {
  if (isQueueDisabled()) return [];
  const cwd = path.resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const today = dateOnly(now);

  const { hitIds, missIds } = await matchRuleHitsMisses({
    cwd,
    rulesDir: opts.rulesDir,
    rules: opts.rules,
  });

  let state: ObserveState = await readObserveState(cwd);
  const prevFile = state[SYNC_OBSERVE_STATE_KEY] ?? {};
  // Rebuild from only currently-applicable rules (hit ∪ miss); entries for
  // rules no longer applicable (e.g. after a major bump) are pruned. prevFile
  // is consulted solely to detect hit→miss transitions.
  const nextFile: ObserveState[string] = {};
  const resolvedIds: string[] = [];

  for (const id of hitIds) {
    nextFile[id] = { last_result: "hit", date: today };
  }
  for (const id of missIds) {
    const prev = prevFile[id];
    if (prev?.last_result === "hit") {
      resolvedIds.push(id);
    }
    nextFile[id] = { last_result: "miss", date: today };
  }

  state = { ...state, [SYNC_OBSERVE_STATE_KEY]: nextFile };
  try {
    await writeObserveState(cwd, state);
  } catch {
    /* fail-open */
  }
  return resolvedIds;
}

/**
 * Enqueue coverage events for every recent/minority row from sync.
 * Independent of whether rules exist for the package.
 * Only rows already classified by sync are passed (registry failures excluded).
 */
export type EnqueueHitsOptions = {
  cwd: string;
  rules: Array<{
    id: string;
    package: string;
    from_major: number;
  }>;
  now?: Date;
  noTelemetry?: boolean;
};

/** Enqueue hit events for already-matched rules (dedup via sent.json). No send. */
export async function enqueueHitEvents(
  opts: EnqueueHitsOptions,
): Promise<RuleObservePayload[]> {
  return enqueueResultEvents({ ...opts, result: "hit" });
}

/** Enqueue miss events for applicable non-matching rules (dedup via sent.json). */
export async function enqueueMissEvents(
  opts: EnqueueHitsOptions,
): Promise<RuleObservePayload[]> {
  return enqueueResultEvents({ ...opts, result: "miss" });
}

async function enqueueResultEvents(
  opts: EnqueueHitsOptions & { result: "hit" | "miss" },
): Promise<RuleObservePayload[]> {
  if (opts.noTelemetry || isQueueDisabled()) return [];
  const cwd = path.resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const today = dateOnly(now);
  const sent = await readSent(cwd);
  const toQueue: RuleObservePayload[] = [];

  for (const rule of opts.rules) {
    if (shouldSkip(sent, rule.id, opts.result, today)) continue;
    const payload: RuleObservePayload = {
      schema: 1,
      rule_id: rule.id,
      package: rule.package,
      from_major: rule.from_major,
      result: opts.result,
      date: today,
    };
    toQueue.push(payload);
    sent[sentKey(rule.id, opts.result)] = today;
  }

  if (toQueue.length > 0) {
    await appendQueue(cwd, toQueue);
    await writeSent(cwd, sent);
  }
  return toQueue;
}

export type EnqueueResolvedOptions = {
  cwd: string;
  ruleIds: string[];
  now?: Date;
  noTelemetry?: boolean;
};

/** Enqueue lifecycle resolved events (dedup via sent.json on rule_id+outcome). */
export async function enqueueResolvedEvents(
  opts: EnqueueResolvedOptions,
): Promise<LifecyclePayload[]> {
  if (opts.noTelemetry || isQueueDisabled()) return [];
  const cwd = path.resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const today = dateOnly(now);
  const sent = await readSent(cwd);
  const toQueue: LifecyclePayload[] = [];

  for (const ruleId of opts.ruleIds) {
    if (shouldSkipLifecycle(sent, ruleId, "resolved", today)) continue;
    const payload = buildLifecyclePayload(ruleId, now);
    toQueue.push(payload);
    sent[lifecycleSentKey(ruleId, "resolved")] = today;
  }

  if (toQueue.length > 0) {
    await appendQueue(cwd, toQueue);
    await writeSent(cwd, sent);
  }
  return toQueue;
}

export async function enqueueCoverageEvents(
  opts: EnqueueCoverageOptions,
): Promise<CoveragePayload[]> {
  if (opts.noTelemetry || isQueueDisabled()) return [];
  const cwd = path.resolve(opts.cwd);
  const now = opts.now ?? new Date();
  const today = dateOnly(now);
  const sent = await readSent(cwd);
  const toQueue: CoveragePayload[] = [];

  for (const row of opts.found) {
    if (row.which !== "recent" && row.which !== "minority") continue;
    if (shouldSkipCoverage(sent, row.name, row.inUseMajor, row.which, today)) {
      continue;
    }
    const payload = buildCoveragePayload(row, now);
    toQueue.push(payload);
    sent[coverageSentKey(row.name, row.inUseMajor, row.which)] = today;
  }

  if (toQueue.length > 0) {
    await appendQueue(cwd, toQueue);
    await writeSent(cwd, sent);
  }
  return toQueue;
}

export type SendQueueOptions = {
  cwd: string;
  endpoint: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export type SendQueueResult = {
  sent: number;
  remaining: number;
};

/** Match server OBSERVE_MAX_EVENTS / OBSERVE_MAX_BODY_BYTES. */
export const SEND_BATCH_MAX_EVENTS = 200;
export const SEND_BATCH_MAX_BYTES = 64 * 1024;

function encodeObserveBody(batch: ObservePayload[]): string {
  return batch.length === 1
    ? JSON.stringify(batch[0])
    : JSON.stringify(batch);
}

/** Split queue into batches capped by event count and JSON body size. */
export function splitObserveSendBatches(
  queue: ObservePayload[],
  maxEvents: number = SEND_BATCH_MAX_EVENTS,
  maxBytes: number = SEND_BATCH_MAX_BYTES,
): ObservePayload[][] {
  const batches: ObservePayload[][] = [];
  let current: ObservePayload[] = [];

  for (const item of queue) {
    const candidate = [...current, item];
    const overCount = candidate.length > maxEvents;
    const overBytes =
      Buffer.byteLength(encodeObserveBody(candidate), "utf8") > maxBytes;
    if (current.length > 0 && (overCount || overBytes)) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function sendQueue(
  opts: SendQueueOptions,
): Promise<SendQueueResult> {
  if (isQueueDisabled()) return { sent: 0, remaining: 0 };
  const cwd = path.resolve(opts.cwd);
  const queue = await readQueue(cwd);
  if (queue.length === 0) return { sent: 0, remaining: 0 };

  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const batches = splitObserveSendBatches(queue);
  const remaining: ObservePayload[] = [];
  let sent = 0;
  let failed = false;

  for (const batch of batches) {
    if (failed) {
      remaining.push(...batch);
      continue;
    }
    try {
      const res = await fetchFn(opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeObserveBody(batch),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        sent += batch.length;
      } else {
        remaining.push(...batch);
        failed = true;
      }
    } catch {
      remaining.push(...batch);
      failed = true;
    }
  }

  await writeQueue(cwd, remaining);
  return { sent, remaining: remaining.length };
}

/** Print 3-line stderr notice once per cwd. */
export async function maybeShowTelemetryNotice(
  cwd: string,
  err: (line: string) => void = (l) => console.error(l),
): Promise<void> {
  const flag = path.join(cwd, NOTICE_FLAG);
  if (await pathExists(flag)) return;
  err("aieph telemetry: queues rule match events locally.");
  err("Payload: schema, rule_id, package, from_major, result, date only.");
  err("Disable with --no-telemetry or config telemetry:false. Send with --send.");
  await mkdir(path.join(cwd, ".aieph"), { recursive: true });
  await writeFile(flag, "1\n", "utf8");
}

export async function ensureAiephGitignore(cwd: string): Promise<void> {
  const gi = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(gi, "utf8");
  } catch {
    return; // no .gitignore — delivery.ts only appends when file exists
  }
  const { appendAiephGitignore } = await import("./delivery.js");
  const next = appendAiephGitignore(content);
  if (next !== null) await writeFile(gi, next, "utf8");
}
