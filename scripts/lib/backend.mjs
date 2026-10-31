// 后端连接：定位引擎仓库 → 探活 → attach 到页面里的真实仿真引擎。
//
// 三条线（与 ExtCircuitJS wiki / SKILL-DELEGATION.md 一致）：
//   ① 本地 dev server（vite，5174）—— 热更新，开发时用
//   ② 本地静态产物（ext serve，8080）—— 只用 dist/，跑仿真首选（不需要 vite 常驻）
//   ③ 都没有 → CLI 自己拉起一个（--no-spawn 可关）：有 dist 就 serve，没有就 dev
//
// 为什么没有 GitHub Pages：backend 的探活用 http 模块，https base 直接抛
// ERR_INVALID_PROTOCOL；Pages 站点只用于「给人点开看」，不能驱动 AI 仿真。

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
export const SKILL_DIR = path.resolve(HERE, "../..");

/** 官方引擎仓库。setup 命令按它克隆；也可以 --url 换成自己的 fork。 */
export const ENGINE_URL = "https://github.com/blankwy/ExtCircuitJS.git";

/**
 * 钉住的引擎版本（commit SHA，不用 HEAD）。
 *
 * 为什么：README 承诺"每个数字都能复现"，而 clone HEAD 意味着任何人明天装到的引擎
 * 都可能和今天不同——数字对不上时无法解释。
 *
 * 这个 SHA = ExtCircuitJS origin/main @ 2026-10-30（v0.2.0 + 22 个提交），
 * 也是 README/references 里所有实测值的来源。换它就等于换引擎，
 * 换完必须重跑 \`node scripts/smoke.mjs\` 核对这些数字。
 */
export const ENGINE_REF = "bfebc8046ca3dff3c148bf6a97b412ca35b799db";

/** 读引擎的 tag/commit 描述（如 v0.2.0 / v0.2.0-3-gabc1234 / abc1234）。 */
export function engineDescribe(dir) {
    if (!dir) return null;
    try {
        const r = spawnSync("git", ["-C", dir, "describe", "--tags", "--always", "--dirty"], { encoding: "utf8", timeout: 8000 });
        return r.status === 0 ? String(r.stdout).trim() || null : null;
    } catch {
        return null;
    }
}

/** 读引擎当前 commit（短哈希）。不是 git 仓库就返回 null。 */
export function engineCommit(dir) {
    if (!dir) return null;
    try {
        const r = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 8000 });
        return r.status === 0 ? String(r.stdout).trim() || null : null;
    } catch {
        return null;
    }
}

/** 引擎 commit 的提交时间（ISO）。浅克隆也有，不用 --unshallow。 */
export function engineCommitDate(dir) {
    if (!dir) return null;
    try {
        const r = spawnSync("git", ["-C", dir, "log", "-1", "--format=%cI"], { encoding: "utf8", timeout: 8000 });
        return r.status === 0 ? String(r.stdout).trim() || null : null;
    } catch {
        return null;
    }
}

/** setup 写的安装元数据文件名（放在引擎目录里，git 未跟踪文件不会让 describe --dirty 变脏）。 */
export const ENGINE_META_FILE = ".ee-engine.json";

/** 读 setup 留下的安装元数据（没有就返回 null）。 */
export function engineMeta(dir) {
    if (!dir) return null;
    try {
        const f = path.join(dir, ENGINE_META_FILE);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    } catch {
        return null;
    }
}

/**
 * 技能目录是不是躺在某个 node_modules 里（npx / -g / 装成依赖）。
 * 那种位置的目录会被升级、`npm cache clean`、临时安装目录回收抹掉。
 */
export const SKILL_IN_NODE_MODULES = /[\\/](node_modules|_npx)[\\/]/.test(`${SKILL_DIR}${path.sep}`);

/** 技能自带引擎的落点（.gitignore 掉，不进本仓库）。 */
export function defaultEngineDir() {
    if (process.env.EE_CIRCUIT_ENGINE_DIR) return process.env.EE_CIRCUIT_ENGINE_DIR;
    // 从 npm 装着跑（npx 最典型）时，包目录是临时/可回收的：引擎放到用户目录，
    // 否则换一次版本就得重下一份引擎、重构建两分钟。
    return SKILL_IN_NODE_MODULES
        ? path.join(os.homedir(), ".ee-circuit", "ExtCircuitJS")
        : path.join(SKILL_DIR, "vendor", "ExtCircuitJS");
}

/** 判断一个目录是不是 ExtCircuitJS 仓库根。 */
export function isEngineRepo(dir) {
    return Boolean(
        dir &&
            fs.existsSync(path.join(dir, "tools", "ext.mjs")) &&
            fs.existsSync(path.join(dir, "packages", "mcp", "src", "backend.ts")),
    );
}

/**
 * 目录存在、但不像一个完整的引擎 —— 返回缺什么。
 *
 * 为什么不能只看"目录存在"：上次 setup 中断留下的空目录会被当成"我明明装过了"，
 * 排查时一路走偏（issue #7）。判据必须是内容，不是存在性。
 */
export function engineIncomplete(dir) {
    if (!dir || !fs.existsSync(dir)) return null;
    let st = null;
    try {
        st = fs.statSync(dir);
    } catch {
        return null;
    }
    if (!st.isDirectory()) return null;
    const missing = [];
    if (!fs.existsSync(path.join(dir, "tools", "ext.mjs"))) missing.push("tools/ext.mjs");
    if (!fs.existsSync(path.join(dir, "packages", "mcp", "src", "backend.ts"))) missing.push("packages/mcp/src/backend.ts");
    return missing.length ? { dir, missing } : null;
}

/**
 * 引擎的 MCP 桥必须有 playwright-core，但引擎故意不把它写进依赖。
 * 与 backend.ts 的 resolvePwCore 保持同一套查找位置：仓库根 / core/ts / EXT_PW_CORE。
 */
export function hasPlaywrightCore(repo) {
    if (!repo) return false;
    if (process.env.EXT_PW_CORE && fs.existsSync(process.env.EXT_PW_CORE)) return true;
    for (const dir of [repo, path.join(repo, "core", "ts")]) {
        for (const f of ["index.js", "index.mjs"]) {
            if (fs.existsSync(path.join(dir, "node_modules", "playwright-core", f))) return true;
        }
    }
    return false;
}

/** 路径名看着像引擎目录（用来区分"本想装引擎的地方"和无关的上级目录）。 */
function looksLikeEngineDir(dir) {
    return /extcircuitjs|circuitjs/i.test(path.basename(dir));
}

/** 仓库根：显式参数 → 环境变量 → 随技能克隆的 vendor/ → 同级目录 → HOME → cwd。 */
export function resolveRepo(explicit) {
    const tried = [];
    const incomplete = [];
    const cands = [
        explicit,
        process.env.EXTCIRCUIT_HOME,
        process.env.EXT_REPO,
        defaultEngineDir(),
        path.resolve(SKILL_DIR, "../ExtCircuitJS"),
        path.resolve(SKILL_DIR, ".."),
        path.join(os.homedir(), ".ee-circuit", "ExtCircuitJS"),
        path.resolve(process.cwd(), "ExtCircuitJS"),
        process.cwd(),
    ].filter(Boolean);

    // 明确指向的位置（--repo / 环境变量 / 默认安装点）用户一定是想装引擎的，
    // 哪怕目录名不像，也要做完整性检查；其余候选只在名字像引擎时才检查。
    const intentional = new Set(
        [explicit, process.env.EXTCIRCUIT_HOME, process.env.EXT_REPO, defaultEngineDir()].filter(Boolean).map((p) => path.resolve(p)),
    );

    for (const c of cands) {
        const dir = path.resolve(c);
        tried.push(dir);
        if (isEngineRepo(dir)) return { repo: dir, tried, incomplete };
        // 目录在、但内容不全：记下来，报错时点名，别让用户以为"装过了"
        const half = intentional.has(dir) || looksLikeEngineDir(dir) ? engineIncomplete(dir) : null;
        if (half && !incomplete.some((x) => x.dir === half.dir)) incomplete.push(half);
    }
    return { repo: null, tried, incomplete };
}

export function defaultBases() {
    const out = [];
    if (process.env.EXC_BASE) out.push(process.env.EXC_BASE);
    out.push("http://127.0.0.1:5174", "http://127.0.0.1:8080", "http://127.0.0.1:8081");
    return [...new Set(out)];
}

/**
 * 带 code 的引擎错误。上层按 code 分支，不靠匹配中文句子。
 *
 * 为什么必须结构化：调用方是模型，它按 `code` 走分支是稳定的，字符串匹配改一个标点就失效。
 */
export class EngineError extends Error {
    constructor(message, { code = "engine.error", hint = null, details = null } = {}) {
        super(message);
        this.name = "EngineError";
        this.code = code;
        this.hint = hint;
        this.details = details;
    }
}

/**
 * 探一个地址：是引擎 / 是别人的服务 / 没人应答。
 *
 * 三种状态必须分开 —— 只判 `r.ok` 会把"端口被别的程序占着（返回 404）"当成"不可达"，
 * 于是去那个端口起服务，白等到超时还不说真因（issue #1）。
 */
async function probeBase(base, timeoutMs = 2500) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${base.replace(/\/$/, "")}/circuitjs.html`, { signal: ctl.signal, redirect: "follow" });
        return r.ok ? "engine" : "stranger";
    } catch {
        return "closed";
    } finally {
        clearTimeout(timer);
    }
}

async function reachable(base, timeoutMs = 2500) {
    return (await probeBase(base, timeoutMs)) === "engine";
}

/** 这个端口现在能绑吗？抢不到就别往那儿起服务，省掉 45 秒白等。 */
function canBind(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const srv = net.createServer();
        const done = (ok) => {
            srv.removeAllListeners();
            try {
                srv.close();
            } catch {
                /* ignore */
            }
            resolve(ok);
        };
        srv.once("error", () => done(false));
        srv.once("listening", () => done(true));
        try {
            srv.listen({ port, host, exclusive: true });
        } catch {
            done(false);
        }
    });
}

/** 只探活，不 attach（快，不启浏览器）。 */
export async function probe({ bases = defaultBases(), timeoutMs = 2500 } = {}) {
    const results = [];
    for (const base of bases) {
        const state = await probeBase(base, timeoutMs);
        results.push({ base, reachable: state === "engine", state });
    }
    return results;
}

// ── 自己拉起后端 ────────────────────────────────────────────────────────────
// 只托管自己启动的进程：退出时一并收掉，避免留下孤儿服务。

const spawned = [];

function portOf(base) {
    try {
        const u = new URL(base);
        if (u.port) return Number(u.port);
    } catch {
        /* ignore */
    }
    return 8080;
}

function startServer(repo, mode, port) {
    const args = [path.join(repo, "tools", "ext.mjs"), mode, "--port", String(port)];
    const child = spawn(process.execPath, args, {
        cwd: repo,
        // 必须接住管道：子进程的 stderr 里就有 EADDRINUSE 这种真因，忽略掉就只能猜
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, BROWSER: "none" },
    });
    let stderr = "";
    child.stdout?.resume();
    child.stderr?.on("data", (b) => {
        stderr = (stderr + b.toString()).slice(-4000); // 只留尾巴，够定位
    });
    child.on("error", () => {});
    const rec = { child, mode, port, stderr: () => stderr.trim() };
    spawned.push(rec);
    return rec;
}

/** 收掉本进程启动的所有后端（幂等）。 */
export function shutdownSpawned() {
    while (spawned.length) {
        const { child } = spawned.pop();
        try {
            if (process.platform === "win32") {
                spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            } else {
                child.kill("SIGTERM");
            }
        } catch {
            /* ignore */
        }
    }
}

process.on("exit", shutdownSpawned);

/**
 * 等后端起来。子进程一旦退出就立刻返回，不再把剩下的超时等满。
 * （以前端口被占时 EADDRINUSE 之后还要干等 45 秒，见 issue #1）
 */
async function waitFor(base, { timeoutMs = 45000, intervalMs = 400, child = null } = {}) {
    let exit = null;
    child?.once("exit", (code, signal) => {
        exit = { code, signal };
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (exit) return { ok: false, reason: "exited", exit };
        if (await reachable(base, 1200)) return { ok: true };
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, reason: "timeout" };
}

let backendModule = null;
async function loadBackendModule(repo) {
    if (backendModule) return backendModule;
    register(pathToFileURL(path.join(repo, "tests", "contract", "helpers", "ts-resolve.mjs")).href);
    backendModule = await import(pathToFileURL(path.join(repo, "packages", "mcp", "src", "backend.ts")).href);
    return backendModule;
}

/**
 * attach 到真实引擎。返回 { backend, toolset, base, via }。
 * 失败一律抛带修复建议的 Error（脚本层统一转成 {ok:false}）。
 */
export async function attach({ repo, base, allowSpawn = true, timeoutMs = 60000, log = () => {} } = {}) {
    if (!repo) {
        throw new EngineError("找不到 ExtCircuitJS 引擎仓库：先跑 `circuitlab.mjs setup`，或设置 EXTCIRCUIT_HOME 指向仓库根，或用 --repo 指定", {
            code: "engine.not_found",
            hint: "npx ee-circuit-draw-simulator setup（或 node <skill>/scripts/circuitlab.mjs setup）",
        });
    }
    const { startAttachBackend } = await loadBackendModule(repo);

    const bases = base ? [base] : defaultBases();
    let chosen = null;
    const seen = [];
    const occupied = [];
    for (const b of bases) {
        const state = await probeBase(b);
        seen.push(`${b} ${state === "engine" ? "✓" : state === "stranger" ? "⚠ 被别的程序占用" : "✗"}`);
        if (state === "engine") {
            chosen = b;
            break;
        }
        if (state === "stranger") occupied.push(b);
    }

    const opts = { timeoutMs, log };
    if (chosen) {
        // 已经有人在服务：不碰 dev server（off = 连不上就报错，不会偷偷拉起）
        const backend = await startAttachBackend({ ...opts, baseUrl: chosen, devServer: "off" });
        return { backend, toolset: backend.toolset, base: chosen, via: backend.info?.bridgeVia ?? "attached" };
    }
    if (!allowSpawn) {
        throw new EngineError(
            `没有可达的后端（试过 ${seen.join(" / ")}）。先起一个：\n  cd ${repo} && node tools/ext.mjs serve --port 8080\n（还没构建过就先 node tools/ext.mjs build）`,
            { code: "engine.unreachable", details: { candidates: seen, occupied } },
        );
    }

    // 有 dist 就走静态 serve（不依赖 vite 常驻）；没有 dist 只能 dev（需要 core install）
    const hasDist = fs.existsSync(path.join(repo, "dist", "circuitjs.html"));
    const mode = hasDist ? "serve" : "dev";
    // 以前这里硬编码 8080：默认候选列表明明有三个端口，自启却只认那个最容易被占的。
    const candidates = base ? [portOf(base)] : hasDist ? [8080, 8081, 8090, 18734] : [5174, 5175, 5180, 18735];

    const portTried = [];
    let port = null;
    for (const p of candidates) {
        if (!(await canBind(p))) {
            portTried.push(`:${p} 已被占用`);
            continue;
        }
        port = p;
        break;
    }
    if (occupied.length) {
        log(`${occupied.join(" / ")} 上有别的程序（/circuitjs.html 返回的不是引擎页面），跳过。`);
    }
    if (port == null) {
        throw new EngineError(
            `没有可用端口：${portTried.join("、")}。端口都被别的程序占着，引擎起不来。`,
            {
                code: "port.occupied",
                hint: "先腾一个端口，或用 --base http://127.0.0.1:<端口> 指定一个空端口；也可以手动起后端再 --no-spawn 连它",
                details: { tried: portTried, occupiedByOthers: occupied },
            },
        );
    }
    log(`没有可达后端（${seen.join(" / ")}），拉起 ${mode}（:${port}）…`);

    const server = startServer(repo, mode, port);
    const target = `http://127.0.0.1:${port}`;
    const waited = await waitFor(target, { child: server.child });
    if (!waited.ok) {
        const why = waited.reason === "exited"
            ? `进程退出了（exit ${waited.exit.code ?? "?"}）`
            : `等了 ${Math.round(timeoutMs / 1000)} 秒没起来`;
        const tail = server.stderr();
        const looksInUse = /EADDRINUSE|address already in use/i.test(tail);
        throw new EngineError(
            `自启后端失败（:${port}，${why}）。${looksInUse ? "端口确实被占用了。" : ""}`,
            {
                code: looksInUse ? "port.occupied" : "engine.unreachable",
                hint: `手动跑一遍看完整报错：\n  cd ${repo} && node tools/ext.mjs ${mode} --port ${port}`
                    + (hasDist ? "" : "\n没构建过就先 node tools/ext.mjs core install && node tools/ext.mjs build"),
                details: { port, reason: waited.reason, exit: waited.exit ?? null, stderr: tail || null, candidates: seen },
            },
        );
    }
    const backend = await startAttachBackend({ ...opts, baseUrl: target, devServer: "off" });
    return { backend, toolset: backend.toolset, base: target, via: "spawned" };
}

/** 取当前电路文本（core 格式），需要活会话。 */
export async function dumpCircuitText(toolset) {
    if (toolset.sessionId == null) await toolset.openSession();
    const r = await toolset.bridge.request("export", {
        sessionId: toolset.sessionId,
        params: { format: "xml" },
        timeoutMs: 30000,
    });
    if (!r?.ok) throw new Error(`导出电路失败：${JSON.stringify(r)}`);
    return r.payload;
}
