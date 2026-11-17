---
name: pi-loop-herdr
description: In a pi-loop run on a machine with Herdr (hc), how to start long work so it stays visible under the run's own terminal. Use when a loop run starts another agent, a build or a server.
---

# Visible work from a loop run

A loop run here has its own Herdr terminal (`loop-<id>-<fire>`), and `HC_TERMINAL_ID` points at it, so
whatever you start with `hc run` sits under it where the owner can watch and step in.

- Start long work with `hc run --bg --name <name> ...`, never anonymously in the background. Name it
  after the loop and the job: `<loop-id>-<what-it-does>`, e.g. `codebase-health-split-store`
  (1-32 of `a-z 0-9 - _`, unique among live terminals).
- Agents: interactive (`hc run --bg --name review-x claude "<task>; report with hc send $HC_TERMINAL_ID when done"`),
  never a one-shot print mode. Wait with `hc wait`, not sleep. See `hc --skill`.
- Finish your own work (including `loop_report`) only once what you started has reported; kill and
  `hc rm` helpers whose results you have.
