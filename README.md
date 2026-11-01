# VideoGen: AI-assisted video edit pipeline

Claude Code edits raw footage + b-roll into a finished video in the style of
your reference videos, built and rendered with
[HyperFrames](https://github.com/heygen-com/hyperframes).

The loop is **analyze → plan → approve → build → preview → revise → render**,
with two approval gates: the style spec (Gate 1) and the edit decision list
(Gate 2). Every decision lives in readable files: `analysis/style.md`,
`plan/edl.md` and `composition/styles/motion.js`.

Two parts:

- **`/edit-video`**, a Claude Code skill (`.claude/skills/edit-video/SKILL.md`)
  that runs the pipeline and stops at the gates.
- **`vg`**, helper commands that do the mechanical work: frames and contact
  sheets, pacing measured from cut detection, the word-level transcript with
  fillers/retakes/pauses flagged, the b-roll index, building the HyperFrames
  composition from the EDL, QA, and rendering.

## Setup

Requires Node.js 22+ and FFmpeg.

```bash
git clone https://github.com/techzy/VideoGen && cd VideoGen
npm install
npm link
vg setup
```

`npm link` puts `vg` on your PATH; `vg setup` links the /edit-video skill into
`~/.claude/skills` and installs headless Chrome.

The first `vg transcribe` downloads a Whisper model (`small.en` is about
470 MB; `--model base.en` is smaller, `medium.en` is more accurate).

## Use

```bash
vg init my-video
cd my-video
claude
> /edit-video
```

`vg init` creates `raw/ broll/ reference/ music/ brief.md CHANGELOG.md`. Add
your files and fill in brief.md before running `/edit-video`.

Claude reads brief.md (and asks if it is vague), then:

| Phase | Commands | Output |
|---|---|---|
| 1. Reference analysis | `vg reference` | `analysis/style.md` (**Gate 1**) |
| 2. Footage prep | `vg transcribe`, `vg broll` | `analysis/transcript.json`, `analysis/broll_index.md` |
| 3. Edit plan | `vg edl-draft`, `vg build` (to validate) | `plan/edl.md` (**Gate 2**) |
| 4. Build | `vg build` | `composition/` |
| 5. QA | `vg qa`, `vg snapshot --at …` | checks pass |
| 6. Render | `vg render`, then `vg render --final` | `renders/draft_vN.mp4`, `renders/final.mp4` |

Other aspect ratios from the same EDL: `vg render --phone` (9:16) or
`--format 16:9|1:1|4:5`. By default the EDL's `**Format:**` line decides, and
`source` keeps the main footage's own ratio.

## The EDL

`plan/edl.md` is a markdown table you can edit by hand. Row types: `cut` (main
footage, back to back), `broll`, `title` / `text` / `callout` / `lower-third`,
`music` (ducked under speech automatically) and `sfx`. The full format is in
the skill file.

```markdown
**Format:** 9:16
**Target length:** 45s

| # | Out time | Source | In → Out | Type | Caption | B-roll / overlay | Motion preset | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 0:00.00 | raw/take1.mp4 | 12.40 → 18.95 | cut | auto | broll/city.mp4 3 → 6 | punchIn | focus=0.45 |
| 2 | 0:01.00 → 0:03.40 | | | title | "The biggest fear" | icon:warning | slamUp / liftOut | y=0.25 |
| 3 | 0:00.00 | music/bed.mp3 | 0 → end | music | | | | volume=0.5 duck=0.3 |
```

## Motion presets

`composition/styles/motion.js` holds named GSAP presets: entrances (`slamUp`,
`popIn`, `fadeUp`, `zoomIn`, `wordStagger`, `letterPop`, `typewriter`,
`drawOn`, `whipLeft`, and more), exits (`fadeOut`, `liftOut`, `popOut`,
`slideDownOut`, `whipOutLeft`), framing for cuts (`punchIn`, `slowPush`,
`slowPull`, `zoomBump`) and caption word highlights (`color`, `box`). It is
created from `templates/motion.js` on the first build and never overwritten,
so tune it per project. To reuse a house style, copy `style.md` and
`motion.js` into the next project.

## Notes

- Source media is never modified: the composition links to it.
- Fillers and retakes are only cut when the timing comes from speech
  recognition. With `--srt` and no Whisper, timings are estimated (up to about
  1 s off inside long cues) and these words are only flagged.
- QA uses `hyperframes check`, which replaces the deprecated `inspect`.
- The HyperFrames CLI sends anonymous telemetry by default.

## Tests

```bash
npm test
```
