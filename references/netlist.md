# 网表 JSON：手写电路的正确姿势

`circuitlab.mjs run --netlist <file|内联JSON>` 接受**只有拓扑、没有坐标**的网表。编译器
（`packages/netlist` 的 compile/geom）负责自动布局 + 正交布线，并做一层节点划分校验。

但那层校验**不是万能的**：实测有拓扑（运放反馈、三极管）能让它放过短接的器件。所以 CLI 在
载入之后、仿真之前自己再加一道闸（见第 5 节）：三极管的 C/E、MOS 的 D/S 落到同一个网就
直接报 `拓扑错误` 并中止，不给"全 0 但看起来正常"的结果。

## 1. 最小结构

```json
{
  "schema": "netlist/0.1",
  "components": [
    { "id": "v1", "type": "VoltageElm", "props": { "waveform": 1, "frequency": 1000, "maxVoltage": 5 } },
    { "id": "r1", "type": "ResistorElm", "props": { "resistance": 1000 } },
    { "id": "c1", "type": "CapacitorElm", "props": { "capacitance": 1e-7 } },
    { "id": "g1", "type": "GroundElm", "props": {} }
  ],
  "nets": [
    { "id": "in",  "pins": ["v1:1", "r1:0"] },
    { "id": "out", "pins": ["r1:1", "c1:0"] },
    { "id": "gnd", "pins": ["v1:0", "c1:1", "g1:0"], "ground": true }
  ]
}
```

规则：

| 字段 | 说明 |
|---|---|
| `components[].id` | 自定义字符串（`v1`/`r1`…），**只在本网表内有效**；载入后引擎改成 `e1..eN` |
| `components[].type` | 引擎类名，如 `ResistorElm`（见下表） |
| `components[].props` | 字段名 + 数值（秒/欧/法/亨/伏，SI 基本单位，**不用写单位字母**） |
| `components[].f` | 位标志，默认 `0`。只有高级用法才需要（如 `VoltageElm` 的 `f=2` → 余弦） |
| `nets[].pins` | `"<元件id>:<引脚序号>"`，引脚序号从 **0** 开始，按元件构造顺序 |
| `nets[].ground` | 恰好一个网标 `true`（接 `GroundElm` 的那个网） |

硬约束（违反会报错或仿真异常）：

- **每个网 ≥ 2 个引脚**（地网可以只接 `GroundElm` + 元件地脚）。悬空节点会让引擎停在 t=0、读数全 0。
- 不要写 `WireElm`：导线由布线算法生成。
- 一个 `GroundElm` 只接 1 个网；需要多处接地就多放几个 `GroundElm`。
- **`VoltageElm` 的 1 脚是正端、0 脚是负端**（实测，见第 3 节）。上面那个例子里正端
  `v1:1` 接热端，所以读数是正的；把 0/1 接反不会报错，只是所有读数变号。
- `nets[].id` 是给你自己看的名字，载入后会变成 `n0/n1…`；判断"哪个网是输出"靠 `circuit.nets[].pins`。

## 2. 常用元件（字段名 = `props` 里的键）

| type | 引脚 | 关键 props（基本单位） |
|---|---|---|
| `ResistorElm` | 2 | `resistance`（Ω） |
| `CapacitorElm` | 2 | `capacitance`（F）、`initialVoltage`、`seriesResistance` |
| `InductorElm` | 2 | `inductance`（H）、`initialCurrent`、`saturationCurrent`、`seriesResistance` |
| `VoltageElm` | 2 | `waveform`、`frequency`（Hz）、`maxVoltage`（V）、`bias`、`phaseShift`（°）、`dutyCycle`（0–1）、`riseTime`、`internalResistance`；**1 脚 = 正端，0 脚 = 负端** |
| `CurrentElm` | 2 | `currentValue`（A）、`maxVoltage` |
| `GroundElm` | 1 | `symbolType` |
| `RailElm` | 1 | 供电轨（V+），值由仿真设置决定 |
| `OutputElm` | 1 | 画布上的数值显示探针，不影响电路 |
| `SwitchElm` | 2 | `position`（0/1）、`momentary`、`resistance` |
| `PotElm` | 3 | `maxResistance`（Ω）、`position`（0–1）；引脚 0/1 = 两端，2 = 抽头 |
| `DiodeElm` / `ZenerElm` | 2 | `modelName`（**必填**，写 `"default"`） |
| `LEDElm` | 2 | `colorR/colorG/colorB`、`maxBrightnessCurrent` |
| `LampElm` | 2 | `nom_v`、`nom_pow`、`temp`、`warmTime`、`coolTime` |
| `OpAmpElm` | 3 | `maxOut`、`minOut`、`gbw`、`gain`；引脚 0 = 同相输入，1 = 反相输入，2 = 输出 |
| `TransistorElm` | 3 | `pnp`（布尔）、`beta`、`modelName`（**必填**） |
| `MosfetElm` / `NMosfetElm` / `PMosfetElm` | 3 | `modelName`（**必填**） |
| `TimerElm`（555） | 6–8 | 引脚数随标志变化（`hasGroundPin` 8 / `hasReset` 7 / 默认 6）——**建议直接用内置语料 `555*`** |

其余 200+ 类见仓库 `packages/netlist/src/registry.json`（键是类名，`xmlAttrs[].field` 就是 props 的键）。

### 必填字段：`modelName`

二极管/稳压管/LED/三极管/MOS 的 `modelName` 决定的是器件特性 —— 缺了就不是"一个二极管"，
而是一个没有特性的空壳。实测（钉住的 `bfebc80` 与本地 `4004e1b`）：不写时引擎会用内部
静态默认值（`DiodeElm.lastModelName = "default"`）兜住，所以"不写"常常看起来没事；
但这份兜底是引擎实现细节，不同家族/版本并不一致。兜不住时的症状是 `engineSteps=0`、
读数全 0 —— 跟"电路画错了"长得一模一样。

CLI 现在在载入阶段就把这类缺失点出来，并同时给出引擎实际填了什么：

```json
"load": {
  "stats": { "components": 4, "wires": 12, "nets": 3 },
  "missingProps": [ { "element": "d1", "type": "DiodeElm", "prop": "modelName" } ]
}
```

同一份 `elements` 里能看到引擎补成了 `"modelName": "default"`。结论很简单：**显式写
`"modelName": "default"`（或你的模型名），别依赖默认值**。

### `VoltageElm.waveform` 取值

| 值 | 波形 |
|---|---|
| 0 | 直流 DC |
| 1 | 正弦 AC |
| 2 | 方波 |
| 3 | 三角波 |
| 4 | 锯齿波 |
| 5 | 脉冲 |
| 6 | 噪声 |
| 7 | 可变 |

## 3. 极性：为什么读到的是负电压

`VoltageElm` 的 **1 脚是正端**。下面这个分压器（9 V、1 kΩ / 2 kΩ）：

```json
{ "id": "v1", "type": "VoltageElm", "props": { "maxVoltage": 9, "waveform": 0 } },
{ "id": "r1", "type": "ResistorElm", "props": { "resistance": 1000 } },
{ "id": "r2", "type": "ResistorElm", "props": { "resistance": 2000 } },
{ "id": "g1", "type": "GroundElm", "props": {} }
```
```json
{ "id": "in",  "pins": ["v1:0", "r1:0"] },
{ "id": "out", "pins": ["r1:1", "r2:0"] },
{ "id": "gnd", "pins": ["v1:1", "r2:1", "g1:0"], "ground": true }
```

实测 `--step 0.001 --measure all` → `n0 = -9 V`、`n1 = -6 V`。**幅值正确（9 V 分压到 6 V），
符号取决于源的接线顺序**。想让读数为正，把源的 1 脚接到热端（`v1:1` → `in`，`v1:0` → `gnd`）。
讲极性时用 `V(a) − V(b)`，别假设符号。

## 4. 可直接抄的例子

**RC 低通（测 −3dB 点）** —— 见 `SKILL.md` 第三节的扫频命令；R=1 k、C=100 n → 实测 Vpp 在
1.6 kHz 掉到 0.707×（理论 1591 Hz）。

**半波整流**

```json
{
  "schema": "netlist/0.1",
  "components": [
    { "id": "v1", "type": "VoltageElm", "props": { "waveform": 1, "frequency": 50, "maxVoltage": 10 } },
    { "id": "d1", "type": "DiodeElm", "props": { "modelName": "default" } },
    { "id": "r1", "type": "ResistorElm", "props": { "resistance": 1000 } },
    { "id": "g1", "type": "GroundElm", "props": {} }
  ],
  "nets": [
    { "id": "ac",  "pins": ["v1:0", "d1:0"] },
    { "id": "dc",  "pins": ["d1:1", "r1:0"] },
    { "id": "gnd", "pins": ["v1:1", "r1:1", "g1:0"], "ground": true }
  ]
}
```

**运放 / 555 / 晶体管：先试内置语料，别手写**

`references/examples/` 里的三个例子都是 2 端元件为主的拓扑，实测可直接用：

| 文件 | 内容 | 实测 |
|---|---|---|
| `divider.json` | 9 V + 1 k/2 k 分压 | `n1 = -6 V`（幅值 6 V ✓） |
| `rc-lowpass.json` | R 1 k + C 100 n，AC 1 kHz | 扫频到 1.6 kHz 时 Vpp = 0.707× |
| `halfwave-rectifier.json` | 二极管 + 1 k 负载，50 Hz | 输入 ±10 V、输出 0…9.43 V（半波） |
| `shorted-transistor.json` | **反例**：三极管 C/E 接到同一个网 | CLI 直接报 `拓扑错误`，不仿真 |
| `diode-no-model.json` | **反例**：二极管没写 `modelName` | `load.missingProps` 点名 `d1`，warning 说明引擎可能补了 `default` |

**多端元件默认不要手写网表**：实测把「运放 + R1/R2 反馈」写成网表后，自动布线在这个拓扑上
生成了重复/交叉导线（导出的 XML 里同一条 `<w>` 出现两次、还有一段竖线横穿元件），结果
`engineSteps=0`、读数全 0。CLI 的拓扑闸能拦住"器件被短接"这一类（`e3:1`/`e3:2` 同网），
但拦不住"布线难看但没短路"，那种情况读数也不会报错。所以这类电路的可靠做法仍是：

```bash
# 用内置语料（已验证可跑），再改参数
node <skill>/scripts/circuitlab.mjs run --circuit amp-noninvert --measure all
node <skill>/scripts/circuitlab.mjs run --circuit amp-noninvert --set ResistorElm#1.resistance=1k \
  --sample n2,n0 --span 0.25 --points 400 --svg
```

内置 `amp-noninvert`：源 5 V/40 Hz → 同相端，R2(2 k) 从输出接回反相端、R1(1 k) 到地，
增益 1+R2/R1 = 3，但源是 5 V 峰值、输出会顶到 ±15 V 轨，量增益要先把源降下来：
`--set e1.maxVoltage=1` → 实测输出 3.00 V（增益 3，误差 <0.1%）。把 R2 改成 1 k → 增益 2；
改成 9 k → 增益 10 但输出顶到 ±15 V 轨（**削顶**，这也是个能讲的现象）。运放引脚：
**0 = 反相输入，1 = 同相输入，2 = 输出**（对照语料 `opamp`：pin0 = 3 V、pin1 = 4 V → 输出顶到
+15 V，说明 vd = pin1 − pin0）。

## 5. 载入失败怎么办

| 返回 | 原因 | 处理 |
|---|---|---|
| `ok:false` + `error.message` 以 `拓扑错误` 开头 | 器件被短接（三极管 C/E 或 MOS 的 D/S 同网） | 改接线；这是器件失效，不是参数问题。确属本意才 `--force` |
| `ok:false` + `unsupported[].code = needs_layout` | 多端元件无法自动布局 | 换 2 端元件实现，或改用内置语料 / 带 `layout` 坐标的网表 |
| `invalid_json` / `invalid_compact` | JSON 语法错 | 检查引号与逗号 |
| `load.missingProps` 非空，或 `warnings` 提到「没写必填字段」 | 二极管/三极管/MOS 缺 `modelName` | 补 `"modelName": "default"`；别依赖引擎默认值 |
| 编译成功但读数全 0 | 悬空网、极性反了、或没推进 | 检查每网 ≥2 引脚，先 `--step 0.001`；看 `warnings` |
| `warnings` 里出现「仿真没有推进」 | 不收敛，或布线画成了短路/开路 | `--shot` 看图；换内置语料对照；多端元件改用 `--circuit` |
| `losses.conflicts` 非空 | 布线与元件本体冲突（拓扑仍正确） | 不影响数值，视觉上可能略挤 |

> 需要"看图对不对"时加 `--shot out.png`（要矢量用 `.svg`），引擎会导出真实电路图。**拓扑对但图丑**不影响结论，
> 但**图明显接错**（导线横穿元件、重复线段）就一定要换电路表示形式——数值已经不可信了。
