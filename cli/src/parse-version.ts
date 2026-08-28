import semver from "semver";
import type { SkipReason } from "./types.js";

const GIT_PREFIXES = [
  "git+",
  "git://",
  "github:",
  "gitlab:",
  "bitbucket:",
  "ssh://",
  "git@",
];

export function isGitUrl(spec: string): boolean {
  const s = spec.trim().toLowerCase();
  return GIT_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * Resolve the "in use" major from a package.json version string.
 * Returns a skip reason when the major cannot be determined uniquely
 * or the dep is non-registry.
 */
export function extractMajor(
  range: string,
): { major: number } | { skip: SkipReason } {
  const s = range.trim();

  if (s.startsWith("workspace:")) return { skip: "workspace" };
  if (s.startsWith("file:")) return { skip: "file" };
  if (s.startsWith("link:")) return { skip: "link" };
  if (isGitUrl(s)) return { skip: "git" };

  if (/^(\*|latest|x|X)$/i.test(s)) return { skip: "ambiguous" };
  if (s.includes("||") || /\s-\s/.test(s)) return { skip: "ambiguous" };

  // Strip one leading comparator / tilde / caret
  const rest = s.replace(/^(>=|<=|>|<|=|\^|~)\s*/, "").trim();

  // Anything still containing a comparator or whitespace → ambiguous range
  if (/[<>^=~]/.test(rest) || /\s/.test(rest)) return { skip: "ambiguous" };

  // Accept: 1 / 1.2 / 1.2.3 / 1.x / 1.* / v1.2.3 / prerelease tags on the pin
  if (
    !/^[vV]?\d+(\.(x|\*|\d+)(\.(x|\*|\d+)(-[0-9A-Za-z.-]+)?)?)?$/.test(rest)
  ) {
    return { skip: "ambiguous" };
  }

  const coerced = semver.coerce(rest);
  if (!coerced) return { skip: "ambiguous" };
  return { major: coerced.major };
}
