import fs from "node:fs";
import path from "node:path";
import { buildComposition } from "./build.mjs";
import { hyperframesBin } from "./transcribe.mjs";
import { projectPaths, readJson, fmtTime } from "./project.mjs";
import { probe } from "./media.mjs";
import { run, round } from "./util.mjs";

// Findings the generated structure triggers by design; reported as counts only.
const EXPECTED = new Set(["timeline_track_too_dense", "composition_file_too_large"]);

export function hf(args, cwd, extra = {}) {
  return run(process.execPath, [hyperframesBin(), ...args], { cwd, env: { HYPERFRAMES_NO_UPDATE_CHECK: "1" }, ...extra });
}

export const MANUAL_CHECKS = [
  "No caption overlaps a face or important b-roll content",
  "No audio pops at cuts",
  "Captions match the spoken words and their timing",
  "Safe zones respected for the platform (9:16: nothing important in the top ~9% or bottom ~30%, nothing under the right-hand buttons)",
  "Music ducks under speech",
];

/** Rebuild the composition from the EDL, then run HyperFrames' checks and the pipeline's own. */
export async function runQa(root, { format, log = () => {} } = {}) {
  const P = projectPaths(root);
  const build = await buildComposition(root, { format, log });
  const errors = [];
  const warnings = [...build.warnings];
  const checks = [];

  // HyperFrames: lint + runtime + layout (overflow, off-screen) + contrast
  let report = null;
  try {
    const { stdout } = await hf(["check", "--json"], P.composition);
    report = JSON.parse(stdout);
  } catch (e) {
    try {
      report = JSON.parse(e.stdout);
    } catch {
      errors.push(`hyperframes check failed to run: ${e.message.split("\n")[0]}`);
    }
  }
  const expected = {};
  if (report) {
    for (const section of ["lint", "runtime", "layout", "motion", "contrast", "craft", "audio"]) {
      for (const f of report[section]?.findings || []) {
        if (f.severity === "info") continue;
        if (EXPECTED.has(f.code)) {
          expected[f.code] = (expected[f.code] || 0) + 1;
          continue;
        }
        const where = [f.selector, f.time != null ? `@${round(f.time, 2)}s` : "", f.sourceFile ? path.basename(f.sourceFile) : ""].filter(Boolean).join(" ");
        const msg = `${section}/${f.code} ${where}: ${f.message}${f.fixHint ? ` (fix: ${f.fixHint})` : ""}`;
        (f.severity === "error" ? errors : warnings).push(msg);
      }
    }
    checks.push({ name: "HyperFrames check (lint, runtime, layout, contrast)", ok: report.ok !== false && !errors.length });
  }

  // runtime vs target (±10%)
  if (build.target) {
    const diff = (build.duration - build.target) / build.target;
    checks.push({ name: `Runtime ${fmtTime(build.duration)} vs target ${fmtTime(build.target)} (${diff >= 0 ? "+" : ""}${Math.round(diff * 100)}%)`, ok: Math.abs(diff) <= 0.1 });
  } else checks.push({ name: `Runtime ${fmtTime(build.duration)} (no target length in the EDL)`, ok: null });

  // fades on every cut
  const index = fs.readFileSync(path.join(P.composition, "index.html"), "utf8");
  const cutVideos = [...index.matchAll(/<video id="cut\d+"[^>]*>/g)].map((m) => m[0]);
  const unfaded = cutVideos.filter((v) => !/data-fade-in=/.test(v)).length;
  checks.push({ name: `Audio fades on every cut (${cutVideos.length - unfaded}/${cutVideos.length})`, ok: unfaded === 0 });

  // caption coverage: words spoken inside the kept ranges vs words captioned
  const transcript = readJson(P.transcript, { sources: [] });
  const bySource = new Map(transcript.sources.map((s) => [s.source, s]));
  let spoken = 0;
  for (const c of build.timeline.cuts) {
    if (/^none$/i.test(c.caption) || c.opts["no-captions"] || (c.caption && !/^auto$/i.test(c.caption))) continue;
    const src = bySource.get(c.source);
    if (!src) continue;
    spoken += src.words.filter((w) => w.flag !== "filler" && (w.start + w.end) / 2 >= c.in && (w.start + w.end) / 2 <= c.out).length;
  }
  if (spoken && build.captionsEnabled) checks.push({ name: `Captions cover ${build.captionWords >= spoken ? spoken : build.captionWords}/${spoken} spoken words`, ok: build.captionWords >= spoken });

  // music ducking
  const music = build.timeline.audio.filter((a) => a.type === "music");
  if (music.length) checks.push({ name: `Music ducks under speech (${music.length} track${music.length > 1 ? "s" : ""})`, ok: build.speech.length > 0 && /data-automation=/.test(index) });

  if (Object.keys(expected).length)
    warnings.push(`Expected for generated edits, not fixed: ${Object.entries(expected).map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  const ok = !errors.length && checks.every((c) => c.ok !== false);
  return { ok, errors, warnings, checks, build };
}

function nextDraftPath(dir, suffix) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 1;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^draft_v(\d+)/);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return path.join(dir, `draft_v${n}${suffix}.mp4`);
}

/** QA, then render a draft (fast) or the final (full quality). */
export async function renderEdit(root, { final = false, format, force = false, fps = 30, log = () => {} } = {}) {
  const P = projectPaths(root);
  const qa = await runQa(root, { format, log });
  if (!qa.ok && !force) return { qa, out: null };
  const suffix = format ? `_${String(format).replace(":", "x")}` : "";
  const out = final ? path.join(P.renders, `final${suffix}.mp4`) : nextDraftPath(P.renders, suffix);
  fs.mkdirSync(P.renders, { recursive: true });
  log(`Rendering ${final ? "final (delivery quality)" : "draft"} → ${path.relative(P.root, out)}…`);
  await hf(["render", "--quality", final ? "delivery" : "draft", "--fps", String(fps), "--output", out, "--quiet"], P.composition);
  const info = await probe(out);
  return { qa, out, info, durationOk: Math.abs(info.duration - qa.build.duration) < 0.25 };
}
