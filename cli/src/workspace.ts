import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";

export type DepEntry = {
  name: string;
  range: string;
};

export type PackageJsonFields = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

export function collectDepsFromPkg(pkg: PackageJsonFields): DepEntry[] {
  const out: DepEntry[] = [];
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    out.push({ name, range });
  }
  for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) {
    out.push({ name, range });
  }
  return out;
}

/** @deprecated alias — prefer collectDepsFromPkg */
export const collectDeps = collectDepsFromPkg;

export type TargetPackage = {
  /** Absolute path to package.json */
  pkgPath: string;
  /** Path relative to cwd (posix-ish) */
  relPath: string;
  /** package.json name, or directory basename */
  displayName: string;
  pkg: PackageJsonFields;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse pnpm-workspace.yaml `packages:` list without a YAML dependency. */
export function parsePnpmWorkspacePackages(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }

    if (!inPackages) continue;

    // New top-level key ends the list
    if (/^[A-Za-z_][\w-]*\s*:/.test(trimmed) && !trimmed.startsWith("-")) {
      break;
    }

    const m = trimmed.match(/^-\s+(.+)$/);
    if (!m) continue;
    let raw = m[1]!.trim();
    if (
      (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))
    ) {
      raw = raw.slice(1, -1);
    }
    if (raw) patterns.push(raw);
  }

  return patterns;
}

export function workspacesFromPackageJson(
  pkg: PackageJsonFields,
): string[] | null {
  const ws = pkg.workspaces;
  if (!ws) return null;
  if (Array.isArray(ws)) return ws.length > 0 ? ws : null;
  if (Array.isArray(ws.packages) && ws.packages.length > 0) return ws.packages;
  return null;
}

/**
 * Expand a single workspace pattern to directories that contain package.json.
 * Supports exact paths and a single trailing `/*` segment (e.g. packages/*).
 */
async function expandPattern(
  cwd: string,
  pattern: string,
): Promise<string[]> {
  if (pattern.startsWith("!")) return [];

  const dirs: string[] = [];

  if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
    const parent = path.join(cwd, pattern.slice(0, -2));
    if (!(await pathExists(parent))) return [];
    const entries = await readdir(parent, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(path.join(parent, e.name));
    }
    return dirs;
  }

  if (pattern.includes("*")) {
    // Unsupported glob shape — skip rather than guess
    return [];
  }

  dirs.push(path.join(cwd, pattern));
  return dirs;
}

export async function resolveWorkspaceTargets(
  cwd: string,
  patterns: string[],
): Promise<TargetPackage[]> {
  const seen = new Set<string>();
  const out: TargetPackage[] = [];

  for (const pattern of patterns) {
    const dirs = await expandPattern(cwd, pattern);
    for (const dir of dirs) {
      const pkgPath = path.join(dir, "package.json");
      if (!(await pathExists(pkgPath))) continue;
      const abs = path.resolve(pkgPath);
      if (seen.has(abs)) continue;
      seen.add(abs);

      const raw = await readFile(pkgPath, "utf8");
      let pkg: PackageJsonFields;
      try {
        pkg = JSON.parse(raw) as PackageJsonFields;
      } catch {
        continue;
      }

      const relPath = path.relative(cwd, pkgPath).split(path.sep).join("/");
      const displayName =
        typeof pkg.name === "string" && pkg.name.length > 0
          ? pkg.name
          : path.basename(dir);

      out.push({ pkgPath: abs, relPath, displayName, pkg });
    }
  }

  return out;
}

export async function loadWorkspacePatterns(
  cwd: string,
  rootPkg: PackageJsonFields,
): Promise<string[] | null> {
  const pnpmPath = path.join(cwd, "pnpm-workspace.yaml");
  if (await pathExists(pnpmPath)) {
    const content = await readFile(pnpmPath, "utf8");
    const patterns = parsePnpmWorkspacePackages(content);
    return patterns.length > 0 ? patterns : null;
  }
  return workspacesFromPackageJson(rootPkg);
}

export function formatScanningLine(
  relPaths: string[],
): string {
  const n = relPaths.length;
  const shown =
    n <= 3
      ? relPaths.join(", ")
      : `${relPaths.slice(0, 3).join(", ")} +${n - 3} more`;
  return `Scanning ${n} package.json (${shown})`;
}
