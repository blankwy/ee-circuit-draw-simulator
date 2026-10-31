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
    hasPlaywrightCore,
    engineCommit,
    engineCommitDate,
    engineDescribe,
    engineMeta,
    ENGINE_META_FILE,
    SKILL_IN_NODE_MODULES,
    ENGINE_URL,
    ENGINE_REF,
    SKILL_DIR,
} from "./lib/backend.mjs";
import { renderChannels, rasterizeSvg } from "./lib/svg.mjs";
import { parseValue, fmtEng, round } from "./lib/units.mjs";

const HELP = `ee-circuit-draw-simulator —— 电子电路绘制仿真助手 CLI

用法: ee-circuit-draw-simulator <命令> [选项]
      （等价写法：npx ee-circuit-draw-simulator ... / node scripts/circuitlab.mjs ...）

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
  --dir <path>      引擎装到哪（默认 <skill>/vendor/ExtCircuitJS；
                    npx / 全局安装时默认 ~/.ee-circuit/ExtCircuitJS）
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
  --step <秒>       确定性推进（必须用 step，不用 run；缺省时 --measure 会自动推进 1 ms）
  --measure <nets>  读瞬时值：all 或 n1,n2
  --components <ids>  读元件电流：all 或 e1,e2
  --sample <nets>   采样时域波形：all 或 n1,n2（all 默认略过 GND 与恒值网）
  --span <秒>       采样时长（默认 0.02）
  --points <n>      采样点数（默认 200）
  --settle <秒>     采样前先跑这么多秒（跳过暂态）
  --sweep <ref=v1,v2,...>  参数扫描（配合 --sample 或 --measure）
  --probe <nets>    扫描时观测的网络
  --logx            扫描图横轴取对数
  --svg             为采样/扫描生成 SVG（写到 --out）
  --png             出 PNG（给用户看图用；需本机 Chrome/Edge）。只给 --png 就够，
                   会自动补出 SVG 中间文件并把两张都登记进 artifacts[]
  --scale <n>       PNG 缩放倍数（默认 2）
  --dump <file>     导出电路文本
  --share           生成分享链接（先 dump 再压缩）
  --share-out <f>   同时生成 1–2KB 分享页
  --shot <file>     导出电路图（.svg 或 .png，看扩展名）
  --include-supply  --sample all 时连 GND / 恒值网一起输出
  --force           拓扑闸拦下时强行放行（结果可能无意义）
  --print-text      JSON 里附带电路文本
  --data            JSON 里附带采样原始数组（默认只给统计量）
  --jobs <json|@f>  一次进程跑多个作业（共用后端，省掉每次 ~4.5 s 的启动开销）。
                   每项是一套上面这些选项；顶层选项当默认值，作业里同名键覆盖它。
                   产物按作业名分到 --out 下的子目录，顶层 artifacts[] 给出全部路径。
                   例：--jobs @jobs.json
                   jobs.json: [{"name":"图","circuit":"lrc","shot":"lrc.png"},
                               {"name":"波","circuit":"lrc","sample":"all","span":0.02,"svg":true,"png":true}]

产物路径统一在结果的 artifacts[] 里（绝对路径），不用去猜 --out 目录。
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

/** 产物路径集中登记：agent 不用再去 \`circuit-out/\` 里 find。 */
function addArtifact(result, kind, file) {
    if (!result.artifacts) result.artifacts = [];
    const abs = path.resolve(file);
    if (result.artifacts.some((a) => a.path === abs)) return;
    result.artifacts.push({ kind, path: abs, bytes: fs.existsSync(abs) ? fs.statSync(abs).size : undefined });
}

/**
 * 要求了产物却没产出：结构化记一笔。
 *
 * 为什么不能只 warn：这种"成功退出但什么都没做"最容易被模型读成"这个电路不能出图"，
 * 于是转去手搓 SVG 或者干脆放弃出图，而日志里看起来一切正常。
 */
function noteArtifactIssue(result, { requested, reason, fallback }) {
    if (!result.artifactIssues) result.artifactIssues = [];
    result.artifactIssues.push({
        code: "artifact.not_generated",
        requested,
        reason,
        ...(fallback ? { fallback } : {}),
    });
    warn(result, `${requested.join("/")} 没生成：${reason}${fallback ? `（已退回到 ${fallback}）` : ""}`);
}

/** 读数全是 0（或压根没值）——用于判断"要不要自动推进再读"。 */
function allNearlyZero(values) {
    const vs = Object.values(values ?? {});
    return vs.length === 0 || vs.every((v) => Math.abs(Number(v)) < 1e-9);
}

// ── 拓扑闸：载入后、仿真前自己查一遍 ─────────────────────────────────────────
//
// 为什么需要：`packages/netlist` 的自动布线在多端元件上偶尔会把两个功率脚并进
// 同一个网（已验证：三极管的 C 与 E 同网）。引擎不报错，只会 engineSteps=0、读数
// 全 0，看起来像"你电路画错了"。这类错误纯图论就能判，不必等仿真跑完才发现。
//
// 引脚语义取自引擎源码（core/ts/*.ts 的节点注释）：
//   TransistorElm  node0 = base，node1 = collector，node2 = emitter
//   MosfetElm      node0 = gate，node1 / node2 = source / drain（源漏可互换）
const PIN_SEMANTICS = {
    TransistorElm: { 1: "集电极 C", 2: "发射极 E" },
    MosfetElm: { 1: "漏极 D", 2: "源极 S" },
};

/**
 * 只查"短接即失去意义"的引脚对（C-E / D-S），不查 555、电位器这类
 * 允许多脚同网的元件——那些接法在真实电路里是合法的，查了只会误报。
 */
function lintTopology(elements, nets) {
    if (!elements?.length || !nets?.length) return { fatal: [], checked: 0 };
    const netOf = new Map();
    for (const n of nets) for (const p of n.pins ?? []) netOf.set(String(p), n.id);

    const fatal = [];
    let checked = 0;
    for (const el of elements) {
        const names = PIN_SEMANTICS[el.type];
        if (!names) continue;
        checked++;
        const postsByNet = new Map();
        for (const post of Object.keys(names)) {
            const net = netOf.get(`${el.id}:${post}`);
            if (net === undefined) continue;
            if (!postsByNet.has(net)) postsByNet.set(net, []);
            postsByNet.get(net).push(post);
        }
        for (const [net, posts] of postsByNet) {
            if (posts.length < 2) continue;
            const label = posts.map((p) => names[p]).join(" 与 ");
            fatal.push({
                element: el.id,
                type: el.type,
                net,
                pins: posts,
                message: `${el.id}（${el.type}）的${label}落在同一个网 ${net}`,
            });
        }
    }
    return { fatal, checked };
}

/** 拓扑致命时才抛，`--force` 可以强行放行（有人故意接成二极管/短路来玩）。 */
function assertTopology(result, force) {
    const lint = lintTopology(result.circuit.elements, result.circuit.nets);
    if (!lint.fatal.length) return;
    const detail = lint.fatal.map((f) => f.message).join("；");
    if (force) {
        warn(result, `拓扑可疑但 --force 放行：${detail}。仿真结果不保证有意义。`);
        result.topology = { fatal: lint.fatal, forced: true };
        return;
    }
    result.topology = { fatal: lint.fatal };
    throw new CliError(
        `拓扑错误：${detail} —— 器件被导线短路，仿真只会给出无意义的数（通常是 engineSteps=0、全 0 V）。`,
        "这是自动布线在多端元件上的已知问题：改用 --circuit 内置语料 + --set，或给网表补 layout 坐标。"
            + "确认电路本来就该这样接，才加 --force。",
        {
            code: "topology.shorted_device",
            details: {
                devices: lint.fatal.map((f) => ({ element: f.element, type: f.type, net: f.net, pins: f.pins })),
            },
            suggestions: ["use_corpus", "provide_layout", "force"],
        },
    );
}

// ── 必填字段审计：载入时就把"没写"说出来 ─────────────────────────────────────
//
// 有些字段不写，电路不会报错，只会变成一个"空器件"。二极管、三极管、MOS 的
// modelName 就是这类：它决定的是器件特性，缺了就没有特性可言。症状不是异常，
// 而是 engineSteps=0、读数全 0 —— 一句"引擎卡住或不收敛"，用户得自己猜。
//
// 实测（bfebc80 与 4004e1b 两版引擎）：二极管不写 modelName 时，引擎的
// static 默认值（DiodeElm.lastModelName = "default"）会兜住，"不写"看起来没事。
// 这份兜底是引擎内部实现，不同元件家族、不同版本并不一致 —— 所以这里不假装
// 能判断"会不会出事"，只如实说"你没写这一项、引擎可能替你填了"。
//
// 在**载入前**对照源网表查：此时还没有引擎补过的默认值，能分清"用户没写"和
// "引擎填了"。
const REQUIRED_PROPS = {
    DiodeElm: ["modelName"],
    ZenerElm: ["modelName"],
    LEDElm: ["modelName"],
    TunnelDiodeElm: ["modelName"],
    TransistorElm: ["modelName"],
    MosfetElm: ["modelName"],
    NMosfetElm: ["modelName"],
    PMosfetElm: ["modelName"],
};

function auditRequiredProps(sourceText) {
    let netlist;
    try {
        netlist = JSON.parse(sourceText);
    } catch {
        return []; // XML / 紧凑格式：解析不了就跳过，不是这里该报的错
    }
    const comps = netlist?.components;
    if (!Array.isArray(comps)) return [];
    const out = [];
    for (const c of comps) {
        const req = REQUIRED_PROPS[c?.type];
        if (!req) continue;
        for (const prop of req) {
            const v = c.props?.[prop];
            if (v === undefined || v === null || String(v).trim() === "") {
                out.push({ element: String(c.id ?? "?"), type: c.type, prop });
            }
        }
    }
    return out;
}

/**
 * 带稳定 code 的错误。
 *
 * message/hint 是给人读的，`code` 是给调用方分支用的 —— 模型按 code 判断是稳定的，
 * 靠中文句子做字符串匹配改一个标点就失效（issue #6）。
 */
class CliError extends Error {
    constructor(message, hint, { code = "error", details = null, suggestions = null } = {}) {
        super(message);
        this.hint = hint;
        this.code = code;
        this.details = details;
        this.suggestions = suggestions;
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
    if (i < 0) throw new CliError(`--set 需要 ref=value 形式，收到 ${expr}`, undefined, { code: "usage.bad_set" });
    const ref = expr.slice(0, i).trim();
    const rawVal = expr.slice(i + 1).trim();
    const prop = ref.includes(".") ? ref.slice(ref.lastIndexOf(".") + 1) : null;
    const target = ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : ref;
    if (!prop) throw new CliError(`--set 需要 元件.参数=值 形式，收到 ${expr}`, "例：--set e1.resistance=4.7k", { code: "usage.bad_set" });
    const num = parseValue(rawVal);
    return { target, prop, value: num == null ? rawVal : num, raw: rawVal };
}

// ── 采样 ────────────────────────────────────────────────────────────────────

/**
 * 用 DFT 找基频，并判断它靠不靠得住。
 *
 * 为什么不能数过零点：60 Hz 正弦上叠 120 Hz 分量时，过零点数被高频分量放大一倍，
 * 频率直接翻倍报成 120 Hz（issue #3）—— 教学场景下这种"看着很精确的错误数字"
 * 比给不出数字更糟，学生会拿它去算容抗，后面全错且不会怀疑工具。
 *
 * 做法：Hann 窗 + Goertzel 逐 bin 求幅度，峰值抛物线插值拿亚 bin 精度。
 * 两个判定分开，因为"有明确基频"和"接近正弦"是两回事：
 *   periodic —— 能量是否都落在 f0 的整数倍上（方波、锯齿波成立，噪声不成立）
 *   tonal    —— 主峰是否独大（近似单音，波形基本是正弦）
 */
function dominantFrequency(points, { hintHz = null, maxBins = 4096, maxComponents = 3 } = {}) {
    const n = points.length;
    if (n < 64) return null; // 点太少，频谱全是泄漏，别装懂
    const t0 = points[0][0];
    const t1 = points[n - 1][0];
    const L = t1 - t0; // 记录长度，决定 bin 宽度 1/L
    if (!(L > 0)) return null;
    const dt = L / (n - 1);
    const nyquist = 1 / (2 * dt);
    const ys = points.map((p) => (Number.isFinite(p[1]) ? p[1] : 0));
    const mean = ys.reduce((a, b) => a + b, 0) / n;
    // Hann 窗：矩形窗的旁瓣会把相邻谐波的能量糊到基频上，让插值偏出 1 Hz 量级
    for (let i = 0; i < n; i++) ys[i] = (ys[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

    // 搜索带的上界：过零率只会**高估**基频，拿它当上界是安全的，能把长窗口的
    // bin 数从 n/2 压到实际需要的量级（否则 6 s 窗口算一次要 18M 次乘法）。
    const bandTop = Math.min(nyquist, Math.max((hintHz ?? 0) * 1.6, (hintHz ? 40 : nyquist)));
    let K = Math.min(Math.floor(n / 2), Math.max(8, Math.ceil(bandTop * L)));
    if (K > maxBins) K = maxBins; // 兜底：无论多长都不超过这个代价
    const mag = new Float64Array(K + 1);
    for (let k = 1; k <= K; k++) {
        const w = (2 * Math.PI * k) / n;
        const c = 2 * Math.cos(w);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < n; i++) {
            const s0 = ys[i] + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        mag[k] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
    }

    // 局部极大值 = 候选分量
    const peaks = [];
    for (let k = 1; k <= K; k++) {
        const left = k > 1 ? mag[k - 1] : 0;
        const right = k < K ? mag[k + 1] : 0;
        if (mag[k] > left && mag[k] >= right) {
            // 抛物线插值：bin 宽度是 1/L，插值后误差降到亚 bin
            const denom = left - 2 * mag[k] + right;
            const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom)) : 0;
            peaks.push({ f: (k + delta) / L, mag: mag[k] });
        }
    }
    if (!peaks.length) return null;
    peaks.sort((a, b) => b.mag - a.mag);

    let total = 0;
    for (let k = 1; k <= K; k++) total += mag[k] * mag[k];
    const f0 = peaks[0].f;

    // 主峰必须是基频：若有个更低频的峰也占了不少能量，它就是真正的基频
    const lower = peaks.filter((p) => p.f < f0 * 0.85 && p.mag >= peaks[0].mag * 0.5);
    if (lower.length) return { ...buildResult(lower[0].f), note: "存在更低频的强分量" };

    function buildResult(fundamental) {
        // 谐波能量按"窗口内积分"算，不能只取峰顶：窗函数会把一个谐波摊到相邻几个 bin，
        // 只数峰顶会大幅低估，导致周期信号被误判成噪声（555 的锯齿就是这样翻车的）。
        const df = 1 / L;
        const tolHz = Math.max(fundamental * 0.06, 1.5 * df);
        const bandPower = (fc) => {
            const lo = Math.max(1, Math.round((fc - tolHz) / df));
            const hi = Math.min(K, Math.round((fc + tolHz) / df));
            let sum = 0;
            for (let b = lo; b <= hi; b++) sum += mag[b] * mag[b];
            return sum;
        };
        let harmonic = 0;
        const kMaxHarm = Math.floor((K * df) / fundamental);
        for (let kk = 1; kk <= kMaxHarm; kk++) harmonic += bandPower(kk * fundamental);

        const fundamentalPower = bandPower(fundamental);
        const share = total > 0 ? fundamentalPower / total : 0;
        return {
            f: fundamental,
            periodic: total > 0 && harmonic / total >= 0.6,
            tonal: share >= 0.5,
            share: round(share, 3),
            // 主峰贴近奈奎斯特频率：采样太稀，真实频率很可能已经混叠到别处
            aliased: fundamental > nyquist * 0.75,
            components: peaks.slice(0, maxComponents).map((p) => ({ f: round(p.f, 4), amp: round((4 * p.mag) / n, 4) })),
        };
    }
    return buildResult(f0);
}

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
        if (ups.length >= 2) {
            // 振荡信号：基频与"靠不靠得住"都交给频谱判
            const tFirst = ups[0].t;
            const tLast = ups[ups.length - 1].t;
            const fc = tLast > tFirst ? (ups.length - 1) / (tLast - tFirst) : null;
            const spec = dominantFrequency(points, { hintHz: fc });
            if (spec?.periodic && !spec.aliased) {
                // 频谱负责"是哪个基频"（不受谐波干扰），过零间隔负责"有多准"
                // （把整个窗口的边沿间隔平均掉，bin 分辨率不够时更精确）。
                // 两者用整数倍对齐：过零率只可能是基频的整数倍。
                let f0 = spec.f;
                let k = 1;
                if (fc) {
                    const m = Math.round(fc / f0);
                    if (m >= 1 && Math.abs(fc / f0 - m) <= 0.08 * m) {
                        k = fc / m / f0;
                        f0 = fc / m;
                    }
                }
                out.freqEstimate = round(f0, 4);
                out.periodic = true;
                out.tonal = spec.tonal;
                out.freqShare = spec.share;
                // 分量频率跟着同一个修正因子走，否则 freq 说 60、components 说 60.49 自相矛盾
                if (spec.components.length > 1) out.components = spec.components.map((c) => ({ ...c, f: round(c.f * k, 3) }));
                if (!spec.tonal) {
                    out.freqNote = `基频 ${round(f0, 1)} Hz，但波形不是正弦：能量分散在谐波上`
                        + `（主峰只占 ${Math.round(spec.share * 100)}%）；幅值请用 vpp，不要用主峰能量反推`;
                }
            } else if (spec?.aliased) {
                // 混叠比"没数"更糟：会给出一个看似合理的错频率
                const perCycle = spec.f > 0 ? 1 / (spec.f * (points[1][0] - points[0][0])) : 0;
                out.components = spec.components;
                out.freqNote = `采样太稀（每周期约 ${perCycle.toFixed(1)} 点，奈奎斯特频率 ${Math.round(1 / (2 * (points[1][0] - points[0][0])))} Hz）：`
                    + "频率会混叠，不报 freqEstimate。加大 --points 或缩短 --span";
            } else if (spec) {
                // 判不出基频就别硬填：宁可说"没有"，也不要给一个看起来精确的错误数字
                out.components = spec.components;
                out.freqNote = "波形没有明确基频（能量没落在某个频率的整数倍上），不报 freqEstimate";
            } else if (fc) {
                // 点数太少算不了频谱：退回过零间隔（误差小，但别无选择）
                out.freqEstimate = round(fc, 4);
            }
        }

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
        if (!r.ok) throw new CliError(`预热步进失败：${JSON.stringify(r.error)}`, undefined, { code: "sim.step_failed" });
    }
    const dt = span / points;
    const series = new Map();
    let last = null;
    for (let i = 0; i < points; i++) {
        const st = await toolset.call("sim.step", { seconds: dt });
        if (!st.ok) throw new CliError(`采样步进失败（第 ${i + 1} 点）：${JSON.stringify(st)}`, undefined, { code: "sim.step_failed", details: { point: i + 1 } });
        last = st.t;
        const m = await toolset.call("sim.read_measurements", nets?.length ? { nets } : {});
        if (!m.ok) throw new CliError(`采样读数失败：${JSON.stringify(m)}`, undefined, { code: "sim.read_failed" });
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
            { code: "circuit.load_failed", details: { unsupported: loaded.unsupported ?? null } },
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
    throw new CliError("缺少电路来源", "用 --circuit <名> / --text / --file / --netlist 之一", { code: "usage.missing_circuit" });
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
    const { repo, tried, incomplete } = resolveRepo(o.repo);
    if (!repo) {
        const half = (incomplete ?? []).map((x) => `${x.dir} 缺 ${x.missing.join(" / ")}`).join("；");
        throw new CliError(
            `找不到 ExtCircuitJS 仓库（试过 ${tried.join(" / ")}）`,
            "用 --repo 或环境变量 EXTCIRCUIT_HOME 指定"
                + (half ? `\n注意：${half} —— 目录不完整，建议重跑 setup` : ""),
            { code: "engine.not_found", details: { tried, incomplete } },
        );
    }
    const outDir = path.resolve(String(o.out ?? "circuit-out"));
    fs.mkdirSync(outDir, { recursive: true });

    // 多作业：一个进程、一个后端，跑完所有作业再退出
    if (o.jobs !== undefined) return cmdRunJobs({ repo, outDir, o });

    // 先把电路来源解析好：语料名写错就别去启动浏览器了
    const { text: sourceText, source } = readCircuitSource(repo, o);
    const { backend, toolset, base, via } = await attach({ repo, base: o.base, allowSpawn: o["no-spawn"] !== true, log });
    try {
        const result = { ok: true, backend: { base, via } };
        Object.assign(result, await executeJob({ toolset, repo, outDir, o, sourceText, source }));
        return result;
    } finally {
        try {
            await backend.dispose();
        } catch {
            /* 清理失败不该掩盖主流程结果 */
        }
    }
}

/**
 * 一个作业的全部步骤（后端已挂载之后）。返回要并进结果的字段。
 *
 * 抽出来是为了 --jobs：后端挂载贵（node 启动 + MCP 握手 + 载入，约 4.5 s 固定成本），
 * 作业本身很便宜（+0.9 s 量级），所以"一个进程跑 N 个作业"比分 N 次进程快得多。
 */
async function executeJob({ toolset, repo, outDir, o, sourceText, source }) {
    const result = {};
    {
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

        // 1a) 必填字段：载入前对照源网表查（此时还没有引擎补过的默认值）
        const missingProps = auditRequiredProps(sourceText);
        if (missingProps.length) {
            const names = missingProps.map((m) => `${m.element}(${m.type}).${m.prop}`).join("、");
            result.circuit.load.missingProps = missingProps;
            warn(result, `这些元件没写必填字段：${names}。引擎可能用内部默认值兜住（二极管是 "default"），`
                + "但不同元件家族/版本并不一致；仿真若停在 t=0、读数全 0，先补这一项。");
        }

        // 1b) 拓扑闸：多端元件被短路就别往下跑了（--force 可放行）
        assertTopology(result, o.force === true);

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
                if (r.ok === false) throw new CliError(`改参失败 ${expr}：${JSON.stringify(r).slice(0, 400)}`, "参数名对不上？看 elements[].props 里的字段名", { code: "param.unknown" });
                const el = result.circuit.elements.find((c) => c.id === id);
                if (el) el.props = { ...el.props, [s.prop]: s.value };
            }
            result.changes = changes;
        }

        if (o.reset) {
            const r = await toolset.call("sim.reset");
            if (r.ok === false) throw new CliError(`复位失败：${JSON.stringify(r)}`, undefined, { code: "sim.reset_failed" });
        }

        // 3) 步进
        if (o.step) {
            const sec = parseValue(o.step);
            const r = await advance(toolset, sec);
            if (!r.ok) throw new CliError(`步进失败：${JSON.stringify(r.error)}`, undefined, { code: "sim.step_failed" });
            result.step = { seconds: sec, t: round(r.t, 8), engineSteps: r.engineSteps, chunks: r.chunks };
            if (r.achieved < sec * 0.99) {
                warn(result, `只推进了 ${r.achieved.toFixed(6)}s（请求 ${sec}s）：引擎单次最多约 20000 步。`
                    + "CLI 已自动分块，仍不足说明仿真卡住或不收敛。");
            }
            if (r.engineSteps === 0) {
                // 有明确线索就先说线索：这句泛泛的"卡住/不收敛"正是上一轮反馈里最没用的一句。
                const lead = missingProps.length
                    ? `最可能是没写必填字段：${missingProps.map((m) => `${m.element}.${m.prop}`).join("、")}，先补上；`
                    : "";
                warn(result, `仿真没有推进（engineSteps=0）：${lead}否则是电路不收敛，或自动布局把导线画成了短路/开路。`
                    + "先把 --shot 出张图看一眼；多端元件（运放/555/晶体管）建议改用内置语料 + --set。");
            }
        }

        // 4) 瞬时测量（t=0 时引擎刚建网表：读数要么是空的，要么是 AC 源的 sin(0)=0）
        if (o.measure !== undefined) {
            const nets = listArg(o.measure);
            let m = await toolset.call("sim.read_measurements", nets ? { nets } : {});
            if (!o.step && m.ok !== false && allNearlyZero(m.values)) {
                // 推进 1 ms（不是 1 个 5µs 引擎步）：对 DC 和低频电路才有意义
                const adv = await advance(toolset, 0.001);
                if (adv.ok) {
                    m = await toolset.call("sim.read_measurements", nets ? { nets } : {});
                    result.autoStep = {
                        seconds: 0.001,
                        t: round(adv.t, 8),
                        reason: "没给 --step：t≈0 时读数为 0 或空，已自动推进 1 ms 再读",
                    };
                }
            }
            if (m.ok === false) throw new CliError(`读数失败：${JSON.stringify(m)}`, undefined, { code: "sim.read_failed" });
            const values = m.values ?? {};
            if (nets) {
                const missing = nets.filter((n) => !(n in values));
                if (missing.length) {
                    throw new CliError(
                        `网络不存在：${missing.join(", ")}`,
                        `可用网络：${(result.circuit.nets ?? []).map((n) => n.id).join(", ")}`,
                        { code: "net.unknown", details: { missing, available: (result.circuit.nets ?? []).map((n) => n.id) } },
                    );
                }
            }
            result.measurements = {
                t: round(m.t, 8),
                quantity: m.quantity ?? "voltage",
                values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)])),
            };
            if (allNearlyZero(values)) {
                warn(result, "所有节点电压都 ≈0：正弦源在 t≈0 附近本身就是 0（要看幅值请用 --sample）；"
                    + "若源是直流，则可能是拓扑断了、极性反了，或仿真没推进（用 --shot 看一眼）。");
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
                    { code: "net.unknown", details: { missing, available: (result.circuit.nets ?? []).map((n) => n.id) } },
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
            // 数值零而不是严格零：悬空网会给出 1e-12 量级的"波纹"，那也是直线
            const isFlat = (r) => !(Math.abs(r.vpp) >= 1e-9);
            const flat = rows.filter(isFlat).map((r) => r.net);

            // --sample all 的语义是"值得看的信号"，不是"网表里所有 net"（issue #4）：
            // GND 定义上恒 0，恒值网是数字而不是波形 —— 它们只会压扁图的纵轴、白占上下文。
            // 但"恒值"里也包含用户真正关心的输入参考（RC 的输入端是正弦，vpp>0，不受影响）；
            // 全是直流的电路则回退成"除 GND 外全留"，否则会给出空图。
            let channels = rows;
            let omitted = null;
            if (!nets && !o["include-supply"]) {
                const groundIds = new Set((result.circuit.nets ?? []).filter((n) => n.ground || n.id === "GND").map((n) => n.id));
                const isGround = (r) => groundIds.has(r.net) || r.net === "GND";
                const ground = rows.filter(isGround).map((r) => r.net);
                const constant = rows.filter((r) => !isGround(r) && isFlat(r)).map((r) => ({ net: r.net, value: r.final }));
                const keep = rows.filter((r) => !isGround(r) && !isFlat(r));
                channels = keep.length ? keep : rows.filter((r) => !isGround(r));
                if (ground.length || constant.length) {
                    omitted = {
                        ground,
                        constant,
                        note: "默认省略 GND（定义上恒 0）与恒值网（是数字不是波形）；要全部保留加 --include-supply",
                    };
                }
            }

            result.sample = {
                span,
                points,
                settle,
                tEnd: round(tEnd, 8),
                channels,
                flat: flat.length ? flat : undefined,
                ...(omitted ? { omitted } : {}),
            };
            if (!nets) result.sample.mode = "--sample all（已省略 GND 与恒值网）";
            if (!tEnd) {
                const lead = missingProps.length
                    ? `最可能是没写必填字段：${missingProps.map((m) => `${m.element}.${m.prop}`).join("、")}，先补上；`
                    : "";
                warn(result, `采样期间仿真时间没有推进：${lead}否则是电路不收敛，或布线把节点接错。`
                    + "建议换内置语料对照，或 --shot 看图。");
            }
            // 只给 --png 也要出图：栅格化本来就必须先生成 SVG，用户不关心中间文件。
            // （以前 png 嵌在 svg 分支里，只给 --png 时静默产出零个文件、exit 0。）
            if (o.svg || o.png) {
                // 缩窗：周期信号铺满整窗会糊成色块（240 Hz × 0.6 s = 144 个周期）。
                // 统计量仍按全窗口算，图只画最后 5 个周期，并在标题里说清楚。
                const fmax = Math.max(0, ...channels.map((r) => r.freqEstimate ?? 0));
                const t0 = Math.min(...channels.map((r) => r.t0 ?? 0));
                const cycles = fmax > 0 ? fmax * (tEnd - t0) : 0;
                let cropFrom = null;
                if (cycles > 12) cropFrom = tEnd - 5 / fmax;
                const pick = (pts) => (cropFrom == null ? pts : pts.filter((p) => p[0] >= cropFrom));
                const drawn = channels
                    .filter((r) => r.vpp > 0 || channels.length <= 4)
                    .slice(0, 6)
                    .map((r) => ({ label: `V(${r.net})`, unit: "V", points: pick(series.get(r.net)) }));
                const zoomNote = cropFrom == null
                    ? ""
                    : `（全窗口 ${cycles.toFixed(0)} 个周期太密，图中只画最后 5 个周期；统计量仍按全窗口）`;
                const svg = renderChannels({
                    title: `${sourceLabel(result.circuit.source)} · 时域波形${zoomNote}`,
                    xLabel: `t / s（${points} 点，确定性步进）`,
                    channels: drawn,
                });
                const f = path.join(outDir, "waveform.svg");
                fs.writeFileSync(f, svg, "utf8");
                result.sample.svg = f;
                addArtifact(result, "waveform-svg", f);
                if (o.png) {
                    const png = path.join(outDir, "waveform.png");
                    const r = rasterizeSvg(f, png, { scale: Number(o.scale ?? 2) || 2 });
                    if (r.ok) {
                        result.sample.png = png;
                        addArtifact(result, "waveform-png", png);
                    } else {
                        noteArtifactIssue(result, { requested: ["png"], reason: r.reason, fallback: f });
                    }
                }
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
            if (values.length < 2) throw new CliError("--sweep 至少两个值", "例：--sweep e6.frequency=10,100,1k,10k", { code: "usage.bad_sweep" });
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
                if (set.ok === false) throw new CliError(`扫描改参失败 ${s.prop}=${v}：${JSON.stringify(set).slice(0, 300)}`, undefined, { code: "param.unknown" });
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
            // 行、曲线、横轴统一按数值升序：以前 rows 保持输入顺序而图按升序画，
            // 读图的人会把 "40,20,10,5" 当横轴顺序，结论正好反了。
            rows.sort((a, b) => a.x - b.x);
            for (const pts of curves.values()) pts.sort((p, q) => p[0] - q[0]);
            const sorted = [...values].sort((a, b) => a - b);
            const lo = sorted[0];
            const hi = sorted[sorted.length - 1];
            result.sweep = {
                param: `${id}.${s.prop}`,
                values: sorted,
                xRange: lo === hi ? fmtEng(lo, propUnit(s.prop)) : `${fmtEng(lo, propUnit(s.prop))} – ${fmtEng(hi, propUnit(s.prop))}`,
                order: "升序（与图中横轴一致）",
                mode: useSample ? "vpp（峰峰值，含采样窗口统计）" : "瞬时值",
                rows,
            };
            // 只给 --png 也要出图（同波形分支：栅格化必须先有 SVG）
            if (o.svg || o.png) {
                const channels = [...curves.entries()].slice(0, 4).map(([net, pts]) => ({
                    label: `${useSample ? "Vpp" : "V"}(${net})`,
                    unit: "V",
                    points: pts,
                }));
                const svg = renderChannels({
                    // 标题只说范围，不复述顺序：顺序由横轴负责，两处写两套语义必然对不上
                    title: `参数扫描：${s.prop} ${result.sweep.xRange}（${sorted.length} 点）`,
                    xLabel: `${s.prop} / ${propUnit(s.prop) || "—"}${o.logx ? "（对数轴）" : ""}`,
                    channels,
                    logX: Boolean(o.logx),
                });
                const f = path.join(outDir, "sweep.svg");
                fs.writeFileSync(f, svg, "utf8");
                result.sweep.svg = f;
                addArtifact(result, "sweep-svg", f);
                if (o.png) {
                    const png = path.join(outDir, "sweep.png");
                    const r = rasterizeSvg(f, png, { scale: Number(o.scale ?? 2) || 2 });
                    if (r.ok) {
                        result.sweep.png = png;
                        addArtifact(result, "sweep-png", png);
                    } else {
                        noteArtifactIssue(result, { requested: ["png"], reason: r.reason, fallback: f });
                    }
                }
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
                addArtifact(result, "circuit-text", f);
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
            addArtifact(result, svg ? "schematic-svg" : "schematic-png", f);
        }

        return result;
    }
}

/**
 * --jobs：一次进程跑多个作业。
 *
 *   --jobs @jobs.json      从文件读（推荐：Windows 命令行引号很痛）
 *   --jobs '[{...}]'       内联 JSON
 *
 * 每个作业就是同一套 run 选项；没写的项从顶层继承（--circuit / --span / --svg / --png …）。
 * 依据是实测成本结构：后端挂载约 4.5 s 是**每次进程**的固定开销，作业本身只加 0.9 s 量级，
 * 所以「一个进程跑 N 个作业」远快于「N 次进程」。单个作业失败不拖垮整批。
 */
async function cmdRunJobs({ repo, outDir, o }) {
    const jobs = normalizeJobs(readIfFile(String(o.jobs)));
    if (!jobs.length) {
        throw new CliError("--jobs 里没有作业", '给一个 JSON 数组，例：[{"circuit":"lrc","sample":"all","svg":true}]', { code: "usage.bad_jobs" });
    }

    // 顶层选项作为默认值（jobs / out / base 之类不继承）
    const inherited = {};
    for (const [k, v] of Object.entries(o)) {
        if (k === "_" || k === "jobs" || k === "out" || k === "base" || k === "repo") continue;
        inherited[k] = v;
    }

    // 先把所有作业的电路来源解析一遍：哪个作业的语料名写错，启动浏览器之前就报出来
    const prepared = jobs.map((job, i) => {
        const jo = { ...inherited, ...job };
        const name = String(jo.name ?? `job${i + 1}`);
        delete jo.name;
        const jobOut = path.join(outDir, safeName(name));
        // 相对路径的产物落到该作业自己的子目录，免得多个作业的 lrc.png 互相覆盖
        for (const key of ["shot", "dump", "share-out"]) {
            if (typeof jo[key] === "string" && !path.isAbsolute(jo[key])) jo[key] = path.join(jobOut, jo[key]);
        }
        const { text, source } = readCircuitSource(repo, jo);
        return { name, jo, jobOut, text, source };
    });

    const { backend, toolset, base, via } = await attach({ repo, base: o.base, allowSpawn: o["no-spawn"] !== true, log });
    const out = { ok: true, backend: { base, via }, total: prepared.length, jobs: [] };
    try {
        for (const p of prepared) {
            fs.mkdirSync(p.jobOut, { recursive: true });
            const t0 = Date.now();
            try {
                const r = await executeJob({ toolset, repo, outDir: p.jobOut, o: p.jo, sourceText: p.text, source: p.source });
                out.jobs.push({ name: p.name, ok: true, ms: Date.now() - t0, outDir: p.jobOut, ...r });
            } catch (e) {
                const err = e instanceof CliError ? e : new CliError(String(e?.message ?? e));
                out.jobs.push({
                    name: p.name,
                    ok: false,
                    ms: Date.now() - t0,
                    outDir: p.jobOut,
                    error: { code: err.code ?? e?.code ?? "error", message: err.message, hint: err.hint ?? null, ...(err.details ? { details: err.details } : {}) },
                });
            }
        }
    } finally {
        try {
            await backend.dispose();
        } catch {
            /* 清理失败不该掩盖主流程结果 */
        }
    }

    const bad = out.jobs.filter((j) => j.ok === false);
    if (bad.length) {
        out.ok = false;
        out.error = {
            message: `${bad.length}/${out.jobs.length} 个作业失败：${bad.map((j) => j.name).join(", ")}`,
            hint: "逐条看 jobs[].error；其余作业的结果仍然有效",
        };
    }
    // 产物汇总到顶层：agent 一次拿全路径，不用进子目录翻
    const arts = out.jobs.flatMap((j) => (j.artifacts ?? []).map((a) => ({ job: j.name, ...a })));
    if (arts.length) out.artifacts = arts;
    return out;
}

/** 把 --jobs 的 JSON 归一成作业数组。 */
function normalizeJobs(raw) {
    let v;
    try {
        v = JSON.parse(raw);
    } catch (e) {
        throw new CliError(`--jobs 不是合法 JSON：${e.message}`, "建议写成文件再用 --jobs @jobs.json 传", { code: "usage.bad_jobs" });
    }
    const clean = (arr) => arr.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (Array.isArray(v)) return clean(v);
    if (v && Array.isArray(v.jobs)) return clean(v.jobs);
    if (v && typeof v === "object") return [v];
    return [];
}

/** 作业名 → 安全目录名。 */
function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "job";
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
        shell: process.platform === "win32", // npm 在 Windows 上是 .cmd
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
    const ref = String(o.ref ?? ENGINE_REF);
    const steps = [];
    let cloned = false;

    if (isEngineRepo(dir)) {
        steps.push({ step: "engine", status: "exists", dir, commit: engineCommit(dir), ref });
    } else {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
            throw new CliError(`${dir} 已存在且非空，但不是 ExtCircuitJS 仓库`, "换一个 --dir，或清理该目录后重试");
        }
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        if (/^[0-9a-f]{7,40}$/i.test(ref)) {
            // 裸 SHA：--branch 接不了，得先建仓库再按 SHA fetch
            runStep("git", ["init", "-q", dir], path.dirname(dir), `git init ${path.basename(dir)}`);
            runStep("git", ["-C", dir, "remote", "add", "origin", url], dir, `git remote add origin ${url}`);
            runStep("git", ["-C", dir, "fetch", "--depth", "1", "origin", ref], dir, `git fetch --depth 1 origin ${ref}`);
            runStep("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"], dir, `git checkout ${ref}`);
        } else {
            runStep("git", ["clone", "--depth", "1", "--branch", ref, url, dir], path.dirname(dir), `git clone --branch ${ref} ${url}`);
        }
        cloned = true;
        if (!isEngineRepo(dir)) throw new CliError("克隆完成但没找到 tools/ext.mjs", "确认 --url 指向 ExtCircuitJS 仓库根");
        steps.push({ step: "engine", status: "cloned", dir, url, ref, commit: engineCommit(dir) });
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

    // 引擎不把 playwright-core 写进依赖（只跑 Node 契约的人不需要它），但 MCP 桥必须有它。
    // --no-save：装进 node_modules 而不改动引擎的 package.json。
    const pwReady = hasPlaywrightCore(dir);
    if (!o["skip-install"] && !pwReady) {
        runStep("npm", ["install", "--no-save", "--no-audit", "--no-fund", "playwright-core"], dir, "安装 playwright-core（无头浏览器驱动）");
        steps.push({ step: "playwright-core", status: "ok" });
    } else {
        steps.push({ step: "playwright-core", status: pwReady ? "already" : "skipped" });
    }

    const hasDist = fs.existsSync(distHtml);
    const commit = engineCommit(dir);

    // 安装元数据：浅克隆只有一个 commit，事后想问"我这版引擎是什么时候的"就没法查了
    // （issue #9）。把日期写下来，probe 直接回显；真要 bisect 时也知道该 fetch 什么。
    const meta = {
        engine: "ExtCircuitJS",
        url,
        ref,
        commit,
        describe: engineDescribe(dir),
        commitDate: engineCommitDate(dir),
        builtAt: new Date().toISOString(),
        dist: hasDist,
    };
    try {
        fs.writeFileSync(path.join(dir, ENGINE_META_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");
    } catch {
        /* 写不进去不影响引擎可用 */
    }

    return {
        ok: true,
        engine: {
            dir,
            cloned,
            dist: hasDist ? path.join(dir, "dist") : null,
            url,
            ref,
            commit,
            commitDate: meta.commitDate,
            describe: meta.describe,
            builtAt: meta.builtAt,
            metaFile: path.join(dir, ENGINE_META_FILE),
        },
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
    const { repo, tried, incomplete } = resolveRepo(o.repo);
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
    // 目录在、内容不全的候选单独列出来：不然排查会一路往"我明明装过了"走
    if (incomplete?.length) out.incomplete = incomplete;
    if (repo) {
        out.capabilities = {
            dist: fs.existsSync(path.join(repo, "dist", "circuitjs.html")),
            playwrightCore: hasPlaywrightCore(repo),
        };
        // 引擎版本必须可见：README 里的数字只对钉住的那个版本保证可复现
        out.engine = {
            dir: repo,
            ref: ENGINE_REF,
            commit: engineCommit(repo),
            commitDate: engineCommitDate(repo),
            describe: engineDescribe(repo),
            builtAt: engineMeta(repo)?.builtAt ?? null,
        };
        if (out.engine.describe && !String(out.engine.describe).startsWith(ENGINE_REF)) {
            out.engine.note = `引擎不是钉住的 ${ENGINE_REF}（当前 ${out.engine.describe}）：数值可能与本 skill 文档里的实测值有差异。`;
        }
        if (!out.capabilities.playwrightCore) {
            out.hint = ["缺 playwright-core（无头浏览器驱动），补一次就好：", `  cd ${repo} && npm install --no-save playwright-core`];
        }
    }
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
        const how = SKILL_IN_NODE_MODULES
            ? "npx ee-circuit-draw-simulator setup"
            : "node <skill>/scripts/circuitlab.mjs setup";
        out.hint = [
            "还没装引擎（ExtCircuitJS）。一条命令搞定：",
            `  ${how}`,
            `引擎会装到：${defaultEngineDir()}`,
            `找过的位置：${tried.slice(0, 5).join(" / ")}`,
        ];
        // 半装状态要点名：目录在但内容不全，最容易让人以为"装过了"
        for (const half of incomplete ?? []) {
            out.hint.push(`注意：${half.dir} 目录存在，但缺少 ${half.missing.join(" / ")} —— 目录不完整，建议重跑 setup（或删掉它再装）`);
        }
    } else if (!out.ok && !out.hint) {
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
    if (!repo) throw new CliError("找不到 ExtCircuitJS 仓库", "先跑 setup，或用 --repo / EXTCIRCUIT_HOME 指定", { code: "engine.not_found" });
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
    if (!repo) throw new CliError("找不到 ExtCircuitJS 仓库", "先跑 setup，或用 --repo / EXTCIRCUIT_HOME 指定", { code: "engine.not_found" });
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
        if (!fs.existsSync(f)) throw new CliError(`内置语料里没有 ${name}`, "用 corpus --search <关键词> 找", { code: "circuit.not_in_corpus", details: { name } });
        return { ok: true, ...makeShare(repo, { circuit: name, shareOut }) };
    }
    throw new CliError("缺少电路来源", "--circuit / --text / --file / --netlist 之一", { code: "usage.missing_circuit" });
}

async function cmdShot(o) {
    const { repo } = resolveRepo(o.repo);
    if (!repo) throw new CliError("找不到 ExtCircuitJS 仓库", "先跑 setup，或用 --repo / EXTCIRCUIT_HOME 指定", { code: "engine.not_found" });
    // --shot 与 --out 都当目标文件（--out 是历史写法，兼容）
    const target = path.resolve(String(o.shot ?? o.out ?? "circuit.svg"));
    const svg = target.toLowerCase().endsWith(".svg");
    const { backend, toolset } = await attach({ repo, base: o.base, allowSpawn: o["no-spawn"] !== true, log });
    try {
        await loadCircuit(toolset, repo, o);
        const shot = await toolset.call("schematic.screenshot", { format: svg ? "svg" : "png" });
        if (shot.ok === false) throw new CliError(`截图失败：${JSON.stringify(shot)}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (svg) fs.writeFileSync(target, shot.data, "utf8");
        else fs.writeFileSync(target, Buffer.from(String(shot.data).replace(/^data:image\/png;base64,/, ""), "base64"));

        // 出图的同时顺手查拓扑：图照给，但短路要明说
        const comps = await toolset.call("circuit.list_components");
        const nl = await toolset.call("circuit.get_netlist");
        const elements = (comps.components ?? []).filter((c) => c.type !== "WireElm");
        const lint = lintTopology(elements, nl.netlist?.nets ?? []);
        const out = { ok: true, file: target, format: svg ? "svg" : "png", bytes: fs.statSync(target).size };
        if (lint.fatal.length) {
            out.topology = { fatal: lint.fatal };
            out.warning = `拓扑可疑：${lint.fatal.map((f) => f.message).join("；")} —— 这张图的仿真结果无意义。`;
            process.stderr.write(`[warn] ${out.warning}\n`);
        }
        return out;
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
            throw new CliError(`未知命令 ${cmd}`, "可用：setup / probe / corpus / run / share / shot", { code: "usage.unknown_command" });
    }
    emit(out);
    process.exit(out?.ok === false ? 2 : 0);
} catch (e) {
    // 错误对象统一带 code：调用方 switch(err.code) 就够了，不用读中文句子
    const known = e instanceof CliError || e?.name === "EngineError";
    const body = {
        code: known ? (e.code ?? "error") : "internal.error",
        message: String(e?.message ?? e),
        hint: known ? (e.hint ?? null) : (e?.stack ?? null),
    };
    if (known && e.details) body.details = e.details;
    if (known && e.suggestions) body.suggestions = e.suggestions;
    emit({ ok: false, error: body });
    process.exit(1);
}
