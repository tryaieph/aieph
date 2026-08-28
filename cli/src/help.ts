export const HELP = `aieph — dependency major-version sync

Usage:
  aieph sync [--dry-run] [--check] [--json] [--cwd <path>] [--window-months <n>]
             [--quiet] [--no-write] [--send] [--no-telemetry]
  aieph init [--uninstall] [--print-ci] [--claude-code] [--cursor] [--cwd <path>]
  aieph observe <file...> [--cwd <path>] [--quiet] [--no-telemetry]
  aieph observe --stdin [--cwd <path>] [--quiet] [--no-telemetry]
  aieph uninstall [--yes] [--cwd <path>]
  aieph memory serve [--cwd <path>]
  aieph memory review-hint [--cwd <path>] [--stale-after-days <n>]

Options:
  --dry-run         Print .aieph/versions.md to stdout; do not write
  --check           Exit 1 if writes would change files; do not write
  --json            Print aggregate JSON to stdout; do not write files
  --cwd             Directory containing package.json (default: .)
  --window-months   Window in months for recent judgment only (default: 6; minority ignores this)
  --quiet           Suppress stdout/stderr for sync and observe
  --stdin           Read Cursor/hook JSON from stdin; use file_path field
  --no-write        Do not write AGENTS.md or .aieph/versions.md (observe queue still runs)
  --send            POST local observe queue (env > .aieph/config.json > https://aieph.dev)
  --no-telemetry    Do not enqueue or send rule-match events
  --uninstall       With init: remove aieph git / Claude Code / Cursor hooks only
  --yes             With uninstall: apply removals (default is dry-run list only)
  --print-ci        Print GitHub Actions snippet to stdout (no file writes)
  --claude-code     Install/merge PostToolUse observe into .claude/settings.json
  --cursor          Install/merge afterFileEdit observe into .cursor/hooks.json
  -h, --help        Show help
  -V, --version     Print package version

  memory serve      Run a local stdio MCP server exposing memory.write/search/list/
                    pin/forget/consolidate/review/verify. Fully local (Markdown +
                    SQLite FTS5 under .aieph/memory and ~/.aieph/memory); no cloud.
  memory review-hint  Print (to stdout) a short hint listing memories not
                    re-verified against the repo in --stale-after-days (default 7).
                    Silent (no output) when nothing is stale. Meant to run as a
                    Claude Code SessionStart hook so the model sees the hint as
                    context at the start of the next session and can call
                    memory.review + memory.verify to check them.

Note: git hooks installed by \`aieph init\` run with --quiet --no-write --send.
経路: hook=イベントのみ / 手動=書き込み+イベント / CI=check のみ
`;
