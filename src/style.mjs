import fs from "node:fs";

/**
 * Machine-readable settings live in one fenced block inside analysis/style.md:
 *
 *   ```json vg-style
 *   { "captions": { "maxWords": 3 } }
 *   ```
 *
 * Anything left out falls back to these defaults.
 */
export const DEFAULT_STYLE = {
  background: "#000000",
  fonts: {},
  captions: {
    enabled: true,
    maxWords: 3,
    maxChars: 18,
    case: "upper",
    font: "Inter",
    weight: 900,
    size: "auto",
    color: "#FFFFFF",
    activeColor: "#FFD23F",
    highlight: "color",
    boxColor: "#FF5A36",
    stroke: "#000000",
    strokeWidth: 10,
    position: "auto",
    entry: "popIn",
    exit: "cut",
    skipFillers: true,
  },
  text: {
    font: "Inter",
    weight: 900,
    color: "#FFFFFF",
    accent: "#FF5A36",
    accent2: "#FFD23F",
    entry: "slamUp",
    exit: "liftOut",
  },
  broll: { entry: "cut", exit: "cut" },
  cuts: { framing: "none", punchScale: 1.12 },
  music: { volume: 0.6, duck: 0.3 },
};

function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function readStyle(file) {
  if (!fs.existsSync(file)) return { style: structuredClone(DEFAULT_STYLE), found: false };
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/```(?:json)?\s*vg-style\s*\n([\s\S]*?)```/);
  if (!m) return { style: structuredClone(DEFAULT_STYLE), found: false };
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`The vg-style block in ${file} is not valid JSON: ${e.message}`);
  }
  return { style: merge(DEFAULT_STYLE, parsed), found: true };
}

/** Canvas size for a format setting; "source" keeps the main footage's ratio. */
export function canvasFor(format, source) {
  const f = String(format || "source").toLowerCase().replace(/\s+/g, "");
  const fixed = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350], "4:3": [1440, 1080] };
  if (fixed[f]) return { width: fixed[f][0], height: fixed[f][1], format: f };
  if (!source?.width) return { width: 1920, height: 1080, format: "16:9" };
  const even = (n) => Math.round(n / 2) * 2;
  const ar = source.width / source.height;
  const [w, h] = ar >= 1 ? [even(1080 * ar), 1080] : [1080, even(1080 / ar)];
  return { width: w, height: h, format: `source (${source.width}×${source.height})` };
}
