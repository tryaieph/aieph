import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendAiephGitignore } from "./delivery.js";

export const DEFAULT_ENDPOINT = "https://aieph.dev";

export const CONFIG_REL = ".aieph/config.json";

export type AiephConfig = {
  endpoint: string;
  telemetry: boolean;
};

export const DEFAULT_CONFIG: AiephConfig = {
  endpoint: DEFAULT_ENDPOINT,
  telemetry: true,
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function parseConfig(raw: unknown): AiephConfig | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const endpoint =
    typeof o.endpoint === "string" && o.endpoint.trim().length > 0
      ? o.endpoint.trim()
      : DEFAULT_ENDPOINT;
  const telemetry = o.telemetry === false ? false : true;
  return { endpoint, telemetry };
}

type ConfigFileResult =
  | { status: "ok"; cfg: AiephConfig }
  | { status: "missing" }
  | { status: "invalid" };

async function readConfigFile(cwd: string): Promise<ConfigFileResult> {
  const p = path.join(path.resolve(cwd), CONFIG_REL);
  try {
    const text = await readFile(p, "utf8");
    try {
      const parsed: unknown = JSON.parse(text);
      const cfg = parseConfig(parsed);
      if (!cfg) return { status: "invalid" };
      return { status: "ok", cfg };
    } catch {
      return { status: "invalid" };
    }
  } catch {
    return { status: "missing" };
  }
}

/** Load .aieph/config.json; invalid/missing → defaults. Never throws. */
export async function loadAiephConfig(cwd: string): Promise<AiephConfig> {
  const result = await readConfigFile(cwd);
  if (result.status === "ok") return result.cfg;
  return { ...DEFAULT_CONFIG };
}

/**
 * Explicit endpoint only: env AIEPH_ENDPOINT > valid config.json.
 * Missing/invalid config → null (no silent default). Used for ranking GET.
 */
export async function resolveConfiguredEndpoint(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnv = env.AIEPH_ENDPOINT?.trim();
  if (fromEnv) return fromEnv;
  const result = await readConfigFile(cwd);
  if (result.status === "ok") return result.cfg.endpoint || DEFAULT_ENDPOINT;
  return null;
}

/**
 * Priority: env AIEPH_ENDPOINT > config.json endpoint > default.
 * Used for observe --send.
 */
export async function resolveEndpoint(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return (await resolveConfiguredEndpoint(cwd, env)) ?? DEFAULT_ENDPOINT;
}

/**
 * Telemetry on unless --no-telemetry or config.telemetry === false.
 * Missing/invalid config → telemetry on (default).
 */
export async function isTelemetryEnabled(
  cwd: string,
  noTelemetryFlag: boolean,
): Promise<boolean> {
  if (noTelemetryFlag) return false;
  const result = await readConfigFile(cwd);
  if (result.status === "ok") return result.cfg.telemetry !== false;
  return true;
}

/** Create config.json if missing (idempotent; never overwrite). */
export async function ensureAiephConfig(cwd: string): Promise<AiephConfig> {
  const root = path.resolve(cwd);
  const dir = path.join(root, ".aieph");
  const p = path.join(root, CONFIG_REL);
  await mkdir(dir, { recursive: true });
  if (await pathExists(p)) {
    return loadAiephConfig(root);
  }
  const cfg = { ...DEFAULT_CONFIG };
  await writeFile(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return cfg;
}

/** Ensure .gitignore lists .aieph/ when the file exists. */
export async function ensureAiephGitignore(cwd: string): Promise<void> {
  const gi = path.join(path.resolve(cwd), ".gitignore");
  if (!(await pathExists(gi))) return;
  try {
    const content = await readFile(gi, "utf8");
    const next = appendAiephGitignore(content);
    if (next !== null) {
      await writeFile(gi, next, "utf8");
    }
  } catch {
    // fail-open
  }
}

/** ≤4 lines: what is sent + how to disable. For init stdout only. */
export function formatInitTelemetryNotice(cfg: AiephConfig): string[] {
  return [
    "aieph telemetry: sends rule IDs, package names, majors, and integers only (no code/paths).",
    `Endpoint: ${cfg.endpoint} (env AIEPH_ENDPOINT overrides .aieph/config.json).`,
    'Disable: --no-telemetry, or set "telemetry": false in .aieph/config.json.',
    "Events queue locally; git hooks send with sync --send.",
  ];
}
