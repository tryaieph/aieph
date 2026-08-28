import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

/** Stable marker embedded in command string to identify aieph-managed hooks. */
export const AIEPH_CURSOR_MARKER = "aieph observe";

/**
 * afterFileEdit command: pipe Cursor stdin JSON to observe --stdin.
 * Fail-open: missing aieph binary must not block the editor (command -v + exit 0).
 * Input shape from https://cursor.com/docs/hooks (afterFileEdit).
 * No jq — observe parses JSON itself.
 */
export const AIEPH_CURSOR_COMMAND =
  "command -v aieph >/dev/null 2>&1 || exit 0; " +
  "aieph observe --stdin --quiet || true; " +
  "exit 0";

/**
 * Official docs afterFileEdit input example (transcribed for fixture tests).
 * https://cursor.com/docs/hooks — afterFileEdit Input
 */
export const CURSOR_AFTER_FILE_EDIT_INPUT_FIXTURE = {
  file_path: "<absolute path>",
  edits: [{ old_string: "<search>", new_string: "<replace>" }],
} as const;

type HookEntry = {
  command?: string;
  [key: string]: unknown;
};

type CursorHooksConfig = {
  version?: number;
  hooks?: {
    afterFileEdit?: HookEntry[];
    [event: string]: HookEntry[] | undefined;
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

export function extractCursorFilePath(
  input: unknown,
): string | null {
  if (!input || typeof input !== "object") return null;
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  return filePath;
}

export function isAiephCursorEntry(e: HookEntry): boolean {
  if (typeof e.command !== "string") return false;
  return e.command.includes(AIEPH_CURSOR_MARKER);
}

export function aiephCursorEntry(): HookEntry {
  return { command: AIEPH_CURSOR_COMMAND };
}

/** Merge aieph afterFileEdit entry without touching other hooks/events. */
export function mergeCursorHooks(
  existing: CursorHooksConfig | null,
): CursorHooksConfig {
  const base: CursorHooksConfig =
    existing && typeof existing === "object" ? { ...existing } : {};
  if (base.version === undefined) base.version = 1;

  const hooks = { ...(base.hooks ?? {}) };
  const after: HookEntry[] = Array.isArray(hooks.afterFileEdit)
    ? hooks.afterFileEdit.map((e) => ({ ...e }))
    : [];

  const withoutAieph = after.filter((e) => !isAiephCursorEntry(e));
  hooks.afterFileEdit = [...withoutAieph, aiephCursorEntry()];
  base.hooks = hooks;
  return base;
}

/** Remove only aieph-managed entries; leave other entries intact. */
export function uninstallCursorHooksConfig(
  existing: CursorHooksConfig | null,
): CursorHooksConfig | null {
  if (!existing || typeof existing !== "object") return existing;
  const base: CursorHooksConfig = { ...existing };
  if (!base.hooks || !Array.isArray(base.hooks.afterFileEdit)) return base;

  const hooks = { ...base.hooks };
  const kept = (hooks.afterFileEdit ?? []).filter((e) => !isAiephCursorEntry(e));
  if (kept.length === 0) {
    const { afterFileEdit: _drop, ...rest } = hooks;
    base.hooks = Object.keys(rest).length > 0 ? rest : undefined;
    if (base.hooks === undefined) {
      const { hooks: _h, ...root } = base;
      // Keep version if it was the only remaining key besides hooks
      return Object.keys(root).length > 0 ? root : {};
    }
    return base;
  }
  hooks.afterFileEdit = kept;
  base.hooks = hooks;
  return base;
}

export async function installCursorHooks(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".cursor");
  const file = path.join(dir, "hooks.json");
  let existing: CursorHooksConfig | null = null;
  if (await pathExists(file)) {
    const raw = await readFile(file, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      existing = JSON.parse(trimmed) as CursorHooksConfig;
    } else {
      existing = {};
    }
  }
  const next = mergeCursorHooks(existing);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function uninstallCursorHooks(cwd: string): Promise<void> {
  const file = path.join(cwd, ".cursor", "hooks.json");
  if (!(await pathExists(file))) return;
  const raw = await readFile(file, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const existing = JSON.parse(trimmed) as CursorHooksConfig;
  const next = uninstallCursorHooksConfig(existing);
  if (next === null) return;
  await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}
