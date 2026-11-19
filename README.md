# pi-loop-herdr

**See your [pi-loop](https://github.com/recursive-systems/pi-loop) runs in [Herdr](https://herdr.dev).**

Every loop run that wakes a model (never a gate's skip) gets its own named terminal in `hc`,
`loop-<id>-<fire>`, under the terminal your Pi runs in. Attach to it to watch the run live, type to
steer it, or press Tab to take it over: it becomes a regular Pi on the run's conversation, and the loop
still gets its report. When the run ends, its terminal stays, showing done, failed or needs you,
and older finished ones are cleaned up (the newest two per loop, for up to 6 hours).

With pi-loop's `pi` runner (`"loop": { "runner": "pi" }` in settings) there is no watcher: the terminal
`loop-<id>-<fire>` IS the run, an ordinary Pi session you attach to and type into. It outlives the session that
runs the loop, so restarting that session picks the run up instead of losing it, and it stays open for a while
after the run is recorded (then pi-loop closes it). Its labels add `loop-kind=run` and `loop-runner=pi`.

Anything the run starts with `hc run` sits under the run's terminal, and runs are asked to name what
they start after the job.

## Install

```bash
pi install git:github.com/recursive-systems/pi-loop-herdr@v0.1.0
```

Needs pi-loop 0.19 or later and `hc` on `PATH` (or in `~/.local/bin`). It reads the core's socket from
`~/.local/state/herdr-core/<session>/core.lock`. If `hc` is missing or fails, it does nothing and your
loops run as before.

Terminals carry labels `loop=<id>`, `loop-fire=<n>`, `loop-status=<status>` (once it ends) and
`loop-by=pi-loop-herdr`: `hc ls --label loop=<id>` lists one loop's runs.

MIT
