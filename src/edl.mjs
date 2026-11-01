import fs from "node:fs";
import path from "node:path";
import { parseTime, fmtTime, isImageFile, isHeicFile } from "./project.mjs";
import { round } from "./util.mjs";

/*
 * The EDL is a markdown table a person edits. Columns are found by header
 * name, so their order can change. Row types:
 *   cut     main footage, played back to back in table order (Out time is computed)
 *   broll   a cutaway over the main footage, starting at Out time; an image
 *           (png/jpg/webp/gif) is held over Out time "a → b"
 *   text / title / callout / lower-third   on-screen text over Out time "a → b"
 *   music   background track from Out time; ducks under speech
 *   sfx     a sound effect at Out time
 */

const TYPE_ALIASES = {
  cut: ["cut", "a-roll", "aroll", "main", "talking", "speech", "a roll"],
  broll: ["broll", "b-roll", "b roll", "cutaway", "insert"],
  title: ["title"],
  text: ["text", "graphic", "overlay", "kinetic"],
  callout: ["callout", "call-out", "icon"],
  "lower-third": ["lower-third", "lower third", "lowerthird", "l3"],
  music: ["music", "bed", "song"],
  sfx: ["sfx", "sound", "sound effect", "fx"],
};
export const OVERLAY_TYPES = ["title", "text", "callout", "lower-third"];

const COLUMNS = {
  n: /^#|^no\.?$|^n$/i,
  out: /^out/i,
  source: /^source|^file|^clip/i,
  range: /^in\b|^in\s*[→>-]|^src.*range|^range/i,
  type: /^type/i,
  caption: /^caption|^text/i,
  overlay: /^b-?roll|^overlay/i,
  preset: /^motion|^preset|^animation/i,
  notes: /^notes?|^comment/i,
};

function cells(line) {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** "12.3 → 15", "0:12-0:15.5", "12.3 to end" → [a, b]; b may be Infinity ("end") or NaN (missing). */
export function parseRange(s) {
  const t = String(s ?? "").trim();
  if (!t || /^[—–-]$/.test(t)) return [NaN, NaN];
  let parts = t.split(/\s*(?:→|->|⟶|–|—|\bto\b)\s*/i).filter(Boolean);
  if (parts.length === 1 && /^[\d:.,]+\s*-\s*[\d:.,]+$/.test(t)) parts = t.split(/\s*-\s*/);
  const val = (p) => (/^end$/i.test(p) ? Infinity : parseTime(p));
  return [val(parts[0]), parts.length > 1 ? val(parts[1]) : NaN];
}

function normType(raw) {
  const t = String(raw || "").trim().toLowerCase().replace(/[`*_]/g, "");
  for (const [type, names] of Object.entries(TYPE_ALIASES)) if (names.includes(t)) return type;
  return t || null;
}

/** "focus=0.3 keep-audio volume=0.6" → { focus: "0.3", "keep-audio": true, volume: "0.6" } */
export function parseOptions(notes) {
  const opts = {};
  for (const m of String(notes || "").matchAll(/\b([a-z][\w-]*)(?:=([^\s,;]+))?/gi)) {
    if (m[2] != null) opts[m[1].toLowerCase()] = m[2];
    else if (/^(keep-audio|mute|loop|no-captions|no-fade|border)$/i.test(m[1])) opts[m[1].toLowerCase()] = true;
  }
  return opts;
}

const clean = (s) => String(s ?? "").trim().replace(/^`(.*)`$/, "$1").replace(/^"(.*)"$/, "$1");
const isBlank = (s) => !s || /^[—–-]+$/.test(s.trim());

/** Settings lines anywhere above the table, e.g. "**Format:** 9:16" or "- Target length: 60s". */
function parseSettings(text) {
  const settings = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*]\s*)?\**\s*(format|aspect|target(?: length)?|fps|resolution)\s*:?\**\s*:?\s*(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase().startsWith("target") ? "target" : m[1].toLowerCase() === "aspect" ? "format" : m[1].toLowerCase();
    settings[key] = m[2].replace(/\*\*/g, "").replace(/\s*\(.*\)$/, "").trim();
  }
  if (settings.target) settings.targetSeconds = parseTime(settings.target.replace(/\s*(sec(onds)?|s)$/i, "")) || null;
  return settings;
}

export function parseEdl(text) {
  const lines = text.split("\n");
  let header = null;
  let headerLine = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const h = cells(lines[i]);
    if (h.some((c) => COLUMNS.type.test(c))) {
      header = h;
      headerLine = i;
      break;
    }
  }
  if (!header) throw new Error("No EDL table found (needs a markdown table with a 'Type' column)");
  const col = {};
  header.forEach((h, idx) => {
    const name = h.replace(/[*_`]/g, "").trim();
    for (const [key, re] of Object.entries(COLUMNS)) if (col[key] == null && re.test(name)) col[key] = idx;
  });

  const rows = [];
  for (let i = headerLine + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const c = cells(line);
    const get = (k) => (col[k] != null ? clean(c[col[k]]) : "");
    const type = normType(get("type"));
    if (!type) continue;
    const [inT, outT] = parseRange(get("range"));
    const [startT, endT] = parseRange(get("out"));
    const overlay = get("overlay");
    const row = {
      n: get("n") || String(rows.length + 1),
      line: i + 1,
      type,
      source: isBlank(get("source")) ? null : get("source"),
      in: inT,
      out: outT,
      start: startT,
      end: endT,
      caption: get("caption"),
      overlay: isBlank(overlay) ? null : overlay,
      preset: isBlank(get("preset")) ? null : get("preset"),
      notes: get("notes"),
    };
    row.opts = parseOptions(row.notes);
    rows.push(row);
  }
  return { settings: parseSettings(lines.slice(0, headerLine).join("\n")), rows };
}

/** "broll/city.mp4 3→6.5" or "broll/photo.jpg" in a cut row's B-roll column. */
export function parseInlineBroll(s) {
  if (!s) return null;
  const m = s.match(/^\s*([^\s]+\.(?:mp4|mov|m4v|mkv|webm|avi|png|jpe?g|webp|gif|heic|heif))\s*(.*)$/i);
  if (!m) return null;
  const [a, b] = parseRange(m[2]);
  return { source: m[1], in: Number.isFinite(a) ? a : 0, out: b };
}

/**
 * Check the EDL against the media and lay it on the output timeline.
 * Returns { timeline, errors, warnings }.
 */
export function resolveEdl(edl, { root, durations }) {
  const errors = [];
  const warnings = [];
  const at = (r) => `row ${r.n} (line ${r.line})`;
  const durationOf = (src) => durations[src];
  const checkSource = (r, src) => {
    if (!src) return errors.push(`${at(r)}: no Source`), false;
    if (!fs.existsSync(path.join(root, src))) return errors.push(`${at(r)}: ${src} not found`), false;
    if (isHeicFile(src))
      return errors.push(`${at(r)}: ${src} is HEIC, which browsers can't display. Export a JPG copy (Preview: File → Export → JPEG) next to it and use that`), false;
    return true;
  };
  // placement for stills: size (fraction of frame width), x/y (centre, 0..1), rotate (deg), border (px)
  const placement = (r) => {
    const p = {};
    for (const k of ["size", "x", "y", "rotate", "border"]) {
      if (r.opts[k] == null) continue;
      const v = k === "border" && r.opts[k] === true ? true : Number(r.opts[k]);
      if (v !== true && !Number.isFinite(v)) errors.push(`${at(r)}: ${k}=${r.opts[k]} is not a number`);
      else p[k] = v;
    }
    if (p.size != null && !(p.size > 0)) errors.push(`${at(r)}: size must be above 0 (a fraction of the frame width)`);
    return Object.keys(p).length ? p : null;
  };

  const cuts = [];
  const overlays = [];
  const brolls = [];
  const audio = [];
  let t = 0;
  for (const r of edl.rows) {
    if (r.type === "cut") {
      if (!checkSource(r, r.source)) continue;
      const dur = durationOf(r.source);
      const out = r.out === Infinity ? dur : r.out;
      if (!Number.isFinite(r.in) || !Number.isFinite(out) || out <= r.in) {
        errors.push(`${at(r)}: In → Out must be two times with Out after In`);
        continue;
      }
      if (dur != null && out > dur + 0.05) warnings.push(`${at(r)}: Out ${out}s is past the end of ${r.source} (${round(dur, 2)}s); clamped`);
      const o = Math.min(out, dur ?? out);
      const cut = { ...r, in: r.in, out: o, start: round(t), end: round(t + (o - r.in)) };
      if (Number.isFinite(r.start) && Math.abs(r.start - cut.start) > 0.1)
        warnings.push(`${at(r)}: Out time ${fmtTime(r.start)} differs from the computed ${fmtTime(cut.start)}; using the computed time`);
      t = cut.end;
      cuts.push(cut);
      const inline = parseInlineBroll(r.overlay);
      if (!inline || !checkSource(r, inline.source)) continue;
      if (isImageFile(inline.source)) {
        // a still covers the whole cut
        if (Number.isFinite(inline.out)) warnings.push(`${at(r)}: ${inline.source} is an image; it shows for the whole cut, so its range is ignored`);
        brolls.push({ ...r, source: inline.source, still: true, place: placement(r), in: 0, out: 0, start: cut.start, end: cut.end, preset: r.opts.broll || null });
      } else {
        const bdur = durationOf(inline.source);
        const len = Math.min(cut.end - cut.start, (Number.isFinite(inline.out) ? inline.out : bdur) - inline.in);
        brolls.push({ ...r, source: inline.source, in: inline.in, out: inline.in + len, start: cut.start, end: round(cut.start + len), preset: r.opts.broll || null });
      }
    }
  }
  const total = round(t);

  for (const r of edl.rows) {
    if (r.type === "cut") continue;
    if (!Number.isFinite(r.start)) {
      errors.push(`${at(r)}: ${r.type} needs an Out time (when it starts on the edit)`);
      continue;
    }
    if (r.type === "broll" && r.source && isImageFile(r.source)) {
      if (!checkSource(r, r.source)) continue;
      if (!(Number.isFinite(r.end) || r.end === Infinity)) {
        errors.push(`${at(r)}: ${r.source} is an image, so it needs Out time "a → b" (e.g. 0:12.00 → 0:14.50) for how long it shows`);
        continue;
      }
      if (Number.isFinite(r.in) || Number.isFinite(r.out)) warnings.push(`${at(r)}: ${r.source} is an image; In → Out is ignored (Out time "a → b" sets how long it shows)`);
      const end = Math.min(total, r.end);
      if (!(end > r.start)) {
        errors.push(`${at(r)}: Out time ${fmtTime(r.start)} → ${fmtTime(r.end)} is empty`);
        continue;
      }
      brolls.push({ ...r, still: true, place: placement(r), in: 0, out: 0, end: round(end) });
    } else if (r.type === "broll") {
      if (!checkSource(r, r.source)) continue;
      const dur = durationOf(r.source);
      const inT = Number.isFinite(r.in) ? r.in : 0;
      let outT = r.out === Infinity || !Number.isFinite(r.out) ? dur : r.out;
      if (Number.isFinite(r.end)) outT = Math.min(outT, inT + (r.end - r.start));
      if (!(outT > inT)) {
        errors.push(`${at(r)}: b-roll In → Out is empty`);
        continue;
      }
      const end = Math.min(total, r.start + (outT - inT));
      brolls.push({ ...r, in: inT, out: inT + (end - r.start), end: round(end) });
    } else if (OVERLAY_TYPES.includes(r.type)) {
      const end =
        r.end === Infinity ? total : Number.isFinite(r.end) ? r.end : Number.isFinite(r.out) && Number.isFinite(r.in) ? r.start + (r.out - r.in) : r.start + 2.5;
      if (!r.caption && !r.overlay) warnings.push(`${at(r)}: ${r.type} has no text (Caption column)`);
      overlays.push({ ...r, end: round(Math.min(end, total)) });
    } else if (r.type === "music" || r.type === "sfx") {
      if (!checkSource(r, r.source)) continue;
      const dur = durationOf(r.source);
      const inT = Number.isFinite(r.in) ? r.in : 0;
      const outT = r.out === Infinity || !Number.isFinite(r.out) ? dur : r.out;
      let end = Number.isFinite(r.end) ? r.end : r.start + (outT - inT);
      end = Math.min(end, total);
      audio.push({ ...r, in: inT, end: round(end) });
    } else {
      warnings.push(`${at(r)}: unknown type "${r.type}" skipped`);
    }
  }
  for (const x of [...brolls, ...overlays, ...audio]) {
    if (x.start >= total) errors.push(`row ${x.n}: starts at ${fmtTime(x.start)}, after the edit ends (${fmtTime(total)})`);
  }
  return { timeline: { duration: total, cuts, brolls, overlays, audio }, errors, warnings };
}

/** A first-pass EDL from the transcript's suggested cuts, for Claude/you to refine. */
export function draftEdl(transcript, { format = "source", target = null } = {}) {
  const rows = [];
  let t = 0;
  const decisions = [];
  for (const src of transcript.sources) {
    const cutsFlagged = !src.note; // with estimated timings, flagged words stay in
    for (const k of src.suggestedKeep) {
      const words = src.words.filter((w) => (w.start + w.end) / 2 >= k.in && (w.start + w.end) / 2 <= k.out && !(cutsFlagged && (w.flag === "retake" || w.flag === "filler")));
      const excerpt = words.map((w) => w.text).join(" ");
      rows.push(`| ${rows.length + 1} | ${fmtTime(t)} | ${src.source} | ${k.in.toFixed(2)} → ${k.out.toFixed(2)} | cut | auto |  |  | ${excerpt.length > 70 ? excerpt.slice(0, 67) + "…" : excerpt} |`);
      t += k.out - k.in;
    }
    for (const r of src.retakes)
      decisions.push(
        cutsFlagged
          ? `- Cut ${r.kind} in ${src.source} at ${fmtTime(src.words[r.dropped[0]].start)}: "${r.text}" (kept the later take)`
          : `- Possible ${r.kind} in ${src.source} at ${fmtTime(src.words[r.dropped[0]].start)}: "${r.text}" (not cut: timing is estimated)`,
      );
    const certain = src.words.filter((w) => w.flag === "filler");
    if (certain.length) decisions.push(`- ${certain.length} filler words (um/uh) in ${src.source} ${cutsFlagged ? "cut" : "flagged, not cut"}`);
    const maybe = src.words.filter((w) => w.flag === "filler?");
    if (maybe.length) decisions.push(`- ${maybe.length} possible filler words in ${src.source} left in (e.g. "${maybe[0].text}" at ${fmtTime(maybe[0].start)})`);
    if (src.note) decisions.push(`- ${src.source}: ${src.note}`);
  }
  return `# Edit decision list

**Format:** ${format}
**Target length:** ${target ? `${target}s` : "(from brief.md)"}
**Runtime:** ${fmtTime(t)} (${t.toFixed(1)} s)

## Decisions to confirm

${decisions.join("\n") || "- (none yet)"}

## Timeline

| # | Out time | Source | In → Out | Type | Caption | B-roll / overlay | Motion preset | Notes |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
}
