/**
 * Parse an SRT file into cues and a flat word list.
 * Words carry the index of the cue they came from; timings are filled in later.
 */

function parseTimestamp(ts) {
  const m = ts.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) throw new Error(`Bad SRT timestamp: "${ts}"`);
  const [, h, mi, s, ms] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

export function parseSrt(text) {
  const blocks = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    const [a, b] = lines[timeIdx].split("-->");
    const start = parseTimestamp(a);
    const end = parseTimestamp(b.trim().split(/\s+/)[0]);
    const body = lines
      .slice(timeIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "") // strip <i>, <b>, <font> tags
      .replace(/\{\\[^}]*\}/g, "") // strip ASS-style tags
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    cues.push({ index: cues.length, start, end, text: body });
  }
  if (!cues.length) throw new Error("No cues found in SRT file");
  cues.sort((x, y) => x.start - y.start);
  return cues;
}

/** Split cue text into display words, keeping punctuation attached to each word. */
export function cuesToWords(cues) {
  const words = [];
  for (const cue of cues) {
    for (const token of cue.text.split(/\s+/)) {
      if (!token) continue;
      words.push({ text: token, cue: cue.index });
    }
  }
  return words;
}
