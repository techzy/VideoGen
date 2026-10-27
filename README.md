# VideoGen

Give it a video of you talking and its SRT transcript; it makes a 9:16 short with
word-synced captions and animated vector graphics, rendered with
[HyperFrames](https://github.com/heygen-com/hyperframes).

```bash
videogen --video talking.mp4 --srt talking.srt --out short.mp4
```

## What it does

1. **Times every word.** Your SRT is the wording. Local speech recognition
   (Whisper, through `hyperframes transcribe`) supplies the timing, and the two
   are aligned word by word. If speech recognition is unavailable, the tool
   estimates timings from the SRT cues and the pauses in the audio. Those
   estimates are less exact (up to about a second off inside long cues).
2. **Edits.** Pauses longer than 0.4 s are shortened. Restarts and stutters
   ("I need to, I need to…", "You, you…") are cut, but only when the word
   timings come from speech recognition. The framing alternates between two
   zoom levels at every cut (punch-ins), so the jump cuts read as deliberate.
3. **Plans the graphics.** With `ANTHROPIC_API_KEY` set, Claude picks the
   moments, headlines, icons and emphasized words. Without a key, keyword rules
   do it.
4. **Builds a HyperFrames project.** It contains:
   - a hook title on the first frame
   - captions that highlight each word as it's spoken
   - graphic beats in the top third of the frame, above your head
   - the edited footage underneath

   Everything is SVG or CSS shapes and text, animated with GSAP. No stock
   images or other raster art.
5. **Renders** to MP4 at 1080×1920, 30 fps.

Graphic templates: `icon_title` (a line icon draws itself, then a headline
lands), `big_word` (kinetic letters with an underline swoosh), `counter` (a
number counts up inside a ring) and `versus` (two options face off). The
24 line icons are in `src/icons.mjs`.

## Setup

Requires Node.js 22+ and FFmpeg.

```bash
npm install
npx hyperframes browser ensure     # one-time: headless Chrome for rendering
npm link                           # optional: puts `videogen` on your PATH
```

On first run the tool creates `.env` (git-ignored) with an empty
`ANTHROPIC_API_KEY=`. Fill it in to have Claude plan the graphics.

The first run with speech recognition downloads the Whisper model (about 470 MB
for `small.en`; use `--whisper base.en` for a smaller, faster one).

## Options

| Option | |
| --- | --- |
| `--out <file>` | Output MP4 (default: `<video>-short.mp4` next to the input) |
| `--quality draft\|looks\|delivery` | Render quality (default `looks`) |
| `--work <dir>` | Keep the working files: the HyperFrames project, `plan.json`, `scene-plan.json` |
| `--plan <file>` | Re-use a `scene-plan.json`, for example after editing headlines by hand |
| `--no-render` | Only build the project; open it with `npx hyperframes preview` inside `<work>/project` |
| `--brand <file>` | Brand theme (default `brand.json`) |
| `--whisper <model>` | `tiny.en`, `base.en`, `small.en` (default), `medium.en` |
| `--no-asr` | Skip speech recognition and estimate the timings |
| `--no-ai` | Skip Claude and use the built-in rules |
| `--keep-pauses`, `--keep-retakes`, `--max-pause <s>` | Editing controls |

To tweak a video: run with `--work my-run`, edit `my-run/scene-plan.json`
(word indices are listed at the bottom), then rerun with
`--plan my-run/scene-plan.json`.

## Brand

`brand.json` is a **placeholder** theme. Set the colors (hex) and fonts to the
brand's own. Fonts outside the bundled HyperFrames set (Inter, Montserrat,
Poppins, Oswald, Archivo Black and others) need a font file: put it in
`fontFiles`.

## Tests

```bash
npm test
```
