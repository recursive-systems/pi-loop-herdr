# pi-loop-herdr

**See your [pi-loop](https://github.com/recursive-systems/pi-loop) runs in [Herdr](https://herdr.dev).**

Every loop run that wakes a model (never a gate's skip) gets its own named terminal in `hc`,
`loop-<id>-<fire>`, under the terminal your Pi runs in. Attach to it to watch the run live, type to
steer it, or press Tab to take it over: it becomes a regular Pi on the run's conversation, and the loop
still gets its report. When the run ends, its terminal stays, showing done, failed or needs you,
and older finished ones are cleaned up (the newest two per loop, for up to 6 hours).

Anything the run starts with `hc run` sits under the run's terminal, and runs are asked to name what
they start after the job.

A loop's native run (pi-loop 0.20's `agents`: Claude Code or Codex itself) is not watched: its program runs in
that terminal, so attaching gives you an ordinary Claude Code or Codex session. pi-loop follows it through the
handle this extension gives back (status, screen, keys, send, close). A finished one stays until it is swept,
unless you have typed into it since its run ended: then it is yours and is never swept.

## Install

```bash
pi install git:github.com/recursive-systems/pi-loop-herdr@v0.2.0
```

Needs pi-loop 0.19 or later and `hc` on `PATH` (or in `~/.local/bin`). It reads the core's socket from
`~/.local/state/herdr-core/<session>/core.lock`. If `hc` is missing or fails, it does nothing and your
loops run as before.

Terminals carry labels `loop=<id>`, `loop-fire=<n>`, `loop-status=<status>` (once it ends),
`loop-native=claude|codex` and `loop-turn=<n>` for a native run, and `loop-by=pi-loop-herdr`: `hc ls --label loop=<id>` lists one loop's runs.

## Run the tests

Use Node.js 22 (22.6 or later). `npm test` uses Node's TypeScript stripping, which Node 18 does not
support. With Node 22 on your `PATH`, run `npm test` from the repo root.
On the Recursive Systems VM, use `PATH=/opt/node22/bin:$PATH npm test` if `node -v` still shows Node 18.

MIT
