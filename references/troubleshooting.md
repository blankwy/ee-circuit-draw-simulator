# 已知坑与判定方法

## 环境

| 现象 | 原因 | 处理 |
|---|---|---|
| `没有可达的后端` | dev server / 静态服务都没起 | `cd 仓库 && node tools/ext.mjs dev --port 5174`；或 `build` 后 `serve --port 8080` |
| 自动拉起 dev server 失败 | `core/ts/node_modules` 没有 vite | `npm install --prefix core/ts` |
| `backend_unavailable` | playwright-core 找不到 / 浏览器找不到 | 先 `node <skill>/scripts/circuitlab.mjs setup`（会补装 playwright-core）；仍不行设 `EXT_PW_CORE`、`EXT_CHROME`；或装 Chrome/Edge |
| 端口被占 | 有旧的 dev server 在跑 | 换 `EXC_BASE`/`--base` 的端口，或停掉旧的 |
| 改了代码但行为没变 | 复用了一个跑着旧代码的 dev server | 停掉它，让脚本自己拉起 |
| Pages 站点连不上/连上也没用 | 探活只支持 http，https base 直接抛 `ERR_INVALID_PROTOCOL` | 本地起后端；Pages 只用于"给人点开看" |

## 数值

| 现象 | 原因 | 处理 |
|---|---|---|
| 同一电路两次跑数值不同 | 用了 `sim.run`（墙钟驱动） | 一律 `sim.step`（CLI 内部已保证） |
| **`--settle 0.2` 实际只跑了 0.1 s** | 桥的 `sim.step` 单次上限约 20000 引擎步（5 µs 步长 ≈ 0.1 s），超出部分**静默丢弃** | CLI 已自动分块补齐（`step.chunks` 可见）；自己写脚本时按"实际 t 增量"循环 |
| 读数全 0、t 一直 0 | ① 还没步进 ② 有悬空网导致引擎卡住 ③ 缺必填字段 | 先 `--step 0.001`；再检查每个网 ≥2 引脚；看 `circuit.load.missingProps`，非空就补 `"modelName": "default"` |
| 二极管/三极管/MOS 不像那个器件，或仿真直接停在 t=0 | 网表漏了 `modelName`：引擎可能用自己的默认模型顶上，也可能不顶（不同家族/版本不一致） | 显式写 `"modelName": "default"`；载入阶段 `load.missingProps` 会点名是哪个元件 |
| 波形是直线、`sample.flat` 有网名 | 该网没被驱动（悬空或没连到源） | 查 `circuit.nets[].pins`，补连接 |
| 幅值对、符号反了 | `VoltageElm` 的 1 脚是正端，接线顺序决定符号 | 用 `V(a)−V(b)` 讲，或对调源的两脚 |
| 频率/占空比乱跳、带 `resolutionWarning` | 每周期采样点太少 / 窗口不足 2 个周期 | 加大 `--points`、调 `--span` 到 ≥3 个周期 |
| 扫描曲线不像理论 | `--settle` 太短，暂态混进统计窗口 | 预热 ≥5 个周期再采样（`--settle`） |
| 扫描第一点数值异常 | 改参后没重置，接着上一组状态跑 | CLI 每轮自动 `sim.reset`；自己写脚本记得手动 reset |

## 电路构建

| 现象 | 原因 | 处理 |
|---|---|---|
| 手写 XML 后读数全 0、不报错 | 坐标差 1 px = 静默开路 | 别手写坐标；用网表 JSON 让编译器布局 |
| `needs_layout` | 多端元件 + 无坐标 | 换 2 端元件，或用内置语料，或补 `layout` 坐标 |
| **多端元件（运放/555/晶体管）网表跑不动** | 自动布线在某些拓扑上生成重复/交叉导线；表现为 `engineSteps=0`、读数全 0 | 改用内置语料 + `--set`；`--shot out.png` 看图确认 |
| `拓扑错误：… 集电极 C 与 发射极 E 落在同一个网` | CLI 的仿真前拓扑闸发现器件被短接（自动布线把两个功率脚并了） | 这是真错误，改接线或换内置语料；`--force` 只用于"故意短路" |
| 没给 `--step` 也拿到了非 0 读数 | 正常：`--measure` 会自动推进 1 ms 再读，结果里的 `autoStep` 写明了 | 想控制时间点就显式给 `--step` |
| `--png` 没生成图片 | 本机找不到 Chrome/Edge，或栅格化超时；SVG 仍然可用 | 设 `EXT_CHROME` 指向浏览器；或直接用 `--shot out.png`（引擎自己渲染） |
| `probe` 的 `engine.note` 说版本不符 | 引擎不是钉住的 commit，数值可能与文档差一点 | `setup --ref <sha>` 重装钉住版本，或跑 `node scripts/smoke.mjs` 看偏差 |
| 参数改了 `applied: 0` | 字段名写错（`capacitor` vs `capacitance`） | 看 `circuit.elements[].props` 的真实键名 |
| 网表载入了但网名对不上 | 引擎把自定义网名改成 `n0/n1…` | 看 `circuit.nets[].pins` 判拓扑 |
| 导线一堆、元件 id 跳号 | 自动布线生成的 `WireElm` 也占 id | 正常现象；`circuit.elements` 已滤掉导线 |
| `--jobs` 整批在启动前就失败 | 某个作业的电路来源解析不出来（语料名写错 / 文件不存在）——这是故意的：省掉一次浏览器启动 | 修好那个作业；作业之间的仿真失败才是逐个隔离的 |
| `--jobs` 里某个作业 `ok:false` 但整体还有结果 | 单个作业失败不拖垮整批，整体 `ok` 也是 false（退出码 2） | 看 `jobs[].error`；其余作业的 `artifacts[]` 仍然可用 |
| 8080 被别的程序占着（`/circuitjs.html` 返回 404，`/` 返回别人的页面） | 探活会区分「引擎 / 别的程序 / 没人应答」，自启时自动跳过被占端口换下一个 | 日志里会点名；实在没端口可用会报 `port.occupied`，用 `--base http://127.0.0.1:<空端口>` |
| `sample.channels[]` 里没有 `freqEstimate` | 要么非周期（能量不在某个频率的整数倍上），要么采样太稀会混叠 | 看 `freqNote`；混叠就加大 `--points`，别拿 `vpp` 反推频率 |
| `sample.omitted` 里有网名 | 正常：`--sample all` 默认略过 GND 与恒值网（是数字不是波形） | 需要保留就加 `--include-supply` |
| `probe` 的 `incomplete[]` 里有路径 | 目录存在但缺 `tools/ext.mjs` 或 `packages/mcp`，是上次 setup 中断留下的半装状态 | 重跑 setup，或删掉该目录再装 |

## 分享与产物

| 现象 | 原因 | 处理 |
|---|---|---|
| 链接打开是默认电路 | `ctz` 被截断 | 长度 >2000 改用 `--share-out` 出分享页 |
| 链接里没有我的仿真状态 | 设计如此：只装电路，不装时间和状态 | 对方从 t=0 开始（通常正是想要的） |
| 单文件 HTML 里没有电路列表/中文 | `file://` 下 fetch 被 CORS 禁 | 已知限制，粘贴电路文本即可；仿真本身正常 |
| SVG 在深色主题下看不清 | 电路图是引擎导出的白底矢量 | 必要时在回复里说明，或让用户点开文件看 |

## 错误码（`error.code`）

失败时 `error` 一定带 `code`，按它分支比匹配中文句子可靠：

| code | 场景 | 能否就地解决 |
|---|---|---|
| `topology.shorted_device` | 器件被导线短路（三极管 C/E、MOS D/S 同网） | 换内置语料 / 补 layout；确属本意才 `--force` |
| `engine.not_found` | 找不到引擎仓库（详见 `details.tried` / `details.incomplete`） | 跑 `setup` |
| `engine.unreachable` | 后端连不上、也起不来 | 手动起后端，或去掉 `--no-spawn` |
| `port.occupied` | 端口被别的程序占，且没有可换的 | `--base http://127.0.0.1:<空端口>` |
| `artifact.not_generated` | 要求了产物却没生成（见 `artifactIssues[]`） | 看 `reason`，通常退回 SVG |
| `net.unknown` | `--measure` / `--sample` 给了不存在的网名 | 看 `details.available` |
| `param.unknown` | `--set` 的参数名对不上 | 看 `circuit.elements[].props` |
| `circuit.not_in_corpus` | 内置语料里没这个名字 | `corpus --search <关键词>` |
| `circuit.load_failed` | 网表载入失败 | 见 `unsupported[]`（多半是 `needs_layout`） |
| `sim.step_failed` / `sim.read_failed` / `sim.reset_failed` | 引擎内部失败 | 先 `--shot` 看图，换内置语料对照 |
| `usage.*` | 参数写法不对（`missing_circuit` / `bad_set` / `bad_jobs`…） | 按 `hint` 改 |

## 排查顺序（省时间）

1. `probe` —— 后端通不通
2. `run --circuit <语料> --measure all` —— 引擎通不通、网名是什么
3. `run ... --step 0.001 --measure all` —— 读数是否有值（排除悬空网）
4. 再加 `--sample`/`--sweep` —— 波形/扫描是否合理
5. 最后才 `--svg` / `--share` —— 产物层
