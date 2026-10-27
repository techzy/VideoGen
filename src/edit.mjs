import { normWord, round } from "./util.mjs";

/**
 * Find stutters and restarts: a run of 1–4 words immediately said again
 * ("I need to, I need to support"). The first copy is dropped. A single
 * repeated word only counts when punctuation marks the break ("You, you").
 */
export function findRetakes(words) {
  const toks = words.map((w) => normWord(w.text));
  const drop = new Set();
  for (let i = 0; i < toks.length; i++) {
    for (let n = 4; n >= 1; n--) {
      if (i + 2 * n > toks.length) continue;
      let same = true;
      for (let k = 0; k < n; k++) {
        if (!toks[i + k] || toks[i + k] !== toks[i + n + k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      if (n === 1 && !/[,—–-]$|\.\.\.$/.test(words[i].text)) continue;
      for (let k = 0; k < n; k++) drop.add(i + k);
      i += n - 1;
      break;
    }
  }
  return drop;
}

/**
 * Decide which stretches of the source to keep: long pauses shrink to a beat,
 * dropped words are cut out, and head/tail silence is trimmed.
 */
export function planCuts(words, duration, { maxPause = 0.4, padBefore = 0.08, padAfter = 0.14, drop = new Set() } = {}) {
  const kept = words.map((w, i) => ({ ...w, i })).filter((w) => !drop.has(w.i));
  if (!kept.length) throw new Error("Nothing left to keep after editing");

  const segments = [];
  let cur = null;
  for (let k = 0; k < kept.length; k++) {
    const w = kept[k];
    const prev = kept[k - 1];
    const contiguous = prev && w.i === prev.i + 1;
    const gap = prev ? w.start - prev.end : Infinity;
    if (cur && contiguous && gap <= maxPause) {
      cur.end = w.end;
    } else {
      if (cur) segments.push(cur);
      cur = { start: w.start, end: w.end };
    }
  }
  segments.push(cur);

  // pad each segment, without overlapping its neighbours or the file edges
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    const lo = k > 0 ? segments[k - 1].end : 0;
    const hi = k < segments.length - 1 ? segments[k + 1].start : duration;
    const before = k === 0 ? 0.15 : padBefore;
    const after = k === segments.length - 1 ? 0.45 : padAfter;
    s.start = Math.max(lo, s.start - before, 0);
    s.end = Math.min(hi, s.end + after, duration);
  }
  // fold touching segments together
  const merged = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && s.start - last.end < 0.04) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.map((s) => ({ start: round(s.start), end: round(s.end) }));
}

/** Map source times to the edited timeline and keep only the surviving words. */
export function remapWords(words, segments, drop = new Set()) {
  const offsets = [];
  let acc = 0;
  for (const s of segments) {
    offsets.push(acc);
    acc += s.end - s.start;
  }
  const map = (t) => {
    for (let k = 0; k < segments.length; k++) {
      const s = segments[k];
      if (t < s.start) return offsets[k];
      if (t <= s.end) return offsets[k] + (t - s.start);
    }
    return acc;
  };
  const out = [];
  words.forEach((w, i) => {
    if (drop.has(i)) return;
    out.push({ ...w, start: round(map(w.start)), end: round(map(w.end)) });
  });
  return {
    words: out,
    duration: round(acc),
    cutTimes: offsets.slice(1).map((t) => round(t)),
  };
}
