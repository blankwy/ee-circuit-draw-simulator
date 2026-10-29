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
| 读数全 0、t 一直 0 | ① 还没步进 ② 有悬空网导致引擎卡住 | 先 `--step 0.001`；再检查每个网 ≥2 引脚 |
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
| **多端元件（运放/555/晶体管）网表跑不动** | 自动布线在某些拓扑上生成重复/交叉导线，拓扑硬闸没拦住；表现为 `engineSteps=0`、读数全 0 | 改用内置语料 + `--set`；`--shot` 看图确认 |
| 参数改了 `applied: 0` | 字段名写错（`capacitor` vs `capacitance`） | 看 `circuit.elements[].props` 的真实键名 |
| 网表载入了但网名对不上 | 引擎把自定义网名改成 `n0/n1…` | 看 `circuit.nets[].pins` 判拓扑 |
| 导线一堆、元件 id 跳号 | 自动布线生成的 `WireElm` 也占 id | 正常现象；`circuit.elements` 已滤掉导线 |

## 分享与产物

| 现象 | 原因 | 处理 |
|---|---|---|
| 链接打开是默认电路 | `ctz` 被截断 | 长度 >2000 改用 `--share-out` 出分享页 |
| 链接里没有我的仿真状态 | 设计如此：只装电路，不装时间和状态 | 对方从 t=0 开始（通常正是想要的） |
| 单文件 HTML 里没有电路列表/中文 | `file://` 下 fetch 被 CORS 禁 | 已知限制，粘贴电路文本即可；仿真本身正常 |
| SVG 在深色主题下看不清 | 电路图是引擎导出的白底矢量 | 必要时在回复里说明，或让用户点开文件看 |

## 排查顺序（省时间）

1. `probe` —— 后端通不通
2. `run --circuit <语料> --measure all` —— 引擎通不通、网名是什么
3. `run ... --step 0.001 --measure all` —— 读数是否有值（排除悬空网）
4. 再加 `--sample`/`--sweep` —— 波形/扫描是否合理
5. 最后才 `--svg` / `--share` —— 产物层
