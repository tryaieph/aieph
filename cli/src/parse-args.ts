import { DEFAULT_WINDOW_MONTHS } from "./analyze.js";

export type CliArgs = {
  command: "sync" | "init" | "observe" | "uninstall" | "memory" | null;
  memorySubcommand: "serve" | "review-hint" | null;
  staleAfterDays: number | null;
  dryRun: boolean;
  json: boolean;
  check: boolean;
  cwd: string;
  windowMonths: number;
  help: boolean;
  error: string | null;
  quiet: boolean;
  noWrite: boolean;
  send: boolean;
  noTelemetry: boolean;
  uninstall: boolean;
  yes: boolean;
  printCi: boolean;
  claudeCode: boolean;
  cursor: boolean;
  stdin: boolean;
  files: string[];
};

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let command: "sync" | "init" | "observe" | "uninstall" | "memory" | null = null;
  let memorySubcommand: "serve" | "review-hint" | null = null;
  let staleAfterDays: number | null = null;
  let dryRun = false;
  let json = false;
  let check = false;
  let cwd = process.cwd();
  let windowMonths = DEFAULT_WINDOW_MONTHS;
  let help = false;
  let error: string | null = null;
  let quiet = false;
  let noWrite = false;
  let send = false;
  let noTelemetry = false;
  let uninstall = false;
  let yes = false;
  let printCi = false;
  let claudeCode = false;
  let cursor = false;
  let stdin = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      continue;
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--stdin") {
      stdin = true;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--check") {
      check = true;
      continue;
    }
    if (a === "--quiet") {
      quiet = true;
      continue;
    }
    if (a === "--no-write") {
      noWrite = true;
      continue;
    }
    if (a === "--send") {
      send = true;
      continue;
    }
    if (a === "--no-telemetry") {
      noTelemetry = true;
      continue;
    }
    if (a === "--uninstall") {
      uninstall = true;
      continue;
    }
    if (a === "--yes") {
      yes = true;
      continue;
    }
    if (a === "--print-ci") {
      printCi = true;
      continue;
    }
    if (a === "--claude-code") {
      claudeCode = true;
      continue;
    }
    if (a === "--cursor") {
      cursor = true;
      continue;
    }
    if (a === "--cwd") {
      const next = args[++i];
      if (!next) {
        error = "missing value for --cwd";
        break;
      }
      cwd = next;
      continue;
    }
    if (a === "--window-months") {
      const next = args[++i];
      if (!next) {
        error = "missing value for --window-months";
        break;
      }
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1) {
        error = "invalid --window-months (need positive integer)";
        break;
      }
      windowMonths = n;
      continue;
    }
    if (a === "--stale-after-days") {
      const next = args[++i];
      if (!next) {
        error = "missing value for --stale-after-days";
        break;
      }
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0) {
        error = "invalid --stale-after-days (need non-negative integer)";
        break;
      }
      staleAfterDays = n;
      continue;
    }
    if (a.startsWith("-")) {
      error = `unknown option: ${a}`;
      break;
    }
    if (command === null) {
      if (
        a === "sync" ||
        a === "init" ||
        a === "observe" ||
        a === "uninstall" ||
        a === "memory"
      ) {
        command = a;
        continue;
      }
      error = `unknown command: ${a}`;
      break;
    }
    if (command === "observe") {
      files.push(a);
      continue;
    }
    if (command === "memory" && memorySubcommand === null) {
      if (a === "serve" || a === "review-hint") {
        memorySubcommand = a;
        continue;
      }
      error = `unknown memory subcommand: ${a} (expected: serve, review-hint)`;
      break;
    }
    error = `unexpected argument: ${a}`;
    break;
  }

  if (
    !error &&
    command === "observe" &&
    files.length === 0 &&
    !stdin &&
    !help
  ) {
    error = "observe requires at least one file argument or --stdin";
  }

  if (!error && command === "memory" && memorySubcommand === null && !help) {
    error = "memory requires a subcommand: serve, review-hint";
  }

  return {
    command,
    memorySubcommand,
    staleAfterDays,
    dryRun,
    json,
    check,
    cwd,
    windowMonths,
    help,
    error,
    quiet,
    noWrite,
    send,
    noTelemetry,
    uninstall,
    yes,
    printCi,
    claudeCode,
    cursor,
    stdin,
    files,
  };
}
