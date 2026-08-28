# aieph

*your fix, everyone's gain*

aieph is a shared answer cache for AI coding assistants.

When an AI coding assistant is about to search the web, a small hook can quietly
ask: *"Does someone already have the answer?"*

If the answer is already in the shared cache, aieph can return it right away —
avoiding another trip to the web. If there is no answer, aieph simply gets out
of the way.

MISS, timeout, or error? Nothing breaks. The original request continues as
usual. That is the whole idea.

Your fix can become everyone's gain.

## Why a shared cache?

AI coding assistants often look up the same kinds of things:

- a familiar error message
- a library's behavior
- a configuration detail
- a solution someone has already found

The first person does the searching. The next person doesn't necessarily need
to. aieph gives those answers a place to be shared, and as more people use it,
the cache can gradually become more useful.

It's still early, so a cache hit is not guaranteed. Sometimes aieph simply won't
have the answer yet — and that's perfectly fine.

## How it feels

```text
AI assistant
     │
     │  "I'm about to search..."
     ▼
   aieph
     │
     ├── HIT  → answer is already here
     │
     └── MISS / timeout / error
              │
              ▼
          original search
```

aieph is designed to stay out of the way. There is no need to change how you
work when the cache doesn't have something useful.

## Getting started with Claude Code

Claude Code can use aieph with a single `PreToolUse` hook for `WebSearch` and
`WebFetch`. A small setup looks like this:

```bash
git clone https://github.com/tryaieph/aieph.git
```

Then, in `~/.claude/settings.json`, the relevant hook can look like:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebSearch|WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aieph/hook/aieph-cache.mjs"
          }
        ]
      }
    ]
  }
}
```

That's it.

Requirements: Node.js 18+. No account or API key is required.

Optional environment variables:

```text
AIEPH_API_BASE
LOOKUP_TIMEOUT_MS
```

Cursor support is being prepared.

## Removing aieph

If aieph is no longer useful for you, removing the `PreToolUse` block is enough
to return to the original setup.

## What gets sent?

aieph is intentionally simple and transparent. Only the search query text is
sent for matching. Nothing else is sent. There is no account to create and no
personal profile to maintain. When there is no matching answer, the request
passes through normally.

## Local shared memory

aieph also includes a small local-only memory CLI in [`cli/`](cli/). It is
separate from the shared answer cache. The idea is simple: write a fact once,
and let connected assistants remember it later. This memory stays completely
local.

## Early days, honest expectations

aieph is still growing. The shared cache is young, so there will be plenty of
moments when it doesn't have an answer yet. That's intentional: aieph never
needs to be perfect to be useful. A miss should feel exactly like there was no
cache at all.

Over time, every useful answer someone discovers has the potential to help the
next person.

*your fix, everyone's gain.*

## License

MIT
