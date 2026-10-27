import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { run, debug } from "./util.mjs";

const require = createRequire(import.meta.url);

/** Absolute path of the pinned HyperFrames CLI entry point. */
export function hyperframesBin() {
  const pkgPath = require.resolve("hyperframes/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.hyperframes;
  return path.join(path.dirname(pkgPath), bin);
}

/**
 * Word-level speech recognition through `hyperframes transcribe` (local
 * Whisper / Parakeet). Only the timings are used; the SRT stays the source
 * of truth for the words themselves.
 */
export async function transcribeWords(audioFile, workDir, { model = "small.en" } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const lastJson = (text) => {
    const line = (text || "")
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    try {
      return line ? JSON.parse(line) : {};
    } catch {
      return {};
    }
  };
  let stdout;
  try {
    ({ stdout } = await run(
      process.execPath,
      [hyperframesBin(), "transcribe", audioFile, "--dir", workDir, "--model", model, "--language", "en", "--json"],
      { cwd: workDir, env: { HYPERFRAMES_NO_UPDATE_CHECK: "1" } },
    ));
  } catch (e) {
    throw new Error(lastJson(e.stdout).error || e.message.split("\n")[0]);
  }
  const result = lastJson(stdout);
  if (result.ok === false) throw new Error(result.error || "transcription failed");
  const file = result.transcriptPath || path.join(workDir, "assets", "transcript.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.words || raw.transcription || [];
  const words = list
    .map((w) => ({
      text: String(w.text ?? w.word ?? "").trim(),
      start: Number(w.start ?? w.offsets?.from / 1000),
      end: Number(w.end ?? w.offsets?.to / 1000),
    }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .filter((w) => !/^[♪�♪-♯\[\(]/.test(w.text));
  debug(`ASR returned ${words.length} words`);
  return words;
}
