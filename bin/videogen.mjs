#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { generate } from "../src/pipeline.mjs";
import { setVerbose } from "../src/util.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// first run: create the (git-ignored) .env with an empty key to fill in
if (!fs.existsSync(path.join(root, ".env")) && fs.existsSync(path.join(root, ".env.example"))) {
  fs.copyFileSync(path.join(root, ".env.example"), path.join(root, ".env"));
}
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ quiet: true }); // also read a .env in the current folder

const HELP = `videogen: talking-head video + SRT → animated 9:16 HyperFrames short

Usage:
  videogen --video <talking.mp4> --srt <transcript.srt> [--out short.mp4]

Options:
  -v, --video <file>      Video of you talking (required)
  -s, --srt <file>        SRT transcript, word for word (required)
  -o, --out <file>        Output MP4 (default: <video name>-short.mp4 next to the video)
      --brand <file>      Brand theme JSON (default: brand.json in this tool's folder)
      --work <dir>        Keep the working files and the HyperFrames project here
      --quality <q>       draft | looks | delivery (default: looks)
      --whisper <model>   Speech model for word timing: tiny.en, base.en, small.en, medium.en (default: small.en)
      --no-asr            Don't run speech recognition; estimate word timing from the SRT cues
      --no-ai             Don't call Claude; plan graphics with built-in rules
      --keep-pauses       Don't shorten pauses
      --keep-retakes      Don't cut repeated words/restarts
      --max-pause <s>     Longest pause to keep, in seconds (default: 0.4)
      --plan <file>       Use a scene plan from a previous run (scene-plan.json in --work), e.g. after editing it
      --no-render         Build the HyperFrames project only (preview it with: npx hyperframes preview)
      --verbose           More logging
  -h, --help              Show this help

Claude plans the graphics when ANTHROPIC_API_KEY is set (in .env or the environment).
`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      video: { type: "string", short: "v" },
      srt: { type: "string", short: "s" },
      out: { type: "string", short: "o" },
      brand: { type: "string" },
      work: { type: "string" },
      quality: { type: "string", default: "looks" },
      whisper: { type: "string", default: "small.en" },
      "no-asr": { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      "keep-pauses": { type: "boolean", default: false },
      "keep-retakes": { type: "boolean", default: false },
      "max-pause": { type: "string", default: "0.4" },
      "no-render": { type: "boolean", default: false },
      plan: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (e) {
  console.error(e.message + "\n\n" + HELP);
  process.exit(2);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (!args.video || !args.srt) {
  console.error("Both --video and --srt are required.\n\n" + HELP);
  process.exit(2);
}
for (const f of [args.video, args.srt, args.plan].filter(Boolean)) {
  if (!fs.existsSync(f)) {
    console.error(`File not found: ${f}`);
    process.exit(2);
  }
}
if (!["draft", "looks", "delivery"].includes(args.quality)) {
  console.error(`--quality must be draft, looks or delivery`);
  process.exit(2);
}
const maxPause = Number(args["max-pause"]);
if (!(maxPause > 0)) {
  console.error(`--max-pause must be a positive number of seconds`);
  process.exit(2);
}

setVerbose(args.verbose);
const parsed = path.parse(path.resolve(args.video));
const out = args.out ?? path.join(parsed.dir, `${parsed.name}-short.mp4`);
const workDir = args.work ? path.resolve(args.work) : fs.mkdtempSync(path.join(os.tmpdir(), "videogen-"));

try {
  await generate({
    video: path.resolve(args.video),
    srt: path.resolve(args.srt),
    out,
    workDir,
    brand: path.resolve(args.brand ?? path.join(root, "brand.json")),
    quality: args.quality,
    asr: !args["no-asr"],
    whisperModel: args.whisper,
    ai: !args["no-ai"],
    cutPauses: !args["keep-pauses"],
    cutRetakes: !args["keep-retakes"],
    maxPause,
    render: !args["no-render"],
    planFile: args.plan ? path.resolve(args.plan) : null,
  });
  if (!args.work && !args["no-render"]) fs.rmSync(workDir, { recursive: true, force: true });
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  console.error(`  Working files kept in ${workDir}`);
  process.exit(1);
}
