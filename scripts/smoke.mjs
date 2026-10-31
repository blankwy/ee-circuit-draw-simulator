#!/usr/bin/env node
// smoke.mjs —— 把 README / SKILL.md 里的实测数字重跑一遍。
//
// 为什么需要：这个 skill 的全部信誉建立在"每个数都由引擎产出"上。引擎一升级、
// 模型一换，数字就可能悄悄漂移，而文档不会自己报警。这个脚本就是那道闸。
//
// 用法：
//   node scripts/smoke.mjs                 # 用默认引擎（EXTCIRCUIT_HOME / vendor）
//   node scripts/smoke.mjs --base http://127.0.0.1:8080
//   node scripts/smoke.mjs --verbose       # 打印每次调用的完整 JSON
//
// 退出码：0 = 全部落在容差内；1 = 有偏差或调用失败。
// 前置：引擎已 setup、本机有 Chrome/Edge。CI 里跑不了（太重），本地/发布前跑。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "circuitlab.mjs");

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const baseIdx = argv.indexOf("--base");
const base = baseIdx >= 0 ? argv[baseIdx + 1] : null;

/** 跑一次 CLI，返回解析后的 JSON。 */
function run(args) {
    const full = [...args, ...(base ? ["--base", base] : [])];
    if (verbose) process.stderr.write(`\n$ circuitlab ${full.join(" ")}\n`);
    const r = spawnSync(process.execPath, [CLI, ...full], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (verbose) process.stderr.write(r.stderr ?? "");
    try {
        return JSON.parse(r.stdout);
    } catch {
        throw new Error(`CLI 输出不是 JSON（exit ${r.status}）：\n${(r.stdout ?? "").slice(0, 400)}\n${(r.stderr ?? "").slice(-400)}`);
    }
}

const CASES = [];
function check(name, { got, want, tol, unit = "" }) {
    const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
    CASES.push({ name, got, want, tol, unit, ok });
    return ok;
}

function step(msg) {
    process.stderr.write(`▸ ${msg}\n`);
}

// 1) 555 方波：频率与占空比
step("555 astable：频率 / 占空比");
{
    const j = run(["run", "--circuit", "555square", "--sample", "n2", "--span", "0.6", "--points", "2000", "--settle", "0.2"]);
    if (!j.ok) throw new Error(`555 采样失败：${JSON.stringify(j.error)}`);
    const c = j.sample.channels[0];
    check("555 频率 (Hz)", { got: c.freqEstimate, want: 239.6, tol: 0.8 });
    check("555 占空比", { got: c.dutyCycle, want: 0.496, tol: 0.02 });
}

// 2) 555 改 R2：同一次扫描里的三组
step("555 astable：R2 = 10k / 22k / 47k");
{
    const j = run(["run", "--circuit", "555square", "--sweep", "e14.resistance=10k,22k,47k", "--probe", "n2",
        "--settle", "0.2", "--span", "0.6", "--points", "2000"]);
    if (!j.ok) throw new Error(`555 扫描失败：${JSON.stringify(j.error)}`);
    const by = new Map(j.sweep.rows.map((r) => [r.x, r.nets.n2]));
    const at = (v) => by.get(v)?.freqEstimate;
    check("R2=10k 频率 (Hz)", { got: at(10000), want: 239.6, tol: 0.8 });
    check("R2=22k 频率 (Hz)", { got: at(22000), want: 108.8, tol: 1.0 });
    check("R2=47k 频率 (Hz)", { got: at(47000), want: 50.8, tol: 0.6 });
}

// 3) RC 低通：1.6 kHz 处应为 0.707× 通带
step("RC 低通：−3 dB 点");
{
    const j = run(["run", "--netlist", path.join(HERE, "..", "references", "examples", "rc-lowpass.json"),
        "--sweep", "e1.frequency=100,1600,6400", "--probe", "n1", "--settle", "0.02", "--span", "0.02", "--points", "100"]);
    if (!j.ok) throw new Error(`RC 扫描失败：${JSON.stringify(j.error)}`);
    const by = new Map(j.sweep.rows.map((r) => [r.x, r.nets.n1.vpp]));
    const pass = by.get(100);
    const atCut = by.get(1600);
    check("RC 100 Hz Vpp (V)", { got: pass, want: 9.98, tol: 0.1 });
    check("RC 1.6 kHz Vpp (V)", { got: atCut, want: 7.05, tol: 0.15 });
    check("RC 1.6 kHz / 100 Hz 比值", { got: pass ? atCut / pass : NaN, want: 0.7071, tol: 0.02 });
}

// 4) 分压器：9 V、1k/2k → 6 V（符号取决于接线顺序，取绝对值比）
step("分压器 9 V / 1k / 2k");
{
    const j = run(["run", "--netlist", path.join(HERE, "..", "references", "examples", "divider.json"), "--step", "0.001", "--measure", "all"]);
    if (!j.ok) throw new Error(`分压失败：${JSON.stringify(j.error)}`);
    // 别用"所有节点里最大的那个"——那是源节点（9 V）。分压点 = 接在 r1 的 1 脚与 r2 的 0 脚之间的网。
    const tap = (j.circuit.nets ?? []).find((n) => (n.pins ?? []).includes("e2:1") && (n.pins ?? []).includes("e3:0"));
    const raw = tap ? j.measurements.values[tap.id] : undefined;
    check("分压点输出 (|V|)", { got: Math.abs(raw), want: 6, tol: 0.05 });
    // 极性：divider.json 是"0 脚接热端"的接法，读数为负（第 3 节实测）。这条把
    // "VoltageElm 的 1 脚是正端"钉住——文档写了、引擎换了的话这里会变红。
    const negative = Number.isFinite(raw) && raw < 0;
    CASES.push({ name: "极性：0 脚接热端得负值", got: negative ? 1 : 0, want: 1, tol: 0, unit: "", ok: negative });
}

// 5) 运放：增益 3（1 V 输入 → 3.00 V），用 --set 把 5 V 源降到 1 V 免得削顶
step("运放同相放大：增益 3");
{
    const j = run(["run", "--circuit", "amp-noninvert", "--set", "e1.maxVoltage=1", "--sample", "n2",
        "--span", "0.25", "--points", "400"]);
    if (!j.ok) throw new Error(`运放采样失败：${JSON.stringify(j.error)}`);
    const c = j.sample.channels[0];
    const gain = (c.max - c.min) / 2; // 输入 1 V 峰值 → 输出峰值 = 增益
    check("运放输出峰值 (V)", { got: gain, want: 3.0, tol: 0.08 });
}

// 6) 拓扑闸：短接的三极管必须被拦下
step("拓扑闸：C/E 短接应报错");
{
    const j = run(["run", "--netlist", path.join(HERE, "..", "references", "examples", "shorted-transistor.json"), "--measure", "all"]);
    const blocked = j.ok === false && /拓扑错误/.test(j.error?.message ?? "");
    CASES.push({ name: "短接三极管被拦下", got: blocked ? 1 : 0, want: 1, tol: 0, unit: "", ok: blocked });
}

// 7) 批处理：一个进程跑两个作业。既要证明"好作业照旧出数"（= 抽 executeJob 没改坏），
//    也要证明"坏作业被隔离"（一个短接三极管不该把整批拖垮）。
step("--jobs：一进程多作业 + 单作业失败隔离");
{
    const jobsFile = path.join(os.tmpdir(), `ee-smoke-jobs-${process.pid}.json`);
    fs.writeFileSync(jobsFile, JSON.stringify([
        { name: "divider", netlist: path.join(HERE, "..", "references", "examples", "divider.json"), step: "0.001", measure: "all" },
        { name: "shorted", netlist: path.join(HERE, "..", "references", "examples", "shorted-transistor.json"), measure: "all" },
    ]), "utf8");
    const j = run(["run", "--jobs", "@" + jobsFile]);
    fs.unlinkSync(jobsFile);
    const first = j.jobs?.[0];
    const second = j.jobs?.[1];
    CASES.push({
        name: "批处理：好作业仍成功", got: first?.ok ? 1 : 0, want: 1, tol: 0, unit: "",
        ok: first?.ok === true,
    });
    const isolated = second?.ok === false && /拓扑错误/.test(second?.error?.message ?? "");
    CASES.push({ name: "批处理：坏作业被隔离", got: isolated ? 1 : 0, want: 1, tol: 0, unit: "", ok: isolated });
    const tap = (first?.circuit?.nets ?? []).find((n) => (n.pins ?? []).includes("e2:1") && (n.pins ?? []).includes("e3:0"));
    const raw = tap ? first.measurements?.values?.[tap.id] : undefined;
    check("批处理：分压点 (|V|)", { got: Math.abs(raw), want: 6, tol: 0.05 });
    const code = second?.error?.code === "topology.shorted_device";
    CASES.push({ name: "错误码 topology.*", got: code ? 1 : 0, want: 1, tol: 0, unit: "", ok: code });
}

// 8) 复合波形的基频：60 Hz 上叠 120 Hz 分量，数过零点会翻倍报成 120（issue #3）
step("复合波形：60 Hz + 120 Hz 应报 60 Hz");
{
    const j = run(["run", "--circuit", "amp-diff", "--sample", "n4", "--settle", "0.1", "--span", "0.5", "--points", "1000"]);
    if (!j.ok) throw new Error(`amp-diff 采样失败：${JSON.stringify(j.error)}`);
    const c = j.sample.channels[0];
    check("复合波形基频 (Hz)", { got: c.freqEstimate, want: 60, tol: 2 });
    const listed = c.periodic === true && Array.isArray(c.components) && c.components.length >= 2;
    CASES.push({ name: "复合波形给出分量", got: listed ? 1 : 0, want: 1, tol: 0, unit: "", ok: listed });
}

// 9) --sample all 应略过 GND 与恒值网（issue #4）
step("--sample all：略过 GND 与恒值网");
{
    const j = run(["run", "--circuit", "lrc", "--sample", "all", "--span", "0.02", "--points", "200"]);
    if (!j.ok) throw new Error(`lrc 采样失败：${JSON.stringify(j.error)}`);
    const chans = j.sample.channels.map((c) => c.net);
    const constant = j.sample.omitted?.constant ?? [];
    const clean = chans.length > 0 && chans.every((n) => !constant.some((c) => c.net === n));
    CASES.push({ name: "恒值网不进 channels", got: clean ? 1 : 0, want: 1, tol: 0, unit: "", ok: clean });
    const told = constant.length > 0 && Array.isArray(j.sample.omitted?.ground);
    CASES.push({ name: "省略项有告知", got: told ? 1 : 0, want: 1, tol: 0, unit: "", ok: told });
}

// 10) 只给 --png 也要出图（issue #2：以前静默产出零个文件、exit 0）
step("只给 --png 应自动补 SVG 并出 PNG");
{
    const j = run(["run", "--circuit", "lrc", "--sample", "n1", "--span", "0.02", "--points", "200", "--png"]);
    if (!j.ok) throw new Error(`--png 运行失败：${JSON.stringify(j.error)}`);
    const kinds = (j.artifacts ?? []).map((a) => a.kind);
    const hasPng = kinds.includes("waveform-png");
    CASES.push({ name: "只给 --png 出 PNG", got: hasPng ? 1 : 0, want: 1, tol: 0, unit: "", ok: hasPng });
    const hasSvg = kinds.includes("waveform-svg");
    CASES.push({ name: "同时补出 SVG 中间件", got: hasSvg ? 1 : 0, want: 1, tol: 0, unit: "", ok: hasSvg });
}

// 11) 必填字段：二极管少了 modelName 要在载入阶段就点名，而不是等仿真停在 t=0
//     说一句"引擎卡住或不收敛"——那正是上一轮反馈里最没用的一句。
step("必填字段：diode 缺 modelName 应被点名");
{
    const j = run(["run", "--netlist", path.join(HERE, "..", "references", "examples", "diode-no-model.json"), "--step", "0.001"]);
    if (!j.ok) throw new Error(`diode 运行失败：${JSON.stringify(j.error)}`);
    const miss = j.circuit?.load?.missingProps ?? [];
    const named = miss.length === 1 && miss[0].type === "DiodeElm" && miss[0].prop === "modelName";
    CASES.push({ name: "缺 modelName 被点名", got: named ? 1 : 0, want: 1, tol: 0, unit: "", ok: named });
    const told = (j.warnings ?? []).some((w) => /没写必填字段/.test(w));
    CASES.push({ name: "审计写进 warnings", got: told ? 1 : 0, want: 1, tol: 0, unit: "", ok: told });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = CASES.filter((c) => !c.ok);
const pad = (s, n) => String(s).padEnd(n);
process.stdout.write("\n");
process.stdout.write(`${pad("检查项", 26)} ${pad("实测", 10)} ${pad("期望", 10)} ${pad("容差", 8)} 结果\n`);
process.stdout.write(`${"-".repeat(70)}\n`);
for (const c of CASES) {
    const fmt = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : "—");
    process.stdout.write(`${pad(c.name, 26)} ${pad(fmt(c.got), 10)} ${pad(fmt(c.want), 10)} ${pad("±" + c.tol, 8)} ${c.ok ? "ok" : "FAIL"}\n`);
}
process.stdout.write(`${"-".repeat(70)}\n`);
process.stdout.write(failed.length === 0
    ? `全部 ${CASES.length} 项通过。\n`
    : `${failed.length}/${CASES.length} 项失败：${failed.map((c) => c.name).join(", ")}\n`);

process.exit(failed.length === 0 ? 0 : 1);
