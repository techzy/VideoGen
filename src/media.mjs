import { spawn } from "node:child_process";
import { run, round, debug } from "./util.mjs";

export async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate:stream_side_data=rotation:stream_tags=rotate",
    "-of", "json",
    file,
  ]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error(`${file} has no video stream`);
  if (!a) throw new Error(`${file} has no audio stream`);
  const [num, den] = v.r_frame_rate.split("/").map(Number);
  let rotation = Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0);
  // ffmpeg auto-rotates on decode, so report the displayed size
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    duration: Number(info.format.duration),
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: den ? num / den : 30,
  };
}

export async function extractAudio(video, outWav) {
  await run("ffmpeg", ["-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", outWav]);
}

/**
 * Find pauses from 20 ms frame energy. The threshold sits between the
 * noise floor and typical speech level, so a car, a noisy room and a quiet
 * studio all work without tuning.
 */
export async function detectSilences(file, { minDuration = 0.18 } = {}) {
  const rate = 16000;
  const pcm = await new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"]);
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg could not decode the audio"))));
  });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const hop = rate * 0.02;
  const db = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let k = i; k < i + hop; k++) sum += samples[k] * samples[k];
    db.push(10 * Math.log10(sum / hop / 32768 ** 2 + 1e-12));
  }
  if (!db.length) return [];
  // light smoothing so single quiet frames inside words don't count
  const sm = db.map((_, i) => {
    const w = db.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((s, x) => s + x, 0) / w.length;
  });
  const sorted = [...sm].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const speech = sorted[Math.floor(sorted.length * 0.8)];
  const threshold = floor + Math.max(4, (speech - floor) * 0.35);
  debug(`noise floor ${round(floor, 1)} dB, speech ${round(speech, 1)} dB → pause threshold ${round(threshold, 1)} dB`);

  const silences = [];
  let open = null;
  sm.forEach((v, i) => {
    if (v < threshold) {
      if (open == null) open = i;
    } else if (open != null) {
      if ((i - open) * 0.02 >= minDuration) silences.push({ start: round(open * 0.02), end: round(i * 0.02) });
      open = null;
    }
  });
  if (open != null && (sm.length - open) * 0.02 >= minDuration) silences.push({ start: round(open * 0.02), end: Infinity });
  return silences;
}

/**
 * Cut the kept segments out of the source, scale/crop to the canvas and
 * re-encode with a keyframe every second (HyperFrames seeks frame by frame).
 */
export async function renderCut(input, segments, out, { width, height, fps }) {
  const parts = [];
  const labels = [];
  const fade = 0.012; // tiny audio fades hide clicks at each cut
  segments.forEach((seg, i) => {
    const d = seg.end - seg.start;
    parts.push(
      `[0:v]trim=start=${round(seg.start)}:end=${round(seg.end)},setpts=PTS-STARTPTS,` +
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}[v${i}]`,
      `[0:a]atrim=start=${round(seg.start)}:end=${round(seg.end)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=${fade},afade=t=out:st=${round(Math.max(0, d - fade))}:d=${fade}[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`);
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", input,
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
    "-g", String(Math.round(fps)), "-keyint_min", String(Math.round(fps)),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    out,
  ]);
}
