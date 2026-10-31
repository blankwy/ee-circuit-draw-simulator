# 变更记录

## 0.3.2 — 未发布

两条都来自实际用这个技能画电路时踩到的坑：**不是算错数，而是错得没有声音**。

### 修复

- **`VoltageElm` 的引脚极性不再只写在第 3 节**
  §1 那个最容易被整段抄走的最小示例，原本把源接成 `v1:0 → 热端`；抄下来整张网表
  都是负值（9 V 分压器读 −9 V / −6 V），而「0 脚是负端」只在第 3 节解释。现在示例改成
  正端 `v1:1` 接热端，元件表里也直接标了「1 脚 = 正端，0 脚 = 负端」，smoke 里加了
  一条断言把这条极性钉住（`divider.json` 按老接法必须读负值）。

- **必填字段缺失在载入阶段就点名，不再混进「引擎卡住或不收敛」**
  二极管/稳压管/LED/三极管/MOS 的 `modelName` 决定器件特性，缺了就不是「一个二极管」。
  实测两版引擎（`bfebc80` / `4004e1b`）都会用内部静态默认值
  （`DiodeElm.lastModelName = "default"`）兜住，所以「不写」常常看起来没事；但这份兜底
  是引擎实现细节，不同家族/版本并不一致 —— 兜不住时的症状是 `engineSteps=0`、读数全 0，
  和「电路画错了」长得一模一样，CLI 只会说一句「引擎卡住或不收敛」。
  现在载入后立刻对照**源网表**审计一遍（此时还没有引擎补的默认值），缺失项进
  `circuit.load.missingProps` 并写进 `warnings`；`engineSteps=0` 与「采样没推进」这两条
  泛泛的提示会先点名缺字段的元件。新增反例 `references/examples/diode-no-model.json`。

### 其他

- smoke 21 → 24 项（极性 1 项 + 必填字段 2 项）。

## 0.3.1 — 已发布（npm / skillhub）

这一版全部来自 issue 追踪表里的反馈。共同点：**它们都不是算错数，而是让调用方看不见发生了什么**。

### 修复

- **`port.occupied`：端口被占时不再白等 45 秒**（#1）
  探活现在区分「引擎 / 别人的服务 / 没人应答」三种状态；自启按候选端口逐个试**能否真正绑定**，
  而不是固定 8080；子进程一退出就立刻返回，并保留它的 stderr（`EADDRINUSE` 会被引用进错误）。
  实测：8080 被无关服务占着时，46 s → 3.8 s，日志第一行点名占用者。

- **只给 `--png` 不再静默零产物**（#2）
  `--png` 现在自动补出 SVG 中间文件（栅格化本来就需要它），两张图都登记进 `artifacts[]`。
  栅格化失败不再只丢一句 warning，而是记进 `artifactIssues[]`（带 `code` 与 `fallback`）。

- **复合波形的基频不再翻倍**（#3）
  过零点计数会被高频分量放大：5 V/60 Hz 上叠 1 V/120 Hz 时曾报成 120 Hz。改为 Hann 窗 +
  Goertzel 扫频找基频，再用过零间隔补精度（频谱定阶数，过零点定小数）。新增
  `periodic` / `tonal` / `components` / `freqNote` 说明可信度；采样太稀会混叠时**不报频率**，
  而不是给一个看起来精确的错数。

- **`--sample all` 不再混入 GND 与恒值网**（#4）
  恒 0 与恒定值只是数字，不是波形 —— 它们会压扁图的纵轴、白占上下文。省略了什么写在
  `sample.omitted` 里；`--include-supply` 恢复旧行为；全直流电路自动回退成「除 GND 外全留」。

- **扫描图的标题不再与横轴打架**（#5）
  行、曲线、`values`、标题统一按数值升序，标题只写范围（`resistance 5 Ω – 40 Ω（4 点）`）。

- **错误带稳定的 `code`**（#6）
  `topology.shorted_device` / `engine.not_found` / `engine.unreachable` / `port.occupied` /
  `artifact.not_generated` / `net.unknown` / `param.unknown` / `circuit.not_in_corpus` /
  `circuit.load_failed` / `sim.*` / `usage.*`，必要时附 `details` 与 `suggestions`。
  中文文案保留给人看，调用方按 `code` 分支。

- **半装引擎不再被当成已安装**（#7）
  目录存在但缺 `tools/ext.mjs` 或 `packages/mcp` 时，`probe` 在 `incomplete[]` 里点名并说明缺什么，
  不再出现「说没装又暗示装过」的自相矛盾。

- **`npm run verify` 与 CI**（#8）
  `verify = check && smoke`；`.github/workflows/verify.yml` 在每次 push / PR 上从零装一遍
  钉住的引擎再跑 smoke，数字漂移会直接变红。

- **`setup` 留下引擎元数据**（#9）
  浅克隆没有历史可 bisect，至少要知道自己在哪个 commit：写 `.ee-engine.json`
  （ref / commit / commit 日期 / 构建时间），`probe` 回显 `commitDate` 与 `builtAt`。

### 其他

- 新增图标 `assets/icon.svg` 与 128/256/512/1024 PNG；npm 包只带 README 用到的
  256 与 svg 源文件（其余尺寸给商店列表用，留在仓库里），包体 1.0 MB → 143 KB。
- `run --jobs` 的作业级错误也带 `code`。
- smoke 从 14 项扩到 21 项，新增断言覆盖上面 #2 / #3 / #4 / #6 的行为。
