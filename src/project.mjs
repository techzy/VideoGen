import fs from "node:fs";
import path from "node:path";

export const MEDIA_DIRS = ["raw", "broll", "reference", "music"];
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|aif|aiff)$/i;

/** Absolute paths for every pipeline file inside a project folder. */
export function projectPaths(root) {
  const r = path.resolve(root);
  return {
    root: r,
    brief: path.join(r, "brief.md"),
    changelog: path.join(r, "CHANGELOG.md"),
    analysis: path.join(r, "analysis"),
    frames: path.join(r, "analysis", "frames"),
    style: path.join(r, "analysis", "style.md"),
    transcript: path.join(r, "analysis", "transcript.json"),
    brollIndex: path.join(r, "analysis", "broll_index.md"),
    media: path.join(r, "analysis", "media.json"),
    edl: path.join(r, "plan", "edl.md"),
    composition: path.join(r, "composition"),
    renders: path.join(r, "renders"),
  };
}

export function listMedia(root, dir, { audio = false } = {}) {
  const d = path.join(root, dir);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => !f.startsWith(".") && (VIDEO_EXT.test(f) || (audio && AUDIO_EXT.test(f))))
    .sort()
    .map((f) => path.join(dir, f));
}

export const isAudioFile = (f) => AUDIO_EXT.test(f);

/** "1:02.5", "00:01:02,500", "62.5", "62.5s" → seconds. */
export function parseTime(s) {
  if (s == null) return NaN;
  const t = String(s).trim().replace(/s$/i, "").replace(",", ".");
  if (!t) return NaN;
  const parts = t.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** seconds → "1:02.50" */
export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return "?";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** A copy of a template file into the project, never overwriting. Returns true when written. */
export function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
