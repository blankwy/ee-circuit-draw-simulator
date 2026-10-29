# 电子电路绘制仿真助手

[English](README.md) · **简体中文**

一个 [Agent Skill](https://skill.md)：让 AI 助手**真的把电路跑起来**，而不是凭记忆描述。
载入或现造一个电路，改个电阻，确定性地推进仿真，读节点电压，采波形，扫参数，出 SVG ——
最后给你一个点开就能拖滑块调参的链接。

```
你的一句话 ──▶ agent ──▶ circuitlab.mjs ──▶ 无头 Chrome ──▶ 真实的节点分析仿真器
                     ◀── 数值 · 波形 · SVG · 分享链接 ──
```

数值来自引擎，不是模型背下来的公式。本文里每个数都是这个 skill 跑出来的。

- 引擎：[ExtCircuitJS](https://github.com/blankwy/ExtCircuitJS)（CircuitJS1 二开，JSON 网表层 + MCP 桥，GPL-2.0-or-later）
- 技能本体：纯 Node ≥ 22，零运行时依赖，一个 CLI，stdout 只出 JSON
- 任何会读 `SKILL.md` 的助手都能用（Claude Code、Codex CLI、DeepSeek Harness、WorkBuddy…）

## 它能回答什么

| 你问 | 它给 |
|---|---|
| "这个 RC 滤波器的截止频率是多少？" | 扫频后的幅频响应，−3 dB 点由实测 Vpp 算出 |
| "这个 555 跑多快？" | 实测 239.5 Hz、占空比 49.6%（窗口 t=0.2–0.8 s） |
| "R2 换成 22 kΩ 会怎样？" | 同一次扫描里两组数，可直接比 |
| "画个波形 / 画个电路图" | 内联 SVG，自带坐标轴与图例 |
| "我想自己调调看" | 分享链接，点开就是可交互电路 |
| "这振荡器为什么不起振？" | `engineSteps`、平坦通道与收敛告警 |

实测样例（用下面的命令可复现）：

| 电路 | 结果 |
|---|---|
| RC 低通，R=1 kΩ、C=100 nF | 100 Hz–6.4 kHz 之间 Vpp 从 9.98 掉到 2.40 V；1.6 kHz 处 0.707×（理论 1591 Hz） |
| 555 无稳态，R2 = 10 k / 22 k / 47 k | 239.5 Hz / 108.8 Hz / 50.8 Hz，占空比 48–50% |
| 运放同相放大，R2/R1 = 2 k/1 k | 增益 3：1 V 输入 → 3.00 V 输出；用原本的 5 V 源会削顶在 ±15 V 轨 |
| 分压器 9 V、1 k/2 k | 分压点 6 V |

## 安装

### 0. 前置条件

- **Node ≥ 22**
- 本机有 **Chrome 或 Edge**（引擎跑在无头浏览器里，经页面桥驱动）
- `git`

### 1. 拿到技能和它的引擎

```bash
git clone https://github.com/blankwy/ee-circuit-draw-simulator.git ~/ee-circuit-draw-simulator
cd ~/ee-circuit-draw-simulator
node scripts/circuitlab.mjs setup
```

`setup` 会把引擎克隆到 `vendor/ExtCircuitJS`、装构建依赖和无头浏览器驱动（`playwright-core`）、生成 `dist/`。一次性，约 2–4 分钟。
已经有引擎 checkout？跳过这步，指过去即可：

```bash
export EXTCIRCUIT_HOME=/path/to/ExtCircuitJS
```

### 2. 装进你的助手

技能就是一个根目录带 `SKILL.md` 的文件夹，下面各家用的内容完全一样，只有搜索路径不同。
克隆一次，再链进去（软链只保留一份；复制一份也能用）：

| 助手 | 用户级路径 | 项目级路径 |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex CLI | `~/.codex/skills/` | `.codex/skills/` |
| DeepSeek Harness（`dsh`） | `~/.dsh/skills/` 或 `~/.agents/skills/` | `.dsh/skills/` 或 `.agents/skills/` |
| WorkBuddy | `~/.workbuddy/skills/` | `.workbuddy/skills/` |

```bash
mkdir -p ~/.claude/skills
ln -s ~/ee-circuit-draw-simulator ~/.claude/skills/ee-circuit-draw-simulator
```

Windows（PowerShell，软链需要开发者模式或管理员）：

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills\ee-circuit-draw-simulator" -Target "$env:USERPROFILE\ee-circuit-draw-simulator"
```

没有软链权限就整个复制过去 —— 所有路径都相对技能根目录。

#### Claude Code

```bash
ln -s ~/ee-circuit-draw-simulator ~/.claude/skills/ee-circuit-draw-simulator
```

随便开个会话问电路问题，任务匹配时 Claude Code 会自己加载这个技能。团队共用就链到
`.claude/skills/` 并提交。

#### Codex CLI

技能还藏在实验开关后面：

```toml
# ~/.codex/config.toml
[features]
skills = true
```

```bash
ln -s ~/ee-circuit-draw-simulator ~/.codex/skills/ee-circuit-draw-simulator
```

之后正常描述任务，或用 `$ee-circuit-draw-simulator` 显式点名。`/skills` 能看它扫到了什么。
仓库里还带了 `AGENTS.md`，所以不开开关、直接在仓库里跑 `codex` 也能拿到工作流。

#### DeepSeek Harness（`dsh`）

```bash
mkdir -p ~/.dsh/skills
ln -s ~/ee-circuit-draw-simulator ~/.dsh/skills/ee-circuit-draw-simulator
```

`dsh` 的扫描顺序是 项目 `.dsh/skills/` → `.agents/skills/` → `~/.dsh/skills/` → `~/.agents/skills/`，
只往下看一层、认文件夹名、`SKILL.md` 必须在根上 —— 本仓库已经合规（kebab-case 名、description
控制在 500 字符渲染上限内）。用 `/ee-circuit-draw-simulator` 调用。

#### WorkBuddy

```bash
mkdir -p ~/.workbuddy/skills
ln -s ~/ee-circuit-draw-simulator ~/.workbuddy/skills/ee-circuit-draw-simulator
```

放进项目的 `.workbuddy/skills/` 就只在该工作区生效。

#### 其它支持 Agent Skills 的客户端

把它的技能目录指到这个文件夹就行。没有 MCP 服务器要配，没有后台进程要开。

### 3. 验一下

```bash
node ~/ee-circuit-draw-simulator/scripts/circuitlab.mjs probe
```

`ok: true` 表示引擎在、后端通。后端没起也不用管：下一次 `run` 会自己拉起静态服务，跑完回收。

## 用法

```bash
CLI=~/ee-circuit-draw-simulator/scripts/circuitlab.mjs

# 367 个内置电路，可搜
node $CLI corpus --search 555

# 一轮完整仿真：载入 → 读数
node $CLI run --circuit lrc --measure all

# 波形：240 Hz 方波采 0.6 s，出 SVG
node $CLI run --circuit 555square --sample n2 --span 0.6 --points 2000 --settle 0.2 --svg

# 参数扫描：同一次运行三组值，可横向比
node $CLI run --circuit 555square --sweep e14.resistance=10k,22k,47k \
  --probe n2 --settle 0.2 --span 0.6 --points 2000 --svg

# 频率响应（对数轴）
node $CLI run --netlist ~/ee-circuit-draw-simulator/references/examples/rc-lowpass.json \
  --sweep e1.frequency=100,200,400,800,1600,3200,6400 --probe n1 \
  --settle 0.02 --span 0.02 --points 100 --logx --svg

# 分享链接（不需要浏览器）
node $CLI share --circuit lrc

# 导出电路图
node $CLI shot --circuit lrc --out lrc.svg
```

`stdout` 永远只有一个 JSON 对象，诊断信息走 `stderr`。这是故意的：助手可以直接把结果接进推理，
不用先解析散文。

常用参数：

| 参数 | 含义 |
|---|---|
| `--circuit <名>` / `--netlist <json\|@文件>` / `--text` / `--file` | 电路来源。网表只写拓扑，编译器负责布局布线，不用坐标 |
| `--set <ref>=<值>` | 改元件参数；`e14.resistance`、`ResistorElm#2.resistance`；支持 `4.7k`、`100n`、`2.2M` |
| `--step <秒>` | 确定性推进（内部自动分块 —— 桥对单次长步进会静默截断） |
| `--measure all \| n1,n2` / `--components` | 瞬时节点电压 / 元件电流 |
| `--sample` `--span` `--points` `--settle` | 时域采样，不依赖引擎自带的示波器缓冲 |
| `--sweep <ref>=v1,v2,…` `--probe` `--logx` | 参数扫描，一个值一行结果 |
| `--svg` `--shot` `--share` `--dump` | 波形图、电路图、分享链接、电路文本 |

## 目录

```
ee-circuit-draw-simulator/
├── SKILL.md                  助手入口：先决条件、交付形态、工作流、硬性纪律
├── AGENTS.md                 给读仓库说明的助手（Codex 等）的同款工作流
├── scripts/
│   ├── circuitlab.mjs        CLI（setup / probe / corpus / run / share / shot）
│   └── lib/
│       ├── backend.mjs       引擎定位、探活、自启后端
│       ├── svg.mjs           波形/扫描 → 内联 SVG，按量纲分面
│       └── units.mjs         4.7k / 100n 解析与格式化
├── references/               网表 schema、语料索引、MCP 工具表、排障
└── vendor/                   setup 克隆下来的引擎（已 gitignore）
```

## 写进技能里的"老实规矩"

1. 数值只能来自 `measurements` / `sample` / `sweep`，不许把公式结果当实测值报。
2. 只用 `sim.step`（冻结墙钟）。`sim.run` 由墙钟驱动，两次跑数不一样。
3. 不手写坐标：手写 XML 差 1 px 就是静默开路。
4. 多端元件（运放、555、晶体管）用内置语料 + `--set`；把这类电路手写成网表，自动布线可能让求解停住，CLI 会报出来。
5. 采样太稀不藏着：`resolutionWarning` 就是"加大 `--points` 重跑"。

## 边界

- 对话里没有可交互画布：能点能拖的东西一律做成分享链接。
- 链接只承载电路本身，不含仿真状态（对方从 t=0 开始）。
- 单文件离线 HTML（`ext bundle-single`）没有内置电路列表与中文语言包（`file://` 的 CORS 限制），仿真本身正常。
- 引擎是 GPL-2.0-or-later；本技能沿用同一许可，不打包引擎代码。

## 致谢

建立在 Paul Falstad / Iain Sharp 的 [CircuitJS1](https://github.com/pfalstad/circuitjs1) 之上，经
[ExtCircuitJS](https://github.com/blankwy/ExtCircuitJS) 二开。技能文本与 CLI：GPL-2.0-or-later，见 [LICENSE](LICENSE)。
