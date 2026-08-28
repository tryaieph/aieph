import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

/** Stable marker embedded in command string to identify aieph-managed hooks. */
export const AIEPH_CLAUDE_MARKER = "aieph observe";

/** Legacy marker — still recognized so re-init replaces old entries. */
export const AIEPH_CLAUDE_LEGACY_MARKER = "aieph guard";

export const AIEPH_CLAUDE_MATCHER = "Write|Edit";

/**
 * PostToolUse command: extract edited path, run observe (record-only, exit 0).
 */
export const AIEPH_CLAUDE_COMMAND =
  'FILE=$(jq -r \'.tool_input.file_path // empty\'); ' +
  '[ -n "$FILE" ] && aieph observe --quiet "$FILE"; ' +
  "exit 0";

/** Stable marker identifying the aieph-managed SessionStart memory review-hint hook. */
export const AIEPH_MEMORY_REVIEW_MARKER = "aieph memory review-hint";

/**
 * Match every session-start reason: a fresh session, a resumed one, /clear,
 * /compact, and a forked branch — the review-hint should fire on all of them.
 */
export const AIEPH_SESSION_START_MATCHER = "startup|resume|clear|compact|fork";

/**
 * SessionStart command: print any stale-memory hint to stdout (silent if none).
 * Unlike PostToolUse, SessionStart hook stdout is injected as context the model
 * sees — this is what makes "re-verify what you touched" possible at all, since
 * SessionEnd hook output never reaches the model.
 */
export const AIEPH_MEMORY_REVIEW_COMMAND =
  'command -v aieph >/dev/null 2>&1 && aieph memory review-hint --cwd "$CLAUDE_PROJECT_DIR"; ' +
  "exit 0";

type HookHandler = {
  type?: string;
  command?: string;
  [key: string]: unknown;
};

type MatcherGroup = {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
};

type ClaudeSettings = {
  hooks?: {
    PreToolUse?: MatcherGroup[];
    PostToolUse?: MatcherGroup[];
    SessionStart?: MatcherGroup[];
    [event: string]: MatcherGroup[] | undefined;
  };
  [key: string]: unknown;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function isAiephClaudeHandler(h: HookHandler): boolean {
  if (typeof h.command !== "string") return false;
  return (
    h.command.includes(AIEPH_CLAUDE_MARKER) ||
    h.command.includes(AIEPH_CLAUDE_LEGACY_MARKER)
  );
}

export function aiephClaudeHandler(): HookHandler {
  return { type: "command", command: AIEPH_CLAUDE_COMMAND };
}

/** Merge aieph PostToolUse entry without touching other hooks/groups. */
export function mergeClaudeCodeSettings(
  existing: ClaudeSettings | null,
): ClaudeSettings {
  const base: ClaudeSettings =
    existing && typeof existing === "object" ? { ...existing } : {};
  const hooks = { ...(base.hooks ?? {}) };
  const post: MatcherGroup[] = Array.isArray(hooks.PostToolUse)
    ? hooks.PostToolUse.map((g) => ({
        ...g,
        hooks: Array.isArray(g.hooks) ? [...g.hooks] : [],
      }))
    : [];

  let group = post.find(
    (g) => g.matcher === AIEPH_CLAUDE_MATCHER && Array.isArray(g.hooks),
  );
  if (!group) {
    group = { matcher: AIEPH_CLAUDE_MATCHER, hooks: [] };
    post.push(group);
  }
  const handlers = group.hooks ?? [];
  const withoutAieph = handlers.filter((h) => !isAiephClaudeHandler(h));
  group.hooks = [...withoutAieph, aiephClaudeHandler()];

  hooks.PostToolUse = post;
  base.hooks = hooks;
  return base;
}

/** Remove only aieph-managed handlers; leave other entries intact. */
export function uninstallClaudeCodeSettings(
  existing: ClaudeSettings | null,
): ClaudeSettings | null {
  if (!existing || typeof existing !== "object") return existing;
  const base: ClaudeSettings = { ...existing };
  if (!base.hooks || !Array.isArray(base.hooks.PostToolUse)) return base;

  const hooks = { ...base.hooks };
  const postToolUse = hooks.PostToolUse ?? [];
  const nextPost: MatcherGroup[] = [];
  for (const g of postToolUse) {
    const handlers = Array.isArray(g.hooks) ? g.hooks : [];
    const kept = handlers.filter((h) => !isAiephClaudeHandler(h));
    if (kept.length === 0 && g.matcher === AIEPH_CLAUDE_MATCHER) {
      // drop empty aieph-only matcher group
      continue;
    }
    if (kept.length !== handlers.length) {
      nextPost.push({ ...g, hooks: kept });
    } else {
      nextPost.push(g);
    }
  }
  hooks.PostToolUse = nextPost;
  if (nextPost.length === 0) {
    const { PostToolUse: _drop, ...rest } = hooks;
    base.hooks = Object.keys(rest).length > 0 ? rest : undefined;
    if (base.hooks === undefined) {
      const { hooks: _h, ...root } = base;
      return Object.keys(root).length > 0 ? root : {};
    }
    return base;
  }
  base.hooks = hooks;
  return base;
}

export function isAiephMemoryReviewHandler(h: HookHandler): boolean {
  if (typeof h.command !== "string") return false;
  return h.command.includes(AIEPH_MEMORY_REVIEW_MARKER);
}

export function aiephMemoryReviewHandler(): HookHandler {
  return { type: "command", command: AIEPH_MEMORY_REVIEW_COMMAND };
}

/** Merge the aieph SessionStart review-hint entry without touching other hooks/groups. */
export function mergeClaudeCodeSessionStartHook(
  existing: ClaudeSettings | null,
): ClaudeSettings {
  const base: ClaudeSettings =
    existing && typeof existing === "object" ? { ...existing } : {};
  const hooks = { ...(base.hooks ?? {}) };
  const starts: MatcherGroup[] = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart.map((g) => ({
        ...g,
        hooks: Array.isArray(g.hooks) ? [...g.hooks] : [],
      }))
    : [];

  let group = starts.find(
    (g) => g.matcher === AIEPH_SESSION_START_MATCHER && Array.isArray(g.hooks),
  );
  if (!group) {
    group = { matcher: AIEPH_SESSION_START_MATCHER, hooks: [] };
    starts.push(group);
  }
  const handlers = group.hooks ?? [];
  const withoutAieph = handlers.filter((h) => !isAiephMemoryReviewHandler(h));
  group.hooks = [...withoutAieph, aiephMemoryReviewHandler()];

  hooks.SessionStart = starts;
  base.hooks = hooks;
  return base;
}

/** Remove only the aieph SessionStart review-hint entry; leave other entries intact. */
export function uninstallClaudeCodeSessionStartHook(
  existing: ClaudeSettings | null,
): ClaudeSettings | null {
  if (!existing || typeof existing !== "object") return existing;
  if (!existing.hooks || !Array.isArray(existing.hooks.SessionStart)) return existing;

  const base: ClaudeSettings = { ...existing };
  const hooks = { ...base.hooks };
  const starts = hooks.SessionStart ?? [];
  const nextStarts: MatcherGroup[] = [];
  for (const g of starts) {
    const handlers = Array.isArray(g.hooks) ? g.hooks : [];
    const kept = handlers.filter((h) => !isAiephMemoryReviewHandler(h));
    if (kept.length === 0 && g.matcher === AIEPH_SESSION_START_MATCHER) {
      continue;
    }
    if (kept.length !== handlers.length) {
      nextStarts.push({ ...g, hooks: kept });
    } else {
      nextStarts.push(g);
    }
  }
  if (nextStarts.length === 0) {
    const { SessionStart: _drop, ...rest } = hooks;
    base.hooks = Object.keys(rest).length > 0 ? rest : undefined;
    if (base.hooks === undefined) {
      const { hooks: _h, ...root } = base;
      return Object.keys(root).length > 0 ? root : {};
    }
    return base;
  }
  hooks.SessionStart = nextStarts;
  base.hooks = hooks;
  return base;
}

/** Stable marker identifying the aieph-managed PreToolUse cache hook. */
export const AIEPH_CACHE_MARKER = "aieph cache-hook";

export const AIEPH_CACHE_MATCHER = "WebSearch|WebFetch";

/**
 * PreToolUse command: ask the shared aieph cache before a web lookup. Fail-open —
 * a missing `aieph`, a miss, a timeout, or any error simply passes through so the
 * original WebSearch/WebFetch runs untouched.
 */
export const AIEPH_CACHE_COMMAND =
  'command -v aieph >/dev/null 2>&1 && aieph cache-hook; exit 0';

export function isAiephCacheHandler(h: HookHandler): boolean {
  if (typeof h.command !== "string") return false;
  return h.command.includes(AIEPH_CACHE_MARKER);
}

export function aiephCacheHandler(): HookHandler {
  return { type: "command", command: AIEPH_CACHE_COMMAND };
}

/** Merge the aieph PreToolUse cache hook without touching other hooks/groups. */
export function mergeClaudeCodePreToolUseHook(
  existing: ClaudeSettings | null,
): ClaudeSettings {
  const base: ClaudeSettings =
    existing && typeof existing === "object" ? { ...existing } : {};
  const hooks = { ...(base.hooks ?? {}) };
  const pre: MatcherGroup[] = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse.map((g) => ({
        ...g,
        hooks: Array.isArray(g.hooks) ? [...g.hooks] : [],
      }))
    : [];

  let group = pre.find(
    (g) => g.matcher === AIEPH_CACHE_MATCHER && Array.isArray(g.hooks),
  );
  if (!group) {
    group = { matcher: AIEPH_CACHE_MATCHER, hooks: [] };
    pre.push(group);
  }
  const handlers = group.hooks ?? [];
  const withoutAieph = handlers.filter((h) => !isAiephCacheHandler(h));
  group.hooks = [...withoutAieph, aiephCacheHandler()];

  hooks.PreToolUse = pre;
  base.hooks = hooks;
  return base;
}

/** Remove only the aieph PreToolUse cache hook; leave other entries intact. */
export function uninstallClaudeCodePreToolUseHook(
  existing: ClaudeSettings | null,
): ClaudeSettings | null {
  if (!existing || typeof existing !== "object") return existing;
  if (!existing.hooks || !Array.isArray(existing.hooks.PreToolUse)) {
    return existing;
  }

  const base: ClaudeSettings = { ...existing };
  const hooks = { ...base.hooks };
  const pre = hooks.PreToolUse ?? [];
  const nextPre: MatcherGroup[] = [];
  for (const g of pre) {
    const handlers = Array.isArray(g.hooks) ? g.hooks : [];
    const kept = handlers.filter((h) => !isAiephCacheHandler(h));
    if (kept.length === 0 && g.matcher === AIEPH_CACHE_MATCHER) {
      continue;
    }
    if (kept.length !== handlers.length) {
      nextPre.push({ ...g, hooks: kept });
    } else {
      nextPre.push(g);
    }
  }
  if (nextPre.length === 0) {
    const { PreToolUse: _drop, ...rest } = hooks;
    base.hooks = Object.keys(rest).length > 0 ? rest : undefined;
    if (base.hooks === undefined) {
      const { hooks: _h, ...root } = base;
      return Object.keys(root).length > 0 ? root : {};
    }
    return base;
  }
  hooks.PreToolUse = nextPre;
  base.hooks = hooks;
  return base;
}

export async function installClaudeCodeHooks(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".claude");
  const file = path.join(dir, "settings.json");
  let existing: ClaudeSettings | null = null;
  if (await pathExists(file)) {
    const raw = await readFile(file, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      existing = JSON.parse(trimmed) as ClaudeSettings;
    } else {
      existing = {};
    }
  }
  const next = mergeClaudeCodePreToolUseHook(
    mergeClaudeCodeSessionStartHook(mergeClaudeCodeSettings(existing)),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function uninstallClaudeCodeHooks(cwd: string): Promise<void> {
  const file = path.join(cwd, ".claude", "settings.json");
  if (!(await pathExists(file))) return;
  const raw = await readFile(file, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const existing = JSON.parse(trimmed) as ClaudeSettings;
  const afterPostToolUse = uninstallClaudeCodeSettings(existing);
  if (afterPostToolUse === null) return;
  const afterSessionStart = uninstallClaudeCodeSessionStartHook(afterPostToolUse);
  if (afterSessionStart === null) return;
  const next = uninstallClaudeCodePreToolUseHook(afterSessionStart);
  if (next === null) return;
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}
