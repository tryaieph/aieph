#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./parse-args.js";
import { runSync } from "./sync.js";
import { runInit } from "./init.js";
import { runObserve } from "./observe-cmd.js";
import { runUninstall } from "./uninstall.js";
import { extractCursorFilePath } from "./cursor.js";
import { runStdioServer } from "./memory/server.js";
import { formatReviewHint } from "./memory/review-hint.js";
import { findStaleEntries } from "./memory/stale.js";
import { HELP } from "./help.js";

export { HELP };

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function packageVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function filesFromStdin(): Promise<string[]> {
  let raw: string;
  try {
    raw = await readStdinText();
  } catch {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const filePath = extractCursorFilePath(parsed);
  return filePath ? [filePath] : [];
}

async function main(): Promise<void> {
  if (
    process.argv.includes("--version") ||
    process.argv.includes("-V")
  ) {
    console.log(packageVersion());
    process.exit(0);
  }

  const args = parseArgs(process.argv);

  if (args.error) {
    console.error(args.error);
    process.exit(1);
  }

  if (args.help || args.command === null) {
    console.log(HELP);
    process.exit(args.command === null && !args.help ? 1 : 0);
  }

  if (args.command === "uninstall") {
    try {
      await runUninstall({
        cwd: args.cwd,
        yes: args.yes,
      });
      process.exit(0);
    } catch (e) {
      console.error((e as Error).message ?? String(e));
      process.exit(1);
    }
  }

  if (args.command === "init") {
    try {
      await runInit({
        cwd: args.cwd,
        uninstall: args.uninstall,
        printCi: args.printCi,
        claudeCode: args.claudeCode,
        cursor: args.cursor,
      });
      process.exit(0);
    } catch (e) {
      console.error((e as Error).message ?? String(e));
      process.exit(1);
    }
  }

  if (args.command === "observe") {
    try {
      let files = args.files;
      if (args.stdin) {
        files = await filesFromStdin();
      }
      const result = await runObserve({
        cwd: args.cwd,
        files,
        noTelemetry: args.noTelemetry,
        quiet: args.quiet,
      });
      process.exit(result.exitCode);
    } catch (e) {
      if (!args.quiet) {
        console.error((e as Error).message ?? String(e));
      }
      process.exit(args.quiet ? 0 : 1);
    }
  }

  if (args.command === "memory") {
    if (args.memorySubcommand === "serve") {
      // Runs until stdin closes (the client disconnects) — do not process.exit here.
      runStdioServer(args.cwd);
      return;
    }
    if (args.memorySubcommand === "review-hint") {
      // Meant to run as a SessionStart hook: stdout becomes context the model
      // sees, so print nothing but the hint (or nothing at all) and never fail
      // the session by throwing — fail-open, same as observe/sync hooks.
      try {
        const stale = await findStaleEntries(args.cwd, {
          staleAfterDays: args.staleAfterDays ?? undefined,
        });
        const hint = formatReviewHint(stale);
        if (hint) console.log(hint);
      } catch {
        // swallow — a broken memory store must never block session start
      }
      process.exit(0);
    }
  }

  if (args.command === "sync") {
    try {
      await runSync({
        cwd: args.cwd,
        dryRun: args.dryRun,
        json: args.json,
        check: args.check,
        windowMonths: args.windowMonths,
        quiet: args.quiet,
        noWrite: args.noWrite,
        send: args.send,
        noTelemetry: args.noTelemetry,
      });
      process.exit(0);
    } catch (e) {
      const err = e as Error & { exitCode?: number };
      if (typeof err.exitCode === "number") {
        process.exit(err.exitCode);
      }
      console.error(err.message ?? String(e));
      process.exit(1);
    }
  }
}

main();
