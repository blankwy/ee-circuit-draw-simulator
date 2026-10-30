#!/usr/bin/env node
// Repo hygiene checks that do not need the simulator engine.
// 1) SKILL.md frontmatter is valid for Claude Code / Codex CLI / dsh
// 2) every referenced file exists
// 3) CLI files parse

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const errors = [];

function fail(msg) {
    errors.push(msg);
}

// ── SKILL.md frontmatter ────────────────────────────────────────────────────
const skillPath = path.join(root, "SKILL.md");
const raw = fs.readFileSync(skillPath, "utf8");
const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
if (!m) {
    fail("SKILL.md: missing YAML frontmatter block");
} else {
    const fm = m[1];
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm.match(/^description:\s*"([\s\S]*?)"\s*$/m)?.[1] ?? fm.match(/^description:\s*([^\n]+)$/m)?.[1];

    if (!name) fail("SKILL.md: missing name");
    else {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail(`SKILL.md: name "${name}" is not kebab-case`);
        if (name !== "ee-circuit-draw-simulator") fail(`SKILL.md: name should be ee-circuit-draw-simulator, got ${name}`);
        if (name.length > 100) fail("SKILL.md: name longer than 100 characters");
    }

    if (!desc) fail("SKILL.md: missing description");
    else {
        // Codex hard-caps at 500 characters; dsh truncates the rendered catalogue at 500.
        if (desc.length > 500) fail(`SKILL.md: description is ${desc.length} chars, cap is 500`);
        if (desc.length < 40) fail("SKILL.md: description too short to route on");
    }
}

// ── referenced files exist ──────────────────────────────────────────────────
const docs = ["SKILL.md", "AGENTS.md", "README.md", "README.zh-CN.md"];
for (const doc of docs) {
    const text = fs.readFileSync(path.join(root, doc), "utf8");
    for (const hit of text.matchAll(/`(references\/[A-Za-z0-9._/-]+|scripts\/[A-Za-z0-9._/-]+)`/g)) {
        const rel = hit[1];
        if (!fs.existsSync(path.join(root, rel))) fail(`${doc}: refers to missing ${rel}`);
    }
}

// ── CLI parses ─────────────────────────────────────────────────────────────
for (const rel of ["scripts/circuitlab.mjs", "scripts/lib/backend.mjs", "scripts/lib/svg.mjs", "scripts/lib/units.mjs", "scripts/smoke.mjs"]) {
    try {
        execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
    } catch (e) {
        fail(`${rel}: ${String(e.stderr ?? e.message).slice(0, 400)}`);
    }
}

if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
}
console.log("✓ skill metadata, links and syntax look good");
