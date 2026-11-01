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
  const [num, den] = v.r_frame_rate.split("/").map(Number);
  let rotation = Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0);
  // ffmpeg auto-rotates on decode, so report the displayed size
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    duration: Number(info.format.duration),
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: den ? num / den : 30,
    hasAudio: Boolean(a),
  };
}

/** Pixel size of a still image (it has no duration). */
export async function probeImage(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file]);
  const v = JSON.parse(stdout).streams?.[0];
  if (!v?.width || !v?.height) throw new Error(`Could not read the size of ${file}`);
  return { duration: null, width: v.width, height: v.height, image: true };
}

/** Duration of any media file, audio-only included. */
export async function probeDuration(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read the duration of ${file}`);
  return d;
}

export async function extractAudio(video, outWav) {
  await run("ffmpeg", ["-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", outWav]);
}

/** Loudness (dBFS) of the audio in fixed frames: { step, db[] }. */
export async function frameEnergy(file, step = 0.02) {
  const rate = 16000;
  const pcm = await new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"]);
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg could not decode the audio"))));
  });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const hop = Math.round(rate * step);
  const db = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let k = i; k < i + hop; k++) sum += samples[k] * samples[k];
    db.push(10 * Math.log10(sum / hop / 32768 ** 2 + 1e-12));
  }
  return { step, db };
}

/**
 * Find pauses from 20 ms frame energy. The threshold sits between the
 * noise floor and typical speech level, so a car, a noisy room and a quiet
 * studio all work without tuning.
 */
export async function detectSilences(file, { minDuration = 0.18 } = {}) {
  const { db } = await frameEnergy(file, 0.02);
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
