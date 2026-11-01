import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseSrt, cuesToWords } from "../src/srt.mjs";
import { alignToAsr, alignFromCues } from "../src/align.mjs";
import { findRetakes, planCuts } from "../src/edit.mjs";
import { flagFillers, findRestarts } from "../src/transcript.mjs";
import { parseEdl, parseRange, resolveEdl, draftEdl } from "../src/edl.mjs";
import { readStyle, canvasFor } from "../src/style.mjs";
import { buildComposition, captionWords, presetNames } from "../src/build.mjs";
import { parseTime } from "../src/project.mjs";

const timed = (texts, step = 0.3, gapAt = new Set()) => {
  let t = 0;
  return texts.map((text, i) => {
    if (gapAt.has(i)) t += 1;
    const w = { text, start: t, end: t + step - 0.05 };
    t += step;
    return w;
  });
};

const SRT = `1
00:00:00,000 --> 00:00:04,000
I need to, I need to support my family.

2
00:00:04,500 --> 00:00:08,000
Where's the money coming from? Six months, maybe.
`;

test("SRT parsing and alignment", () => {
  const cues = parseSrt(SRT);
  const srt = cuesToWords(cues);
  assert.equal(cues.length, 2);
  const asr = timed(["i", "need", "to", "i", "need", "to", "support", "my", "families", "where's", "the", "money", "coming", "from", "6", "months", "maybe"]);
  const { words, matchRatio } = alignToAsr(srt, asr);
  assert.ok(matchRatio > 0.8);
  assert.equal(words[6].start, asr[6].start);
  const est = alignFromCues(srt, cues, [{ start: 1.8, end: 2.4 }]);
  assert.ok(est.every((w) => !(w.start < 2.4 && w.end > 1.8)), "estimated words avoid the pause");
});

test("fillers: hesitations are certain, comma-set 'like' is a judgment call", () => {
  const f = flagFillers(timed(["So", "um", "I", "like", "pizza,", "like,", "a", "lot"]));
  assert.deepEqual(f, [null, "filler", null, null, null, "filler?", null, null]);
});

test("retakes keep the last take, and complete sentences are never restarts", () => {
  const stutter = timed(["I", "need", "to,", "I", "need", "to", "support", "You,", "you", "go"]);
  assert.deepEqual([...findRetakes(stutter)].sort((a, b) => a - b), [0, 1, 2, 7]);
  const restart = timed(["So", "today", "I", "want", "to—", "so", "today", "I", "want", "to", "talk", "about", "money."]);
  assert.deepEqual(findRestarts(restart), [{ from: 0, to: 4, kept: 5 }]);
  const twoSentences = timed("I think that's the biggest fear. I think that's the biggest risk.".split(" "));
  assert.deepEqual(findRestarts(twoSentences), []);
});

test("suggested cut shortens long pauses", () => {
  const words = timed(["a", "b", "c", "d"], 0.3, new Set([2]));
  assert.equal(planCuts(words, 3, { maxPause: 0.4 }).length, 2);
});

test("time and range parsing", () => {
  assert.equal(parseTime("1:02.5"), 62.5);
  assert.equal(parseTime("00:01:02,500"), 62.5);
  assert.deepEqual(parseRange("12.4 → 15"), [12.4, 15]);
  assert.deepEqual(parseRange("0:12-0:15.5"), [12, 15.5]);
  assert.deepEqual(parseRange("3 to end"), [3, Infinity]);
  assert.ok(Number.isNaN(parseRange("—")[0]));
});

test("EDL parsing: settings, columns by name, options", () => {
  const edl = parseEdl(`# EDL
**Format:** 9:16
**Target length:** 45s

| Type | # | Source | In → Out | Out time | Caption | B-roll / overlay | Motion preset | Notes |
|---|---|---|---|---|---|---|---|---|
| cut | 1 | raw/a.mp4 | 1 → 3 |  | auto | broll/b.mp4 0 → 1 | punchIn | focus=0.4 |
| title | 2 |  |  | 0:00.5 → 0:02 | "Hello" | icon:money | slamUp / liftOut | y=0.2 |
`);
  assert.equal(edl.settings.format, "9:16");
  assert.equal(edl.settings.targetSeconds, 45);
  assert.equal(edl.rows[0].type, "cut");
  assert.equal(edl.rows[0].opts.focus, "0.4");
  assert.equal(edl.rows[1].caption, "Hello");
  assert.equal(edl.rows[1].end, 2);
});

function tinyProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vg-test-"));
  for (const d of ["raw", "broll", "analysis", "plan"]) fs.mkdirSync(path.join(root, d));
  const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30", "-f", "lavfi", "-i", "sine=f=300", "-t", "6", "-pix_fmt", "yuv420p", "-shortest", path.join(root, "raw", "a.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "3", "-pix_fmt", "yuv420p", path.join(root, "broll", "b.mp4")]);
  const words = timed("Hello there this is a test of the captions".split(" "), 0.5).map((w, i) => ({ i, ...w }));
  fs.writeFileSync(path.join(root, "analysis", "transcript.json"), JSON.stringify({ version: 1, sources: [{ source: "raw/a.mp4", words, suggestedKeep: [{ in: 0, out: 2 }, { in: 2.5, out: 5 }], retakes: [] }] }));
  return root;
}

test("resolveEdl lays out the timeline and reports problems", () => {
  const root = tinyProject();
  const edl = parseEdl(`| # | Out time | Source | In → Out | Type | Caption | B-roll / overlay | Motion preset | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | raw/a.mp4 | 1 → 3 | cut | auto | broll/b.mp4 0 → 1 | | |
| 2 | 0:09 | raw/a.mp4 | 4 → 5.5 | cut | auto | | | |
| 3 | 0:01 → 0:02.5 | | | text | Hi | | | |
| 4 | 0:00 | raw/missing.mp4 | 0 → 1 | cut | | | | |
| 5 | 0:00 → end | | | title | Stays up | | none / none | |
`);
  const { timeline, errors, warnings } = resolveEdl(edl, { root, durations: { "raw/a.mp4": 6, "broll/b.mp4": 3 } });
  assert.equal(timeline.duration, 3.5);
  assert.equal(timeline.cuts[1].start, 2);
  assert.equal(timeline.brolls[0].end, 1);
  assert.equal(timeline.overlays[0].end, 2.5);
  assert.equal(timeline.overlays[1].end, 3.5, "→ end runs to the end of the edit");
  assert.ok(errors.some((e) => e.includes("missing.mp4")));
  assert.ok(warnings.some((w) => w.includes("differs from the computed")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("captions map transcript words onto the edit and skip fillers", () => {
  const transcript = { sources: [{ source: "raw/a.mp4", words: [{ text: "um", start: 1, end: 1.2, flag: "filler" }, { text: "hi", start: 1.3, end: 1.6 }, { text: "cut", start: 2.2, end: 2.5 }] }] };
  const cuts = [{ source: "raw/a.mp4", in: 1, out: 2, start: 5, end: 6, caption: "auto", opts: {} }];
  assert.deepEqual(captionWords(cuts, transcript), [{ text: "hi", cut: 0, start: 5.3, end: 5.6 }]);
});

test("style block and canvas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-style-"));
  const f = path.join(dir, "style.md");
  fs.writeFileSync(f, '# Style\n\n```json vg-style\n{ "captions": { "maxWords": 2 } }\n```\n');
  const { style, found } = readStyle(f);
  assert.ok(found);
  assert.equal(style.captions.maxWords, 2);
  assert.equal(style.captions.font, "Inter");
  assert.deepEqual(canvasFor("9:16"), { width: 1080, height: 1920, format: "9:16" });
  assert.equal(canvasFor("source", { width: 1920, height: 1080 }).width, 1920);
  assert.equal(canvasFor("source", { width: 608, height: 1080 }).height, 1918);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion template exposes the documented presets", () => {
  const names = presetNames(new URL("../templates/motion.js", import.meta.url).pathname);
  for (const n of ["cut", "slamUp", "popIn", "zoomIn", "wordStagger", "drawOn"]) assert.ok(names.in.includes(n), n);
  for (const n of ["fadeOut", "liftOut"]) assert.ok(names.out.includes(n), n);
  for (const n of ["none", "punchIn", "slowPush"]) assert.ok(names.frame.includes(n), n);
});

test("build writes a HyperFrames composition and rejects unknown presets", async () => {
  const root = tinyProject();
  const transcript = JSON.parse(fs.readFileSync(path.join(root, "analysis", "transcript.json"), "utf8"));
  fs.writeFileSync(path.join(root, "plan", "edl.md"), draftEdl(transcript, { format: "9:16", target: 4 }));
  const b = await buildComposition(root);
  assert.equal(b.canvas.height, 1920);
  assert.equal(b.cuts, 2);
  const index = fs.readFileSync(path.join(root, "composition", "index.html"), "utf8");
  assert.match(index, /data-media-start="2.5"/);
  assert.match(index, /data-fade-in="0.02"/);
  assert.ok(fs.lstatSync(path.join(root, "composition", "assets", "media", "raw__a.mp4")).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(root, "composition", "compositions", "captions.html")));

  // motion.js is kept between builds
  const motion = path.join(root, "composition", "styles", "motion.js");
  fs.appendFileSync(motion, "\n// tuned\n");
  await buildComposition(root);
  assert.match(fs.readFileSync(motion, "utf8"), /\/\/ tuned/);

  fs.appendFileSync(path.join(root, "plan", "edl.md"), "| 9 | 0:01 → 0:02 |  |  | title | Hi |  | nope |  |\n");
  await assert.rejects(buildComposition(root), /not a in preset/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("image b-roll: held over Out time a → b, inline for a whole cut, HEIC rejected", () => {
  const root = tinyProject();
  const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  ff(["-f", "lavfi", "-i", "testsrc=size=400x300", "-frames:v", "1", path.join(root, "broll", "p.jpg")]);
  fs.writeFileSync(path.join(root, "broll", "q.heic"), "");
  const edl = parseEdl(`| # | Out time | Source | In → Out | Type | Caption | B-roll / overlay | Motion preset | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | raw/a.mp4 | 1 → 3 | cut | auto | broll/p.jpg | | |
| 2 | | raw/a.mp4 | 4 → 5.5 | cut | auto | | | |
| 3 | 0:01 → 0:02.5 | broll/p.jpg | | broll | | | | size=0.6 x=0.4 rotate=-4 border |
| 4 | 0:03 → end | broll/p.jpg | 0 → 9 | broll | | | | |
| 5 | 0:01 | broll/p.jpg | 0 → 1 | broll | | | | |
| 6 | 0:01 → 0:02 | broll/q.heic | | broll | | | | |
| 7 | 0:01 → 0:02 | broll/p.jpg | | broll | | | | size=big |
`);
  const { timeline, errors, warnings } = resolveEdl(edl, { root, durations: { "raw/a.mp4": 6 } });
  const [inline, placed, toEnd] = timeline.brolls;
  assert.deepEqual([inline.still, inline.start, inline.end, inline.place], [true, 0, 2, null], "inline still covers the whole cut");
  assert.deepEqual([placed.start, placed.end], [1, 2.5]);
  assert.deepEqual(placed.place, { size: 0.6, x: 0.4, rotate: -4, border: true });
  assert.equal(toEnd.end, 3.5, "→ end runs to the end of the edit");
  assert.ok(warnings.some((w) => w.includes("row 4") && w.includes("In → Out is ignored")));
  assert.ok(errors.some((e) => e.includes("row 5") && e.includes('needs Out time "a → b"')));
  assert.ok(errors.some((e) => e.includes("row 6") && e.includes("HEIC")));
  assert.ok(errors.some((e) => e.includes("row 7") && e.includes("size=big is not a number")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("build draws stills full-frame or as placed cards", async () => {
  const root = tinyProject();
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=400x200", "-frames:v", "1", path.join(root, "broll", "p.png")]);
  fs.writeFileSync(path.join(root, "plan", "edl.md"), `**Format:** 9:16

| # | Out time | Source | In → Out | Type | Caption | B-roll / overlay | Motion preset | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | raw/a.mp4 | 0 → 4 | cut | auto | | | |
| 2 | 0:00.5 → 0:01.5 | broll/p.png | | broll | | | fadeIn / fadeOut | focus=0.2 |
| 3 | 0:02 → 0:03 | broll/p.png | | broll | | | fadeIn / fadeOut | size=0.5 x=0.25 y=0.5 rotate=5 border=10 |
`);
  const b = await buildComposition(root);
  assert.equal(b.brolls, 2);
  const index = fs.readFileSync(path.join(root, "composition", "index.html"), "utf8");
  assert.match(index, /<img id="broll0" class="clip" src="assets\/media\/broll__p.png" alt="" data-start="0.5" data-duration="1" data-track-index="1" style="object-position: 20% 50%;">/);
  // 540 px wide, 270 tall, centred on (270, 960), plus a 10 px border
  assert.match(index, /<img id="broll1" class="clip placed"[^>]*style="left: -10px; top: 815px; width: 540px; height: 270px; padding: 10px; background: #FFFFFF; transform: rotate\(5deg\);">/);
  assert.match(index, /id="bf1" class="frame" style="z-index:2; transform-origin: 25% 50%"/);
  assert.doesNotMatch(index, /<img[^>]*data-media-start/);
  fs.rmSync(root, { recursive: true, force: true });
});
