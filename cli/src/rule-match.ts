import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractMajor } from "./parse-version.js";

export type Detect =
  | { type: "regex"; value: string }
  | { type: "toml_key" | "json_key"; path: string };

export type MigrationRule = {
  id: string;
  package: string;
  from_major: number;
  to_major: number;
  kind: string;
  files: string[];
  detect: Detect;
  message: string;
  source_url: string;
  pattern_version: number;
  fix_hint?: string;
  fix?: string;
};

export type MigrationFile = {
  migration_id: string;
  package: string;
  from_major: number;
  to_major: number;
  rules: MigrationRule[];
};

export type RuleWithMigration = {
  rule: MigrationRule;
  migration: MigrationFile;
};

export type MatchDirectoryResult = {
  applicableRuleIds: string[];
  matchedRuleIds: string[];
  missRuleIds: string[];
  matchCounts: Record<string, number>;
};

/** Returns true when a repo-root-relative path should be excluded from scans. */
export type IgnoreMatcher = (relPath: string) => boolean;

/** Opt-in ignore file (gitignore-lite) read from the project root. */
export const AIEPH_IGNORE_FILE = ".aiephignore";

const NEVER_IGNORE: IgnoreMatcher = () => false;

/**
 * Compile one gitignore-lite pattern to a RegExp over "/"-normalized rel paths.
 * Supports: `*` (not crossing "/"), `**` (crossing "/"), leading "/" (anchor to
 * root), trailing "/" (directory → everything under it). A pattern containing a
 * slash is anchored to root; a slash-free pattern matches at any depth. Comments
 * (`#`) and blanks return null.
 */
function ignorePatternToRegExp(pattern: string): RegExp | null {
  let pat = pattern.trim();
  if (pat === "" || pat.startsWith("#")) return null;
  const leadingSlash = pat.startsWith("/");
  if (leadingSlash) pat = pat.slice(1);
  if (pat.endsWith("/")) pat = `${pat}**`;
  const anchored = leadingSlash || pat.includes("/");
  let src = "";
  let i = 0;
  while (i < pat.length) {
    if (pat.startsWith("/**", i)) {
      src += "(?:/.*)?";
      i += 3;
      continue;
    }
    if (pat.startsWith("**/", i)) {
      src += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pat.startsWith("**", i)) {
      src += ".*";
      i += 2;
      continue;
    }
    const c = pat[i]!;
    if (c === "*") {
      src += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      src += "[^/]";
      i++;
      continue;
    }
    src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  try {
    return new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`);
  } catch {
    return null;
  }
}

/**
 * Load `.aiephignore` from rootDir. Absent/empty file → matches nothing (so
 * existing consumers see zero behavior change until they add the file).
 */
export async function loadIgnoreMatcher(
  rootDir: string,
): Promise<IgnoreMatcher> {
  let text: string;
  try {
    text = await readFile(path.join(rootDir, AIEPH_IGNORE_FILE), "utf8");
  } catch {
    return NEVER_IGNORE;
  }
  const regs = text
    .split(/\r?\n/)
    .map(ignorePatternToRegExp)
    .filter((r): r is RegExp => r != null);
  if (regs.length === 0) return NEVER_IGNORE;
  return (rel: string) => {
    const norm = rel.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm === "") return false;
    return regs.some((re) => re.test(norm));
  };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert a simple filename glob to RegExp source (basename-oriented). */
function globToRegSrc(pattern: string): string {
  let i = 0;
  let out = "";
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        i++;
        continue;
      }
      const opts = pattern
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      out += `(?:${opts.join("|")})`;
      i = end + 1;
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return out;
}

export function matchFilePattern(pattern: string, filePath: string): boolean {
  const name = path.basename(filePath);
  const norm = filePath.replace(/\\/g, "/");
  if (pattern.startsWith("**/")) {
    const rest = pattern.slice(3);
    const src = globToRegSrc(rest);
    return (
      new RegExp(`(?:^|/)${src}$`).test(norm) || new RegExp(`^${src}$`).test(name)
    );
  }
  if (pattern.includes("*") || pattern.includes("{")) {
    return new RegExp(`^${globToRegSrc(pattern)}$`).test(name);
  }
  return name === pattern || norm === pattern || norm.endsWith(`/${pattern}`);
}

function detectKeyPath(
  content: string,
  keyPath: string,
  kind: "toml_key" | "json_key",
): boolean {
  const parts = keyPath.split(".");
  const leaf = parts[parts.length - 1]!;
  if (kind === "toml_key") {
    const toml = new RegExp(`(?:^|[\\n\\r])\\s*${escapeReg(leaf)}\\s*=`, "m");
    const json = new RegExp(`"${escapeReg(leaf)}"\\s*:`);
    if (parts.length === 1) return toml.test(content) || json.test(content);
    const parent = parts[parts.length - 2]!;
    if (toml.test(content) || json.test(content)) {
      const parentRe = new RegExp(
        `(?:\\[\\s*${escapeReg(parts.slice(0, -1).join("[."))}|(?:^|[\\n\\r{,])\\s*${escapeReg(parent)}\\s*[=:]|"${escapeReg(parent)}"\\s*:)`,
        "m",
      );
      return parentRe.test(content);
    }
    return false;
  }
  if (kind === "json_key") {
    try {
      const obj = JSON.parse(content) as unknown;
      let cur: unknown = obj;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object" || !(p in (cur as object))) {
          return false;
        }
        cur = (cur as Record<string, unknown>)[p];
      }
      return true;
    } catch {
      return new RegExp(`"${escapeReg(leaf)}"\\s*:`).test(content);
    }
  }
  return false;
}

export function matchesDetect(content: string, detect: Detect): boolean {
  if (detect.type === "regex") {
    return new RegExp(detect.value, "m").test(content);
  }
  if (detect.type === "toml_key" || detect.type === "json_key") {
    return detectKeyPath(content, detect.path, detect.type);
  }
  throw new Error(`unknown detect.type: ${(detect as Detect).type}`);
}

function ruleAppliesToFile(rule: MigrationRule, filePath: string): boolean {
  return rule.files.some((p) => matchFilePattern(p, filePath));
}

function filePresenceHit(rule: MigrationRule, filePath: string): boolean {
  if (rule.id !== "vitest:3->4:workspace") return false;
  return /^vitest\.workspace\./.test(path.basename(filePath));
}

function matchContent(
  rule: MigrationRule,
  filePath: string,
  content: string,
): boolean {
  if (filePresenceHit(rule, filePath)) return true;
  return matchesDetect(content, rule.detect);
}

function depMajor(
  pkgJson: Record<string, unknown> | null,
  name: string,
): number | null {
  if (!pkgJson) return null;
  const buckets = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const;
  for (const b of buckets) {
    const bucket = pkgJson[b];
    if (bucket && typeof bucket === "object" && name in bucket) {
      const v = (bucket as Record<string, unknown>)[name];
      if (typeof v === "string") {
        const parsed = extractMajor(v);
        if ("major" in parsed) return parsed.major;
      }
    }
  }
  return null;
}

type WalkOptions = { ignore?: IgnoreMatcher; ignoreRoot?: string };

async function walkFiles(
  dir: string,
  opts: WalkOptions = {},
  acc: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  const ignoreRoot = opts.ignoreRoot ?? dir;
  for (const ent of entries) {
    if (
      ent.name === "node_modules" ||
      ent.name === ".git" ||
      ent.name === "dist" ||
      ent.name === "coverage"
    ) {
      continue;
    }
    const full = path.join(dir, ent.name);
    const rel = path.relative(ignoreRoot, full).split(path.sep).join("/");
    if (opts.ignore && rel !== "" && opts.ignore(rel)) continue;
    if (ent.isDirectory()) await walkFiles(full, opts, acc);
    else acc.push(full);
  }
  return acc;
}

export async function loadRules(rulesDir: string): Promise<RuleWithMigration[]> {
  const out: RuleWithMigration[] = [];
  let packages: string[];
  try {
    packages = await readdir(rulesDir);
  } catch {
    return out;
  }
  for (const pkg of packages) {
    if (pkg === "fixtures" || pkg === "schema.json") continue;
    const pkgPath = path.join(rulesDir, pkg);
    let st;
    try {
      st = await stat(pkgPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const files = await readdir(pkgPath);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(pkgPath, file);
      const data = JSON.parse(await readFile(full, "utf8")) as MigrationFile;
      for (const rule of data.rules) {
        out.push({ rule, migration: data });
      }
    }
  }
  return out;
}

/**
 * Resolve rules bundled with this package (not cwd-relative).
 * - dist/ or src/ → ../rules (packages/hook/rules, included in npm pack)
 * - monorepo fallback → ../../../rules (repo root) when local bundle missing
 */
export function packagedRulesCandidates(
  fromDir: string = import.meta.dirname,
): string[] {
  return [
    path.resolve(fromDir, "../rules"),
    path.resolve(fromDir, "../../../rules"),
  ];
}

/** Package-relative rules dir; cwd is ignored (kept for call-site compat). */
export async function findRulesDir(_cwd?: string): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of packagedRulesCandidates()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const st = await stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function packageDepMajor(
  pkgJson: Record<string, unknown> | null,
  name: string,
): number | null {
  return depMajor(pkgJson, name);
}

export type MatchFilesResult = {
  applicable: MigrationRule[];
  hits: MigrationRule[];
};

/**
 * Match only the given files (no tree walk). Applies rules whose package
 * from_major matches package.json at cwd.
 */
export async function matchFiles(
  cwd: string,
  filePaths: string[],
  opts?: {
    rulesDir?: string;
    rules?: RuleWithMigration[];
    kinds?: ReadonlySet<string>;
    ignore?: IgnoreMatcher;
  },
): Promise<MatchFilesResult> {
  const rulesDir = opts?.rulesDir ?? (await findRulesDir(cwd));
  const rulesWithMig =
    opts?.rules ?? (rulesDir ? await loadRules(rulesDir) : []);
  const ignore = opts?.ignore ?? (await loadIgnoreMatcher(cwd));

  const pkgPath = path.join(cwd, "package.json");
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    pkg = null;
  }

  const kinds = opts?.kinds;
  const applicable: MigrationRule[] = [];
  for (const item of rulesWithMig) {
    if (kinds && !kinds.has(item.rule.kind)) continue;
    const major = depMajor(pkg, item.rule.package);
    if (major === item.rule.from_major) applicable.push(item.rule);
  }

  const contents = new Map<string, string>();
  for (const fp of filePaths) {
    const abs = path.resolve(cwd, fp);
    const rel = path.relative(cwd, abs).split(path.sep).join("/");
    if (rel !== "" && !rel.startsWith("..") && ignore(rel)) continue;
    try {
      contents.set(abs, await readFile(abs, "utf8"));
    } catch {
      /* skip unreadable */
    }
  }

  const hits: MigrationRule[] = [];
  for (const rule of applicable) {
    let matched = false;
    for (const [abs, content] of contents) {
      const rel = path.relative(cwd, abs);
      if (!ruleAppliesToFile(rule, rel) && !ruleAppliesToFile(rule, abs)) {
        continue;
      }
      if (matchContent(rule, rel, content)) {
        matched = true;
        break;
      }
    }
    if (matched) hits.push(rule);
  }

  return { applicable, hits };
}

export async function matchDirectory(
  targetDir: string,
  opts?: {
    rulesDir?: string;
    rules?: RuleWithMigration[];
    ignore?: IgnoreMatcher;
    ignoreRoot?: string;
  },
): Promise<MatchDirectoryResult> {
  const rulesDir = opts?.rulesDir ?? (await findRulesDir(targetDir));
  const rulesWithMig =
    opts?.rules ?? (rulesDir ? await loadRules(rulesDir) : []);
  const ignoreRoot = opts?.ignoreRoot ?? targetDir;
  const ignore = opts?.ignore ?? (await loadIgnoreMatcher(ignoreRoot));

  const pkgPath = path.join(targetDir, "package.json");
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    pkg = null;
  }

  const applicable: RuleWithMigration[] = [];
  for (const item of rulesWithMig) {
    const major = depMajor(pkg, item.rule.package);
    if (major === item.rule.from_major) applicable.push(item);
  }

  const files = await walkFiles(targetDir, { ignore, ignoreRoot });
  const hitCounts = new Map<string, number>();
  const hitIds: string[] = [];

  for (const { rule } of applicable) {
    let count = 0;
    for (const file of files) {
      const rel = path.relative(targetDir, file);
      if (!ruleAppliesToFile(rule, rel) && !ruleAppliesToFile(rule, file)) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (matchContent(rule, rel, content)) count++;
    }
    if (count > 0) {
      hitIds.push(rule.id);
      hitCounts.set(rule.id, count);
    }
  }

  const matchedSet = new Set(hitIds);
  const missRuleIds = applicable
    .map((a) => a.rule.id)
    .filter((id) => !matchedSet.has(id));

  return {
    applicableRuleIds: applicable.map((a) => a.rule.id),
    matchedRuleIds: hitIds,
    missRuleIds,
    matchCounts: Object.fromEntries(hitCounts),
  };
}
