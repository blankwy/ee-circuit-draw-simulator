# EE Circuit Draw & Simulator

<img src="assets/icon-256.png" width="88" height="88" align="right" alt="An op-amp triangle whose output becomes a sine wave">

**English** · [简体中文](README.zh-CN.md)

An [Agent Skill](https://skill.md) that makes your coding agent **actually simulate circuits** instead of describing them from memory. Load or author a circuit, change a resistor, step the simulator deterministically, read node voltages, sample waveforms, sweep a parameter, render an SVG — and hand back a link that opens a live circuit.

```
your prompt ──▶ agent ──▶ circuitlab.mjs ──▶ headless Chrome ──▶ real nodal-analysis simulator
                    ◀── numbers · waveforms · SVG · share link ──
```

Numbers come from the engine, never from a formula the model recalled. Every value in this README was produced by this skill.

- Engine: [ExtCircuitJS](https://github.com/blankwy/ExtCircuitJS) — a CircuitJS1 fork with a JSON netlist layer and an MCP bridge, GPL-2.0-or-later
- Skill: pure Node ≥ 22, no runtime dependencies, one CLI, JSON on stdout
- CLI on npm: [`ee-circuit-draw-simulator`](https://www.npmjs.com/package/ee-circuit-draw-simulator)
- Works with any agent that reads `SKILL.md` (Claude Code, Codex CLI, DeepSeek Harness, WorkBuddy, …)

## What it answers

| Ask | You get |
|---|---|
| "What's the cutoff of this RC filter?" | Swept frequency response, −3 dB point from measured Vpp |
| "What frequency does this 555 run at?" | Measured 239.6 Hz, duty 49.6% (window t=0.2–0.8 s) |
| "What happens if R2 becomes 22 kΩ?" | Same run, both circuits, comparable numbers |
| "Show me the waveform / the schematic" | Inline SVG, axes and legend included |
| "I want to play with it" | Share URL — the circuit opens in the simulator, sliders live |
| "Why won't this oscillator start?" | `engineSteps`, flat-channel and convergence warnings |

Measured examples (reproducible with the commands below):

| Circuit | Result |
|---|---|
| RC low-pass, R=1 kΩ, C=100 nF | Vpp 9.98 → 2.40 V across 100 Hz–6.4 kHz; 0.707× at 1.6 kHz (theory 1591 Hz) |
| 555 astable, R2 = 10 k / 22 k / 47 k | 239.6 Hz / 108.8 Hz / 50.8 Hz, duty 48–50% |
| Op-amp non-inverting, R2/R1 = 2 k/1 k | Gain 3: 1 V in → 3.00 V out; the stock 5 V source clips at the ±15 V rail |
| Divider 9 V, 1 k/2 k | 6 V at the tap |

## Install

### 0. Prerequisites

- **Node ≥ 22**
- **Chrome or Edge** on the machine (the engine runs in headless Chrome through a page bridge)
- `git`

### 1. Get the skill and its engine

**As an agent skill (recommended).** The agent needs the files on disk to read `SKILL.md`, so clone:

```bash
git clone https://github.com/blankwy/ee-circuit-draw-simulator.git ~/ee-circuit-draw-simulator
cd ~/ee-circuit-draw-simulator
node scripts/circuitlab.mjs setup
```

**As a plain CLI.** Also published on npm — no clone, good for scripts and CI:

```bash
npx ee-circuit-draw-simulator@latest setup     # engine → ~/.ee-circuit/ExtCircuitJS
npx ee-circuit-draw-simulator run --circuit lrc --step 0.005 --measure all
```

`setup` clones the engine, installs its build dependencies plus the headless-browser driver (`playwright-core`), and builds `dist/`. One time, ~2–4 minutes. With a clone the engine lands in `vendor/ExtCircuitJS`; installed from npm (0.2.1 and later) it goes to `~/.ee-circuit/ExtCircuitJS`, so upgrading the package never throws away a 2-minute build. Already have an engine checkout? Skip both and point at it:

```bash
export EXTCIRCUIT_HOME=/path/to/ExtCircuitJS
```

### 2. Register the skill with your agent

A skill is just a folder with `SKILL.md` at its root, so every agent below uses the same content — only the search path differs. Clone once, then link it in (symlink keeps one copy; a copy also works):

| Agent | User-level path | Project-level path |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex CLI | `~/.codex/skills/` | `.codex/skills/` |
| DeepSeek Harness (`dsh`) | `~/.dsh/skills/` or `~/.agents/skills/` | `.dsh/skills/` or `.agents/skills/` |
| WorkBuddy | `~/.workbuddy/skills/` | `.workbuddy/skills/` |

```bash
mkdir -p ~/.claude/skills
ln -s ~/ee-circuit-draw-simulator ~/.claude/skills/ee-circuit-draw-simulator
```

Windows (PowerShell; symlinks need Developer Mode or an elevated shell):

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills\ee-circuit-draw-simulator" -Target "$env:USERPROFILE\ee-circuit-draw-simulator"
```

No symlink permission? Copy the folder instead — everything is relative to the skill root.

#### Claude Code

```bash
ln -s ~/ee-circuit-draw-simulator ~/.claude/skills/ee-circuit-draw-simulator
```

Ask a circuit question in any session; Claude Code loads the skill when the task matches. Project-scoped: link into `.claude/skills/` and commit it for your team.

#### Codex CLI

Skills are behind a feature flag:

```toml
# ~/.codex/config.toml
[features]
skills = true
```

```bash
ln -s ~/ee-circuit-draw-simulator ~/.codex/skills/ee-circuit-draw-simulator
```

Then either describe the task, or invoke it explicitly with `$ee-circuit-draw-simulator`. `/skills` lists what Codex found. Codex also reads `AGENTS.md`, which this repo ships, so a plain `codex` session in the repo gets the workflow without the flag.

#### DeepSeek Harness (`dsh`)

```bash
mkdir -p ~/.dsh/skills
ln -s ~/ee-circuit-draw-simulator ~/.dsh/skills/ee-circuit-draw-simulator
```

`dsh` scans project `.dsh/skills/` → `.agents/skills/` → `~/.dsh/skills/` → `~/.agents/skills/`, one level deep, exact folder name, `SKILL.md` at the root — this repo already complies (kebab-case name, description under the 500-character render cap). Invoke with `/ee-circuit-draw-simulator`.

#### WorkBuddy

```bash
mkdir -p ~/.workbuddy/skills
ln -s ~/ee-circuit-draw-simulator ~/.workbuddy/skills/ee-circuit-draw-simulator
```

Or drop the folder into a project's `.workbuddy/skills/` to scope it to that workspace.

#### Any other Agent Skills client

Point its skills directory at this folder. Nothing else to configure — no MCP server, no background daemon.

### 3. Check it

```bash
node ~/ee-circuit-draw-simulator/scripts/circuitlab.mjs probe
```

`ok: true` means the engine is present and a backend is reachable. If a backend is missing, the next `run` starts a static server itself and shuts it down afterwards.

## Use

```bash
CLI=~/ee-circuit-draw-simulator/scripts/circuitlab.mjs

# 367 built-in circuits, searchable
node $CLI corpus --search 555

# one full round: load → measure
node $CLI run --circuit lrc --measure all

# waveform + schematic in ONE call: 0.6 s of a 240 Hz square wave, PNG for people
node $CLI run --circuit 555square --sample n2 --span 0.6 --points 2000 --settle 0.2 \
  --svg --png --shot out/555.png

# parameter sweep: same run, three values, comparable
node $CLI run --circuit 555square --sweep e14.resistance=10k,22k,47k \
  --probe n2 --settle 0.2 --span 0.6 --points 2000 --svg

# frequency response, log axis
node $CLI run --netlist ~/ee-circuit-draw-simulator/references/examples/rc-lowpass.json \
  --sweep e1.frequency=100,200,400,800,1600,3200,6400 --probe n1 \
  --settle 0.02 --span 0.02 --points 100 --logx --svg

# share link — no browser needed
node $CLI share --circuit lrc

# schematic only (.png for people, .svg for archives)
node $CLI shot --circuit lrc --out lrc.png
```

`stdout` is always one JSON object; diagnostics go to `stderr`. That is deliberate: an agent can pipe the result straight into its reasoning without parsing prose.

Key flags:

| Flag | Meaning |
|---|---|
| `--circuit <name>` / `--netlist <json\|@file>` / `--text` / `--file` | Circuit source. Netlists describe topology only — the compiler lays it out, no coordinates |
| `--set <ref>=<value>` | Change a part; `e14.resistance`, `ResistorElm#2.resistance`; values accept `4.7k`, `100n`, `2.2M` |
| `--step <seconds>` | Deterministic advance (chunked internally — the bridge silently truncates long single steps) |
| `--measure all \| n1,n2` / `--components` | Instantaneous node voltages / element currents |
| `--sample` `--span` `--points` `--settle` | Time-domain sampling, independent of the engine's scope buffer |
| `--sweep <ref>=v1,v2,…` `--probe` `--logx` | Parameter sweep, one row per value |
| `--svg` `--png` | Vector plot, plus a raster copy for humans (headless Chrome/Edge, `--scale` 2× by default) |
| `--shot` `--share` `--dump` | Schematic (.png/.svg by extension), share URL, circuit text |
| `--force` | Skip the topology gate — only when a shorted device is intentional |
| `--include-supply` | With `--sample all`, also emit GND and constant-value nets (they are skipped by default) |
| `--jobs <json\|@file>` | Run several jobs in one process (they share the backend). Top-level flags are defaults; each job gets its own `--out` subdirectory |

Every file the run produces is listed in `artifacts[]` with an absolute path, so an agent never has to guess where `--out` put things.

### Batching

Attach cost is fixed per process — roughly 4.5 s of node boot, backend handshake and circuit load — while the work itself adds about a second. So "three circuits, three pictures" belongs in one invocation:

```bash
cat > jobs.json <<'EOF'
[{"name":"rc","netlist":"rc-lowpass.json","sample":"all","span":0.02,"svg":true,"png":true},
 {"name":"divider","netlist":"divider.json","step":"0.001","measure":"all"},
 {"name":"555","circuit":"555square","sample":"n2","span":0.6,"settle":0.2,"shot":"555.png"}]
EOF
node $CLI run --jobs @jobs.json --out out
```

Measured: those three jobs take **7.1 s** in one process versus **16.3 s** as three separate runs. A failing job does not sink the batch — it comes back as `jobs[].ok:false` with its own `error`, the rest still report results, and the overall `ok` is false so nothing is silently lost.

## Layout

```
ee-circuit-draw-simulator/
├── SKILL.md                  agent entry: preconditions, delivery shapes, workflow, hard rules
├── AGENTS.md                 same workflow for agents that read repo instructions
├── scripts/
│   ├── circuitlab.mjs        the CLI (setup / probe / corpus / run / share / shot)
│   └── lib/
│       ├── backend.mjs       engine discovery, liveness probe, auto-spawn
│       ├── svg.mjs           waveform/sweep → inline SVG, faceted by unit
│       └── units.mjs         4.7k / 100n parsing and formatting
├── references/               netlist schema, corpus index, MCP tool map, troubleshooting
└── vendor/                   engine checkout from `setup` (gitignored)
```

## Honesty rules baked into the skill

1. Numbers may only come from `measurements` / `sample` / `sweep` — never from a formula quoted as a measurement.
2. Only `sim.step` (frozen wall clock). `sim.run` is wall-clock driven and not reproducible.
3. No hand-written coordinates: hand-written XML that is 1 px off is a silent open circuit.
4. Multi-terminal parts (op-amp, 555, transistors) use built-in circuits plus `--set`; auto-routing a hand-written netlist with those can stall the solver, and the CLI reports it.
5. Sparse sampling is reported, not hidden: `resolutionWarning` means "raise `--points` and rerun".
6. **A shorted device fails before it simulates.** If a transistor's collector and emitter — or a MOSFET's drain and source — end up on the same net, the CLI raises `拓扑错误` and stops. The alternative is a plausible-looking run that reports 0 V everywhere.
7. **Pictures are PNG.** `--png` and `--shot x.png` rasterize through headless Chrome/Edge, because an inline SVG is a single 9 KB line that a line-based reader cannot read back.

## Reproducibility

- `setup` checks out a **pinned engine commit**, not `HEAD` — otherwise "these numbers are reproducible" expires as soon as the engine moves. Override with `setup --ref <sha|tag|branch>`. It also writes `.ee-engine.json` (commit, commit date, build time), because a shallow clone leaves no history to answer "which engine am I on".
- `probe` echoes `engine.commit` / `engine.commitDate` / `engine.describe`, and warns when your checkout is not the pinned one.
- `npm run verify` = syntax + skill metadata check, then `smoke`. `npm run smoke` re-derives the numbers in this README — 555 frequency and duty, the RC −3 dB point, the divider, op-amp gain, the topology gate's error code, the composite-waveform fundamental, `--sample all` filtering and `--png`-only output — and fails on drift:

```bash
npm run verify
# 555 频率 239.6 Hz ±0.8 | RC 比值 0.7065 ±0.02 | 复合波形基频 60 Hz ±2 | …
# 全部 21 项通过。
```

- `.github/workflows/verify.yml` runs that on every push and PR, so the numbers cannot drift silently. It installs the pinned engine from scratch (clone + core install + build), which is why the job takes a few minutes.

## Limitations

- No interactive canvas in a chat turn: anything clickable is a share link.
- Share links carry the circuit, not simulation state — the recipient starts at t=0.
- Offline single-file HTML (`ext bundle-single`) has no circuit library and no Chinese language pack (CORS on `file://`); simulation itself works.
- The engine is GPL-2.0-or-later; this skill keeps the same licence and does not bundle engine code.
- Deep-reference files under `references/` are written in Chinese (they carry the author's lab notes); `SKILL.md`, `AGENTS.md` and this README are in English.

## Credits

Built on [CircuitJS1](https://github.com/pfalstad/circuitjs1) by Paul Falstad / Iain Sharp, via the [ExtCircuitJS](https://github.com/blankwy/ExtCircuitJS) fork. Skill text and CLI: GPL-2.0-or-later, see [LICENSE](LICENSE).
