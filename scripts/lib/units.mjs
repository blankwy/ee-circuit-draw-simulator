// 工程单位解析与格式化：让模型能写 --set e1.resistance=4.7k，而不是 4700。
//
// 解析规则（大小写敏感，电子学惯例）：
//   1k = 1e3   1M = 1e6   1G = 1e9
//   1m = 1e-3  1u = 1e-6  1n = 1e-9  1p = 1e-12
// 也接受 "4.7kΩ" / "100 nF" / "1e-7" 这类带单位或科学计数法写法（尾部字母单位忽略）。

const SCALE = {
    G: 1e9,
    M: 1e6,
    k: 1e3,
    K: 1e3,
    m: 1e-3,
    u: 1e-6,
    U: 1e-6,
    n: 1e-9,
    p: 1e-12,
};

/** 把 "4.7k" / "100nF" / "1e-7" / 4700 解析成数字；解析不出返回 null。 */
export function parseValue(raw) {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (raw == null) return null;
    let s = String(raw).trim().replace(/\s+/g, "");
    if (s === "") return null;

    // 去掉尾部单位（Ω / F / H / V / A / s / Hz / ohm / farad …）
    s = s.replace(/(ohms?|Ω|Ωs?|F|H|V|A|s|Hz|%|deg)$/i, "");
    // 纯数字（含科学计数法）
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
    // 数字 + 单个倍率字母（可再跟数字，如 4k7）
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([GMkKmunp])(\d*)$/.exec(s);
    if (m) {
        const base = Number(m[1]);
        const mult = SCALE[m[2]] ?? 1;
        const tail = m[3] ? Number(`0.${m[3]}`) : 0; // 4k7 = 4.7k
        return (base + (m[1].includes(".") ? 0 : tail)) * mult;
    }
    return null;
}

const PREFIX = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
];

/** 3 位有效数字 + 工程前缀，如 4700 → "4.70k"，0.000015 → "15.0µ"。 */
export function fmtEng(v, unit = "") {
    if (v == null || !Number.isFinite(v)) return "—";
    if (v === 0) return `0${unit ? " " + unit : ""}`;
    const abs = Math.abs(v);
    if (abs >= 1e12 || abs < 1e-15) return `${v.toExponential(2)}${unit ? " " + unit : ""}`;
    let [scale, prefix] = PREFIX.find(([s]) => abs >= s) ?? [1e-12, "p"];
    let scaled = v / scale;
    if (Math.abs(scaled) >= 1000) {
        const i = PREFIX.findIndex(([s]) => s === scale);
        if (i > 0) {
            scale = PREFIX[i - 1][0];
            prefix = PREFIX[i - 1][1];
            scaled = v / scale;
        }
    }
    const digits = Math.abs(scaled) >= 100 ? 1 : Math.abs(scaled) >= 10 ? 2 : 3;
    const text = scaled.toFixed(digits).replace(/\.?0+$/, "");
    return `${text}${prefix}${unit ? " " + unit : ""}`;
}

/** 紧凑数字：用于 JSON 里的读数（不加前缀，只控位数）。 */
export function round(v, sig = 6) {
    if (v == null || !Number.isFinite(v)) return v;
    if (v === 0) return 0;
    const abs = Math.abs(v);
    if (abs >= 1e6 || abs < 1e-4) return Number(v.toExponential(3));
    return Number(v.toPrecision(sig));
}
