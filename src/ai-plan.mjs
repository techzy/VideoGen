import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { ICON_NAMES } from "./icons.mjs";
import { TEMPLATES } from "./plan.mjs";

const MODEL = "claude-opus-5-5";

const Side = z.object({ label: z.string(), icon: z.enum(ICON_NAMES) });

const PlanSchema = z.object({
  hook: z.object({ text: z.string() }),
  emphasis: z.array(z.number().int()),
  beats: z.array(
    z.object({
      startWord: z.number().int(),
      endWord: z.number().int(),
      template: z.enum(TEMPLATES),
      headline: z.string(),
      subline: z.string().nullable(),
      icon: z.enum(ICON_NAMES).nullable(),
      value: z.number().nullable(),
      unit: z.string().nullable(),
      left: Side.nullable(),
      right: Side.nullable(),
    }),
  ),
});

const SYSTEM = `You are the motion designer for vertical (9:16) talking-head shorts.
The speaker's words are already captioned word by word. On top of that you plan
animated vector graphic "beats" that appear in the top third of the frame,
above the speaker's head, and you choose which caption words get emphasis.

Templates:
- icon_title: a line icon draws itself, then a short headline slams in. Needs icon + headline.
- big_word: one or two huge words with an underline swoosh. Needs headline (1–2 words).
- counter: a number counts up inside a ring. Needs value (number), unit, headline (e.g. "6 MONTHS").
- versus: two options face off. Needs left {label, icon}, right {label, icon}; headline may be "".

Rules:
- headline: 1–4 words, at most 22 characters, punchy, in the speaker's own words where possible.
- subline: optional, at most 40 characters, or null.
- One beat every 4–7 seconds on average; beats never overlap; each spans 2–6 seconds of speech.
- startWord/endWord are word indices from the transcript; the beat shows while those words are spoken.
- Pick moments that carry the idea: a claim, a number, a contrast, a question, a turn in the story.
- Vary the templates; don't use the same one three times in a row.
- emphasis: 6–15 word indices of the key content words (never filler like "like", "um", "the").
- hook.text: a 2–5 word title shown on the very first frame that makes a scroller stop. Use the speaker's idea; no clickbait they didn't say.
- Fields a template doesn't use are null.`;

/**
 * Ask Claude for a scene plan. Returns null when there is no key, or the
 * request fails or is declined, so the caller can fall back to the rules.
 */
export async function aiPlan(words, duration, { log } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  const transcript = words.map((w, i) => `${i}\t${w.start.toFixed(2)}\t${w.text}`).join("\n");
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium", format: zodOutputFormat(PlanSchema) },
      messages: [
        {
          role: "user",
          content: `Video length: ${duration.toFixed(1)} s. Transcript (index, start seconds, word):\n\n${transcript}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      log?.(`Claude declined to plan this video (${response.stop_details?.category ?? "no category"}); using built-in rules`);
      return null;
    }
    if (!response.parsed_output) {
      log?.(`Claude's plan did not parse (stop: ${response.stop_reason}); using built-in rules`);
      return null;
    }
    return { source: "claude", ...response.parsed_output };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) log?.("ANTHROPIC_API_KEY was rejected; using built-in rules");
    else if (error instanceof Anthropic.RateLimitError) log?.("Claude API rate limited; using built-in rules");
    else if (error instanceof Anthropic.APIConnectionError) log?.("Couldn't reach the Claude API; using built-in rules");
    else if (error instanceof Anthropic.APIError) log?.(`Claude API error ${error.status}: ${error.message}; using built-in rules`);
    else log?.(`Claude planning failed (${error.message}); using built-in rules`);
    return null;
  }
}
