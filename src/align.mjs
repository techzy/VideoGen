import { normWord, round } from "./util.mjs";

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * Give every SRT word the timing of the ASR word it lines up with
 * (Needleman–Wunsch over normalized tokens). SRT words with no partner are
 * interpolated between their timed neighbours. Returns a new word list.
 */
export function alignToAsr(srtWords, asrWords) {
  const A = srtWords.map((w) => normWord(w.text));
  const B = asrWords.map((w) => normWord(w.text));
  const n = A.length;
  const m = B.length;
  const GAP = 0.7;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 diag, 2 up, 3 left
  for (let i = 1; i <= n; i++) (cost[i][0] = i * GAP), (move[i][0] = 2);
  for (let j = 1; j <= m; j++) (cost[0][j] = j * GAP), (move[0][j] = 3);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(A[i - 1], B[j - 1]);
      const sub = sim >= 0.999 ? 0 : sim >= 0.6 ? 0.4 : 1.1;
      const d = cost[i - 1][j - 1] + sub;
      const u = cost[i - 1][j] + GAP;
      const l = cost[i][j - 1] + GAP;
      if (d <= u && d <= l) (cost[i][j] = d), (move[i][j] = 1);
      else if (u <= l) (cost[i][j] = u), (move[i][j] = 2);
      else (cost[i][j] = l), (move[i][j] = 3);
    }
  }
  const pairing = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const mv = move[i][j];
    if (mv === 1) {
      if (similarity(A[i - 1], B[j - 1]) >= 0.34) pairing[i - 1] = j - 1;
      i--, j--;
    } else if (mv === 2) i--;
    else j--;
  }

  const out = srtWords.map((w, i) => {
    const p = pairing[i];
    return p >= 0 ? { ...w, start: asrWords[p].start, end: asrWords[p].end, timed: true } : { ...w, timed: false };
  });
  fillGaps(out);
  const matched = pairing.filter((p) => p >= 0).length;
  return { words: out, matchRatio: n ? matched / n : 0 };
}

/** Interpolate untimed words between timed neighbours, weighted by length. */
function fillGaps(words) {
  let i = 0;
  while (i < words.length) {
    if (words[i].timed) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && !words[j].timed) j++;
    const from = i > 0 ? words[i - 1].end : Math.max(0, (words[j]?.start ?? 0) - 0.3 * (j - i));
    const to = j < words.length ? words[j].start : from + 0.3 * (j - i);
    const run = words.slice(i, j);
    const weights = run.map((w) => normWord(w.text).length + 1);
    const total = weights.reduce((s, x) => s + x, 0);
    let t = from;
    run.forEach((w, k) => {
      const d = ((to - from) * weights[k]) / total;
      w.start = round(t);
      w.end = round(t + Math.max(0.05, d));
      t += d;
    });
    i = j;
  }
  // keep strictly ordered, non-overlapping
  for (let k = 1; k < words.length; k++) {
    if (words[k].start < words[k - 1].start) words[k].start = words[k - 1].start;
    if (words[k - 1].end > words[k].start) words[k - 1].end = words[k].start;
    if (words[k].end < words[k].start + 0.04) words[k].end = round(words[k].start + 0.04);
  }
}

/** Rough syllable count: the weight a word gets when spreading time over speech. */
function syllables(text) {
  const w = normWord(text);
  if (!w) return 1;
  if (/^\d+$/.test(w)) return w.length * 1.5;
  const groups = w.match(/[aeiouy]+/g)?.length ?? 1;
  return Math.max(1, groups - (w.endsWith("e") && groups > 1 ? 1 : 0));
}

/**
 * No ASR available: spread each cue's words over the speech inside the cue
 * (cue window minus detected silences), weighted by syllables. Sentence and
 * clause ends are nudged onto pauses when one is close.
 */
export function alignFromCues(srtWords, cues, silences) {
  const out = srtWords.map((w) => ({ ...w }));
  for (const cue of cues) {
    const idx = out.map((w, i) => (w.cue === cue.index ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const speech = speechIntervals(cue.start, cue.end, silences);
    const total = speech.reduce((s, x) => s + (x.end - x.start), 0);
    const weights = idx.map((i) => syllables(out[i].text) + 0.4);
    const wsum = weights.reduce((s, x) => s + x, 0);

    // Each word belongs to the stretch of speech its midpoint lands in (in
    // "speech time", pauses removed), so word boundaries fall on real pauses.
    const bucket = speech.map(() => []);
    let acc = 0;
    let ivAcc = 0;
    let iv = 0;
    idx.forEach((i, k) => {
      const d = (total * weights[k]) / wsum;
      const mid = acc + d / 2;
      while (iv < speech.length - 1 && mid > ivAcc + (speech[iv].end - speech[iv].start)) {
        ivAcc += speech[iv].end - speech[iv].start;
        iv++;
      }
      bucket[iv].push(k);
      acc += d;
    });
    bucket.forEach((ks, b) => {
      if (!ks.length) return;
      const { start, end } = speech[b];
      const sum = ks.reduce((s, k) => s + weights[k], 0);
      let t = start;
      for (const k of ks) {
        const d = ((end - start) * weights[k]) / sum;
        out[idx[k]].start = round(t);
        out[idx[k]].end = round(t + d);
        t += d;
      }
    });
  }
  for (let k = 1; k < out.length; k++) {
    if (out[k].start < out[k - 1].end) out[k].start = out[k - 1].end;
    if (out[k].end <= out[k].start) out[k].end = round(out[k].start + 0.05);
  }
  return out.map((w) => ({ ...w, timed: false }));
}

function speechIntervals(start, end, silences) {
  const ivs = [];
  let t = start;
  for (const s of silences) {
    if (s.end <= start || s.start >= end) continue;
    const a = Math.max(start, s.start);
    if (a > t + 0.02) ivs.push({ start: t, end: a });
    t = Math.min(end, s.end);
  }
  if (end > t + 0.02) ivs.push({ start: t, end });
  return ivs.length ? ivs : [{ start, end }];
}
