import { ICON_NAMES } from "./icons.mjs";
import { normWord, clamp, round } from "./util.mjs";

export const TEMPLATES = ["icon_title", "big_word", "counter", "versus"];

const KEYWORDS = [
  [/^(money|cash|paid|pay|paying|salary|income|rich|dollars?|funding|funded)$/, "money"],
  [/^(company|companies|corporate|corporation|office|firm|business)$/, "company"],
  [/^(startup|startups|launch|founder|founders|build|building)$/, "rocket"],
  [/^(school|college|university|graduate|graduated|graduating|degree|student|students|class)$/, "graduation"],
  [/^(loan|loans|debt|bills?|rent|tuition)$/, "document"],
  [/^(time|deadline|clock|hours?|until)$/, "hourglass"],
  [/^(work|working|job|jobs|career|employed|employee|hired)$/, "work"],
  [/^(family|parents|mom|dad|kids|brother|sister)$/, "family"],
  [/^(home|house)$/, "home"],
  [/^(fear|risk|risky|scared|scary|danger|dangerous|cooked|worried|worry|afraid)$/, "warning"],
  [/^(forever|stuck|trapped|cage)$/, "lock"],
  [/^(grow|growth|boom|success|successful|win|winning|scale)$/, "growth"],
  [/^(fail|failed|failure|lose|losing|crash|broke)$/, "decline"],
  [/^(idea|ideas|realize|realized|thinking|plan)$/, "idea"],
  [/^(goal|goals|focus|target)$/, "target"],
  [/^(love|passion|care)$/, "heart"],
  [/^(people|team|everyone|friends)$/, "people"],
];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100,
};
const UNITS = /^(seconds?|minutes?|hours?|days?|weeks?|months?|years?|percent|k|grand|dollars?|people|times)$/;

function keywordIcon(text) {
  const w = normWord(text);
  for (const [re, icon] of KEYWORDS) if (re.test(w)) return icon;
  return null;
}

function numberValue(text) {
  const w = normWord(text);
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

const clean = (t) => t.replace(/[^\p{L}\p{N}'’$%-]/gu, "").toUpperCase();

/** Sentences and long clauses as [firstWord, lastWord] index ranges. */
export function splitSentences(words, { maxSeconds = 5.5 } = {}) {
  const out = [];
  let s = 0;
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text;
    const end = /[.?!]["”']?$/.test(t) || /\.\.\.$/.test(t);
    const longClause = /[,;:—]$/.test(t) && words[i].end - words[s].start > maxSeconds * 0.6;
    const tooLong = words[i].end - words[s].start > maxSeconds;
    if (end || longClause || tooLong || i === words.length - 1) {
      out.push([s, i]);
      s = i + 1;
    }
  }
  return out;
}

/** Keyword-driven plan used when there is no API key (or the AI call fails). */
export function rulePlan(words) {
  const emphasis = new Set();
  words.forEach((w, i) => {
    if (keywordIcon(w.text) || numberValue(w.text) != null || /!$/.test(w.text)) emphasis.add(i);
  });

  const beats = [];
  let lastEnd = -Infinity;
  let variant = 0;
  for (const [a, b] of splitSentences(words)) {
    if (words[a].start - lastEnd < 1.2) continue;
    // counter: "<number> <unit>"
    let beat = null;
    for (let i = a; i <= b && i + 1 < words.length && !beat; i++) {
      const v = numberValue(words[i].text);
      if (v != null && UNITS.test(normWord(words[i + 1].text))) {
        beat = { template: "counter", value: v, unit: clean(words[i + 1].text), headline: `${v} ${clean(words[i + 1].text)}`, focus: i };
      }
    }
    if (!beat) {
      const hits = [];
      for (let i = a; i <= b; i++) {
        const icon = keywordIcon(words[i].text);
        if (icon) hits.push({ i, icon });
      }
      const isQuestion = /\?$/.test(words[b].text);
      if (isQuestion) {
        const from = Math.max(a, b - 3);
        const headline = words.slice(from, b + 1).map((w) => clean(w.text)).join(" ") + "?";
        beat = { template: "icon_title", icon: "question", headline, focus: from };
      } else if (hits.length) {
        // prefer the last keyword: sentences tend to land on their point
        const h = hits.at(-1);
        const prev = words[h.i - 1];
        const twoWords = prev && keywordIcon(prev.text) == null && /^(the|my|your|own|student|no|biggest)$/i.test(normWord(prev.text));
        const headline = (twoWords ? clean(prev.text) + " " : "") + clean(words[h.i].text);
        beat = variant++ % 2 === 0 ? { template: "icon_title", icon: h.icon, headline, focus: h.i } : { template: "big_word", headline, focus: h.i };
      }
    }
    if (!beat) continue;
    const start = Math.max(a, beat.focus - 1);
    beats.push({ ...beat, startWord: start, endWord: b });
    lastEnd = words[b].end;
  }

  // hook: the first keyword phrase of the opening sentence ("THE BIGGEST FEAR"),
  // else its first few words
  const [h0, h1] = splitSentences(words)[0];
  let hookWords = words.slice(h0, Math.min(h1, h0 + 3) + 1);
  for (let i = h0; i <= h1; i++) {
    if (keywordIcon(words[i].text)) {
      hookWords = words.slice(Math.max(h0, i - 2), i + 1);
      break;
    }
  }
  return {
    source: "rules",
    hook: { text: hookWords.map((w) => clean(w.text)).join(" ") },
    emphasis: [...emphasis],
    beats,
  };
}

/**
 * Turn a plan (rules or AI) into timed, validated beats: no overlaps, inside
 * the video, 1.6–6 s long, headline short enough to read.
 */
export function finalizePlan(plan, words, duration) {
  const beats = [];
  const sorted = [...(plan.beats || [])]
    .filter((b) => Number.isInteger(b.startWord) && Number.isInteger(b.endWord))
    .map((b) => ({ ...b, startWord: clamp(b.startWord, 0, words.length - 1), endWord: clamp(b.endWord, 0, words.length - 1) }))
    .filter((b) => b.endWord >= b.startWord && TEMPLATES.includes(b.template))
    .sort((x, y) => x.startWord - y.startWord);

  // the hook owns the opening moment
  const hookText = (plan.hook?.text || "").trim();
  let hookEnd = 0;
  if (hookText) hookEnd = round(clamp(words[Math.min(words.length - 1, 5)].end + 0.3, 2, 3));

  for (const b of sorted) {
    let start = Math.max(words[b.startWord].start - 0.12, hookEnd + 0.15);
    let end = Math.min(words[b.endWord].end + 0.35, duration - 0.05);
    const prev = beats.at(-1);
    if (prev) start = Math.max(start, prev.end + 0.25);
    if (end - start > 6) end = start + 6;
    // long enough to read: half a second plus 0.3 s a word, never under 2.4 s
    const words_ = (b.headline || "").split(/\s+/).filter(Boolean).length + (b.subline ? 2 : 0);
    const minLen = Math.max(2.4, 0.5 + 0.3 * words_ + 0.6);
    if (end - start < minLen) end = Math.min(duration - 0.05, start + minLen);
    if (end - start < 2) continue;
    if (b.template === "icon_title" && !ICON_NAMES.includes(b.icon)) b.icon = "idea";
    if (b.template === "counter" && !Number.isFinite(Number(b.value))) continue;
    if (b.template === "versus" && !(b.left?.label && b.right?.label)) continue;
    if (!b.headline && b.template !== "versus") continue;
    beats.push({
      template: b.template,
      headline: String(b.headline || "").toUpperCase().slice(0, 34),
      subline: b.subline ? String(b.subline).slice(0, 48) : "",
      icon: b.icon,
      value: b.value != null ? Number(b.value) : null,
      unit: b.unit ? String(b.unit).toUpperCase().slice(0, 14) : "",
      left: b.left ? { label: String(b.left.label).toUpperCase().slice(0, 12), icon: ICON_NAMES.includes(b.left.icon) ? b.left.icon : "work" } : null,
      right: b.right ? { label: String(b.right.label).toUpperCase().slice(0, 12), icon: ICON_NAMES.includes(b.right.icon) ? b.right.icon : "rocket" } : null,
      start: round(start),
      end: round(end),
    });
  }
  return {
    source: plan.source,
    hook: hookText ? { text: hookText.toUpperCase().slice(0, 40), start: 0, end: hookEnd } : null,
    emphasis: new Set((plan.emphasis || []).filter((i) => Number.isInteger(i) && i >= 0 && i < words.length)),
    beats,
  };
}
