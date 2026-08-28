/** v1 delivery target: most-shared E-2 filename across agents. */
export const DELIVERY_FILE = "AGENTS.md";

export const START_MARKER = "<!-- aieph:start -->";
export const END_MARKER = "<!-- aieph:end -->";

export type BlockParse =
  | { kind: "absent" }
  | { kind: "present"; before: string; after: string; block: string }
  | { kind: "broken"; message: string };

/**
 * Parse the managed aieph block. Outside markers is never modified by callers.
 * Broken / ambiguous markers → error (no heuristic repair).
 * A single newline immediately after end is part of the managed region.
 */
export function parseManagedBlock(content: string): BlockParse {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 && endIdx === -1) return { kind: "absent" };

  if (startIdx === -1) {
    return {
      kind: "broken",
      message: `broken aieph markers in ${DELIVERY_FILE}: end without start`,
    };
  }
  if (endIdx === -1) {
    return {
      kind: "broken",
      message: `broken aieph markers in ${DELIVERY_FILE}: start without end`,
    };
  }
  if (endIdx < startIdx) {
    return {
      kind: "broken",
      message: `broken aieph markers in ${DELIVERY_FILE}: end before start`,
    };
  }

  const startCount = content.split(START_MARKER).length - 1;
  const endCount = content.split(END_MARKER).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    return {
      kind: "broken",
      message: `broken aieph markers in ${DELIVERY_FILE}: duplicate markers`,
    };
  }

  let blockEnd = endIdx + END_MARKER.length;
  if (content.startsWith("\r\n", blockEnd)) blockEnd += 2;
  else if (content.startsWith("\n", blockEnd)) blockEnd += 1;

  const before = content.slice(0, startIdx);
  const after = content.slice(blockEnd);
  const block = content.slice(startIdx, blockEnd);
  return { kind: "present", before, after, block };
}

export type ApplyResult =
  | { ok: true; content: string | null; changed: boolean }
  | { ok: false; error: string };

function normalizeBlock(newBlock: string): string {
  let b = newBlock;
  if (!b.endsWith(END_MARKER) && !b.includes(END_MARKER)) {
    return b.endsWith("\n") ? b : `${b}\n`;
  }
  // Ensure exactly one trailing newline after end marker
  const endAt = b.lastIndexOf(END_MARKER);
  const head = b.slice(0, endAt + END_MARKER.length);
  return `${head}\n`;
}

/**
 * Apply or remove the managed block.
 * - file missing + block → create content = block only
 * - file missing + no block → null (no create)
 * - block present → replace; absent → append
 * - newBlock null → remove block only (keep empty file)
 */
export function applyManagedBlock(
  existing: string | null,
  newBlock: string | null,
): ApplyResult {
  if (existing === null) {
    if (newBlock === null) return { ok: true, content: null, changed: false };
    return { ok: true, content: normalizeBlock(newBlock), changed: true };
  }

  const parsed = parseManagedBlock(existing);
  if (parsed.kind === "broken") return { ok: false, error: parsed.message };

  if (newBlock === null) {
    if (parsed.kind === "absent") {
      return { ok: true, content: existing, changed: false };
    }
    const next = parsed.before + parsed.after;
    return { ok: true, content: next, changed: next !== existing };
  }

  const block = normalizeBlock(newBlock);

  if (parsed.kind === "absent") {
    const sep =
      existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const next = existing + sep + block;
    return { ok: true, content: next, changed: true };
  }

  const next = parsed.before + block + parsed.after;
  return { ok: true, content: next, changed: next !== existing };
}

/** True when .gitignore already mentions .aieph/ */
export function gitignoreHasAieph(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const t = line.trim();
    return t === ".aieph/" || t === ".aieph" || t === "/.aieph/";
  });
}

/** Append `.aieph/` line; returns new content or null if unchanged. */
export function appendAiephGitignore(content: string): string | null {
  if (gitignoreHasAieph(content)) return null;
  const base =
    content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${base}.aieph/\n`;
}

/** Remove `.aieph/` / `.aieph` / `/.aieph/` lines; null if unchanged. */
export function removeAiephGitignore(content: string): string | null {
  if (!gitignoreHasAieph(content)) return null;
  const lines = content.split(/\r?\n/);
  const next = lines.filter((line) => {
    const t = line.trim();
    return t !== ".aieph/" && t !== ".aieph" && t !== "/.aieph/";
  });
  let body = next.join("\n");
  if (content.endsWith("\n") && !body.endsWith("\n")) body += "\n";
  if (body === content) return null;
  return body;
}
