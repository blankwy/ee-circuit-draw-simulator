#!/usr/bin/env node
// ee-circuit-draw-simulator —— 电子电路绘制仿真助手 CLI（给 AI 助手用的一把瑞士刀）。
//
// 一次调用完成一轮真实仿真（载入 → 改参 → 步进 → 读数 → 采样 → 扫描 → 出图 → 分享），
// stdout 只输出结构化 JSON，诊断信息走 stderr。所有数值都来自真实引擎，
// 没有任何"估算"分支 —— 这也是这个 skill 存在的理由。
//
//   node circuitlab.mjs probe                      # 后端探活
//   node circuitlab.mjs corpus --search 555       # 找内置语料
//   node circuitlab.mjs run --circuit lrc --sample all --span 0.02 --points 200 --svg
//   node circuitlab.mjs run --circuit filt-lopass --sweep e6.frequency=10,100,1k,10k --probe n2 --logx
//   node circuitlab.mjs share --circuit lrc       # 纯 Node，出分享 URL
//   node circuitlab.mjs shot --circuit lrc --out lrc.svg

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
    resolveRepo,
    probe,
    attach,
    dumpCircuitText,
    defaultBases,
    defaultEngineDir,
    isEngineRepo,
    ENGINE_URL,
    SKILL_DIR,
} from "./lib/backend.mjs";
import { renderChannels } from "./lib/svg.mjs";
import { parseValue, fmtEng, round } from "./lib/units.mjs";

const HELP = `ee-circuit-draw-simulator —— 电子电路绘制仿真助手 CLI

用法: node circuitlab.mjs <命令> [选项]

命令:
  setup     第一次用：克隆并构建 ExtCircuitJS 引擎（一次就够）
  probe     探活后端（本地静态产物 / dev server）
  corpus    检索 367 个内置电路语料（--search <关键词> / --list）
  run       一轮完整仿真：载入 → 改参 → 步进 → 测量 → 采样 → 扫描 → 出图 → 分享
  share     生成分享链接（纯 Node，不需要浏览器）
  shot      导出电路图（svg / png）

通用选项:
  --repo <dir>      ExtCircuitJS 仓库根（也可用环境变量 EXTCIRCUIT_HOME）
  --base <url>      指定后端地址（默认依次试 5174 / 8080 / 8081）
  --no-spawn        后端不可达时不自动拉起服务
  --out <dir>       产物目录（默认 ./circuit-out）

setup 的选项:
  --dir <path>      引擎装到哪（默认 <skill>/vendor/ExtCircuitJS）
  --url <git url>   换一个 fork（默认 ${ENGINE_URL}）
  --skip-install    跳过 core install
  --skip-build      跳过 build（没有 dist 就只能用 dev server）

run 的选项:
  --circuit <name>  内置语料名（如 lrc / filt-lopass / 555square）
  --text <str|@f>   电路文本（core 格式），@ 开头读文件
  --file <path>     电路文本 / XML 文件
  --netlist <json|@f>  网表 JSON（自动布局，见 references/netlist.md）
  --set <ref=val>   改参数，可重复：--set e1.resistance=4.7k --set R#1.resistance=1k
  --reset           改参后复位到 t=0
  --step <秒>       确定性推进（必须用 step，不用 run）
  --measure <nets>  读瞬时值：all 或 n1,n2
  --components <ids>  读元件电流：all 或 e1,e2
  --sample <nets>   采样时域波形：all 或 n1,n2
  --span <秒>       采样时长（默认 0.02）
  --points <n>      采样点数（默认 200）
  --settle <秒>     采样前先跑这么多秒（跳过暂态）
  --sweep <ref=v1,v2,...>  参数扫描（配合 --sample 或 --measure）
  --probe <nets>    扫描时观测的网络
  --logx            扫描图横轴取对数
  --svg             为采样/扫描生成 SVG（写到 --out）
  --dump <file>     导出电路文本
  --share           生成分享链接（先 dump 再压缩）
  --share-out <f>   同时生成 1–2KB 分享页
  --shot <file>     导出电路图（.svg 或 .png）
  --print-text      JSON 里附带电路文本
  --data            JSON 里附带采样原始数组（默认只给统计量）
`;

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const o = { _: [] };
    const multi = new Set(["set", "measure", "components", "sample", "probe"]);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            o._.push(a);
            continue;
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        const takesValue = next !== undefined && !next.startsWith("--");
        if (!takesValue) {
            o[key] = true;
            continue;
        }
        const val = next;
        i++;
        if (multi.has(key)) {
            o[key] = o[key] === undefined ? [val] : [...[].concat(o[key]), val];
        } else {
            o[key] = val;
        }
    }
    return o;
}

function readIfFile(v) {
    if (typeof v !== "string") return v;
    if (v.startsWith("@")) return fs.readFileSync(v.slice(1), "utf8");
    return v;
}

/**
 * 把可重复/可逗号列表的参数归一成数组。
 *   --measure all        → null（= 全部）
 *   --measure n1,n2      → ["n1","n2"]
 *   --probe n1 --probe n2 → ["n1","n2"]
 */
function listArg(v) {
    if (v === undefined || v === true) return null;
    const parts = [].concat(v).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1 && parts[0].toLowerCase() === "all") return null;
    return parts.length ? parts : null;
}

const log = (...a) => process.stderr.write(a.join(" ") + "\n");

function emit(obj) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

/**
 * 推进仿真 seconds 秒，自动分块。
 *
 * 为什么必须分块：桥的 `sim.step` 单次最多跑约 20000 个引擎步（5µs 步长 ≈ 0.1 s），
 * 超出部分**静默丢弃** —— 直接就 `--settle 0.2` 会只推进 0.1 s，波形里混着暂态。
 * 这里按"实际推进了多少"循环补齐，并把截断情况如实报出来。
 */
async function advance(toolset, seconds, { maxChunks = 400 } = {}) {
    const want = Number(seconds);
    if (!(want > 0)) return { ok: true, t: 0, engineSteps: 0, chunks: 0, achieved: 0 };
    const m0 = await toolset.call("sim.read_measurements");
    let tPrev = m0.ok ? Number(m0.t ?? 0) : 0;
    let achieved = 0;
    let engineSteps = 0;
    let chunks = 0;
    let t = tPrev;
    while (want - achieved > Math.max(1e-9, want * 1e-6) && chunks < maxChunks) {
        const r = await toolset.call("sim.step", { seconds: want - achieved });
        if (r.ok === false) return { ok: false, error: r };
        chunks++;
        const moved = Math.max(0, Number(r.t ?? 0) - tPrev);
        tPrev = Number(r.t ?? tPrev);
        t = tPrev;
        engineSteps += r.timeStepCount ?? 0;
        if (moved <= 0) break; // 一点没动 = 卡住/不收敛
        achieved += moved;
    }
    return { ok: true, t, engineSteps, chunks, achieved };
}
function warn(result, msg) {
    if (!result.warnings) result.warnings = [];
    if (!result.warnings.includes(msg)) result.warnings.push(msg);
}

class CliError extends Error {
    constructor(message, hint) {
        super(message);
        this.hint = hint;
    }
}

// ── 语料 ────────────────────────────────────────────────────────────────────

function loadCorpus(repo) {
    const file = path.join(repo, "core", "ts", "public", "setuplist.txt");
    const dir = path.join(repo, "core", "ts", "public", "circuits");
    const have = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".txt")) : []);
    if (!fs.existsSync(file)) return [];
    const out = [];
    let category = "(未分类)";
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#") || line === "-") continue;
        if (line.startsWith("+")) {
            category = line.slice(1).trim();
            continue;
        }
        const m = /^>?\s*([\w.\-]+\.txt)\s*(.*)$/.exec(line);
        if (!m) continue;
        const file = m[1];
        if (!have.has(file)) continue; // setuplist 里有、语料里没有的跳过
        out.push({ name: file.replace(/\.txt$/, ""), file, title: m[2].trim(), category });
    }
    return out;
}

// ── 元件定位 ────────────────────────────────────────────────────────────────

/** ref 支持 "e1"（稳定 id）或 "ResistorElm#2" / "ResistorElm#2"（按类型第 n 个，1 起）。 */
function resolveTarget(components, ref) {
    if (components.some((c) => c.id === ref)) return ref;
    const m = /^([A-Za-z_][\w]*)#(\d+)$/.exec(ref);
    if (m) {
        const same = components.filter((c) => c.type === m[1]);
        const idx = Number(m[2]) - 1;
        if (same[idx]) return same[idx].id;
        throw new CliError(
            `找不到 ${ref}：该类型只有 ${same.length} 个`,
            `可用元件：${components.map((c) => `${c.id}(${c.type})`).join(", ")}`,
        );
    }
    throw new CliError(
        `找不到元件 ${ref}`,
        `用稳定 id（e1..eN）或 类型#序号（如 ResistorElm#1）。当前：${components.map((c) => `${c.id}(${c.type})`).join(", ")}`,
    );
}

function parseSetExpr(expr) {
    const i = expr.lastIndexOf("=");
    if (i < 0) throw new CliError(`--set 需要 ref=value 形式，收到 ${expr}`);
    const ref = expr.slice(0, i).trim();
    const rawVal = expr.slice(i + 1).trim();
    const prop = ref.includes(".") ? ref.slice(ref.lastIndexOf(".") + 1) : null;
    const target = ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : ref;
    if (!prop) throw new CliError(`--set 需要 元件.参数=值 形式，收到 ${expr}`, "例：--set e1.resistance=4.7k");
    const num = parseValue(rawVal);
    return { target, prop, value: num == null ? rawVal : num, raw: rawVal };
}

// ── 采样 ────────────────────────────────────────────────────────────────────

function stats(points) {
    const vs = points.map((p) => p[1]).filter((v) => Number.isFinite(v));
    if (vs.length === 0) return null;
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    const rms = Math.sqrt(vs.reduce((a, b) => a + b * b, 0) / vs.length);
    const out = {
        min: round(min, 5),
        max: round(max, 5),
        vpp: round(max - min, 5),
        mean: round(mean, 5),
        rms: round(rms, 5),
        final: round(vs[vs.length - 1], 5),
    };
    // 方波/振荡器的两个关键指标：占空比与频率（过中点计数，不依赖波形是否规则）
    if (max - min > 1e-9) {
        const mid = (min + max) / 2;
        const above = vs.filter((v) => v > mid).length;
        out.dutyAboveMid = round(above / vs.length, 3);

        // 过中点时刻线性插值：直接数"窗口边缘的边沿"会把频率误差放大到 1/span，
        // 插值后用首末边沿的真实间隔算周期，误差降到采样间隔的平方量级。
        const cross = [];
        for (let i = 1; i < points.length; i++) {
            const [ta, va] = points[i - 1];
            const [tb, vb] = points[i];
            if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
            if ((va <= mid && vb > mid) || (va >= mid && vb < mid)) {
                const frac = vb === va ? 0 : (mid - va) / (vb - va);
                cross.push({ t: ta + frac * (tb - ta), up: vb > va });
            }
        }
        const ups = cross.filter((c) => c.up);
        let freq = null;
        if (ups.length >= 2) {
            const first = ups[0].t;
            const last = ups[ups.length - 1].t;
            if (last > first) freq = (ups.length - 1) / (last - first);
        } else {
            const rising = ups.length;
            const t0 = points[0][0];
            const t1 = points[points.length - 1][0];
            if (rising > 0 && t1 > t0) freq = rising / (t1 - t0); // 只跨了一个边沿：退化为窗口计数
        }
        if (freq) out.freqEstimate = round(freq, 4);

        // 占空比同理：用"上升沿→下降沿"的插值区间求平均高电平占比
        if (cross.length >= 3) {
            let high = 0;
            let total = 0;
            for (let i = 0; i < cross.length - 1; i++) {
                const a = cross[i];
                const b = cross[i + 1];
                total += b.t - a.t;
                if (a.up && !b.up) high += b.t - a.t;
            }
            if (total > 0) out.dutyCycle = round(high / total, 3);
        }

        if (out.freqEstimate) {
            const t0 = points[0][0];
            const t1 = points[points.length - 1][0];
            const perPeriod = vs.length / (out.freqEstimate * (t1 - t0));
            const cycles = out.freqEstimate * (t1 - t0);
            if (perPeriod < 8 || cycles < 2) {
                out.resolutionWarning = `每周期仅 ${perPeriod.toFixed(1)} 点、共 ${cycles.toFixed(1)} 个周期：频率/占空比不可靠，请加大 --points 或 --span`;
            }
        }
    }
    return out;
}

async function sampleSeries(toolset, { nets, span, points, settle }) {
    if (settle > 0) {
        const r = await advance(toolset, settle);
        if (!r.ok) throw new CliError(`预热步进失败：${JSON.stringify(r.error)}`);
    }
    const dt = span / points;
    const series = new Map();
    let last = null;
    for (let i = 0; i < points; i++) {
        const st = await toolset.call("sim.step", { seconds: dt });
        if (!st.ok) throw new CliError(`采样步进失败（第 ${i + 1} 点）：${JSON.stringify(st)}`);
        last = st.t;
        const m = await toolset.call("sim.read_measurements", nets?.length ? { nets } : {});
        if (!m.ok) throw new CliError(`采样读数失败：${JSON.stringify(m)}`);
        for (const [k, v] of Object.entries(m.values ?? {})) {
            if (!series.has(k)) series.set(k, []);
            series.get(k).push([st.t, v]);
        }
    }
    return { series, tEnd: last };
}

// ── 载入电路 ────────────────────────────────────────────────────────────────

async function loadCircuit(toolset, repo, o) {
    const { text, source } = readCircuitSource(repo, o);
    const loaded = await toolset.call("circuit.load_netlist", { text });
    if (!loaded.ok) {
        throw new CliError(
            `载入电路失败：${JSON.stringify(loaded).slice(0, 800)}`,
            loaded.unsupported?.some?.((u) => /needs_layout|layout/.test(u.code ?? ""))
                ? "含多端元件且没有坐标：改用 --circuit 内置语料，或给网表补 layout 坐标"
                : undefined,
        );
    }
    return { loaded, text, source };
}

/** 只解析电路来源（在连后端之前就能失败，省一次浏览器启动）。 */
function readCircuitSource(repo, o) {
    if (o.circuit) {
        const name = String(o.circuit).replace(/\.txt$/, "");
        const file = path.join(repo, "core", "ts", "public", "circuits", `${name}.txt`);
        if (!fs.existsSync(file)) {
            const corpus = loadCorpus(repo);
            const near = corpus
                .filter((c) => c.name.includes(name) || c.title.toLowerCase().includes(String(name).toLowerCase()))
                .slice(0, 8)
                .map((c) => c.name);
            throw new CliError(
                `内置语料里没有 ${name}`,
                near.length ? `相近的：${near.join(", ")}` : "用 corpus --search <关键词> 找找看",
            );
        }
        return { text: fs.readFileSync(file, "utf8"), source: { kind: "corpus", name } };
    }
    if (o.text) return { text: readIfFile(String(o.text)), source: { kind: "text" } };
    if (o.file) {
        const f = String(o.file).replace(/^@/, "");
        return { text: fs.readFileSync(f, "utf8"), source: { kind: "file", file: f } };
    }
    if (o.netlist) {
        const rawArg = String(o.netlist);
        const text = rawArg.trim().startsWith("{") || rawArg.startsWith("@")
            ? readIfFile(rawArg)
            : fs.readFileSync(rawArg, "utf8");
        return { text, source: { kind: "netlist" } };
    }
    throw new CliError("缺少电路来源", "用 --circuit <名> / --text / --file / --netlist 之一");
}

// ── 分享链接（纯 Node，不需要浏览器）──────────────────────────────────────────

function makeShare(repo, { text, file, circuit, shareOut }) {
    const ext = path.join(repo, "tools", "ext.mjs");
    const argv = [ext, "share"];
    if (circuit) argv.push("--circuit", String(circuit));
    else if (file) argv.push("--file", file);
    else {
        const tmp = path.join(os.tmpdir(), `extskill-${process.pid}-${Date.now()}.txt`);
        fs.writeFileSync(tmp, text, "utf8");
        argv.push("--file", tmp);
    }
    if (shareOut) argv.push("--out", shareOut);
    const r = spawnSync(process.execPath, argv, { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) {
        throw new CliError(`分享链接生成失败：${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
    }
    const url = (r.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//.test(s))
        .pop();
    if (!url) throw new CliError(`分享脚本没有返回 URL：${(r.stdout || "").slice(0, 300)}`);
    const len = url.length;
    return {
        url,
        length: len,
        budget: len < 2000 ? "safe" : len < 8000 ? "risky（部分 IM 会截断，建议改用分享页）" : "too_long（改用 --out 分享页或单文件 HTML）",
        sharePage: shareOut ?? null,
        note: "链接只含电路本身，不含仿真状态；点开是 t=0，可点 RUN 并拖滑块调参",
    };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function cmdRun(o) {
    const { repo, tried } = resolveRepo(o.repo);
    if (!repo) throw new CliError(`找不到 ExtCircuitJS 仓库（试过 ${tried.join(" / ")}）`, "用 --repo 或环境变量 EXTCIRCUIT_HOME 指定");
    const outDir = path.resolve(String(o.out ?? "circuit-out"));
    fs.mkdirSync(outDir, { recursive: true });

    // 先把电路来源解析好：语料名写错就别去启动浏览器了
    const { text: sourceText, source } = readCircuitSource(repo, o);
    const { backend, toolset, base, via } = await attach({ repo, base: o.base, allowSpawn: o["no-spawn"] !== true, log });
    const result = { ok: true, backend: { base, via } };

    try {
        // 1) 载入
        const loaded = await toolset.call("circuit.load_netlist", { text: sourceText });
        if (!loaded.ok) {
            throw new CliError(
                `载入电路失败：${JSON.stringify(loaded).slice(0, 800)}`,
                loaded.unsupported?.some?.((u) => /needs_layout|layout/.test(u.code ?? ""))
                    ? "含多端元件且没有坐标：改用 --circuit 内置语料，或给网表补 layout 坐标"
                    : undefined,
            );
        }
        const circuitText = sourceText;
        const comps = await toolset.call("circuit.list_components");
        const nlRes = await toolset.call("circuit.get_netlist");
        const all = (comps.components ?? []).map((c) => ({ id: c.id, type: c.type, props: c.props }));
        const typeOf = new Map(all.map((e) => [e.id, e.type]));
        // 导线是自动布局/布线造出来的，不是用户的概念元件：从清单里剔掉，只留个数
        const elements = all.filter((e) => e.type !== "WireElm");
        result.circuit = {
            source,
            components: elements.length,
            wires: all.length - elements.length > 0 ? all.length - elements.length : undefined,
            elements,
            // 引擎分配的网名是 n0/n1…（网表里的自定义网名不会保留）——把引脚归属带出来，
            // 模型才能判断"哪个网是输出"（例：接在 ResistorElm 的 1 脚与 CapacitorElm 的 0 脚之间）。
            // 导线引脚已滤掉：布线是编译器造的，对理解拓扑没意义。
            nets: nlRes.ok
                ? (nlRes.netlist?.nets ?? []).map((n) => ({
                    id: n.id,
                    pins: n.pins.filter((p) => typeOf.get(String(p).split(":")[0]) !== "WireElm"),
                    ...(n.ground ? { ground: true } : {}),
                }))
                : undefined,
            load: { stats: loaded.stats, warnings: (loaded.losses?.conflicts ?? []).length ? loaded.losses.conflicts : undefined },
        };

        // 2) 改参数
        if (o.set) {
            const list = [].concat(o.set);
            const changes = [];
            for (const expr of list) {
                const s = parseSetExpr(expr);
                const id = resolveTarget(result.circuit.elements, s.target);
                const before = result.circuit.elements.find((c) => c.id === id)?.props?.[s.prop];
                const r = await toolset.call("circuit.set_param", { target: id, prop: s.prop, value: s.value });
                changes.push({ ref: s.target, target: id, prop: s.prop, before, after: s.value, applied: r.applied ?? (r.ok ? 1 : 0), ok: r.ok !== false, error: r.ok === false ? r.error ?? r : undefined });
                if (r.ok === false) throw new CliError(`改参失败 ${expr}：${JSON.stringify(r).slice(0, 400)}`, "参数名对不上？看 elements[].props 里的字段名");
                const el = result.circuit.elements.find((c) => c.id === id);
                if (el) el.props = { ...el.props, [s.prop]: s.value };
            }
            result.changes = changes;
        }

        if (o.reset) {
            const r = await toolset.call("sim.reset");
            if (r.ok === false) throw new CliError(`复位失败：${JSON.stringify(r)}`);
        }

        // 3) 步进
        if (o.step) {
            const sec = parseValue(o.step);
            const r = await advance(toolset, sec);
            if (!r.ok) throw new CliError(`步进失败：${JSON.stringify(r.error)}`);
            result.step = { seconds: sec, t: round(r.t, 8), engineSteps: r.engineSteps, chunks: r.chunks };
            if (r.achieved < sec * 0.99) {
                warn(result, `只推进了 ${r.achieved.toFixed(6)}s（请求 ${sec}s）：引擎单次最多约 20000 步。`
                    + "CLI 已自动分块，仍不足说明仿真卡住或不收敛。");
            }
            if (r.engineSteps === 0) {
                warn(result, "仿真没有推进（engineSteps=0）：电路不收敛，或自动布局把导线画成了短路/开路。"
                    + "先把 --shot 出张图看一眼；多端元件（运放/555/晶体管）建议改用内置语料 + --set。");
            }
        }

        // 4) 瞬时测量（t=0 时引擎还没建网表，值可能是空的 → 先推进 1 个引擎步）
        if (o.measure !== undefined) {
            const nets = listArg(o.measure);
            let m = await toolset.call("sim.read_measurements", nets ? { nets } : {});
            if (m.ok !== false && Object.keys(m.values ?? {}).length === 0 && !o.step) {
                await toolset.call("sim.step", { steps: 1 });
                m = await toolset.call("sim.read_measurements", nets ? { nets } : {});
                result.autoStepped = "t=0 时无节点电压，已自动推进 1 个引擎步（5µs 量级）";
            }
            if (m.ok === false) throw new CliError(`读数失败：${JSON.stringify(m)}`);
            const values = m.values ?? {};
            if (nets) {
                const missing = nets.filter((n) => !(n in values));
                if (missing.length) {
                    throw new CliError(
                        `网络不存在：${missing.join(", ")}`,
                        `可用网络：${(result.circuit.nets ?? []).map((n) => n.id).join(", ")}`,
                    );
                }
            }
            result.measurements = {
                t: round(m.t, 8),
                quantity: m.quantity ?? "voltage",
                values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)])),
            };
            if (Object.values(values).every((v) => v === 0)) {
                warn(result, "所有节点电压都是 0：可能拓扑断了（导线没接上）、极性反了，或仿真没推进。"
                    + "用 --shot 看图，或改用 --circuit 内置语料对照。");
            }
        }
        if (o.components !== undefined) {
            const ids = listArg(o.components)
                ?? result.circuit.elements.filter((c) => c.type !== "WireElm" && c.type !== "GroundElm").map((c) => c.id);
            const m = await toolset.call("sim.read_measurements", { components: ids, quantity: "current" });
            if (m.ok !== false) {
                result.currents = { t: round(m.t, 8), values: Object.fromEntries(Object.entries(m.values ?? {}).map(([k, v]) => [k, round(v)])) };
            }
        }

        // 5) 时域采样
        if (o.sample !== undefined) {
            const nets = listArg(o.sample);
            const span = parseValue(o.span ?? 0.02) ?? 0.02;
            const points = Math.max(10, Math.min(4000, Number(o.points ?? 200)));
            const settle = parseValue(o.settle ?? 0) ?? 0;
            const { series, tEnd } = await sampleSeries(toolset, { nets, span, points, settle });
            const missing = nets ? nets.filter((n) => !series.has(n)) : [];
            if (missing.length) {
                throw new CliError(
                    `网络不存在：${missing.join(", ")}`,
                    `可用网络：${(result.circuit.nets ?? []).map((n) => n.id).join(", ")}`,
                );
            }
            const rows = [];
            for (const [net, pts] of series) {
                const st = stats(pts);
                if (!st) continue;
                if (st.vpp === 0 && st.final === 0 && pts.length < 2) continue;
                const entry = { net, unit: "V", ...st, points: pts.length, t0: round(pts[0][0], 8), t1: round(pts[pts.length - 1][0], 8) };
                if (o.data) entry.data = pts.map(([t, v]) => [round(t, 8), round(v, 5)]);
                rows.push(entry);
            }
            // 全零网络（悬空/未连接）单独标出来，别让模型当成"波形是直线"
            const flat = rows.filter((r) => r.vpp === 0).map((r) => r.net);
            result.sample = { span, points, settle, tEnd: round(tEnd, 8), channels: rows, flat: flat.length ? flat : undefined };
            if (!tEnd) {
                warn(result, "采样期间仿真时间没有推进：电路不收敛，或布线把节点接错。建议换内置语料对照，或 --shot 看图。");
            }
            if (o.svg) {
                // 缩窗：周期信号铺满整窗会糊成色块（240 Hz × 0.6 s = 144 个周期）。
                // 统计量仍按全窗口算，图只画最后 5 个周期，并在标题里说清楚。
                const fmax = Math.max(0, ...rows.map((r) => r.freqEstimate ?? 0));
                const t0 = Math.min(...rows.map((r) => r.t0 ?? 0));
                const cycles = fmax > 0 ? fmax * (tEnd - t0) : 0;
                let cropFrom = null;
                if (cycles > 12) cropFrom = tEnd - 5 / fmax;
                const pick = (pts) => (cropFrom == null ? pts : pts.filter((p) => p[0] >= cropFrom));
                const channels = rows
                    .filter((r) => r.vpp > 0 || rows.length <= 4)
                    .slice(0, 6)
                    .map((r) => ({ label: `V(${r.net})`, unit: "V", points: pick(series.get(r.net)) }));
                const zoomNote = cropFrom == null
                    ? ""
                    : `（全窗口 ${cycles.toFixed(0)} 个周期太密，图中只画最后 5 个周期；统计量仍按全窗口）`;
                const svg = renderChannels({
                    title: `${sourceLabel(result.circuit.source)} · 时域波形${zoomNote}`,
                    xLabel: `t / s（${points} 点，确定性步进）`,
                    channels,
                });
                const f = path.join(outDir, "waveform.svg");
                fs.writeFileSync(f, svg, "utf8");
                result.sample.svg = f;
                if (cropFrom != null) result.sample.svgWindow = { from: round(cropFrom, 8), to: round(tEnd, 8), cyclesShown: 5 };
            }
        }

        // 6) 参数扫描
        if (o.sweep) {
            const s = parseSetExpr(String(o.sweep));
            const values = String(o.sweep)
                .slice(String(o.sweep).lastIndexOf("=") + 1)
                .split(",")
                .map((v) => parseValue(v))
                .filter((v) => v != null);
            if (values.length < 2) throw new CliError("--sweep 至少两个值", "例：--sweep e6.frequency=10,100,1k,10k");
            const id = resolveTarget(result.circuit.elements, s.target);
            const probeNets = listArg(o.probe);
            const useSample = Boolean(o.span) || o.sample !== undefined;
            const span = parseValue(o.span ?? 0.02) ?? 0.02;
            const points = Math.max(10, Math.min(2000, Number(o.points ?? 120)));
            const settle = parseValue(o.settle ?? 0) ?? 0;

            const rows = [];
            const curves = new Map(); // net -> [[x, v]]
            for (const v of values) {
                const set = await toolset.call("circuit.set_param", { target: id, prop: s.prop, value: v });
                if (set.ok === false) throw new CliError(`扫描改参失败 ${s.prop}=${v}：${JSON.stringify(set).slice(0, 300)}`);
                await toolset.call("sim.reset");
                let row = { x: v, xLabel: fmtEng(v, propUnit(s.prop)) };
                if (useSample) {
                    const { series } = await sampleSeries(toolset, { nets: probeNets, span, points, settle });                    const stat = {};
                    for (const [net, pts] of series) {
                        const st = stats(pts);
                        if (!st) continue;
                        stat[net] = st;
                        if (!curves.has(net)) curves.set(net, []);
                        curves.get(net).push([v, st.vpp]);
                    }
                    row.nets = stat;
                } else {
                    if (settle > 0) await advance(toolset, settle);
                    const m = await toolset.call("sim.read_measurements", probeNets?.length ? { nets: probeNets } : {});
                    const vals = Object.fromEntries(Object.entries(m.values ?? {}).map(([k, val]) => [k, round(val)]));
                    row.nets = Object.fromEntries(Object.entries(vals).map(([k, val]) => [k, { value: val }]));
                    for (const [net, val] of Object.entries(vals)) {
                        if (!curves.has(net)) curves.set(net, []);
                        curves.get(net).push([v, val]);
                    }
                }
                rows.push(row);
            }
            result.sweep = {
                param: `${id}.${s.prop}`,
                values,
                mode: useSample ? "vpp（峰峰值，含采样窗口统计）" : "瞬时值",
                rows,
            };
            if (o.svg) {
                const channels = [...curves.entries()].slice(0, 4).map(([net, pts]) => ({
                    label: `${useSample ? "Vpp" : "V"}(${net})`,
                    unit: "V",
                    points: pts,
                }));
                const svg = renderChannels({
                    title: `参数扫描：${s.prop}（${values.map((v) => fmtEng(v, propUnit(s.prop))).join(" → ")}）`,
                    xLabel: `${s.prop} / ${propUnit(s.prop) || "—"}${o.logx ? "（对数轴）" : ""}`,
                    channels,
                    logX: Boolean(o.logx),
                });
                const f = path.join(outDir, "sweep.svg");
                fs.writeFileSync(f, svg, "utf8");
                result.sweep.svg = f;
            }
        }

        // 7) 导出 / 分享 / 截图
        let finalText = circuitText;
        if (o.dump || o.share || o["share-out"]) {
            finalText = await dumpCircuitText(toolset);
            if (o.dump) {
                const f = path.resolve(String(o.dump));
                fs.mkdirSync(path.dirname(f), { recursive: true });
                fs.writeFileSync(f, finalText, "utf8");
                result.dump = { file: f, bytes: Buffer.byteLength(finalText) };
            }
        }
        if (o.share || o["share-out"]) {
            result.share = makeShare(repo, {
                text: finalText,
                shareOut: o["share-out"] ? path.resolve(String(o["share-out"])) : undefined,
            });
        }
        if (o["print-text"]) result.text = finalText;

        if (o.shot) {
            const f = path.resolve(String(o.shot));
            const svg = f.toLowerCase().endsWith(".svg");
            const shot = await toolset.call("schematic.screenshot", { format: svg ? "svg" : "png" });
            if (shot.ok === false) throw new CliError(`截图失败：${JSON.stringify(shot)}`);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            if (svg) {
                fs.writeFileSync(f, shot.data, "utf8");
            } else {
                const b64 = String(shot.data).replace(/^data:image\/png;base64,/, "");
                fs.writeFileSync(f, Buffer.from(b64, "base64"));
            }
            result.shot = { file: f, format: svg ? "svg" : "png", bytes: fs.statSync(f).size };
        }

        return result;
    } finally {
        try {
            await backend.dispose();
        } catch {
            /* 清理失败不该掩盖主流程结果 */
        }
    }
}

function sourceLabel(source) {
    if (!source) return "电路";
    if (source.kind === "corpus") return source.name;
    if (source.kind === "file") return path.basename(source.file);
    if (source.kind === "netlist") return "自定义网表";
    return "自定义电路";
}

function propUnit(prop) {
    const m = {
        resistance: "Ω",
        capacitance: "F",
        inductance: "H",
        frequency: "Hz",
        maxVoltage: "V",
        position: "",
        bias: "V",
        dutyCycle: "",
    };
    return m[prop] ?? "";
}

// ── 其它命令 ────────────────────────────────────────────────────────────────

/** 跑一条外部命令并把输出收进 stderr（stdout 只留给 JSON）。 */
function runStep(cmd, args, cwd, label) {
    log(`▸ ${label}`);
    const r = spawnSync(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
    });
    if (r.error) throw new CliError(`${label} 失败：${r.error.message}`);
    if (r.status !== 0) {
        const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`
            .trim()
            .split(/\r?\n/)
            .slice(-14)
            .join("\n");
        throw new CliError(`${label} 失败（exit ${r.status}）`, tail);
    }
    return (r.stdout ?? "").trim();
}

async function cmdSetup(o) {
    const dir = path.resolve(String(o.dir ?? defaultEngineDir()));
    const url = String(o.url ?? ENGINE_URL);
    const steps = [];
    let cloned = false;

    if (isEngineRepo(dir)) {
        steps.push({ step: "engine", status: "exists", dir });
    } else {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
            throw new CliError(`${dir} 已存在且非空，但不是 ExtCircuitJS 仓库`, "换一个 --dir，或清理该目录后重试");
        }
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        runStep("git", ["clone", "--depth", "1", url, dir], path.dirname(dir), `git clone ${url}`);
        cloned = true;
        if (!isEngineRepo(dir)) throw new CliError("克隆完成但没找到 tools/ext.mjs", "确认 --url 指向 ExtCircuitJS 仓库根");
        steps.push({ step: "engine", status: "cloned", dir, url });
    }

    const coreModules = path.join(dir, "core", "ts", "node_modules");
    if (!o["skip-install"] && !fs.existsSync(coreModules)) {
        runStep(process.execPath, [path.join(dir, "tools", "ext.mjs"), "core", "install"], dir, "core install（装构建依赖）");
        steps.push({ step: "core install", status: "ok" });
    } else {
        steps.push({ step: "core install", status: fs.existsSync(coreModules) ? "already" : "skipped" });
    }

    const distHtml = path.join(dir, "dist", "circuitjs.html");
    if (!o["skip-build"] && !fs.existsSync(distHtml)) {
        runStep(process.execPath, [path.join(dir, "tools", "ext.mjs"), "build"], dir, "build（生成 dist/）");
        steps.push({ step: "build", status: "ok" });
    } else {
        steps.push({ step: "build", status: fs.existsSync(distHtml) ? "already" : "skipped" });
    }

    const hasDist = fs.existsSync(distHtml);
    return {
        ok: true,
        engine: { dir, cloned, dist: hasDist ? path.join(dir, "dist") : null, url },
        steps,
        next: [
            `node ${path.join(SKILL_DIR, "scripts", "circuitlab.mjs")} probe`,
            hasDist
                ? "有 dist/：跑仿真时 CLI 会自己起 `ext serve` 并回收，不用你管"
                : "没有 dist/：只能走 dev server（需要 core install），建议补跑 build",
        ],
    };
}

async function cmdProbe(o) {
    const { repo, tried } = resolveRepo(o.repo);
    const bases = o.base ? [String(o.base)] : defaultBases();
    const results = await probe({ bases });
    const live = results.find((r) => r.reachable);
    const out = {
        ok: Boolean(live && repo),
        repo,
        candidates: results,
        chosen: live?.base ?? null,
        pages: "https://blankwy.github.io/ExtCircuitJS/circuitjs.html —— 只能给人点开看，MCP 无法驱动（backend 探活只认 http）",
    };
    if (o.attach && live) {
        try {
            const { backend, base, via } = await attach({ repo, base: live.base, allowSpawn: false, log });
            const t = await backend.toolset.call("circuit.list_components");
            out.attach = { ok: true, base, via, sample: JSON.stringify(t).slice(0, 120) };
            await backend.dispose();
        } catch (e) {
            out.attach = { ok: false, error: String(e.message ?? e) };
        }
    }
    if (!repo) {
        out.hint = [
            "还没装引擎（ExtCircuitJS）。一条命令搞定：",
            "  node <skill>/scripts/circuitlab.mjs setup",
            `找过的位置：${tried.slice(0, 5).join(" / ")}`,
        ];
    } else if (!out.ok) {
        out.hint = [
            "引擎有了，但没有可达的后端（下次 run 会自动拉起，见 --no-spawn）：",
            `  cd ${repo} && node tools/ext.mjs serve --port 8080`,
            `  cd ${repo} && node tools/ext.mjs build && node tools/ext.mjs serve --port 8080`,
        ];
    }
    return out;
}

async function cmdCorpus(o) {
    const { repo } = resolveRepo(o.repo);
    if (!repo) throw new CliError("找不到 ExtCircuitJS 仓库");
    const all = loadCorpus(repo);
    const kw = o.search ? String(o.search).toLowerCase() : null;
    const cat = o.category ? String(o.category).toLowerCase() : null;
    const hits = all.filter(
        (c) =>
            (!kw || c.name.toLowerCase().includes(kw) || c.title.toLowerCase().includes(kw)) &&
            (!cat || c.category.toLowerCase().includes(cat)),
    );
    if (o.list) {
        const byCat = {};
        for (const c of hits) (byCat[c.category] ??= []).push(`${c.name} — ${c.title}`);
        return { ok: true, total: hits.length, categories: byCat };
    }
    return { ok: true, total: hits.length, items: hits.slice(0, 60) };
}

async function cmdShare(o) {
    const { repo } = resolveRepo(o.repo);
    if (!repo) throw new CliError("找不到 ExtCircuitJS 仓库");
    const shareOut = o.out ? path.resolve(String(o.out)) : undefined;
    if (o.netlist) {
        // 网表要先经编译器生成坐标与导线，必须借活引擎
        const { backend, toolset } = await attach({ repo, base: o.base, allowSpawn: o["no-spawn"] !== true, log });
        try {
            await loadCircuit(toolset, repo, o);
            const text = await dumpCircuitText(toolset);
            return { ok: true, ...makeShare(repo, { text, shareOut }) };
        } finally {
            try {
                await backend.dispose();
            } catch { /* ignore */ }
        }
    }
    if (o.text) {
        return { ok: true, ...makeShare(repo, { text: readIfFile(String(o.text)), shareOut }) };
    }
    if (o.file) {
        return { ok: true, ...makeShare(repo, { file: String(o.file).replace(/^@/, ""), shareOut }) };
    }
    if (o.circuit) {
        const name = String(o.circuit).replace(/\.txt$/, "");
        const f = path.join(repo, "core", "ts", "public", "circuits", `${name}.txt`);
        if (!fs.existsSync(f)) throw new CliError(`内置语料里没有 ${name}`, "用 corpus --search <关键词> 找");
        return { ok: true, ...makeShare(repo, { circuit: name, shareOut }) };
    }
    throw new CliError("缺少电路来源", "--circuit / --text / --file / --netlist 之一");
}

async function cmdShot(o) {
    const { repo } = resolveRepo(o.repo);
    if (!repo) throw new CliError("找不到 ExtCircuitJS 仓库");
    const target = path.resolve(String(o.out ?? "circuit.svg"));
    const svg = target.toLowerCase().endsWith(".svg");
    const { backend, toolset } = await attach({ repo, base: o.base, allowSpawn: o["no-spawn"] !== true, log });
    try {
        await loadCircuit(toolset, repo, o);
        const shot = await toolset.call("schematic.screenshot", { format: svg ? "svg" : "png" });
        if (shot.ok === false) throw new CliError(`截图失败：${JSON.stringify(shot)}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (svg) fs.writeFileSync(target, shot.data, "utf8");
        else fs.writeFileSync(target, Buffer.from(String(shot.data).replace(/^data:image\/png;base64,/, ""), "base64"));
        return { ok: true, file: target, format: svg ? "svg" : "png", bytes: fs.statSync(target).size };
    } finally {
        try {
            await backend.dispose();
        } catch { /* ignore */ }
    }
}

// ── main ────────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
const o = parseArgs(rest);

try {
    if (!cmd || cmd === "help" || o.help) {
        process.stdout.write(HELP);
        process.exit(0);
    }
    let out;
    switch (cmd) {
        case "setup":
            out = await cmdSetup(o);
            break;
        case "probe":
            out = await cmdProbe(o);
            break;
        case "corpus":
            out = await cmdCorpus(o);
            break;
        case "run":
            out = await cmdRun(o);
            break;
        case "share":
            out = await cmdShare(o);
            break;
        case "shot":
            out = await cmdShot(o);
            break;
        default:
            throw new CliError(`未知命令 ${cmd}`, "可用：setup / probe / corpus / run / share / shot");
    }
    emit(out);
    process.exit(out?.ok === false ? 2 : 0);
} catch (e) {
    const err = e instanceof CliError ? e : new CliError(String(e?.message ?? e), e?.stack);
    emit({ ok: false, error: { message: err.message, hint: err.hint ?? null } });
    process.exit(1);
}
