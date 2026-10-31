# 变更记录

## 0.3.1 — 未发布

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

- 新增图标 `assets/icon.svg` 与 128/256/512/1024 PNG。
- `run --jobs` 的作业级错误也带 `code`。
- smoke 从 14 项扩到 21 项，新增断言覆盖上面 #2 / #3 / #4 / #6 的行为。
