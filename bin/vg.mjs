#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { projectPaths, listMedia, writeIfMissing, readJson, fmtTime, MEDIA_DIRS, isAudioFile } from "../src/project.mjs";
import { probe, probeDuration } from "../src/media.mjs";
import { extractFrames, measurePacing } from "../src/analyze.mjs";
import { transcribeSource } from "../src/transcript.mjs";
import { draftEdl } from "../src/edl.mjs";
import { buildComposition } from "../src/build.mjs";
import { runQa, renderEdit, hf, MANUAL_CHECKS } from "../src/qa.mjs";
import { setVerbose, log, round } from "../src/util.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(REPO, "templates");

const HELP = `vg: helper commands for the /edit-video pipeline (HyperFrames)

Run inside a project folder (or pass --project <dir>):
  project/raw  broll  reference  music  brief.md

Phase 1  reference analysis
  vg init [dir]              Create the folder layout, brief.md and CHANGELOG.md
  vg probe                   Probe every media file → analysis/media.json
  vg reference [files…]      Frames + contact sheets + cut/pacing stats for each reference
                             (--fps N; default 2, or 5 for clips under 20 s)
Phase 2  footage prep
  vg transcribe [files…]     Word-level transcript of raw/ → analysis/transcript.json, with
                             fillers, pauses and retakes flagged and a suggested cut
                             (--model small.en, --srt file.srt, --no-asr)
  vg broll                   Frames + contact sheets of broll/ → analysis/broll_index.md rows
Phase 3  edit plan
  vg edl-draft               First-pass plan/edl.md from the transcript's suggested cut
                             (--format 9:16|16:9|1:1|4:5|source, --target 60, --force)
Phase 4–6  build, QA, render
  vg build                   plan/edl.md + analysis/style.md → composition/
  vg qa                      Rebuild, then HyperFrames check + pipeline checks
  vg render                  QA, then renders/draft_vN.mp4 (draft quality)
  vg render --final          QA, then renders/final.mp4 (delivery quality)
  vg snapshot --at 1.5,8,20  PNG frames of the composition to look at
  vg preview                 Open the HyperFrames preview server for composition/

Options for build/qa/render: --phone (9:16) or --format <ratio> overrides the EDL's format
  --force   render even when QA fails

Setup
  vg setup                   Install the /edit-video skill for Claude Code and headless Chrome
`;

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string", short: "p" },
    fps: { type: "string" },
    model: { type: "string", default: "small.en" },
    srt: { type: "string" },
    "no-asr": { type: "boolean", default: false },
    format: { type: "string" },
    phone: { type: "boolean", default: false },
    target: { type: "string" },
    force: { type: "boolean", default: false },
    final: { type: "boolean", default: false },
    at: { type: "string" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
setVerbose(a.verbose);
const [cmd, ...args] = positionals;
if (a.help || !cmd) {
  console.log(HELP);
  process.exit(cmd || a.help ? 0 : 1);
}

const root = path.resolve(a.project ?? (cmd === "init" && args[0] ? args[0] : "."));
const P = projectPaths(root);
const format = a.phone ? "9:16" : a.format;
const rel = (f) => path.relative(process.cwd(), f) || ".";

function resolveFiles(dir, given) {
  if (given.length) return given.map((f) => path.relative(root, path.resolve(f)));
  return listMedia(root, dir);
}

function printQa(q) {
  for (const c of q.checks) console.log(`  ${c.ok === true ? "✓" : c.ok === false ? "✗" : "·"} ${c.name}`);
  for (const e of q.errors) console.log(`  ✗ ${e}`);
  for (const w of q.warnings) console.log(`  ! ${w}`);
  console.log(`\n  Check by eye (vg snapshot):\n${MANUAL_CHECKS.map((m) => `  [ ] ${m}`).join("\n")}`);
}

const commands = {
  async init() {
    for (const d of [...MEDIA_DIRS, "analysis", "plan", "renders"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    const made = [];
    if (writeIfMissing(P.brief, fs.readFileSync(path.join(TEMPLATES, "brief.md"), "utf8"))) made.push("brief.md");
    if (writeIfMissing(P.changelog, "# Changelog\n\nOne line per revision round.\n\n")) made.push("CHANGELOG.md");
    console.log(`Project ready at ${rel(root)}${made.length ? ` (created ${made.join(", ")})` : ""}.`);
    console.log("Put footage in raw/, b-roll in broll/, examples in reference/, music in music/, and fill in brief.md.");
  },

  async probe() {
    const out = {};
    for (const dir of MEDIA_DIRS) {
      for (const f of listMedia(root, dir, { audio: true })) {
        const abs = path.join(root, f);
        try {
          out[f] = isAudioFile(f) ? { duration: round(await probeDuration(abs), 3), audioOnly: true } : await probe(abs);
        } catch (e) {
          out[f] = { error: e.message.split("\n")[0] };
        }
        const i = out[f];
        console.log(
          `${f.padEnd(40)} ${i.error ? `ERROR ${i.error}` : i.audioOnly ? `audio ${fmtTime(i.duration)}` : `${i.width}×${i.height} ${round(i.fps, 2)}fps ${fmtTime(i.duration)}${i.hasAudio ? "" : " (no audio)"}`}`,
        );
      }
    }
    fs.mkdirSync(P.analysis, { recursive: true });
    fs.writeFileSync(P.media, JSON.stringify(out, null, 2));
    console.log(`→ ${rel(P.media)}`);
  },

  async reference() {
    const files = resolveFiles("reference", args);
    if (!files.length) throw new Error("No reference videos in reference/");
    const summary = {};
    for (const f of files) {
      const abs = path.join(root, f);
      const info = await probe(abs);
      const fps = Number(a.fps) || (info.duration < 20 ? 5 : 2);
      const name = path.basename(f).replace(/\.[^.]+$/, "");
      const frames = await extractFrames(abs, path.join(P.frames, "reference", name), { fps });
      const pacing = await measurePacing(abs, info.duration);
      summary[f] = { ...info, framesFps: fps, sheets: frames.sheets.map((s) => path.relative(root, s)), secondsPerSheet: frames.secondsPerSheet, pacing };
      console.log(`\n${f}: ${info.width}×${info.height}, ${fmtTime(info.duration)}`);
      console.log(`  ${pacing.shots} shots, avg ${pacing.averageShot}s (median ${pacing.medianShot}s), ${pacing.cutsPerMinute} cuts/min`);
      console.log(`  ${frames.frames} frames at ${fps} fps; contact sheets (${frames.secondsPerSheet}s each):`);
      for (const s of frames.sheets) console.log(`    ${rel(s)}`);
    }
    fs.mkdirSync(P.analysis, { recursive: true });
    fs.writeFileSync(path.join(P.analysis, "reference.json"), JSON.stringify(summary, null, 2));
    if (writeIfMissing(P.style, fs.readFileSync(path.join(TEMPLATES, "style.md"), "utf8"))) console.log(`\nCreated ${rel(P.style)} from the template.`);
    console.log(`→ ${rel(path.join(P.analysis, "reference.json"))}`);
  },

  async transcribe() {
    const files = resolveFiles("raw", args);
    if (!files.length) throw new Error("No footage in raw/");
    if (a.srt && files.length > 1) throw new Error("--srt applies to one file; pass that file's path too");
    const existing = readJson(P.transcript, { version: 1, sources: [] });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "vg-"));
    try {
      for (const f of files) {
        const t = await transcribeSource(root, f, { srt: a.srt && path.resolve(a.srt), model: a.model, asr: !a["no-asr"], workDir: path.join(work, String(files.indexOf(f))) });
        existing.sources = existing.sources.filter((s) => s.source !== f).concat(t);
        const flagged = (k) => t.words.filter((w) => w.flag === k).length;
        console.log(`\n${f}: ${t.words.length} words, timing: ${t.timing}`);
        console.log(`  fillers ${flagged("filler")} (+${flagged("filler?")} possible), retakes ${t.retakes.length}, pauses ≥0.4s ${t.pauses.length}`);
        console.log(`  suggested cut: ${t.suggestedKeep.length} segments, ${fmtTime(t.duration)} → ${fmtTime(t.suggestedRuntime)}`);
        for (const r of t.retakes) console.log(`  retake @${fmtTime(t.words[r.dropped[0]].start)}: "${r.text}"`);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    existing.sources.sort((x, y) => x.source.localeCompare(y.source));
    fs.mkdirSync(P.analysis, { recursive: true });
    fs.writeFileSync(P.transcript, JSON.stringify(existing, null, 2));
    console.log(`→ ${rel(P.transcript)}`);
  },

  async broll() {
    const files = resolveFiles("broll", args);
    if (!files.length) throw new Error("No clips in broll/");
    const rows = [];
    for (const f of files) {
      const abs = path.join(root, f);
      const info = await probe(abs);
      const name = path.basename(f).replace(/\.[^.]+$/, "");
      const frames = await extractFrames(abs, path.join(P.frames, "broll", name), { fps: Number(a.fps) || 1 });
      console.log(`${f}: ${info.width}×${info.height}, ${fmtTime(info.duration)}${info.hasAudio ? ", has audio" : ""}`);
      for (const s of frames.sheets) console.log(`  ${rel(s)}`);
      rows.push({ f, info, sheets: frames.sheets.map((s) => path.relative(root, s)) });
    }
    let index = fs.existsSync(P.brollIndex)
      ? fs.readFileSync(P.brollIndex, "utf8")
      : `# B-roll index\n\nWhat each clip shows, its best usable range, and the topics it fits. Contact sheets: analysis/frames/broll/.\n\n| Clip | Length | Size | What it shows | Best range | Fits topics | Contact sheets |\n|---|---|---|---|---|---|---|\n`;
    let added = 0;
    for (const r of rows) {
      if (index.includes(`| ${r.f} |`)) continue;
      index = index.trimEnd() + `\n| ${r.f} | ${fmtTime(r.info.duration)} | ${r.info.width}×${r.info.height} | (?) | (?) | (?) | ${r.sheets.join(", ")} |\n`;
      added++;
    }
    fs.writeFileSync(P.brollIndex, index);
    console.log(`→ ${rel(P.brollIndex)} (${added} new row${added === 1 ? "" : "s"}; fill in the (?) columns)`);
  },

  async "edl-draft"() {
    const transcript = readJson(P.transcript);
    if (!transcript?.sources?.length) throw new Error("No analysis/transcript.json yet; run vg transcribe");
    if (fs.existsSync(P.edl) && !a.force) throw new Error(`${rel(P.edl)} exists; pass --force to replace it`);
    fs.mkdirSync(path.dirname(P.edl), { recursive: true });
    fs.writeFileSync(P.edl, draftEdl(transcript, { format: format || "source", target: a.target ? Number(a.target) : null }));
    console.log(`→ ${rel(P.edl)}`);
  },

  async build() {
    const b = await buildComposition(root, { format, log });
    console.log(`Built ${rel(P.composition)}: ${b.canvas.width}×${b.canvas.height} (${b.canvas.format}), ${fmtTime(b.duration)}`);
    console.log(`  ${b.cuts} cuts, ${b.brolls} b-roll, ${b.overlays} text overlays, ${b.audio} audio, ${b.captionWords} caption words in ${b.captionGroups} groups`);
    if (b.target) console.log(`  target ${fmtTime(b.target)} (${Math.round(((b.duration - b.target) / b.target) * 100)}%)`);
    for (const w of b.warnings) console.log(`  ! ${w}`);
  },

  async qa() {
    const q = await runQa(root, { format, log });
    console.log(`QA ${q.ok ? "passed" : "FAILED"} for ${rel(P.composition)} (${fmtTime(q.build.duration)})`);
    printQa(q);
    if (!q.ok) process.exitCode = 1;
  },

  async render() {
    const r = await renderEdit(root, { final: a.final, format, force: a.force, log });
    console.log(`QA ${r.qa.ok ? "passed" : "FAILED"}`);
    printQa(r.qa);
    if (!r.out) {
      console.log("\nNot rendered: fix the QA failures above, or pass --force.");
      process.exitCode = 1;
      return;
    }
    console.log(`\nRendered ${rel(r.out)}: ${r.info.width}×${r.info.height}, ${fmtTime(r.info.duration)}${r.durationOk ? "" : ` (expected ${fmtTime(r.qa.build.duration)}!)`}`);
  },

  async snapshot() {
    if (!fs.existsSync(path.join(P.composition, "index.html"))) throw new Error("No composition yet; run vg build");
    const { stdout } = await hf(["snapshot", ...(a.at ? ["--at", a.at] : [])], P.composition);
    const files = [...stdout.matchAll(/(\S+\.(?:png|jpg))/g)].map((m) => m[1]);
    for (const f of files) console.log(rel(f));
  },

  async preview() {
    await hf(["preview"], P.composition, { quiet: false });
  },

  async setup() {
    const skills = path.join(os.homedir(), ".claude", "skills");
    const dest = path.join(skills, "edit-video");
    const src = path.join(REPO, ".claude", "skills", "edit-video");
    fs.mkdirSync(skills, { recursive: true });
    let linked = false;
    try {
      const st = fs.lstatSync(dest);
      if (st.isSymbolicLink()) fs.unlinkSync(dest);
      else console.log(`! ${dest} exists and is not a link; leaving it alone`);
    } catch {}
    if (!fs.existsSync(dest)) {
      fs.symlinkSync(src, dest);
      linked = true;
    }
    console.log(linked ? `Installed the /edit-video skill: ${dest} → ${src}` : "Skill not installed (see above).");
    console.log("Making sure HyperFrames has headless Chrome…");
    await hf(["browser", "ensure"], REPO, { quiet: false });
  },
};

if (!commands[cmd]) {
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exit(2);
}
try {
  await commands[cmd]();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
