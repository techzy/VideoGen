import fs from "node:fs";
import path from "node:path";
import { run, round, debug } from "./util.mjs";
import { fmtTime } from "./project.mjs";

/**
 * Extract frames at a fixed rate and tile them into contact sheets (with a
 * timestamp on each tile when ffmpeg has drawtext) so a reviewer can see a
 * whole clip in a few images.
 */
export async function extractFrames(file, outDir, { fps = 2, sheetCols = 6, sheetRows = 4, tileWidth = 320 } = {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `fps=${fps}`, "-q:v", "3", path.join(outDir, `${base}_%04d.jpg`)]);
  const frames = fs.readdirSync(outDir).filter((f) => f.endsWith(".jpg")).sort();

  const label = `drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
  const tile = `scale=${tileWidth}:-2,tile=${sheetCols}x${sheetRows}:padding=4:color=black`;
  const sheetPattern = path.join(outDir, `${base}_sheet_%02d.jpg`);
  const sheetArgs = (vf) => ["-v", "error", "-y", "-i", file, "-vf", vf, "-q:v", "3", "-fps_mode", "vfr", sheetPattern];
  try {
    await run("ffmpeg", sheetArgs(`fps=${fps},${label},${tile}`));
  } catch {
    debug("drawtext unavailable; contact sheets without timestamps");
    await run("ffmpeg", sheetArgs(`fps=${fps},${tile}`));
  }
  const sheets = fs.readdirSync(outDir).filter((f) => f.includes("_sheet_")).sort();
  return {
    frames: frames.length,
    fps,
    sheets: sheets.map((f) => path.join(outDir, f)),
    secondsPerSheet: (sheetCols * sheetRows) / fps,
  };
}

/**
 * Cuts and the pacing numbers a style spec needs. A frame is a cut when its
 * scene-change score clearly stands out from its neighbours, which catches
 * same-shot jump cuts (scores ~0.1) that a fixed 0.3 threshold misses.
 */
export async function measurePacing(file, duration, { hardThreshold = 0.3 } = {}) {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-i", file, "-an",
    "-vf", "select='gte(scene,0)',metadata=print:key=lavfi.scene_score",
    "-f", "null", "-",
  ]);
  const frames = [];
  let t = null;
  for (const line of stderr.split("\n")) {
    const pt = line.match(/pts_time:([\d.]+)/);
    if (pt) t = Number(pt[1]);
    const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (sc && t != null) frames.push({ t, s: Number(sc[1]) });
  }
  const median = (arr) => [...arr].sort((x, y) => x - y)[Math.floor(arr.length / 2)] ?? 0;
  const cuts = [];
  frames.forEach((f, i) => {
    const local = median(frames.slice(Math.max(0, i - 15), i + 16).map((x) => x.s));
    const isCut = f.s >= hardThreshold || (f.s >= 0.06 && f.s >= local * 5 + 0.02);
    if (isCut && f.t > 0.2 && f.t < duration - 0.2 && (!cuts.length || f.t - cuts.at(-1) > 0.3)) cuts.push(round(f.t, 2));
  });
  const hardCuts = frames.filter((f) => f.s >= hardThreshold).length;
  debug(`${cuts.length} cuts (${hardCuts} above ${hardThreshold})`);
  const bounds = [0, ...cuts, duration];
  const shots = bounds.slice(1).map((end, i) => ({ start: bounds[i], end, length: round(end - bounds[i], 2) }));
  const lengths = shots.map((s) => s.length).sort((a, b) => a - b);
  const medianShot = lengths.length ? lengths[Math.floor(lengths.length / 2)] : duration;
  return {
    duration: round(duration, 2),
    cuts,
    hardCuts,
    shots: shots.length,
    averageShot: round(duration / shots.length, 2),
    medianShot,
    shortestShot: lengths[0],
    longestShot: lengths.at(-1),
    cutsPerMinute: round((cuts.length / duration) * 60, 1),
    shotList: shots.map((s) => `${fmtTime(s.start)}–${fmtTime(s.end)} (${s.length}s)`),
  };
}
