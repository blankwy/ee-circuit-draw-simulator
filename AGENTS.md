# AGENTS.md

This repository is an **Agent Skill** for circuit work: real simulation, real numbers, real waveforms.
`SKILL.md` is the single source of truth for the workflow. Read it before answering any circuit question.

## When this applies

Any request that needs circuit behaviour rather than a textbook formula — 电路仿真、波形、滤波器、
555、运放、振荡器、分压、整流、RC 充放电、生成电路图、可交互电路 — and any request to *do* something
with a circuit file.

Skip it for pure concept questions ("what is Ohm's law") and for decorative diagrams that need no
simulation.

## Non-negotiables

1. **Numbers come from the CLI**, from `measurements` / `sample` / `sweep`. Never quote a formula result
   as a measured value. If you compare theory with simulation, label both.
2. **Do not re-implement the bridge.** `scripts/circuitlab.mjs` already wraps attach → load → set →
   step → measure → sample → sweep → SVG → share. If it lacks a capability, extend the CLI.
3. **Deterministic stepping only** (`sim.step`). `sim.run` is wall-clock driven and irreproducible.
4. **Never hand-write element coordinates.** Author circuits as netlist JSON (see
   `references/netlist.md`) or modify built-in circuits with `--set`.
5. **Multi-terminal parts** (op-amp, 555, transistors) belong to built-in circuits plus `--set`;
   auto-routing a hand-written netlist with them can stall the solver.
6. **A `拓扑错误` is a real error.** The CLI checks, before simulating, that a transistor C/E (or
   MOSFET D/S) pair is not on the same net. Do not `--force` past it unless the short is the point.
7. **Deliver PNG for humans** (`--png`, `--shot x.png`). Do not read an inline SVG back: it is one
   very long line, and line-based readers truncate it.
8. **Batch multi-part work into one process.** Attach costs ~4.5 s per process; the work itself adds
   ~1 s. `run --jobs @jobs.json` executes several jobs (different circuits, different outputs) against
   one backend — 7.1 s for three jobs versus 16.3 s as three runs. One job failing leaves the others
   intact and sets the overall `ok` to false; never drop that silently.

## First run

```bash
node scripts/circuitlab.mjs probe    # engine present? backend reachable?
node scripts/circuitlab.mjs setup    # if the engine is missing: clone + build (one time)
```

`stdout` is JSON only; diagnostics go to `stderr`. During development the CLI starts and stops its own
static server, so there is no daemon to manage.

## Layout

| Path | Purpose |
|---|---|
| `SKILL.md` | skill entry: preconditions, delivery shapes, workflow, hard rules |
| `scripts/circuitlab.mjs` | the CLI (`setup` / `probe` / `corpus` / `run` / `share` / `shot`) |
| `scripts/smoke.mjs` | re-derives the documented numbers; run before publishing |
| `scripts/lib/` | engine discovery, SVG rendering, engineering-unit parsing |
| `references/` | netlist schema, corpus index, MCP tool map, troubleshooting |
| `vendor/` | gitignored engine checkout created by `setup` |
