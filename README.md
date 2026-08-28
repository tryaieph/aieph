# aieph

*Your fix, everyone's gain* 🌱

**aieph** is a shared cache of answers for AI coding assistants. When one
developer's assistant works something out — a fix, an error's meaning, the way a
library really behaves — that answer can quietly help the next person, and
future you, instead of everyone paying to figure out the same thing all over
again.

This repository is how you plug in.

## How it helps, in practice

Your assistant reaches for the web fairly often — a `WebSearch` here, a
`WebFetch` there. The little hook in this repo sits just in front of those
moments:

- Before the search goes out, it gently asks the shared aieph cache whether a
  good answer is already known.
- If one is, the cache hands it straight back and the web trip is skipped —
  you get the answer without spending a fresh round of searching on it.
- If nothing matches, or the cache is even a touch slow, the hook simply steps
  aside and your assistant carries on exactly as it would have. It only ever
  helps; it never gets in the way.

That last part matters, so it's worth saying plainly: the hook is **fail-open**.
Any timeout, hiccup, or miss means your original tool call runs untouched.

## Adding it to Claude Code

First, you can bring the files onto your machine wherever you like:

```bash
git clone https://github.com/tryaieph/aieph.git
```

Then, whenever you feel ready, you can point Claude Code at the hook by adding
this to your `~/.claude/settings.json` (Node 18+ is all it needs):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebSearch|WebFetch",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/aieph/hook/aieph-cache.mjs" }
        ]
      }
    ]
  }
}
```

That's the whole setup — no keys, no account, nothing to sign up for. If you'd
ever like to point it somewhere else, `AIEPH_API_BASE` and `LOOKUP_TIMEOUT_MS`
are there for you, but the defaults are meant to just work.

*(Cursor support is on the way — for now the hook is tuned for Claude Code.)*

## If you ever want to remove it

No hard feelings — you can simply take that `PreToolUse` block back out of your
`settings.json`, and delete the clone if you'd like. Nothing else is left
behind.

## A gentle note on what's shared

To look an answer up, the text of your search query is sent to the aieph cache
so it can look for a match — that's the whole trick, and it's the only thing
that leaves your machine here. There are no accounts, and a miss changes
nothing about how your assistant works. The cache is still young and growing, so
plenty of searches won't have a match yet; that's expected, and those simply
pass through.

## A small bonus: local memory

Alongside the cache, the [`cli/`](cli/) folder holds the `aieph` command-line
tool, which gives the assistants you already use a gentle **local** memory —
write a fact once, and any connected assistant can recall it later. It lives
entirely on your own machine. There's more about it in
[`cli/README.md`](cli/README.md).

## License

Released under the MIT License — please use it in whatever way helps you most.
