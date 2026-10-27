import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSrt, cuesToWords } from "../src/srt.mjs";
import { alignToAsr, alignFromCues } from "../src/align.mjs";
import { findRetakes, planCuts, remapWords } from "../src/edit.mjs";
import { rulePlan, finalizePlan } from "../src/plan.mjs";
import { groupWords, writeProject } from "../src/compose.mjs";

const SRT = `1
00:00:00,000 --> 00:00:04,000
I need to, I need to support my family.

2
00:00:04,500 --> 00:00:08,000
Where's the money coming from? Six months, maybe.
`;

const timed = (texts, step = 0.3, gapAt = new Set()) => {
  let t = 0;
  return texts.map((text, i) => {
    if (gapAt.has(i)) t += 1;
    const w = { text, start: t, end: t + step - 0.05 };
    t += step;
    return w;
  });
};

test("parses SRT cues and words", () => {
  const cues = parseSrt(SRT);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].start, 4.5);
  const words = cuesToWords(cues);
  assert.equal(words[0].text, "I");
  assert.equal(words.at(-1).text, "maybe.");
  assert.equal(words.at(-1).cue, 1);
});

test("aligns SRT words to ASR timings despite differences", () => {
  const srt = cuesToWords(parseSrt(SRT));
  const asr = timed(["i", "need", "to", "i", "need", "to", "support", "my", "families", "where's", "the", "money", "coming", "from", "6", "months", "maybe"]);
  const { words, matchRatio } = alignToAsr(srt, asr);
  assert.ok(matchRatio > 0.8);
  assert.equal(words.length, srt.length);
  assert.equal(words[6].start, asr[6].start); // support
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start >= words[i - 1].start);
});

test("estimated timings put word boundaries on pauses", () => {
  const cues = parseSrt(SRT);
  const words = alignFromCues(cuesToWords(cues), cues, [{ start: 1.8, end: 2.4 }]);
  assert.ok(words.every((w) => w.end > w.start));
  assert.ok(words.every((w) => !(w.start < 2.4 && w.end > 1.8)), "no word spans the pause");
  assert.ok(words.at(-1).end <= 8.0001);
});

test("finds restarts and stutters", () => {
  const words = timed(["I", "need", "to,", "I", "need", "to", "support", "You,", "you", "go"]);
  const drop = findRetakes(words);
  assert.deepEqual([...drop].sort((a, b) => a - b), [0, 1, 2, 7]);
});

test("cuts long pauses and remaps word times", () => {
  const words = timed(["a", "b", "c", "d"], 0.3, new Set([2]));
  const segments = planCuts(words, 3, { maxPause: 0.4 });
  assert.equal(segments.length, 2);
  const { words: out, duration, cutTimes } = remapWords(words, segments);
  assert.equal(cutTimes.length, 1);
  assert.ok(duration < 3);
  assert.ok(out[2].start - out[1].end < 0.5, "pause shortened");
});

test("rule plan yields valid, non-overlapping beats", () => {
  const words = timed("I think school is the biggest risk. Where is the money coming from? Six months to make money. Then work forever.".split(" "), 0.35);
  const plan = finalizePlan(rulePlan(words), words, words.at(-1).end + 0.5);
  assert.ok(plan.hook.text.length > 0);
  assert.ok(plan.beats.length >= 2);
  for (let i = 1; i < plan.beats.length; i++) assert.ok(plan.beats[i].start >= plan.beats[i - 1].end);
  assert.ok(plan.beats.some((b) => b.template === "counter" && b.value === 6));
});

test("finalizePlan drops malformed AI beats", () => {
  const words = timed(Array.from({ length: 40 }, (_, i) => `w${i}`));
  const plan = finalizePlan(
    {
      hook: { text: "hi" },
      emphasis: [1, 999],
      beats: [
        { startWord: 5, endWord: 9, template: "versus", headline: "", left: { label: "A", icon: "work" }, right: null },
        { startWord: 10, endWord: 14, template: "nope", headline: "x" },
        { startWord: 15, endWord: 20, template: "icon_title", headline: "ok", icon: "not-an-icon" },
      ],
    },
    words,
    13,
  );
  assert.equal(plan.beats.length, 1);
  assert.equal(plan.beats[0].icon, "idea");
  assert.deepEqual([...plan.emphasis], [1]);
});

test("caption groups stay short", () => {
  const words = timed("one two three four five six seven. eight nine".split(" "));
  for (const g of groupWords(words)) assert.ok(g.length <= 3);
});

test("writes a HyperFrames project", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-test-"));
  const footage = path.join(dir, "f.mp4");
  fs.writeFileSync(footage, "");
  const words = timed("Where is the money coming from? Six months.".split(" "), 1.2);
  const theme = JSON.parse(fs.readFileSync(new URL("../brand.json", import.meta.url), "utf8"));
  const plan = finalizePlan(
    {
      hook: { text: "Money" },
      emphasis: [3],
      beats: [
        { startWord: 0, endWord: 5, template: "versus", headline: "", left: { label: "Job", icon: "work" }, right: { label: "Startup", icon: "rocket" } },
        { startWord: 6, endWord: 7, template: "counter", headline: "6 months", value: 6, unit: "months" },
      ],
    },
    words,
    10,
  );
  assert.equal(plan.beats.length, 2);
  const project = path.join(dir, "project");
  writeProject(project, { footage, words, plan, duration: 10, cutTimes: [2.5], theme });
  const index = fs.readFileSync(path.join(project, "index.html"), "utf8");
  assert.match(index, /data-composition-src="compositions\/captions.html"/);
  assert.match(index, /window.__timelines\["main"\]/);
  for (const f of ["captions.html", "hook.html", "beat-01.html", "beat-02.html"]) {
    const html = fs.readFileSync(path.join(project, "compositions", f), "utf8");
    assert.match(html, /^<template>/);
    assert.match(html, /window.__timelines\["/);
  }
  assert.ok(fs.existsSync(path.join(project, "assets", "gsap.min.js")));
  fs.rmSync(dir, { recursive: true, force: true });
});
