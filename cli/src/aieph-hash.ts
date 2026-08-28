/**
 * Hash helper for repo .aieph isolation checks (queue/sent/observe-state + full tree).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Stable hash of all files under dir (relative paths + contents). Missing dir → empty hash. */
export async function hashDirectory(dir: string): Promise<string> {
  const h = createHash("sha256");
  const files = (await walkFiles(dir)).sort();
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    h.update(rel);
    h.update("\0");
    try {
      const st = await stat(file);
      h.update(String(st.size));
      h.update("\0");
      h.update(await readFile(file));
    } catch {
      h.update("missing");
    }
    h.update("\n");
  }
  return h.digest("hex");
}

export const REPO_AIEPH_QUEUE_FILES = [
  "queue.jsonl",
  "sent.json",
  "observe-state.json",
] as const;
