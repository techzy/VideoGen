import fs from "node:fs";
import path from "node:path";
import { parseSrt, cuesToWords } from "./srt.mjs";
import { probe, extractAudio, detectSilences, frameEnergy } from "./media.mjs";
import { transcribeWords } from "./transcribe.mjs";
import { alignToAsr, alignFromCues, fitToSpeech } from "./align.mjs";
import { findRetakes, planCuts } from "./edit.mjs";
import { normWord, round, log } from "./util.mjs";

const FILLERS = new Set(["um", "uh", "uhm", "umm", "uhh", "erm", "er", "ah", "hmm", "mm", "mhm"]);

/**
 * Flag filler words. Hesitation sounds are certain; "like" / "you know" only
 * when set off by commas, and only as "filler?" (a judgment call).
 */
export function flagFillers(words) {
  const toks = words.map((w) => normWord(w.text));
  return words.map((w, i) => {
    if (FILLERS.has(toks[i])) return "filler";
    const prevComma = i > 0 && /,$/.test(words[i - 1].text);
    const ownComma = /,$/.test(w.text);
    if (toks[i] === "like" && (ownComma || prevComma)) return "filler?";
    if (toks[i] === "you" && toks[i + 1] === "know" && /,$/.test(words[i + 1]?.text ?? "")) return "filler?";
    if (toks[i] === "know" && toks[i - 1] === "you" && ownComma) return "filler?";
    return null;
  });
}

/**
 * Restarts: a phrase abandoned and started again ("So today I want — so
 * today I want to talk about…"). The earlier attempt must share its first
 * 4+ words with the later one, end without finishing a sentence, and be
 * within 15 s. The last take is kept.
 */
export function findRestarts(words) {
  const toks = words.map((w) => normWord(w.text));
  const out = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 2; j < words.length && words[j].start - words[i].start < 15; j++) {
      let k = 0;
      while (j + k < words.length && i + k < j && toks[i + k] && toks[i + k] === toks[j + k]) k++;
      if (k < 4) continue; // shorter repeats are stutters, handled by findRetakes
      const between = words.slice(i, j);
      // an abandoned attempt never completes a sentence
      const finished = between.some((w) => /[.?!]["”']?$/.test(w.text));
      if (finished) continue;
      out.push({ from: i, to: j - 1, kept: j });
      i = j - 1;
      break;
    }
  }
  return out;
}

export function snapEdgesToQuiet(keep, { step, db }, duration, window = 0.12) {
  const level = (t) => db[Math.min(db.length - 1, Math.max(0, Math.round(t / step)))] ?? -99;
  const quietest = (t, lo, hi) => {
    let best = t;
    for (let u = Math.max(lo, t - window); u <= Math.min(hi, t + window); u += step) if (level(u) < level(best) - 0.5) best = u;
    return round(best, 3);
  };
  return keep.map((k, i) => {
    const prevOut = i > 0 ? keep[i - 1].out : 0;
    const nextIn = i < keep.length - 1 ? keep[i + 1].in : duration;
    const inT = k.in > 0.05 && level(k.in) > -32 ? quietest(k.in, prevOut, k.out - 0.1) : k.in;
    const outT = k.out < duration - 0.05 && level(k.out) > -32 ? quietest(k.out, inT + 0.1, nextIn) : k.out;
    return { in: inT, out: outT };
  });
}

function pausesFrom(words, silences, minLength = 0.4) {
  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g >= minLength) gaps.push({ after: i - 1, start: words[i - 1].end, end: words[i].start, length: round(g, 2) });
  }
  if (words.length && words[0].start >= minLength) gaps.unshift({ after: -1, start: 0, end: words[0].start, length: round(words[0].start, 2) });
  return gaps.length ? gaps : silences.filter((s) => s.end - s.start >= minLength).map((s) => ({ ...s, length: round(s.end - s.start, 2) }));
}

/** Word-level transcript of one raw file, with edit suggestions. */
export async function transcribeSource(root, rel, { srt, model = "small.en", asr = true, workDir }) {
  const abs = path.join(root, rel);
  const info = await probe(abs);
  if (!info.hasAudio) throw new Error(`${rel} has no audio track to transcribe`);
  fs.mkdirSync(workDir, { recursive: true });
  const wav = path.join(workDir, path.basename(rel).replace(/\.[^.]+$/, "") + ".wav");
  await extractAudio(abs, wav);
  const silences = await detectSilences(wav);

  let words = null;
  let timing = null;
  let asrError = null;
  let asrWords = null;
  if (asr) {
    try {
      log(`${rel}: transcribing with ${model}…`);
      asrWords = await transcribeWords(wav, path.join(workDir, "asr"), { model });
    } catch (e) {
      asrError = e.message;
      log(`${rel}: speech recognition failed (${asrError})`);
    }
  }
  if (srt) {
    const cues = parseSrt(fs.readFileSync(srt, "utf8"));
    const srtWords = cuesToWords(cues);
    if (asrWords?.length) {
      const aligned = alignToAsr(srtWords, asrWords);
      log(`${rel}: matched ${Math.round(aligned.matchRatio * 100)}% of SRT words to the audio`);
      if (aligned.matchRatio >= 0.6) {
        words = aligned.words;
        timing = "speech-recognition (SRT wording)";
      }
    }
    if (!words) {
      words = alignFromCues(srtWords, cues, silences);
      timing = "estimated from SRT cues";
    }
  } else if (asrWords?.length) {
    words = asrWords;
    timing = "speech-recognition";
  } else {
    throw new Error(
      `No transcript for ${rel}: speech recognition ${asrError ? `failed (${asrError})` : "was turned off"}. Pass --srt <file> to use a subtitle file instead.`,
    );
  }
  words = words
    .map((w) => ({ text: w.text, start: round(Math.min(w.start, info.duration), 3), end: round(Math.min(w.end, info.duration), 3) }))
    .filter((w) => w.text);

  const accurate = timing.startsWith("speech-recognition");
  if (accurate) words = fitToSpeech(words, silences, info.duration);
  const fillers = flagFillers(words);
  const stutters = findRetakes(words);
  const restarts = findRestarts(words);
  const flags = words.map((_, i) => fillers[i]);
  stutters.forEach((i) => (flags[i] = "retake"));
  restarts.forEach((r) => {
    for (let i = r.from; i <= r.to; i++) flags[i] = "retake";
  });

  const retakes = [];
  for (const r of restarts) retakes.push({ kind: "restart", dropped: [r.from, r.to], kept: r.kept, text: words.slice(r.from, r.to + 1).map((w) => w.text).join(" ") });
  const sorted = [...stutters].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length; ) {
    let e = k;
    while (e + 1 < sorted.length && sorted[e + 1] === sorted[e] + 1) e++;
    if (!restarts.some((r) => sorted[k] >= r.from && sorted[k] <= r.to))
      retakes.push({ kind: "stutter", dropped: [sorted[k], sorted[e]], kept: sorted[e] + 1, text: words.slice(sorted[k], sorted[e] + 1).map((w) => w.text).join(" ") });
    k = e + 1;
  }
  retakes.sort((a, b) => a.dropped[0] - b.dropped[0]);

  // Suggested cut: retakes and certain fillers out (only with exact timings), pauses shortened.
  const drop = new Set();
  if (accurate) flags.forEach((f, i) => (f === "retake" || f === "filler") && drop.add(i));
  let keep = planCuts(words, info.duration, { maxPause: 0.4, drop }).map((k) => ({ in: k.start, out: k.end }));
  // cuts that fall mid-speech (around a removed retake) move to the quietest
  // moment nearby: the gap between two words
  const energy = await frameEnergy(wav, 0.01);
  keep = snapEdgesToQuiet(keep, energy, info.duration);
  const runtime = keep.reduce((s, k) => s + (k.out - k.in), 0);

  return {
    source: rel,
    duration: round(info.duration, 3),
    width: info.width,
    height: info.height,
    fps: round(info.fps, 3),
    timing,
    model: asrWords ? model : null,
    words: words.map((w, i) => ({ i, ...w, ...(flags[i] ? { flag: flags[i] } : {}) })),
    pauses: pausesFrom(words, silences),
    retakes,
    suggestedKeep: keep,
    suggestedRuntime: round(runtime, 2),
    note: accurate ? undefined : "Timings are estimated, so fillers and retakes are flagged but not cut in suggestedKeep.",
  };
}
