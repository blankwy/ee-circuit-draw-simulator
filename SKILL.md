---
name: ee-circuit-draw-simulator
description: "Run real circuit simulation instead of guessing: load or author a circuit, tweak part values, step deterministically, read node voltages, sample waveforms, sweep parameters, render SVG plots and schematics, and emit shareable interactive links. Use when a circuit/electronics answer needs real numbers or waveforms: filter cutoff, 555 duty cycle, op-amp gain, dividers, resonance, rectifier ripple, RC charging, why it will not oscillate. 需要真实数值或波形的电路问题与电路图：滤波器、555、运放、分压、谐振、整流、RC、起振排障。"
license: GPL-2.0-or-later
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
metadata:
  version: 0.3.0
  homepage: https://github.com/blankwy/ee-circuit-draw-simulator
  engine: ExtCircuitJS (CircuitJS1 fork; real nodal-analysis simulator driven headlessly over an MCP bridge)
  trigger: 电路仿真、波形、元件参数、滤波器/振荡器/放大器、生成电路图、分享可交互电路
---

# 电子电路绘制仿真助手

回答电路问题时，不要"画一个像电路的图"再凭公式估数 —— 在 **ExtCircuitJS 引擎**上跑，
把真实读数、真实波形给出来。555 的占空比、RC 的 −3dB 点、运放的增益，都能算出来、也能被验证。

核心资产是一个 CLI：`scripts/circuitlab.mjs`。它已封装「载入 → 改参 → 确定性步进 → 读数 →
采样 → 参数扫描 → 出 SVG → 出分享链接」全链路，一次进程跑完，stdout 只有 JSON。

> 回答用用户的语言；数值、单位、元件名照 CLI 输出原样引用。
> 本文件里写作 `node <skill>/scripts/circuitlab.mjs`；如果手上只有 npm 包没有技能目录，
> 换成 `npx ee-circuit-draw-simulator`，参数完全一样。

## 一、先决条件（按顺序做，别跳）

```bash
node <skill>/scripts/circuitlab.mjs probe
```

- `ok: true` → 有引擎、有后端，直接干活。
- `ok: false` + `hint` 说"还没装引擎" → 装一次（克隆 ExtCircuitJS 到 `vendor/`，装依赖、无头浏览器驱动与构建，约 2–4 分钟）：

```bash
node <skill>/scripts/circuitlab.mjs setup
```

- `ok: false` + 引擎在、后端不在 → **不用管**：下一次 `run` 会自己拉起静态服务（有 `dist/` 走
  `ext serve`，没有走 `ext dev`），跑完自动回收。加 `--no-spawn` 可关掉这个行为。

引擎查找顺序：`--repo` → `$EXTCIRCUIT_HOME` → `<skill>/vendor/ExtCircuitJS` → 同级 `../ExtCircuitJS`
→ `~/.ee-circuit/ExtCircuitJS` → `cwd`。想用别的 clone：

```bash
export EXTCIRCUIT_HOME=/path/to/ExtCircuitJS
```

需要 Node ≥ 22 与本机 Chrome/Edge（引擎是无头浏览器里的真仿真器，经 MCP 桥驱动）。

> GitHub Pages 上的在线站点**只能给人点开看**，MCP 驱动不了（探活只支持 http）——别把它当后端。

## 二、交付形态怎么选

| 用户想要 | 给什么 | 命令要点 |
|---|---|---|
| 一句话能答的概念问题 | 直接文字，别折腾 | — |
| 要真实数值 / 看波形 | 读数 + 曲线（给人看用 PNG） | `--sample ... --svg --png` |
| 想对比改参数前后 | 同一次扫描里给出多组数值 | `--sweep` |
| **想自己动手试、拖滑块调参** | **分享链接**（最轻，首选） | `--share` |
| 要电路长什么样 | 电路图（给人看用 PNG，存档再用 SVG） | `--shot out.png` |
| 离线 / 内网 / 存档 | 单文件 HTML（1.4 MB，`<引擎>/build/circuitjs-single.html`） | `node tools/ext.mjs bundle-single` |

## 三、标准回合（照这个顺序做）

### 1. 找电路

```bash
# 内置 367 个电路，按关键词找（RC 滤波、555、运放、振荡器…）
node <skill>/scripts/circuitlab.mjs corpus --search 555
node <skill>/scripts/circuitlab.mjs corpus --list        # 按 52 个分类全列
```

输出固定是 `{ ok, total, items: [{ name, title, category }] }`（`--list` 给 `{ ok, total, categories }`）。
**别猜键名**：搜不到时 `total: 0`，不是报错。

内置语料没有合适的 → 自己写网表 JSON（`references/netlist.md` 有 schema、元件表和示例）。
**不要手写坐标**：网表只描述拓扑，编译器自动布局 + 布线（含多端元件）。

### 2. 看清电路

```bash
node <skill>/scripts/circuitlab.mjs run --circuit lrc --measure all
```

返回 `circuit.elements`（稳定 id `e1..eN` + 参数）与 `circuit.nets`（网名 `n0..` + 引脚归属，
导线引脚已滤掉）。**引擎会把网表里的自定义网名改成 `n0/n1…`**，所以要靠
`nets[].pins` 判断哪个网是输出 —— 例：`n1: [e2:1, e3:0]` = 接在电阻 1 脚与电容 0 脚之间的那个网。

### 3. 改参数 + 看波形

```bash
# 时域波形：覆盖 0.6 s（约 144 个周期），SVG 会自动缩到前几个周期展示，统计仍按全窗口
node <skill>/scripts/circuitlab.mjs run --circuit 555square \
  --sample n2 --span 0.6 --points 2000 --settle 0.2 --svg
```

```bash
# 参数扫描：改 R2，看频率/占空比怎么变（同一次进程，前后可比）
node <skill>/scripts/circuitlab.mjs run --circuit 555square \
  --sweep e14.resistance=10k,22k,47k --probe n2 \
  --settle 0.2 --span 0.6 --points 2000 --svg
```

```bash
# 频率响应：扫频看 −3dB 点（RC 低通，R=1k C=100n → 理论 1591 Hz）
node <skill>/scripts/circuitlab.mjs run --netlist <skill>/references/examples/rc-lowpass.json \
  --sweep e1.frequency=100,200,400,800,1600,3200,6400 --probe n1 \
  --settle 0.02 --span 0.02 --points 100 --logx --svg
```

元件引用支持两种写法：稳定 id（`e14.resistance`）或 `类型#序号`（`ResistorElm#2.resistance`）。
数值支持工程单位：`4.7k`、`100n`、`2.2M`、`1e-7`。

### 4. 读数怎么写进回答

`sample.channels[]` 每个网给：`min / max / vpp / mean / rms / final / dutyCycle / dutyAboveMid / freqEstimate`。
`freqEstimate` 与 `dutyCycle` 由过中点时刻**线性插值**算出（不是数窗口边缘的边沿），所以
`--points` 从 600 加到 4000，同一个 555 的频率只在 239.6 Hz 附近抖动 ±0.1 Hz；`dutyAboveMid`
是纯采样计数，粗看用。`--measure` 给瞬时值，`--components` 给元件电流。

写结论时必须带**数值 + 单位 + 条件**：

> 该 555 方波语料（定时电阻 e14=10 kΩ、定时电容 0.3 µF）输出频率 **239.6 Hz**、占空比 **49.6%**
> （实测，窗口 t=0.2–0.8 s）；把 e14 换成 22 kΩ → **108.8 Hz**，47 kΩ → **50.8 Hz**（占空比 48–50%）。

不要写"频率会变低"这种没有数的话。

### 5. 用户想自己玩 → 分享链接

```bash
node <skill>/scripts/circuitlab.mjs run --circuit 555square --set e14.resistance=22k --share
```

返回一行 URL（`length` < 2000 安全）。点开即见电路、可点 RUN、可拖滑块调参。
链接只含电路本身，不含仿真状态（对方看到的是 t=0）。超过 2000 字符时改用
`--share-out share.html`（1–2KB 分享页）。

## 四、硬性纪律

1. **数值只能来自 CLI 输出**（`measurements` / `sample` / `sweep`）。不许按公式"推"一个数再当实测值报。
   想对比理论值就明确写"实测 X，理论 Y"。
2. **不要绕过 CLI 自己写 Node 脚本调 MCP** —— 除非 CLI 缺能力（此时先补 CLI）。
3. **确定性步进**：CLI 内部只用 `sim.step`（冻结墙钟、可复现）。绝不要改用 `sim.run`（墙钟驱动，两次跑数值不同）。
4. **不手写坐标**。改电路用 `--set`；造电路用网表 JSON。手写 XML 坐标差 1 px 会静默开路（不报错、全 0 V）。
   **多端元件（运放 / 555 / 晶体管）优先用内置语料 + `--set`**：自动布线在某些拓扑上会生成重复/交叉导线。
   CLI 现在会在仿真前拦下"器件被短路"的情况（见规则 9），但布线难看/读数可疑仍要靠内置语料对照。
5. **采样要够密**：每个周期 ≥ 8 点、窗口 ≥ 3 个周期。返回里出现 `resolutionWarning` 就加大
   `--points` / `--span` 重跑，别拿失真数据下结论。
6. **每个网至少接 2 个引脚**（地除外）。悬空节点会让引擎停在 t=0、读数全 0。
7. **读数全 0 时先看 `autoStep`**：没给 `--step` 时 CLI 会自动推进 1 ms 再读，并在结果里写明；
   若仍全 0，是拓扑断了或源本身在 t≈0 处为 0（正弦源就是这样，要看幅值用 `--sample`）。
8. **图的默认形式是 PNG**。给人看的图加 `--png`（波形/扫描）或 `--shot x.png`（电路图）；
   SVG 只用于存档或需要矢量时。**不要试图 Read 一个 SVG 再内联**——它是单行文本，
   Read 按行截断在 2000 字符，读不全，纯属浪费回合。
9. **`拓扑错误` 是真错误，不要 `--force` 糊过去**。CLI 在仿真前检查三极管 C/E、MOS 的 D/S
   是否被接到同一个网——接上了就是器件被短路，读数一定无意义。正确做法是换内置语料或补
   `layout` 坐标，而不是强行跑。`--force` 只留给"我就是要接成二极管/短路"这类明确意图。

## 五、图怎么放进回答

产物的路径都在结果的 `artifacts[]` 里（绝对路径，带 `kind` 与字节数），不用去猜 `--out` 目录：

| 想要 | 命令 | `artifacts[].kind` |
|---|---|---|
| 波形图（给人看） | `--sample … --svg --png` | `waveform-png` |
| 波形图（矢量存档） | `--sample … --svg` | `waveform-svg` |
| 扫描曲线 | `--sweep … --svg --png` | `sweep-png` |
| 电路图 | `--shot out.png` / `--shot out.svg` | `schematic-png` / `schematic-svg` |
| 电路文本 | `--dump out.txt` | `circuit-text` |

`--png` 用本机 Chrome/Edge 无头模式栅格化（`--scale` 控制倍率，默认 2）；找不到浏览器时
只出 SVG 并给一条 `warnings`，不会让整次调用失败。

**一次调用就能同时拿到数据和两张图**，别拆成三次（每次调用要付约 4.5 s 的引擎接入成本）：

```bash
node <skill>/scripts/circuitlab.mjs run --circuit 555square \
  --sample n2 --span 0.6 --points 2000 --settle 0.2 \
  --svg --png --shot out/555.png
```

### 多个电路要比对时，用 `--jobs` 一个进程跑完

固定成本是**每次进程** 4.5 s（node 启动 + 后端握手 + 载入），作业本身只加 1 s 量级。
所以"三个电路各画一张图"应该一次调用做完，不是三次：

```bash
cat > jobs.json <<'EOF'
[{"name":"rc","netlist":"rc-lowpass.json","sample":"all","span":0.02,"svg":true,"png":true},
 {"name":"分压","netlist":"divider.json","step":"0.001","measure":"all"},
 {"name":"555","circuit":"555square","sample":"n2","span":0.6,"settle":0.2,"png":true,"shot":"555.png"}]
EOF
node <skill>/scripts/circuitlab.mjs run --jobs @jobs.json --out out
```

- 每项就是一套 `run` 选项；顶层选项（`--png`、`--out`、`--span`…）当默认值，作业里同名键覆盖它。
- 产物分到 `out/<作业名>/` 子目录，顶层 `artifacts[]` 一次给全（带 `job` 字段）。
- **单个作业失败不拖垮整批**：`jobs[].ok=false` 那条给 `error`，其余结果照常有效，
  但整体 `ok` 为 false（退出码 2），别忽略。
- 实测：3 个作业一次进程 7.1 s；同样的三件事分开跑 16.3 s。

## 六、排障

| 现象 | 处理 |
|---|---|
| `ok:false` + "还没装引擎" | `node <skill>/scripts/circuitlab.mjs setup`（自动装钉住的引擎版本） |
| `ok:false` + "没有可达的后端" | 去掉 `--no-spawn`，或手动 `node tools/ext.mjs serve --port 8080` |
| `backend_unavailable` / 找不到 Chrome | 装 Chrome 或 Edge；或设 `EXT_CHROME`/`EXT_PW_CORE` |
| 改参 `applied: 0` / 参数名对不上 | 看 `circuit.elements[].props` 里的真实字段名（如 `capacitance` 不是 `capacitor`） |
| **`拓扑错误：… 集电极 C 与 发射极 E 落在同一个网`** | 自动布线把器件的两个功率脚短接了。改用内置语料 + `--set`，或给网表补 `layout` 坐标；确属本意才 `--force` |
| 读数全 0 / t 一直是 0 / `engineSteps=0` | 看 `warnings` 与 `topology`；多端元件优先换内置语料 |
| 波形是一条直线 / `flat` 里有网名 | 该网没被驱动（悬空或未连接到源） |
| 扫描出来的数不像理论值 | 先确认 `--settle` 够长（跳过暂态）、`--span` 覆盖 ≥3 周期 |
| 链接打开是空白 | URL 被截断（>2000 字符），改用 `--share-out` 出分享页 |
| `probe` 里 `engine.note` 提示版本不符 | 你的引擎不是钉住的那个 commit：数值可能和文档差一点，`setup --ref <sha>` 可重装 |

更细的坑见 `references/troubleshooting.md`。

## 七、参考文件

| 文件 | 内容 |
|---|---|
| `references/netlist.md` | 网表 JSON schema、常用元件参数与引脚数、可直接抄的示例 |
| `references/circuits.md` | 367 个内置语料的分类索引（52 类）+ 怎么搜 |
| `references/tools.md` | 底层 MCP 11 个工具（CLI 已封装，改造/排障时看） |
| `references/troubleshooting.md` | 已知坑与判定方法 |
