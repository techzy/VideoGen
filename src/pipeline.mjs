import fs from "node:fs";
import path from "node:path";
import { parseSrt, cuesToWords } from "./srt.mjs";
import { probe, extractAudio, detectSilences, renderCut } from "./media.mjs";
import { transcribeWords, hyperframesBin } from "./transcribe.mjs";
import { alignToAsr, alignFromCues } from "./align.mjs";
import { findRetakes, planCuts, remapWords } from "./edit.mjs";
import { rulePlan, finalizePlan } from "./plan.mjs";
import { aiPlan } from "./ai-plan.mjs";
import { writeProject, W, H } from "./compose.mjs";
import { run, log, debug, round } from "./util.mjs";

export async function generate(opts) {
  const {
    video,
    srt,
    out,
    workDir,
    brand,
    quality = "looks",
    asr = true,
    whisperModel = "small.en",
    ai = true,
    cutPauses = true,
    cutRetakes = true,
    maxPause = 0.4,
    render = true,
    planFile = null,
    fps = 30,
  } = opts;

  fs.mkdirSync(workDir, { recursive: true });
  const theme = JSON.parse(fs.readFileSync(brand, "utf8"));

  // 1. inputs
  const info = await probe(video);
  log(`Video: ${info.width}×${info.height}, ${round(info.fps, 2)} fps, ${round(info.duration, 2)} s`);
  if (info.width / info.height > 0.75) log(`Note: source is not vertical; it will be center-cropped to 9:16`);
  const cues = parseSrt(fs.readFileSync(srt, "utf8"));
  const srtWords = cuesToWords(cues);
  log(`Transcript: ${cues.length} cues, ${srtWords.length} words`);

  // 2. word timings
  const wav = path.join(workDir, "audio.wav");
  await extractAudio(video, wav);
  const silences = await detectSilences(wav);
  let words = null;
  let accurate = false;
  if (asr) {
    try {
      log(`Timing every word with local speech recognition (${whisperModel})…`);
      const asrWords = await transcribeWords(wav, path.join(workDir, "asr"), { model: whisperModel });
      const aligned = alignToAsr(srtWords, asrWords);
      log(`Matched ${Math.round(aligned.matchRatio * 100)}% of transcript words to the audio`);
      if (aligned.matchRatio >= 0.6) {
        words = aligned.words;
        accurate = true;
      } else log("Too few words matched; estimating timings from the SRT cues instead");
    } catch (e) {
      log(`Speech recognition unavailable (${e.message.split("\n")[0]}); estimating word timings from the SRT cues`);
    }
  }
  if (!words) words = alignFromCues(srtWords, cues, silences);
  words = words.map((w) => ({ ...w, start: Math.min(w.start, info.duration), end: Math.min(w.end, info.duration) }));

  // 3. edit: tighten pauses, drop restarts
  const drop = cutRetakes && accurate ? findRetakes(words) : new Set();
  if (cutRetakes && !accurate) log("Skipping retake removal: it needs exact word timings from speech recognition");
  if (drop.size) log(`Removing ${drop.size} repeated words: ${[...drop].map((i) => words[i].text).join(" ")}`);
  const segments = cutPauses || drop.size ? planCuts(words, info.duration, { maxPause, drop }) : [{ start: 0, end: info.duration }];
  const edited = remapWords(words, segments, drop);
  log(`Edit: ${segments.length} segments, ${round(info.duration, 1)} s → ${round(edited.duration, 1)} s`);
  const footage = path.join(workDir, "footage.mp4");
  await renderCut(video, segments, footage, { width: W, height: H, fps });

  // 4. plan the graphics
  let rawPlan = null;
  if (planFile) {
    rawPlan = { source: `file ${path.basename(planFile)}`, ...JSON.parse(fs.readFileSync(planFile, "utf8")) };
    delete rawPlan.words;
  } else {
    rawPlan = ai ? await aiPlan(edited.words, edited.duration, { log }) : null;
    if (ai && !rawPlan && !process.env.ANTHROPIC_API_KEY) log("No ANTHROPIC_API_KEY set; planning scenes with built-in rules");
    if (!rawPlan) rawPlan = rulePlan(edited.words);
  }
  // the editable plan: word indices refer to the words listed at the bottom
  fs.writeFileSync(
    path.join(workDir, "scene-plan.json"),
    JSON.stringify({ hook: rawPlan.hook, emphasis: rawPlan.emphasis, beats: rawPlan.beats, words: edited.words.map((w, i) => `${i} ${w.start.toFixed(2)} ${w.text}`) }, null, 2),
  );
  const plan = finalizePlan(rawPlan, edited.words, edited.duration);
  log(`Plan (${plan.source}): hook "${plan.hook?.text ?? "-"}", ${plan.beats.length} graphic beats, ${plan.emphasis.size} emphasized words`);
  for (const b of plan.beats) debug(`${b.start.toFixed(2)}–${b.end.toFixed(2)} ${b.template} ${b.headline || `${b.left?.label} vs ${b.right?.label}`}`);

  // 5. write the HyperFrames project
  const projectDir = path.join(workDir, "project");
  fs.rmSync(projectDir, { recursive: true, force: true });
  writeProject(projectDir, {
    footage,
    words: edited.words,
    plan,
    duration: edited.duration,
    cutTimes: edited.cutTimes,
    theme,
    themeDir: path.dirname(brand),
  });
  fs.writeFileSync(
    path.join(workDir, "plan.json"),
    JSON.stringify(
      { source: plan.source, timing: accurate ? "speech-recognition" : "estimated", duration: edited.duration, segments, hook: plan.hook, beats: plan.beats, emphasis: [...plan.emphasis], words: edited.words },
      null,
      2,
    ),
  );
  log(`HyperFrames project: ${projectDir}`);

  // 6. check + render
  const hf = (args, extra = {}) => run(process.execPath, [hyperframesBin(), ...args], { cwd: projectDir, env: { HYPERFRAMES_NO_UPDATE_CHECK: "1" }, ...extra });
  try {
    await hf(["lint"]);
  } catch (e) {
    throw new Error(`The generated project failed HyperFrames lint:\n${e.stdout || ""}${e.stderr || ""}`);
  }
  if (!render) return { projectDir, plan };

  log(`Rendering (${quality})…`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  await hf(["render", "--quality", quality, "--fps", String(fps), "--output", outAbs, "--quiet"], {
    onStderr: (s) => debug(s.trim()),
  });
  const rendered = await probe(outAbs);
  log(`Done: ${outAbs} (${rendered.width}×${rendered.height}, ${round(rendered.duration, 2)} s)`);
  return { projectDir, plan, out: outAbs };
}
