# 底层 MCP 工具（CLI 已封装，改造时再看）

`circuitlab.mjs` 之下是 ExtCircuitJS 的 MCP 桥：stdio JSON-RPC → `packages/mcp` →
本地环回 WebSocket → 页面里的 `ExtMcpBridge` → 真实引擎。**日常不用碰这一层**，
除非要给 CLI 加能力。

## 11 个工具

| 工具 | 作用 | 关键参数 | CLI 对应 |
|---|---|---|---|
| `circuit.get_netlist` | 读网表（稳定 id `e1..eN`、参数、nets） | `format: netlist\|compact`、`layout`、`legend` | `circuit.elements` / `circuit.nets` |
| `circuit.load_netlist` | 载入电路文本 / XML / 网表 JSON（JSON 会走自动布局编译） | `text` | `--circuit/--text/--file/--netlist` |
| `circuit.list_components` | 元件清单（id/类型/参数） | — | `circuit.elements` |
| `circuit.set_param` | 按稳定 id 改参数，自动重分析 | `target, prop, value` | `--set` |
| `sim.step` | **确定性**推进（冻结墙钟、可复现） | `steps` 或 `seconds`（二选一） | 所有 `--step/--sample/--sweep` |
| `sim.run` / `sim.stop` | 墙钟实时步进 / 暂停 | — | **不使用**（数值不可复现） |
| `sim.reset` | t=0、状态复位、scope 清空 | — | `--reset`；扫描每轮自动 reset |
| `sim.read_measurements` | 瞬时电压 / 电流 / 功率 | `nets` \| `components` \| `quantity` | `--measure` / `--components` |
| `sim.read_scope` | 读 scope 缓冲（默认降到 240 点保峰谷） | `index`、`maxPoints` | 不用（自己采样更通用） |
| `schematic.screenshot` | 画布截图 | `format: png\|svg` | `--shot` |

失败一律返回 `{ok:false, error:{code,message}}`，**不抛异常**。常见 code：
`unknown_tool`、`invalid_args`、`bridge_unavailable`、`no_circuit`、`unknown_session`。

## CLI 额外用到的 RPC：`export`

桥还支持一个没暴露成工具的 `export`（`format: netlist|compact|xml`），
`format=xml` 就是 `dumpCircuit()` 的电路文本 —— CLI 的 `--dump` / `--share` 靠它
把"改完参数的电路"拿出来再压缩成分享链接。走的是同一个活会话：

```js
await toolset.bridge.request("export", {
  sessionId: toolset.sessionId,
  params: { format: "xml" },
});
```

## 一次性调用（不进 CLI 的场合）

```js
import { register } from "node:module";
register(pathToFileURL(path.join(repo, "tests/contract/helpers/ts-resolve.mjs")).href);
const { startAttachBackend } = await import(pathToFileURL(path.join(repo, "packages/mcp/src/backend.ts")).href);

const be = await startAttachBackend({ baseUrl: "http://127.0.0.1:5174", devServer: "off" });
const t = be.toolset;
await t.call("circuit.load_netlist", { text });
await t.call("sim.step", { seconds: 0.01 });
console.log(await t.call("sim.read_measurements"));
await be.dispose();
```

`startAttachBackend` 的选项：`baseUrl`、`devServer: "auto"|"reuse"|"off"`、
`pwCore`、`chrome`、`timeoutMs`、`log`。`devServer:"auto"` 会在探活失败时自己拉起
`ext dev`（需要 `npm install --prefix core/ts`）。

## 纪律

- 一次会话 = 一个活电路。**改参后 `sim.reset` 再采样**，否则波形里混着上一组参数的暂态。
- 所有工具调用串行（宿主并发会排队），不要并发踩同一个电路。
- 桥只监听/连接 `127.0.0.1`（SSRF 约束，不是 bug）。
