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
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
export const SKILL_DIR = path.resolve(HERE, "../..");

/** 官方引擎仓库。setup 命令按它克隆；也可以 --url 换成自己的 fork。 */
export const ENGINE_URL = "https://github.com/blankwy/ExtCircuitJS.git";

/** 技能自带引擎的落点（.gitignore 掉，不进本仓库）。 */
export function defaultEngineDir() {
    return process.env.EE_CIRCUIT_ENGINE_DIR || path.join(SKILL_DIR, "vendor", "ExtCircuitJS");
}

/** 判断一个目录是不是 ExtCircuitJS 仓库根。 */
export function isEngineRepo(dir) {
    return Boolean(
        dir &&
            fs.existsSync(path.join(dir, "tools", "ext.mjs")) &&
            fs.existsSync(path.join(dir, "packages", "mcp", "src", "backend.ts")),
    );
}

/** 仓库根：显式参数 → 环境变量 → 随技能克隆的 vendor/ → 同级目录 → HOME → cwd。 */
export function resolveRepo(explicit) {
    const tried = [];
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

    for (const c of cands) {
        const dir = path.resolve(c);
        tried.push(dir);
        if (isEngineRepo(dir)) return { repo: dir, tried };
    }
    return { repo: null, tried };
}

export function defaultBases() {
    const out = [];
    if (process.env.EXC_BASE) out.push(process.env.EXC_BASE);
    out.push("http://127.0.0.1:5174", "http://127.0.0.1:8080", "http://127.0.0.1:8081");
    return [...new Set(out)];
}

async function reachable(base, timeoutMs = 2500) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${base.replace(/\/$/, "")}/circuitjs.html`, { signal: ctl.signal, redirect: "follow" });
        return r.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** 只探活，不 attach（快，不启浏览器）。 */
export async function probe({ bases = defaultBases(), timeoutMs = 2500 } = {}) {
    const results = [];
    for (const base of bases) {
        const ok = await reachable(base, timeoutMs);
        results.push({ base, reachable: ok });
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
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, BROWSER: "none" },
    });
    child.on("error", () => {});
    spawned.push({ child, mode, port });
    return child;
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

async function waitFor(base, { timeoutMs = 45000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await reachable(base, 1200)) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
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
        throw new Error(
            "找不到 ExtCircuitJS 引擎仓库：先跑 `circuitlab.mjs setup`，或设置 EXTCIRCUIT_HOME 指向仓库根，或用 --repo 指定",
        );
    }
    const { startAttachBackend } = await loadBackendModule(repo);

    const bases = base ? [base] : defaultBases();
    let chosen = null;
    const seen = [];
    for (const b of bases) {
        const ok = await reachable(b);
        seen.push(`${b}${ok ? " ✓" : " ✗"}`);
        if (ok) {
            chosen = b;
            break;
        }
    }

    const opts = { timeoutMs, log };
    if (chosen) {
        // 已经有人在服务：不碰 dev server（off = 连不上就报错，不会偷偷拉起）
        const backend = await startAttachBackend({ ...opts, baseUrl: chosen, devServer: "off" });
        return { backend, toolset: backend.toolset, base: chosen, via: backend.info?.bridgeVia ?? "attached" };
    }
    if (!allowSpawn) {
        throw new Error(
            `没有可达的后端（试过 ${seen.join(" / ")}）。先起一个：\n  cd ${repo} && node tools/ext.mjs serve --port 8080\n（还没构建过就先 node tools/ext.mjs build）`,
        );
    }

    // 有 dist 就走静态 serve（不依赖 vite 常驻）；没有 dist 只能 dev（需要 core install）
    const hasDist = fs.existsSync(path.join(repo, "dist", "circuitjs.html"));
    const target = base ?? (hasDist ? "http://127.0.0.1:8080" : "http://127.0.0.1:5174");
    const port = portOf(target);
    log(`没有可达后端（${seen.join(" / ")}），拉起 ${hasDist ? "serve" : "dev"}（:${port}）…`);

    startServer(repo, hasDist ? "serve" : "dev", port);
    if (!(await waitFor(target))) {
        throw new Error(
            `自启后端失败（:${port} 起不来）。手动跑一遍看报错：\n  cd ${repo} && node tools/ext.mjs ${hasDist ? "serve" : "dev"} --port ${port}\n`
                + (hasDist ? "" : "没构建过就先 node tools/ext.mjs core install && node tools/ext.mjs build"),
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
