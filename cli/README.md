# aieph

Hi, and welcome 🌱

**aieph** is a small command-line companion that gives the AI tools you already
work with — like Claude Code or Cursor — a gentle, shared memory that lives
entirely on your own machine.

The idea behind it is simple: you shouldn't have to explain the same things to
your assistant over and over. Tell it something once, and it can remember —
across chats, across tools, across days.

## What it can do for you

- **A shared memory for your assistants.** Jot down a fact, a preference, or a
  decision, and any connected AI can gently recall it later. You write it once,
  and the next conversation already knows.
- **Quiet notes about dependency updates.** It keeps a light eye on which major
  versions the wider ecosystem has moved to, and leaves short notes so your
  assistant stays aware of changes that landed after its training.
- **Yours, and local.** Your memory is just plain Markdown files kept under your
  project and home folder, with a small search index beside them. There's no
  account to sign up for, and your notes stay on your own computer.

## Trying it out

If you'd like to give it a try, a single command sets everything up:

```bash
npm install -g aieph
```

Then, whenever you feel ready, you can let it introduce itself to your editor:

```bash
aieph init --claude-code   # for Claude Code
aieph init --cursor        # for Cursor
```

That gently registers the memory server and a couple of optional helpers. It
only ever touches your own personal settings — never anything your team shares.

## Using it day to day

- `aieph memory serve` starts a small, local memory server your AI tools can
  connect to. Whatever one assistant remembers, the others can recall too.
- `aieph sync` and `aieph observe` are the quiet helpers that keep those
  dependency-update notes fresh for you.

For the most part you won't have to think about any of this — once it's set up,
it simply hums along in the background.

## If you ever want to remove it

No hard feelings — taking it back out is just as easy as putting it in:

```bash
aieph init --uninstall --claude-code   # unregister from Claude Code
aieph init --uninstall --cursor        # unregister from Cursor
```

That removes the helpers and the memory-server registration it added. And if
you'd also like to remove the program itself:

```bash
npm uninstall -g aieph
```

Your notes are yours, so anything you've written stays right where it is until
you choose to remove it.

## License

Released under the MIT License — please use it in whatever way helps you most.
