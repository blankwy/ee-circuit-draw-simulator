# 内置语料索引（367 个电路 / 52 类）

```bash
node <skill>/scripts/circuitlab.mjs corpus --list                 # 全部，按分类
node <skill>/scripts/circuitlab.mjs corpus --search filter        # 按名字/标题搜
node <skill>/scripts/circuitlab.mjs corpus --category "Filters"   # 按分类筛
node <skill>/scripts/circuitlab.mjs corpus --search 555
```

用法：`run --circuit <name>`（不带 `.txt`）。找不到就先用 `corpus --search`，别猜名字。

## 教学最常用的几类

| 主题 | 分类 | 代表语料 |
|---|---|---|
| 基本定律 / 分压分流 | Basics / Series·Parallel | `ohms`、`resistors`、`voltdivide`、`potdivide`、`thevenin`、`norton`、`capseries`、`indpar` |
| RC/RL 充放电、交流阻抗 | A/C Circuits | `capac`、`inductac`、`impedance`、`res-series`、`res-par` |
| 无源滤波 | Passive Filters | `filt-lopass`、`filt-hipass`、`filt-lopass-l`、`bandpass`、`notch`、`twint`、`butter10lo` |
| 有源滤波 | Active Filters | `filt-vcvs-lopass`、`filt-vcvs-hipass`、`switchedcap` |
| 二极管 / 整流 | Diodes / Zener | `rectify`、`diodecurve`、`diodevar`、`zeneriv`、`zenerref` |
| 倍压 / 电源变换 | Voltage Multipliers / Power Converters | `voltdouble`、`volttriple`、`conv-buck`、`conv-boost`、`conv-buckboost` |
| 运放与放大器 | Op-Amps / Amplifiers | `opamp`、`opampfeedback`、`amp-invert`、`amp-noninvert`、`amp-follower` |
| 晶体管 / MOSFET | Transistors / MOSFETs | `npn`、`pnp`、`transswitch`、`nmosfet`、`pmosfet`、`mosswitch` |
| 振荡器 | Oscillators | `relaxosc`、`phaseshiftosc`、`triangle`、`wienbridge`、`varactorvco` |
| 555 定时器 | 555 Timer Chip | `555square`、`555saw`、`555lowduty`、`555monostable`、`555int` |
| 多谐振荡 / 触发器 | Multivibrators / Flip-Flops | `multivib-a`、`multivib-bi`、`multivib-mono`、`nandff`、`clockedsrff` |
| 数字逻辑 | Combinational / Counters / Shift Registers | `xor`、`halfadd`、`fulladd`、`counter`、`sipo-sr` |
| 逻辑门族（RTL/DTL/TTL/CMOS） | RTL / DTL / TTL / CMOS | `rtlinverter`、`ttlnand`、`cmosinverter`、`cmosnand` |
| 锁相环 | Phase-Locked Loops | `pll`、`xorphasedet`、`phasecomp` |
| 传输线 | Transmission Lines | `tl`、`tlstand`、`tlterm` |
| 受控源 | Controlled Sources | `cs-resistor`、`cs-varyresistor`、`cs-opamp` |
| 弛豫 / 张弛 | Tunnel Diodes / Spark Gap | `tdosc`、`tdrelax`、`spark-sawtooth`、`tesla` |
| 混沌 | Chaotic Circuits | `chua`、`rossler`、`vilnius` |
| 继电器 | Relays | `relay`、`relayand`、`relayor` |
| 2D 示波器（李萨如） | 2-D Scope | `lissa`、`plot2d-color` |

## 使用提示

- 373 个语料文件里（索引收录 367 个有分类的）**只有 27 个自带示波器（scope）**，所以别指望 `read_scope` 一定有数据。
  本 skill 的 `--sample` 是自己逐步测量建的时序，不依赖 scope，任意网都能画。
- 语料里的元件 id 由引擎分配（`e1..eN`，导线也占号），**每次载入后先用 `--measure all` 看
  `circuit.elements` 再决定改哪个**，不要照抄文档里的 id。
- 语料里的 `SweepElm`（扫频源）是 CircuitJS 的"频率自动扫描"元件，跟本 skill 的
  `--sweep`（参数扫描）不是一回事：前者靠仿真时间推进频率，后者是我们主动改参数重新跑。
  要做频率响应，**用 `VoltageElm` + `--sweep e?.frequency=...` 更可控**。
- 语料是 GPL-2.0 上游内容，随仓库分发；改出来的电路用 `--share` 出链接最省事。
