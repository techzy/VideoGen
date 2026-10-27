import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { iconSvg } from "./icons.mjs";
import { escapeHtml, round } from "./util.mjs";

const require = createRequire(import.meta.url);

export const W = 1080;
export const H = 1920;
const TOP_SAFE = 190; // platform status/search bar above this
const CAPTION_BOTTOM = 610; // px from the bottom: keeps captions above the app's caption/handle area

/* ---------- text fitting (estimate, Inter-like heavy uppercase) ---------- */

function charWidth(c) {
  if (/[IJ1!'’.,:;|]/.test(c)) return 0.34;
  if (/[MW@]/.test(c)) return 0.98;
  if (c === " ") return 0.28;
  if (/[A-Z0-9?$%&#]/.test(c)) return 0.72;
  return 0.6;
}
function textWidth(text, size) {
  return [...text].reduce((s, c) => s + charWidth(c), 0) * size;
}
export function fitSize(text, maxWidth, base, min) {
  let size = base;
  while (size > min && textWidth(text, size) > maxWidth) size -= 2;
  return size;
}

/* ---------- shared bits ---------- */

const ease = {
  in: "power2.in",
  out: "power3.out",
  pop: "back.out(1.8)",
};

// @font-face rules for brand fonts outside the bundled set; every file that uses a face declares it
let fontFaceCss = "";

function sceneFile(id, css, markup, script) {
  return `<template>
  <style>
${fontFaceCss}
    #root { position: absolute; inset: 0; overflow: visible; }
${css}
  </style>
  <div id="root" data-composition-id="${id}" data-width="${W}" data-height="${H}">
${markup}
  </div>
  <script>
    (function () {
      const tl = gsap.timeline({ paused: true });
${script}
      window.__timelines["${id}"] = tl;
    })();
  </script>
</template>
`;
}

function scrim(p, theme) {
  return {
    css: `    #${p}-scrim { position: absolute; left: 0; top: 0; width: ${W}px; height: 820px;
      background: linear-gradient(180deg, ${hexA(theme.colors.ink, 0.78)} 0%, ${hexA(theme.colors.ink, 0.45)} 55%, ${hexA(theme.colors.ink, 0)} 100%); }`,
    markup: `    <div id="${p}-scrim"></div>`,
    enter: `      tl.fromTo("#${p}-scrim", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.out" }, 0);`,
    exit: (d) => `      tl.to("#${p}-scrim", { opacity: 0, duration: 0.3, ease: "power1.in" }, ${round(d - 0.32)});`,
  };
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function stageCss(p, top = TOP_SAFE + 20, height = 440) {
  return `    #${p}-stage { position: absolute; left: 0; top: ${top}px; width: ${W}px; height: ${height}px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; }`;
}

function drawIn(selector, at, { duration = 0.6, stagger = 0.08 } = {}) {
  return `      tl.fromTo("${selector}", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: ${duration}, stagger: ${stagger}, ease: "power2.inOut" }, ${at});`;
}

function exitStage(p, d) {
  return `      tl.to("#${p}-stage", { opacity: 0, y: -40, scale: 0.96, duration: 0.3, ease: "${ease.in}" }, ${round(d - 0.32)});`;
}

/** Largest size at which the headline fits on one line, or on two balanced lines. */
function headlineSize(text, maxWidth, base) {
  const one = fitSize(text, maxWidth, base, 40);
  if (one >= base * 0.8) return one;
  return Math.max(one, fitSize(text, maxWidth * 1.75, base, 56));
}

function titleSpans(p, text, cls = "w") {
  return text
    .split(/\s+/)
    .map((w) => `<span class="${p}-${cls}">${escapeHtml(w)}</span>`)
    .join(" ");
}

/* ---------- beat templates ---------- */

function iconTitle(p, beat, theme, d) {
  const s = scrim(p, theme);
  const size = headlineSize(beat.headline, 940, 108);
  const css = `${s.css}
${stageCss(p)}
    #${p}-badge { position: relative; width: 210px; height: 210px; }
    #${p}-badge-bg { position: absolute; inset: 0; }
    #${p}-icon { position: absolute; left: 45px; top: 45px; }
    #${p}-title { font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight}; font-size: ${size}px;
      line-height: 1; color: ${theme.colors.paper}; text-transform: uppercase; letter-spacing: -0.02em; text-align: center;
      padding: 0 60px; text-shadow: 0 8px 28px ${hexA(theme.colors.ink, 0.6)}; }
    .${p}-w { display: inline-block; }
    #${p}-sub { font-family: "${theme.fonts.display}"; font-weight: 700; font-size: 50px; color: ${theme.colors.accent2};
      text-align: center; padding: 0 80px; }`;
  const markup = `${s.markup}
    <div id="${p}-stage">
      <div id="${p}-badge">
        <svg id="${p}-badge-bg" viewBox="0 0 210 210" width="210" height="210" overflow="visible">
          <circle id="${p}-disc" cx="105" cy="105" r="92" fill="${theme.colors.accent}"/>
          <circle id="${p}-ring" cx="105" cy="105" r="102" fill="none" stroke="${theme.colors.accent2}" stroke-width="6" pathLength="1" transform="rotate(-90 105 105)"/>
        </svg>
        ${iconSvg(beat.icon, { size: 120, stroke: theme.colors.paper, width: 4.5, id: `${p}-icon` })}
      </div>
      <div id="${p}-title">${titleSpans(p, beat.headline)}</div>
      ${beat.subline ? `<div id="${p}-sub">${escapeHtml(beat.subline)}</div>` : ""}
    </div>`;
  const script = `${s.enter}
      tl.fromTo("#${p}-badge", { scale: 0, rotation: -25 }, { scale: 1, rotation: 0, duration: 0.45, ease: "${ease.pop}" }, 0.05);
      tl.fromTo("#${p}-disc", { scale: 0.6, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.4, ease: "${ease.pop}" }, 0.08);
${drawIn(`#${p}-ring`, 0.12, { duration: 0.7, stagger: 0 })}
${drawIn(`#${p}-icon .draw`, 0.22, { duration: 0.65, stagger: 0.09 })}
      tl.fromTo(".${p}-w", { y: 90, opacity: 0, rotation: 6 }, { y: 0, opacity: 1, rotation: 0, duration: 0.42, stagger: 0.07, ease: "power4.out" }, 0.32);
      ${beat.subline ? `tl.fromTo("#${p}-sub", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "${ease.out}" }, 0.62);` : ""}
      tl.to("#${p}-badge", { y: -10, duration: ${round(Math.max(0.4, d - 1.2))}, ease: "sine.inOut" }, 0.6);
${exitStage(p, d)}
${s.exit(d)}`;
  return sceneFile(p, css, markup, script);
}

function bigWord(p, beat, theme, d) {
  const s = scrim(p, theme);
  const words = beat.headline.split(/\s+/);
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), "");
  const oneLine = textWidth(beat.headline, 150) <= 960;
  const size = oneLine ? fitSize(beat.headline, 960, 190, 90) : fitSize(longest, 960, 170, 80);
  const letters = words
    .map((w) => `<span class="${p}-word">${[...w].map((c) => `<span class="${p}-ch">${escapeHtml(c)}</span>`).join("")}</span>`)
    .join(" ");
  const css = `${s.css}
${stageCss(p, TOP_SAFE + 40, 420)}
    #${p}-title { font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight}; font-size: ${size}px;
      line-height: 0.95; color: ${theme.colors.paper}; text-transform: uppercase; letter-spacing: -0.03em; text-align: center;
      text-shadow: 0 10px 34px ${hexA(theme.colors.ink, 0.6)}; padding: 0 50px; }
    .${p}-word { display: inline-block; white-space: nowrap; }
    .${p}-ch { display: inline-block; }
    #${p}-swoosh { display: block; margin-top: -6px; }
    .${p}-spark { position: absolute; }`;
  const sparks = [
    [120, 40, 52],
    [920, 10, 40],
    [960, 330, 34],
    [90, 330, 30],
  ]
    .map(
      ([x, y, sz], i) =>
        `<svg class="${p}-spark" id="${p}-spark${i}" style="left:${x}px;top:${y}px" width="${sz}" height="${sz}" viewBox="-10 -10 20 20"><path d="M0-10C1-3 3-1 10 0 3 1 1 3 0 10-1 3-3 1-10 0-3-1-1-3 0-10z" fill="${i % 2 ? theme.colors.accent2 : theme.colors.accent}"/></svg>`,
    )
    .join("\n      ");
  const markup = `${s.markup}
    <div id="${p}-stage">
      ${sparks}
      <div id="${p}-title">${letters}</div>
      <svg id="${p}-swoosh" viewBox="0 0 720 60" width="720" height="60" overflow="visible">
        <path class="${p}-sw" d="M12 40 C 180 8, 460 4, 708 30" pathLength="1" fill="none" stroke="${theme.colors.accent}" stroke-width="16" stroke-linecap="round"/>
        <path class="${p}-sw" d="M120 54 C 300 34, 480 32, 620 46" pathLength="1" fill="none" stroke="${theme.colors.accent2}" stroke-width="8" stroke-linecap="round"/>
      </svg>
      ${beat.subline ? `<div id="${p}-sub" style="font-family:'${theme.fonts.display}';font-weight:700;font-size:50px;color:${theme.colors.accent2};text-align:center;padding:0 80px">${escapeHtml(beat.subline)}</div>` : ""}
    </div>`;
  const script = `${s.enter}
      tl.fromTo(".${p}-ch", { y: 140, opacity: 0, rotation: 12, scale: 0.7 }, { y: 0, opacity: 1, rotation: 0, scale: 1, duration: 0.5, stagger: 0.035, ease: "back.out(1.6)" }, 0.05);
${drawIn(`.${p}-sw`, 0.35, { duration: 0.5, stagger: 0.12 })}
      tl.fromTo(".${p}-spark", { scale: 0, rotation: -90 }, { scale: 1, rotation: 0, duration: 0.4, stagger: 0.08, ease: "${ease.pop}" }, 0.45);
      tl.to(".${p}-spark", { rotation: 90, duration: ${round(Math.max(0.4, d - 1.3))}, ease: "none" }, 0.85);
      tl.fromTo("#${p}-title", { scale: 1 }, { scale: 1.05, duration: ${round(Math.max(0.4, d - 0.8))}, ease: "none" }, 0.5);
      ${beat.subline ? `tl.fromTo("#${p}-sub", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "${ease.out}" }, 0.6);` : ""}
${exitStage(p, d)}
${s.exit(d)}`;
  return sceneFile(p, css, markup, script);
}

function counter(p, beat, theme, d) {
  const s = scrim(p, theme);
  const value = Math.round(beat.value);
  const numSize = fitSize(String(value), 200, 120, 60);
  const unit = beat.unit || beat.headline.replace(/^[\d\s]+/, "");
  const css = `${s.css}
${stageCss(p, TOP_SAFE + 10, 470)}
    #${p}-ringwrap { position: relative; width: 280px; height: 280px; }
    #${p}-num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight}; font-size: ${numSize}px; color: ${theme.colors.paper};
      font-variant-numeric: tabular-nums; letter-spacing: -0.03em; }
    #${p}-unit { font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight}; font-size: ${fitSize(unit, 900, 84, 50)}px;
      color: ${theme.colors.paper}; text-transform: uppercase; letter-spacing: 0.02em; }
    #${p}-sub { font-family: "${theme.fonts.display}"; font-weight: 700; font-size: 50px; color: ${theme.colors.accent2}; text-align: center; padding: 0 80px; }`;
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const r1 = 128;
    const r2 = i % 6 === 0 ? 112 : 119;
    return `<line class="${p}-tick" x1="${round(140 + r1 * Math.sin(a), 1)}" y1="${round(140 - r1 * Math.cos(a), 1)}" x2="${round(140 + r2 * Math.sin(a), 1)}" y2="${round(140 - r2 * Math.cos(a), 1)}" stroke="${hexA(theme.colors.paper, 0.5)}" stroke-width="3" stroke-linecap="round"/>`;
  }).join("");
  const markup = `${s.markup}
    <div id="${p}-stage">
      <div id="${p}-ringwrap">
        <svg viewBox="0 0 280 280" width="280" height="280" overflow="visible">
          <circle cx="140" cy="140" r="100" fill="${hexA(theme.colors.ink, 0.55)}" stroke="${hexA(theme.colors.paper, 0.18)}" stroke-width="14"/>
          <circle id="${p}-arc" cx="140" cy="140" r="100" fill="none" stroke="${theme.colors.accent}" stroke-width="14" stroke-linecap="round" pathLength="1" transform="rotate(-90 140 140)"/>
          ${ticks}
        </svg>
        <div id="${p}-num">0</div>
      </div>
      <div id="${p}-unit">${escapeHtml(unit)}</div>
      ${beat.subline ? `<div id="${p}-sub">${escapeHtml(beat.subline)}</div>` : ""}
    </div>`;
  const countDur = round(Math.min(1.2, Math.max(0.6, d * 0.35)));
  const script = `${s.enter}
      tl.fromTo("#${p}-ringwrap", { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "${ease.pop}" }, 0.05);
      tl.fromTo(".${p}-tick", { opacity: 0 }, { opacity: 1, duration: 0.2, stagger: 0.015 }, 0.1);
${drawIn(`#${p}-arc`, 0.2, { duration: countDur, stagger: 0 })}
      const num = document.querySelector("#${p}-num");
      const counterState = { v: 0 };
      tl.fromTo(counterState, { v: 0 }, { v: ${value}, duration: ${countDur}, ease: "power2.out", onUpdate: () => { num.textContent = Math.round(counterState.v); } }, 0.2);
      tl.fromTo("#${p}-unit", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "${ease.out}" }, ${round(0.2 + countDur * 0.6)});
      ${beat.subline ? `tl.fromTo("#${p}-sub", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "${ease.out}" }, ${round(0.4 + countDur * 0.6)});` : ""}
      tl.fromTo("#${p}-ringwrap", { rotation: 0 }, { rotation: 8, duration: ${round(Math.max(0.4, d - 1.2))}, ease: "sine.inOut" }, 0.6);
${exitStage(p, d)}
${s.exit(d)}`;
  return sceneFile(p, css, markup, script);
}

function versus(p, beat, theme, d) {
  const s = scrim(p, theme);
  const card = (side, sideBeat, x) => `
      <div id="${p}-${side}" class="${p}-card" style="left:${x}px">
        ${iconSvg(sideBeat.icon, { size: 120, stroke: theme.colors.paper, width: 4.5, id: `${p}-${side}-icon` })}
        <div class="${p}-label" style="font-size:${fitSize(sideBeat.label, 310, 64, 36)}px">${escapeHtml(sideBeat.label)}</div>
      </div>`;
  const css = `${s.css}
    #${p}-stage { position: absolute; left: 0; top: ${TOP_SAFE + 20}px; width: ${W}px; height: 440px; }
    .${p}-card { position: absolute; top: 40px; width: 360px; height: 300px; border-radius: 34px;
      background: ${hexA(theme.colors.ink, 0.62)}; border: 4px solid ${hexA(theme.colors.paper, 0.85)};
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; }
    .${p}-label { font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight}; color: ${theme.colors.paper};
      text-transform: uppercase; letter-spacing: -0.01em; text-align: center; line-height: 1; padding: 0 16px; }
    #${p}-right { border-color: ${theme.colors.accent}; }
    #${p}-vs { position: absolute; left: ${W / 2 - 75}px; top: 115px; width: 150px; height: 150px; }
    #${p}-head { position: absolute; left: 0; top: 368px; width: ${W}px; text-align: center;
      font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight}; font-size: ${fitSize(beat.headline || "", 940, 64, 40)}px;
      color: ${theme.colors.paper}; text-transform: uppercase; }`;
  const markup = `${s.markup}
    <div id="${p}-stage">${card("left", beat.left, 100)}${card("right", beat.right, W - 100 - 360)}
      <svg id="${p}-vs" viewBox="0 0 150 150" width="150" height="150">
        <circle cx="75" cy="75" r="70" fill="${theme.colors.accent}" stroke="${theme.colors.paper}" stroke-width="6"/>
        <text x="75" y="75" dy="0.35em" text-anchor="middle" font-family="${theme.fonts.display}" font-weight="900" font-size="64" fill="${theme.colors.paper}">VS</text>
      </svg>
      ${beat.headline ? `<div id="${p}-head">${escapeHtml(beat.headline)}</div>` : ""}
    </div>`;
  const script = `${s.enter}
      tl.fromTo("#${p}-left", { x: -520, rotation: -8 }, { x: 0, rotation: -3, duration: 0.5, ease: "${ease.out}" }, 0.05);
      tl.fromTo("#${p}-right", { x: 520, rotation: 8 }, { x: 0, rotation: 3, duration: 0.5, ease: "${ease.out}" }, 0.12);
${drawIn(`#${p}-left-icon .draw, #${p}-right-icon .draw`, 0.35, { duration: 0.6, stagger: 0.06 })}
      tl.fromTo("#${p}-vs", { scale: 0, rotation: -30 }, { scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2.4)" }, 0.45);
      ${beat.headline ? `tl.fromTo("#${p}-head", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "${ease.out}" }, 0.7);` : ""}
      tl.to("#${p}-left", { rotation: -5, y: -6, duration: ${round(Math.max(0.4, d - 1.35))}, ease: "sine.inOut" }, 0.65);
      tl.to("#${p}-right", { rotation: 5, y: -6, duration: ${round(Math.max(0.4, d - 1.35))}, ease: "sine.inOut" }, 0.65);
${exitStage(p, d)}
${s.exit(d)}`;
  return sceneFile(p, css, markup, script);
}

const TEMPLATE_FNS = { icon_title: iconTitle, big_word: bigWord, counter, versus };

/* ---------- hook (on screen from frame 0: it is the thumbnail) ---------- */

function hookScene(p, hook, theme, d) {
  const words = hook.text.split(/\s+/);
  // break into lines of up to ~12 characters
  const lines = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last && (last + " " + w).length <= 12) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const size = Math.min(...lines.map((l) => fitSize(l, 900, 130, 70)));
  const css = `    #${p}-scrim { position: absolute; left: 0; top: 0; width: ${W}px; height: 900px;
      background: linear-gradient(180deg, ${hexA(theme.colors.ink, 0.8)} 0%, ${hexA(theme.colors.ink, 0.5)} 60%, ${hexA(theme.colors.ink, 0)} 100%); }
    #${p}-stage { position: absolute; left: 0; top: ${TOP_SAFE + 30}px; width: ${W}px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .${p}-line { display: inline-block; font-family: "${theme.fonts.display}"; font-weight: ${theme.fonts.displayWeight};
      font-size: ${size}px; line-height: 1.02; text-transform: uppercase; letter-spacing: -0.03em; padding: 6px 26px 12px;
      color: ${theme.colors.ink}; background: ${theme.colors.paper}; border-radius: 18px; }
    .${p}-line:nth-child(2n) { background: ${theme.colors.accent}; color: ${theme.colors.paper}; }`;
  const markup = `    <div id="${p}-scrim"></div>
    <div id="${p}-stage">
      ${lines.map((l) => `<div class="${p}-line">${escapeHtml(l)}</div>`).join("\n      ")}
    </div>`;
  const script = `      tl.fromTo(".${p}-line", { rotation: -2 }, { rotation: 0, duration: 0.3, stagger: 0.05, ease: "power2.out" }, 0);
      tl.fromTo("#${p}-stage", { scale: 1 }, { scale: 1.04, duration: ${round(Math.max(0.3, d - 0.35))}, ease: "none" }, 0);
      tl.to(".${p}-line", { y: -50, opacity: 0, duration: 0.26, stagger: 0.04, ease: "${ease.in}" }, ${round(d - 0.36)});
      tl.to("#${p}-scrim", { opacity: 0, duration: 0.3, ease: "power1.in" }, ${round(d - 0.32)});`;
  return sceneFile(p, css, markup, script);
}

/* ---------- captions ---------- */

export function groupWords(words, { maxWords = 3, maxChars = 17, pauseBreak = 0.15 } = {}) {
  const groups = [];
  let cur = [];
  words.forEach((w, i) => {
    if (cur.length) {
      const prev = words[i - 1];
      const chars = cur.map((k) => words[k].text).join(" ").length + 1 + w.text.length;
      const sentenceEnd = /[.?!]["”']?$|\.\.\.$/.test(prev.text);
      const clause = /[,;:—]$/.test(prev.text) && cur.length >= 2;
      if (cur.length >= maxWords || chars > maxChars || sentenceEnd || clause || w.start - prev.end >= pauseBreak) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(i);
  });
  if (cur.length) groups.push(cur);
  return groups;
}

function captionsScene(id, words, emphasis, theme, duration) {
  const groups = groupWords(words);
  const timing = groups.map((g, gi) => {
    const first = words[g[0]];
    const last = words[g.at(-1)];
    const next = groups[gi + 1] ? words[groups[gi + 1][0]] : null;
    const start = Math.max(gi === 0 ? 0.15 : 0, first.start - 0.06);
    let end = last.end + 0.4;
    // one group on screen at a time: hand over just before the next group's first word
    if (next) end = Math.min(end, next.start - 0.06);
    return { start: round(start), end: round(Math.max(start + 0.2, Math.min(end, duration - 0.02))) };
  });
  for (let gi = 1; gi < timing.length; gi++) {
    if (timing[gi].start < timing[gi - 1].end) timing[gi].start = timing[gi - 1].end;
  }
  const display = (t) => t.replace(/[.,;:]+$/, "").toUpperCase();

  const css = `    .cap-g { position: absolute; left: 0; bottom: ${CAPTION_BOTTOM}px; width: ${W}px; padding: 0 70px;
      display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-end; gap: 0 30px; opacity: 0; visibility: hidden; }
    .cap-w { display: inline-block; position: relative; font-family: "${theme.fonts.caption}"; font-weight: ${theme.fonts.captionWeight};
      line-height: 1.08; text-transform: uppercase; letter-spacing: -0.01em; color: ${theme.colors.paper};
      -webkit-text-stroke: 12px ${theme.colors.ink}; paint-order: stroke fill; transform-origin: 50% 70%; }`;

  const markup = groups
    .map((g, gi) => {
      const text = g.map((k) => display(words[k].text)).join(" ");
      // one line when it fits at a readable size, else two balanced lines
      const single = fitSize(text, W - 180, 112, 60);
      const size = single >= 84 ? single : fitSize(text, (W - 180) * 1.8, 92, 64);
      const spans = g
        .map((k) => `<span id="cap-w${k}" class="cap-w${emphasis.has(k) ? " emph" : ""}" style="font-size:${size}px">${escapeHtml(display(words[k].text))}</span>`)
        .join("");
      return `    <div id="cap-g${gi}" class="cap-g" data-layout-allow-overflow>${spans}</div>`;
    })
    .join("\n");

  const lines = [];
  groups.forEach((g, gi) => {
    const { start, end } = timing[gi];
    lines.push(
      `      tl.set("#cap-g${gi}", { visibility: "visible" }, ${start});`,
      `      tl.fromTo("#cap-g${gi}", { opacity: 0, y: 26, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.14, ease: "back.out(2)" }, ${start});`,
    );
    g.forEach((k) => {
      const w = words[k];
      const isEmph = emphasis.has(k);
      const at = round(Math.max(start, w.start));
      const hold = round(Math.max(0.06, Math.min(w.end, end) - at));
      lines.push(
        `      tl.fromTo("#cap-w${k}", { color: ${JSON.stringify(theme.colors.paper)}, scale: 1 }, { color: ${JSON.stringify(isEmph ? theme.colors.accent2 : theme.colors.accent)}, scale: ${isEmph ? 1.1 : 1.04}, duration: 0.08, ease: "power2.out", immediateRender: false, overwrite: "auto" }, ${at});`,
      );
      if (!isEmph)
        lines.push(
          `      tl.to("#cap-w${k}", { color: ${JSON.stringify(theme.colors.paper)}, scale: 1, duration: 0.1, ease: "power1.out", overwrite: "auto" }, ${round(at + hold)});`,
        );
      else lines.push(`      tl.to("#cap-w${k}", { scale: 1.04, duration: 0.12, ease: "power1.out", overwrite: "auto" }, ${round(at + hold)});`);
    });
    lines.push(
      `      tl.to("#cap-g${gi}", { opacity: 0, duration: 0.06, ease: "power2.in" }, ${round(Math.max(start + 0.14, end - 0.06))});`,
      `      tl.set("#cap-g${gi}", { opacity: 0, visibility: "hidden" }, ${end});`,
    );
  });
  return sceneFile(id, css, markup, lines.join("\n"));
}

/* ---------- root ---------- */

function indexHtml({ duration, beats, hook, cutTimes, theme }) {
  const hosts = [];
  if (hook)
    hosts.push(
      `      <div id="hook" data-composition-id="hook" data-composition-src="compositions/hook.html" data-start="0" data-duration="${hook.end}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}" style="z-index:3"></div>`,
    );
  beats.forEach((b) => {
    hosts.push(
      `      <div id="${b.id}" data-composition-id="${b.id}" data-composition-src="compositions/${b.id}.html" data-start="${b.start}" data-duration="${round(b.end - b.start)}" data-track-index="${b.track}" data-track-kind="graphics" data-width="${W}" data-height="${H}" style="z-index:3"></div>`,
    );
  });

  // jump-cut punch-ins: alternate framing at every cut so edits read as intentional
  const punch = [];
  let zoomed = false;
  for (const t of cutTimes) {
    zoomed = !zoomed;
    punch.push(`      tl.set("#footage-frame", { scale: ${zoomed ? 1.12 : 1} }, ${t});`);
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="assets/gsap.min.js"></script>
    <style>
${fontFaceCss}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${theme.colors.ink}; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
      #footage-frame { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 50% 38%; }
      #footage { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}">
      <div id="footage-frame">
        <video id="footage" class="clip" src="assets/footage.mp4" data-start="0" data-duration="${duration}" data-track-index="0" data-has-audio="true" data-volume="1" playsinline></video>
      </div>
${hosts.join("\n")}
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${duration}" data-track-index="9" data-track-kind="captions" data-width="${W}" data-height="${H}" style="z-index:4"></div>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.set("#footage-frame", { scale: 1 }, 0);
${punch.join("\n")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

/** Write a complete HyperFrames project for the edited footage + plan. */
export function writeProject(dir, { footage, words, plan, duration, cutTimes, theme, themeDir = "." }) {
  fs.mkdirSync(path.join(dir, "compositions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fontFaceCss = Object.entries(theme.fontFiles || {})
    .map(([family, file]) => {
      const src = path.resolve(themeDir, file);
      if (!fs.existsSync(src)) throw new Error(`Brand font file not found: ${src}`);
      fs.mkdirSync(path.join(dir, "assets", "fonts"), { recursive: true });
      const name = path.basename(src);
      fs.copyFileSync(src, path.join(dir, "assets", "fonts", name));
      return `    @font-face { font-family: "${family}"; src: url("assets/fonts/${name}"); font-display: block; }`;
    })
    .join("\n");
  fs.copyFileSync(footage, path.join(dir, "assets", "footage.mp4"));
  fs.copyFileSync(require.resolve("gsap/dist/gsap.min.js"), path.join(dir, "assets", "gsap.min.js"));

  const beats = plan.beats.map((b, i) => ({ ...b, id: `beat-${String(i + 1).padStart(2, "0")}`, track: 1 + (i % 3) }));
  for (const b of beats) {
    const fn = TEMPLATE_FNS[b.template];
    fs.writeFileSync(path.join(dir, "compositions", `${b.id}.html`), fn(b.id, b, theme, round(b.end - b.start)));
  }
  if (plan.hook) fs.writeFileSync(path.join(dir, "compositions", "hook.html"), hookScene("hook", plan.hook, theme, plan.hook.end));
  fs.writeFileSync(path.join(dir, "compositions", "captions.html"), captionsScene("captions", words, plan.emphasis, theme, duration));
  fs.writeFileSync(path.join(dir, "index.html"), indexHtml({ duration, beats, hook: plan.hook, cutTimes, theme }));
  fs.writeFileSync(
    path.join(dir, "hyperframes.json"),
    JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", assets: "assets" }, media: { autoProxy: true } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: path.basename(dir), name: path.basename(dir), createdAt: new Date().toISOString() }, null, 2),
  );
  return beats;
}
