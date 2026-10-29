// 波形 / 扫描曲线 → 内联 SVG（不依赖浏览器、不依赖 matplotlib）。
//
// 设计取舍：
//   · 透明背景 + 中性灰网格 + 高饱和线条 —— 深色与浅色主题下都能读
//   · 按单位分组分面：V 与 A 不同量纲，叠一张图会互相压平
//   · 坐标轴刻度用"好看的数字"（1/2/5×10^n），不直接取极值
//   · 输出纯 <svg> 片段，可直接贴进 markdown / HTML

const PALETTE = ["#2563eb", "#ea580c", "#059669", "#7c3aed", "#db2777", "#0891b2"];
const GRID = "#94a3b8";
const TEXT = "#64748b";
const AXIS = "#94a3b8";

function niceTicks(lo, hi, count = 4) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [];
    const span = hi - lo;
    const rough = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const start = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
    out.step = step;
    return out;
}

/** 刻度文本：小数位跟着刻度间隔走，避免 0.005/0.01/0.015 被压成三个 "0.01"。 */
function tickLabel(v, step) {
    const abs = Math.abs(v);
    if (abs === 0) return "0";
    if (abs >= 1e5 || abs < 1e-4) {
        const exp = Math.floor(Math.log10(abs));
        const mant = v / Math.pow(10, exp);
        const m = Math.abs(mant - 1) < 1e-9 ? "" : mant.toFixed(1).replace(/\.0$/, "");
        return `${m}e${exp}`;
    }
    const s = Number.isFinite(step) && step > 0 ? step : abs / 5;
    const dec = Math.max(0, Math.min(5, -Math.floor(Math.log10(s) + 1e-9)));
    // 保留固定小数位，避免同一轴上出现 "0.79 / 0.795 / 0.8" 这种不齐的标签
    return dec > 0 ? v.toFixed(dec) : String(Math.round(v));
}

/**
 * 画一条或多条曲线（按单位分面）。
 * @param {object} opt
 * @param {string} opt.title
 * @param {string} opt.xLabel
 * @param {Array<{label:string, unit:string, points:Array<[number,number]>}>} opt.channels
 * @param {number} [opt.width]
 * @param {boolean} [opt.logX]
 * @param {boolean} [opt.zeroLine] 画 y=0 参考线
 */
export function renderChannels({ title = "", xLabel = "", channels = [], width = 680, logX = false, zeroLine = true }) {
    const valid = channels.filter((c) => (c.points ?? []).length > 0);
    if (valid.length === 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 60" width="${width}" height="60">
  <text x="16" y="34" font-size="13" fill="${TEXT}">（无波形数据）</text>
</svg>`;
    }

    // 按单位分组
    const groups = new Map();
    for (const c of valid) {
        const u = c.unit || "";
        if (!groups.has(u)) groups.set(u, []);
        groups.get(u).push(c);
    }

    const pad = { l: 62, r: 16, t: title ? 30 : 12, b: 40 };
    const panelH = 170;
    const legendH = 22;
    const panelCount = groups.size;
    const height = pad.t + panelCount * (panelH + legendH + 22) + pad.b;
    const innerW = width - pad.l - pad.r;

    const allX = valid.flatMap((c) => c.points.map((p) => p[0]));
    let x0 = Math.min(...allX);
    let x1 = Math.max(...allX);
    if (x0 === x1) {
        x0 -= 1;
        x1 += 1;
    }
    const tx = (v) => {
        if (!logX) return pad.l + ((v - x0) / (x1 - x0)) * innerW;
        const a = Math.log10(Math.max(x0, 1e-30));
        const b = Math.log10(Math.max(x1, 1e-30));
        const t = (Math.log10(Math.max(v, 1e-30)) - a) / (b - a || 1);
        return pad.l + t * innerW;
    };

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">`);
    parts.push(`<rect width="${width}" height="${height}" fill="none"/>`);
    if (title) {
        parts.push(`<text x="${pad.l}" y="20" font-size="13" font-weight="600" fill="${TEXT}">${esc(title)}</text>`);
    }

    let idx = 0;
    for (const [unit, chans] of groups) {
        const top = pad.t + idx * (panelH + legendH + 22);
        const yBottom = top + panelH;
        const ys = chans.flatMap((c) => c.points.map((p) => p[1])).filter((v) => Number.isFinite(v));
        let lo = Math.min(...ys);
        let hi = Math.max(...ys);
        if (lo === hi) {
            lo -= 1;
            hi += 1;
        }
        const padY = (hi - lo) * 0.08;
        lo -= padY;
        hi += padY;
        const ty = (v) => yBottom - ((v - lo) / (hi - lo)) * panelH;

        // 网格 + y 轴刻度
        const yticks = niceTicks(lo, hi);
        for (const tv of yticks) {
            const y = ty(tv);
            parts.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-opacity="0.28" stroke-width="1"/>`);
            parts.push(`<text x="${pad.l - 8}" y="${(y + 3.5).toFixed(1)}" font-size="10" fill="${TEXT}" text-anchor="end">${tickLabel(tv, yticks.step)}</text>`);
        }
        if (zeroLine && lo < 0 && hi > 0) {
            const y = ty(0);
            parts.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" stroke="${AXIS}" stroke-opacity="0.6" stroke-width="1" stroke-dasharray="3 3"/>`);
        }
        // x 轴刻度
        const xticks = logX ? logTicks(x0, x1) : niceTicks(x0, x1, 5);
        const isLog = logX;
        for (const tv of xticks) {
            const x = tx(tv);
            if (x < pad.l - 0.5 || x > width - pad.r + 0.5) continue;
            parts.push(`<line x1="${x.toFixed(1)}" y1="${yBottom}" x2="${x.toFixed(1)}" y2="${yBottom + 4}" stroke="${AXIS}" stroke-opacity="0.7"/>`);
            const label = isLog ? tickLabel(tv, tv) : tickLabel(tv, xticks.step);
            parts.push(`<text x="${x.toFixed(1)}" y="${yBottom + 17}" font-size="10" fill="${TEXT}" text-anchor="middle">${label}</text>`);
        }
        // 轴线
        parts.push(`<line x1="${pad.l}" y1="${yBottom}" x2="${width - pad.r}" y2="${yBottom}" stroke="${AXIS}" stroke-opacity="0.7" stroke-width="1"/>`);
        // 单位标（多面时才有意义；单面时图例里已带单位）
        if (unit && panelCount > 1) {
            parts.push(`<text x="${width - pad.r}" y="${top - 5}" font-size="10" fill="${TEXT}" text-anchor="end">${esc(unit)}</text>`);
        }

        // 曲线
        let ci = 0;
        for (const c of chans) {
            const color = c.color ?? PALETTE[(idx + ci) % PALETTE.length];
            const d = c.points
                .map((p, i) => `${i === 0 ? "M" : "L"}${tx(p[0]).toFixed(1)},${ty(p[1]).toFixed(1)}`)
                .join(" ");
            const smooth = c.points.length > 400 ? ' stroke-width="1.1"' : ' stroke-width="1.7"';
            parts.push(`<path d="${d}" fill="none" stroke="${color}"${smooth} stroke-linejoin="round" stroke-linecap="round"/>`);
            // 图例
            const lx = pad.l + ci * 150;
            const ly = yBottom + 32;
            parts.push(`<line x1="${lx}" y1="${ly - 3}" x2="${lx + 14}" y2="${ly - 3}" stroke="${color}" stroke-width="2.4"/>`);
            parts.push(`<text x="${lx + 19}" y="${ly}" font-size="10.5" fill="${TEXT}">${esc(c.label)}</text>`);
            ci++;
        }
        idx++;
    }

    // x 轴标题
    if (xLabel) {
        parts.push(`<text x="${width - pad.r}" y="${height - 6}" font-size="10" fill="${TEXT}" text-anchor="end">${esc(xLabel)}</text>`);
    }
    parts.push("</svg>");
    return parts.join("\n");
}

function logTicks(a, b) {
    const out = [];
    const lo = Math.floor(Math.log10(Math.max(a, 1e-30)));
    const hi = Math.ceil(Math.log10(Math.max(b, 1e-30)));
    for (let e = lo; e <= hi; e++) {
        for (const m of [1, 2, 5]) {
            const v = m * Math.pow(10, e);
            if (v >= a * 0.999 && v <= b * 1.001) out.push(Number(v.toPrecision(6)));
        }
    }
    return out;
}

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
