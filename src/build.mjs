import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseEdl, resolveEdl } from "./edl.mjs";
import { readStyle, canvasFor } from "./style.mjs";
import { probe, probeDuration } from "./media.mjs";
import { iconSvg, ICON_NAMES } from "./icons.mjs";
import { projectPaths, readJson, isAudioFile } from "./project.mjs";
import { escapeHtml, round } from "./util.mjs";

const require = createRequire(import.meta.url);
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

/* ---------------- text measuring (estimate for heavy sans faces) ---------------- */

function charWidth(c) {
  if (/[IJ1!'’.,:;|il]/.test(c)) return 0.34;
  if (/[MW@mw]/.test(c)) return 0.98;
  if (c === " ") return 0.28;
  if (/[A-Z0-9?$%&#]/.test(c)) return 0.72;
  return 0.6;
}
const textWidth = (text, size) => [...text].reduce((s, c) => s + charWidth(c), 0) * size;
function fitSize(text, maxWidth, base, min) {
  let size = base;
  while (size > min && textWidth(text, size) > maxWidth) size -= 2;
  return size;
}
/** Largest size that fits on one line, or on two lines when one line would get too small. */
function headlineSize(text, maxWidth, base) {
  const one = fitSize(text, maxWidth, base, 24);
  if (one >= base * 0.75) return one;
  return Math.max(one, fitSize(text, maxWidth * 1.8, base, Math.round(base * 0.45)));
}

const applyCase = (s, mode) =>
  mode === "upper" ? s.toUpperCase() : mode === "lower" ? s.toLowerCase() : mode === "title" ? s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s;

function hexA(hex, a) {
  const h = String(hex).replace("#", "");
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ---------------- motion presets ---------------- */

/** Load motion.js in a sandbox to learn which preset names exist. */
export function presetNames(motionFile) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(motionFile, "utf8"), sandbox, { filename: motionFile });
  const m = sandbox.window.VG_MOTION || {};
  return {
    in: Object.keys(m.in || {}),
    out: Object.keys(m.out || {}),
    frame: Object.keys(m.frame || {}),
    word: Object.keys(m.word || {}),
    outDuration: m.outDuration || {},
  };
}

/** "slamUp", "slamUp / liftOut", "slamUp → fadeOut" → { entry, exit } */
function splitPreset(p) {
  if (!p) return {};
  const [entry, exit] = String(p).split(/\s*(?:\/|→|->|\+)\s*/);
  return { entry: entry || undefined, exit: exit || undefined };
}

/* ---------------- shared scene scaffolding ---------------- */

function sceneFile(id, { width, height }, fontCss, css, markup, script) {
  return `<template>
  <style>
${fontCss}
    #root { position: absolute; inset: 0; overflow: visible; }
${css}
  </style>
  <div id="root" data-composition-id="${id}" data-width="${width}" data-height="${height}">
${markup}
  </div>
  <script>
    (function () {
      const M = window.VG_MOTION;
      const $ = (s) => document.querySelector(s);
      const tl = gsap.timeline({ paused: true });
${script}
      window.__timelines["${id}"] = tl;
    })();
  </script>
</template>
`;
}

// Letters get their own spans only for presets that animate letters: per-letter spans
// otherwise read as one-letter words to HyperFrames' readability check.
const LETTER_PRESETS = new Set(["letterPop", "typewriter"]);

function splitWords(text, letters) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `<span class="w">${letters ? [...w].map((c) => `<span class="ch">${escapeHtml(c)}</span>`).join("") : escapeHtml(w)}</span>`)
    .join(" ");
}

/* ---------------- captions ---------------- */

function groupWords(words, { maxWords, maxChars }) {
  const groups = [];
  let cur = [];
  words.forEach((w, i) => {
    if (cur.length) {
      const prev = words[i - 1];
      const chars = cur.map((k) => words[k].text).join(" ").length + 1 + w.text.length;
      const sentenceEnd = /[.?!]["”']?$|\.\.\.$/.test(prev.text);
      const clause = /[,;:—]$/.test(prev.text) && cur.length >= 2;
      if (prev.cut !== w.cut || cur.length >= maxWords || chars > maxChars || sentenceEnd || clause || w.start - prev.end >= 0.15) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(i);
  });
  if (cur.length) groups.push(cur);
  return groups;
}

/** Caption words on the output timeline, from the transcript and the cut rows. */
export function captionWords(cuts, transcript, { skipFillers = true } = {}) {
  const bySource = new Map((transcript?.sources || []).map((s) => [s.source, s]));
  const out = [];
  cuts.forEach((c, ci) => {
    if (c.opts["no-captions"] || /^none$/i.test(c.caption)) return;
    const auto = !c.caption || /^auto$/i.test(c.caption);
    if (auto) {
      const src = bySource.get(c.source);
      if (!src) return;
      for (const w of src.words) {
        const mid = (w.start + w.end) / 2;
        if (mid < c.in || mid > c.out) continue;
        if (skipFillers && w.flag === "filler") continue;
        out.push({
          text: w.text,
          cut: ci,
          start: round(c.start + Math.max(0, w.start - c.in)),
          end: round(Math.min(c.end, c.start + (w.end - c.in))),
        });
      }
    } else {
      // typed caption: spread its words evenly over the cut
      const toks = c.caption.split(/\s+/).filter(Boolean);
      const step = (c.end - c.start) / toks.length;
      toks.forEach((t, k) => out.push({ text: t, cut: ci, start: round(c.start + k * step), end: round(c.start + (k + 1) * step) }));
    }
  });
  return out;
}

function captionsScene(words, style, canvas, fontCss, motion) {
  const cs = style.captions;
  const { width: W, height: H } = canvas;
  const groups = groupWords(words, cs);
  const timing = groups.map((g, gi) => {
    const first = words[g[0]];
    const last = words[g.at(-1)];
    const next = groups[gi + 1] ? words[groups[gi + 1][0]] : null;
    const start = Math.max(0, first.start - 0.06);
    let end = last.end + 0.4;
    if (next) end = Math.min(end, next.start - 0.06);
    return { start: round(start), end: round(Math.max(start + 0.2, end)) };
  });
  for (let gi = 1; gi < timing.length; gi++) if (timing[gi].start < timing[gi - 1].end) timing[gi].start = timing[gi - 1].end;

  const portrait = H > W * 1.1;
  const landscape = W > H * 1.1;
  const base = cs.size === "auto" ? Math.round(Math.min(W, H) * (portrait ? 0.085 : 0.07)) : Number(cs.size);
  const pos = cs.position === "auto" ? (portrait ? 0.66 : landscape ? 0.87 : 0.8) : Number(cs.position);
  const maxW = W * 0.84;
  const bottom = Math.round(H * (1 - pos) - base * 0.55);
  const display = (t) => applyCase(t.replace(/[.,;:]+$/, ""), cs.case);
  const entry = cs.entry in motion.inSet ? cs.entry : "popIn";
  const exit = cs.exit;
  const exitDur = motion.outDuration[exit] ?? 0.1;

  const css = `    .cg { position: absolute; left: 0; bottom: ${bottom}px; width: ${W}px; padding: 0 ${Math.round(W * 0.08)}px;
      display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-end; gap: 0 ${Math.round(base * 0.3)}px; opacity: 0; visibility: hidden; }
    .cw { display: inline-block; position: relative; font-family: "${cs.font}"; font-weight: ${cs.weight};
      line-height: 1.1; color: ${cs.color}; transform-origin: 50% 70%;
      ${cs.strokeWidth ? `-webkit-text-stroke: ${cs.strokeWidth}px ${cs.stroke}; paint-order: stroke fill;` : ""} }
    .cw .t { position: relative; z-index: 1; }
    .cw .hl { position: absolute; left: -0.12em; right: -0.12em; top: 0.02em; bottom: 0.02em; border-radius: 0.14em;
      background: ${cs.boxColor}; transform-origin: 0% 50%; opacity: 0; z-index: 0; }`;

  const markup = groups
    .map((g, gi) => {
      const text = g.map((k) => display(words[k].text)).join(" ");
      const single = fitSize(text, maxW, base, Math.round(base * 0.6));
      const size = single >= base * 0.85 ? single : fitSize(text, maxW * 1.8, base, Math.round(base * 0.65));
      const spans = g
        .map((k) => `<span id="cw${k}" class="cw" style="font-size:${size}px">${cs.highlight === "box" ? '<span class="hl"></span>' : ""}<span class="t">${escapeHtml(display(words[k].text))}</span></span>`)
        .join("");
      return `    <div id="cg${gi}" class="cg" data-layout-allow-overflow>${spans}</div>`;
    })
    .join("\n");

  const lines = [];
  const wordFn = motion.wordSet.has(cs.highlight) ? cs.highlight : "none";
  groups.forEach((g, gi) => {
    const { start, end } = timing[gi];
    lines.push(`      tl.set("#cg${gi}", { visibility: "visible" }, ${start});`, `      M.in[${JSON.stringify(entry)}](tl, $("#cg${gi}"), ${start});`);
    for (const k of g) {
      const w = words[k];
      const at = round(Math.max(start, w.start));
      const until = round(Math.max(at + 0.06, Math.min(w.end, end)));
      if (wordFn !== "none")
        lines.push(`      M.word.${wordFn}(tl, $("#cw${k}"), ${at}, ${until}, { color: ${JSON.stringify(cs.color)}, activeColor: ${JSON.stringify(cs.activeColor)} });`);
    }
    if (exit && exit !== "cut") lines.push(`      M.out[${JSON.stringify(exit)}](tl, $("#cg${gi}"), ${round(Math.max(start + 0.15, end - exitDur))});`);
    lines.push(`      tl.set("#cg${gi}", { opacity: 0, visibility: "hidden" }, ${end});`);
  });
  return { html: sceneFile("captions", canvas, fontCss, css, markup, lines.join("\n")), groups: groups.length };
}

/* ---------------- on-screen text overlays ---------------- */

function overlayScene(id, row, style, canvas, fontCss, motion) {
  const ts = style.text;
  const { width: W, height: H } = canvas;
  const portrait = H > W * 1.1;
  const d = round(row.end - row.start);
  const { entry = ts.entry, exit = ts.exit } = splitPreset(row.preset);
  const color = row.opts.color || ts.color;
  const text = applyCase(row.caption || "", row.opts.case || (row.type === "lower-third" ? "none" : "upper"));
  const icon = /^icon:([\w-]+)/i.exec(row.overlay || "")?.[1];
  const unit = Math.min(W, H);
  const exitDur = motion.outDuration[exit] ?? 0.25;
  const letters = LETTER_PRESETS.has(entry);
  let css;
  let markup;

  if (row.type === "lower-third") {
    const [name, role] = text.split(/\s+(?:—|–|\||\/\/)\s+/);
    const nameSize = Number(row.opts.size) || Math.round(unit * (portrait ? 0.075 : 0.055));
    // portrait: above the caption band; landscape: the classic lower third
    const top = row.opts.y ? Number(row.opts.y) * H : H * (portrait ? 0.5 : 0.7);
    css = `    #${id}-box { position: absolute; left: ${Math.round(W * 0.07)}px; top: ${Math.round(top)}px; display: flex; gap: ${Math.round(unit * 0.02)}px; align-items: stretch; }
    #${id}-bar { width: ${Math.round(unit * 0.012)}px; background: ${ts.accent}; border-radius: 4px; }
    #${id}-name { font-family: "${ts.font}"; font-weight: ${ts.weight}; font-size: ${nameSize}px; color: ${color}; line-height: 1.05;
      text-shadow: 0 4px 18px ${hexA("#000", 0.55)}; }
    #${id}-role { font-family: "${ts.font}"; font-weight: 600; font-size: ${Math.round(nameSize * 0.55)}px; color: ${ts.accent2}; margin-top: 6px; }`;
    markup = `    <div id="${id}-box"><div id="${id}-bar"></div><div id="${id}-copy"><div id="${id}-name">${splitWords(name || "", letters)}</div>${role ? `<div id="${id}-role">${escapeHtml(role)}</div>` : ""}</div></div>`;
  } else {
    const base = Number(row.opts.size) || Math.round(unit * (row.type === "title" ? 0.13 : row.type === "callout" ? 0.085 : 0.1));
    const size = headlineSize(text, W * 0.84, base);
    const yDefault = row.type === "title" ? (portrait ? 0.3 : 0.45) : row.type === "callout" ? (portrait ? 0.2 : 0.2) : portrait ? 0.24 : 0.3;
    const cy = (row.opts.y ? Number(row.opts.y) : yDefault) * H;
    const iconSize = Math.round(unit * 0.16);
    css = `    #${id}-box { position: absolute; left: 0; width: ${W}px; top: ${Math.round(cy - (size + (icon ? iconSize + 20 : 0)) / 2)}px;
      display: flex; flex-direction: column; align-items: center; gap: ${Math.round(unit * 0.02)}px; }
    #${id}-text { font-family: "${ts.font}"; font-weight: ${row.opts.weight || ts.weight}; font-size: ${size}px; line-height: 1.02; color: ${color};
      text-align: center; letter-spacing: -0.02em; ${
        row.opts.box
          ? `background: ${row.opts.box}; padding: 0.16em 0.32em 0.2em; border-radius: 0.14em; max-width: ${Math.round(W * 0.9)}px;`
          : `padding: 0 ${Math.round(W * 0.08)}px; text-shadow: 0 8px 28px ${hexA("#000", 0.55)};`
      } }
    #${id}-text .w, #${id}-text .ch { display: inline-block; }`;
    markup = `    <div id="${id}-box">
      ${icon ? iconSvg(ICON_NAMES.includes(icon) ? icon : "idea", { size: iconSize, stroke: ts.accent, width: 4.5, id: `${id}-icon` }) : ""}
      <div id="${id}-text">${splitWords(text, letters)}</div>
    </div>`;
  }
  css += `\n    #${id}-box .w, #${id}-box .ch { display: inline-block; }`;
  const target = row.type === "lower-third" ? `#${id}-box` : `#${id}-text`;
  const script = [
    icon ? `      M.in.drawOn(tl, $("#${id}-icon"), 0.05);` : "",
    row.type === "lower-third" ? `      tl.fromTo("#${id}-bar", { scaleY: 0, transformOrigin: "50% 100%" }, { scaleY: 1, duration: 0.3, ease: "power3.out" }, 0);` : "",
    `      M.in[${JSON.stringify(entry)}](tl, $("${target}"), ${icon ? 0.2 : 0});`,
    exit && exit !== "none" ? `      M.out[${JSON.stringify(exit)}](tl, $("#${id}-box"), ${round(Math.max(0.3, d - exitDur - 0.02))});` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { html: sceneFile(id, canvas, fontCss, css, markup, script), entry, exit };
}

/* ---------------- music ducking ---------------- */

function duckLane(speech, clipStart, clipDur, duck) {
  const merged = [];
  for (const s of speech) {
    const last = merged.at(-1);
    if (last && s.start - last.end < 0.8) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const pts = [{ t: 0, v: 1 }];
  for (const s of merged) {
    const a = s.start - clipStart;
    const b = s.end - clipStart;
    if (b <= 0 || a >= clipDur) continue;
    const down = Math.max(0, a - 0.25);
    const up = Math.min(clipDur, b + 0.35);
    if (down > pts.at(-1).t) pts.push({ t: round(down), v: 1 });
    pts.push({ t: round(Math.max(down, a, pts.at(-1).t)), v: duck });
    pts.push({ t: round(Math.max(b, pts.at(-1).t)), v: duck });
    pts.push({ t: round(Math.max(up, pts.at(-1).t)), v: 1 });
  }
  return pts.slice(0, 512);
}

/* ---------------- main build ---------------- */

export async function buildComposition(root, { format: formatOverride, log = () => {} } = {}) {
  const P = projectPaths(root);
  if (!fs.existsSync(P.edl)) throw new Error(`No EDL at ${P.edl}. Write it (or run "vg edl-draft") first.`);
  const edl = parseEdl(fs.readFileSync(P.edl, "utf8"));
  const { style, found } = readStyle(P.style);
  if (!found) log(`No vg-style block in analysis/style.md; using default caption/text styling`);
  const transcript = readJson(P.transcript, { sources: [] });

  // probe every referenced file once
  const sources = new Set();
  for (const r of edl.rows) {
    if (r.source) sources.add(r.source);
    const inline = /^\s*([^\s]+\.(?:mp4|mov|m4v|mkv|webm|avi))/i.exec(r.overlay || "")?.[1];
    if (inline) sources.add(inline);
  }
  const info = {};
  for (const s of sources) {
    const abs = path.join(P.root, s);
    if (!fs.existsSync(abs)) continue;
    info[s] = isAudioFile(s) ? { duration: await probeDuration(abs) } : await probe(abs);
  }
  const durations = Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.duration]));
  const { timeline, errors, warnings } = resolveEdl(edl, { root: P.root, durations });
  if (errors.length) throw new Error(`The EDL has problems:\n  - ${errors.join("\n  - ")}`);
  if (!timeline.cuts.length) throw new Error("The EDL has no cut rows (main footage)");

  const canvas = canvasFor(formatOverride || edl.settings.format || style.format, info[timeline.cuts[0].source]);
  const { width: W, height: H } = canvas;

  // composition folder: everything is regenerated except styles/motion.js
  const C = P.composition;
  for (const sub of ["compositions", "assets"]) fs.rmSync(path.join(C, sub), { recursive: true, force: true });
  fs.mkdirSync(path.join(C, "compositions"), { recursive: true });
  fs.mkdirSync(path.join(C, "assets", "media"), { recursive: true });
  fs.mkdirSync(path.join(C, "styles"), { recursive: true });
  const motionFile = path.join(C, "styles", "motion.js");
  if (!fs.existsSync(motionFile)) fs.copyFileSync(path.join(TEMPLATES, "motion.js"), motionFile);
  fs.copyFileSync(require.resolve("gsap/dist/gsap.min.js"), path.join(C, "assets", "gsap.min.js"));
  const names = presetNames(motionFile);
  const motion = { inSet: Object.fromEntries(names.in.map((n) => [n, 1])), wordSet: new Set(names.word), outDuration: names.outDuration };

  // check every preset the EDL and style name exist in motion.js
  const unknown = [];
  const need = (kind, name, where) => name && !names[kind].includes(name) && unknown.push(`${where}: "${name}" is not a ${kind} preset in styles/motion.js (have: ${names[kind].join(", ")})`);
  for (const c of timeline.cuts) if (c.preset && c.preset !== "alternate") need("frame", c.preset, `row ${c.n}`);
  for (const b of timeline.brolls) {
    const p = splitPreset(b.preset);
    need("in", p.entry, `row ${b.n}`);
    need("out", p.exit, `row ${b.n}`);
  }
  for (const o of timeline.overlays) {
    const p = splitPreset(o.preset);
    need("in", p.entry, `row ${o.n}`);
    if (p.exit !== "none") need("out", p.exit, `row ${o.n}`);
  }
  need("in", style.captions.entry, "style captions.entry");
  if (style.captions.exit !== "cut") need("out", style.captions.exit, "style captions.exit");
  need("in", style.text.entry, "style text.entry");
  need("out", style.text.exit, "style text.exit");
  need("in", style.broll.entry, "style broll.entry");
  need("out", style.broll.exit, "style broll.exit");
  if (unknown.length) throw new Error(`Unknown motion presets:\n  - ${unknown.join("\n  - ")}`);

  // media: link (never copy or modify) the project's files
  const mediaPath = {};
  for (const s of Object.keys(info)) {
    const name = s.replace(/[\\/]/g, "__");
    const link = path.join(C, "assets", "media", name);
    const target = path.join(P.root, s);
    try {
      fs.symlinkSync(path.relative(path.dirname(link), target), link);
    } catch {
      fs.copyFileSync(target, link);
    }
    mediaPath[s] = `assets/media/${name}`;
  }

  // brand fonts
  const fontCss = Object.entries(style.fonts || {})
    .map(([family, file]) => {
      const src = path.resolve(P.root, file);
      if (!fs.existsSync(src)) throw new Error(`Font file for "${family}" not found: ${src}`);
      fs.mkdirSync(path.join(C, "assets", "fonts"), { recursive: true });
      fs.copyFileSync(src, path.join(C, "assets", "fonts", path.basename(src)));
      return `    @font-face { font-family: "${family}"; src: url("assets/fonts/${path.basename(src)}"); font-display: block; }`;
    })
    .join("\n");

  // captions
  const words = style.captions.enabled ? captionWords(timeline.cuts, transcript, style.captions) : [];
  const missingTranscript = [...new Set(timeline.cuts.map((c) => c.source))].filter((s) => !transcript.sources.some((t) => t.source === s));
  if (style.captions.enabled && missingTranscript.length) warnings.push(`No transcript for ${missingTranscript.join(", ")}; its cuts get no automatic captions (run "vg transcribe")`);
  let captionGroups = 0;
  if (words.length) {
    const cap = captionsScene(words, style, canvas, fontCss, motion);
    fs.writeFileSync(path.join(C, "compositions", "captions.html"), cap.html);
    captionGroups = cap.groups;
  }

  // overlays
  const overlayHosts = [];
  timeline.overlays.forEach((o, i) => {
    const id = `ov-${String(i + 1).padStart(2, "0")}`;
    const ov = overlayScene(id, o, style, canvas, fontCss, motion);
    fs.writeFileSync(path.join(C, "compositions", `${id}.html`), ov.html);
    overlayHosts.push(
      `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${o.start}" data-duration="${round(o.end - o.start)}" data-track-index="${3 + (i % 3)}" data-track-kind="graphics" data-width="${W}" data-height="${H}" style="z-index:5"></div>`,
    );
  });

  // main footage + b-roll
  const objPos = (r) => (r.opts.focus ? `object-position: ${Math.round(Number(r.opts.focus) * 100)}% 50%;` : "");
  const tracks = [];
  const rootScript = [];
  let alt = false;
  timeline.cuts.forEach((c, i) => {
    const framing = c.preset || style.cuts.framing;
    const fade = c.opts["no-fade"] ? "" : ` data-fade-in="0.02" data-fade-out="0.02"`;
    tracks.push(
      `      <div id="cf${i}" class="frame" style="z-index:1">
        <video id="cut${i}" class="clip" src="${mediaPath[c.source]}" data-start="${c.start}" data-duration="${round(c.end - c.start)}" data-media-start="${round(c.in)}" data-track-index="0" data-has-audio="true" data-volume="${c.opts.volume ?? 1}"${fade} playsinline style="${objPos(c)}"></video>
      </div>`,
    );
    let name = framing;
    if (framing === "alternate") {
      name = alt ? "punchIn" : "none";
      alt = !alt;
    }
    rootScript.push(`      M.frame[${JSON.stringify(name)}](tl, $("#cf${i}"), ${c.start}, { end: ${c.end}, scale: ${Number(c.opts.scale) || style.cuts.punchScale} });`);
  });
  timeline.brolls.forEach((b, i) => {
    const { entry = style.broll.entry, exit = style.broll.exit } = splitPreset(b.preset);
    const audio = b.opts["keep-audio"] ? ` data-has-audio="true" data-volume="${b.opts.volume ?? 0.5}" data-fade-in="0.05" data-fade-out="0.05"` : " muted";
    tracks.push(
      `      <div id="bf${i}" class="frame" style="z-index:2">
        <video id="broll${i}" class="clip" src="${mediaPath[b.source]}" data-start="${b.start}" data-duration="${round(b.end - b.start)}" data-media-start="${round(b.in)}" data-track-index="1"${audio} playsinline style="${objPos(b)}"></video>
      </div>`,
    );
    rootScript.push(`      M.in[${JSON.stringify(entry)}](tl, $("#bf${i}"), ${b.start});`);
    if (exit !== "cut") rootScript.push(`      M.out[${JSON.stringify(exit)}](tl, $("#bf${i}"), ${round(Math.max(b.start + 0.2, b.end - (names.outDuration[exit] ?? 0.2)))});`);
  });

  // music + sfx
  const speech = words.map((w) => ({ start: w.start, end: w.end }));
  const audioEls = [];
  timeline.audio.forEach((a, i) => {
    const dur = round(a.end - a.start);
    if (a.type === "music") {
      const lane = duckLane(speech, a.start, dur, Number(a.opts.duck ?? style.music.duck));
      const automation = JSON.stringify({ version: 1, lanes: [{ target: "volume", points: lane }] }).replace(/"/g, "&quot;");
      audioEls.push(
        `      <audio id="music${i}" class="clip" src="${mediaPath[a.source]}" data-start="${a.start}" data-duration="${dur}" data-media-start="${round(a.in)}" data-track-index="7" data-volume="${a.opts.volume ?? style.music.volume}" data-fade-in="${a.opts.fadein ?? 0.5}" data-fade-out="${a.opts.fadeout ?? 1.5}" data-automation="${automation}"></audio>`,
      );
    } else {
      audioEls.push(
        `      <audio id="sfx${i}" class="clip" src="${mediaPath[a.source]}" data-start="${a.start}" data-duration="${dur}" data-media-start="${round(a.in)}" data-track-index="8" data-volume="${a.opts.volume ?? 0.8}"></audio>`,
      );
    }
  });

  const index = `<!doctype html>
<!-- Generated by "vg build" from plan/edl.md and analysis/style.md. Edit those (or styles/motion.js) and rebuild; changes here are overwritten. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="assets/gsap.min.js"></script>
    <script src="styles/motion.js"></script>
    <style>
${fontCss}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${style.background}; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
      .frame { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; overflow: hidden; transform-origin: 50% 40%; }
      .frame video { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${timeline.duration}" data-width="${W}" data-height="${H}">
${tracks.join("\n")}
${overlayHosts.join("\n")}
${words.length ? `      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${timeline.duration}" data-track-index="6" data-track-kind="captions" data-width="${W}" data-height="${H}" style="z-index:6"></div>` : ""}
${audioEls.join("\n")}
    </div>
    <script>
      (function () {
        const M = window.VG_MOTION;
        const $ = (s) => document.querySelector(s);
        const tl = gsap.timeline({ paused: true });
${rootScript.map((l) => "  " + l).join("\n")}
        window.__timelines["main"] = tl;
      })();
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(C, "index.html"), index);
  fs.writeFileSync(
    path.join(C, "hyperframes.json"),
    JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", assets: "assets" }, media: { autoProxy: true } }, null, 2),
  );
  if (!fs.existsSync(path.join(C, "meta.json")))
    fs.writeFileSync(path.join(C, "meta.json"), JSON.stringify({ id: path.basename(P.root), name: path.basename(P.root), createdAt: new Date().toISOString() }, null, 2));

  return {
    canvas,
    duration: timeline.duration,
    target: edl.settings.targetSeconds ?? null,
    cuts: timeline.cuts.length,
    brolls: timeline.brolls.length,
    overlays: timeline.overlays.length,
    audio: timeline.audio.length,
    captionWords: words.length,
    captionGroups,
    warnings,
    timeline,
    speech,
  };
}
