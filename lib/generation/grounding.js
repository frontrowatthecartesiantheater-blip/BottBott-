// Grounding check: is everything concrete in the draft supported by the
// source material?
//
// Why this exists: the draft model is asked for 1,200-1,500 words from
// transcripts that are often 350-550 words, and its own craft audit grades its
// own homework ("Fabrication issues found: none" on a post that opened with an
// invented conversation, a "last week", and a "five years ago"). This is an
// independent second look, in two layers:
//
//   1. Rules (no model call): relative-time phrases, "someone messaged me"
//      narratives, and figures that appear in the draft but nowhere in the
//      source material.
//   2. A verifier call that lists every sentence asserting something concrete
//      (an event, a figure, a named entity, a third-party claim, a stance the
//      speaker never stated, a process claim) that the source does not support.
//
// "Source material" is the transcript (or RAG chunks), the approved facts in
// client-config, the previously published talking points, and the topic
// itself. High-severity findings become error-level lint findings, which
// triggers the engine's one corrective pass and, if anything survives, blocks
// auto-publish. Low-severity findings are shown to the editor as warnings.

import { CLIENT } from '../client-config.js';
import { parseJsonResponse } from '../links/models.js';

const MAX_ERROR_FINDINGS = 8;

// ---------------------------------------------------------------- source text

/** Everything the draft is allowed to draw on, as one lowercase-able string. */
export function buildSupportText(inputs) {
  const parts = [
    inputs.ragFlag ? inputs.ragChunks : inputs.transcript,
    inputs.topicTitle,
    inputs.topicDescription,
    CLIENT.autoblogPrice,
    CLIENT.autoblogRunCost,
    ...(CLIENT.canonicalFacts ?? []),
    ...(inputs.talkingPoints ?? []).map((p) => p.point),
    ...(inputs.priorPosts ?? []).map((p) => p.title),
  ];
  return parts.filter(Boolean).join('\n');
}

// ------------------------------------------------------------------ rule layer

const WORD_NUMBERS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  million: 1000000, dozen: 12,
};

// Relative-time phrases are always specifics the speaker has to have said.
const RELATIVE_TIME_RE = new RegExp(
  '\\b(?:last|this past) (?:week|month|year|night|weekend|summer|winter|spring|fall)\\b'
  + '|\\byesterday\\b|\\bthe other day\\b'
  + '|\\b(?:a )?(?:few|couple(?: of)?|several) (?:days|weeks|months|years) ago\\b'
  + `|\\b(?:\\d+|${Object.keys(WORD_NUMBERS).join('|')}|one) (?:days?|weeks?|months?|years?) ago\\b`,
  'gi',
);

// "X messaged me", "a client told me ...": invented conversations.
const MESSAGE_ME_RE = /\b(messaged|emailed|texted|dm'?d|phoned|pinged|called|wrote to|reached out to)\s+me\b/gi;
const PERSON_SPEECH_RE = /\b(?:a|one|this|another)\s+(client|customer|business owner|owner|founder|prospect|reader|follower|friend|colleague)\b[^.!?\n]{0,60}\b(told|asked|said|messaged|emailed|called|wrote|mentioned)\b/gi;

function normalize(text) {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

// Rendered-text form for matching a model-quoted sentence against markdown.
function plain(text) {
  return normalize(text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''));
}

function stripNonProse(bodyMd) {
  return bodyMd
    .replace(/\]\([^)]*\)/g, ']')          // link targets
    .replace(/https?:\/\/\S+/g, ' ')        // bare URLs
    .replace(/^\s*\d+[.)]\s+/gm, '');       // ordered-list markers
}

function sentencesOf(bodyMd) {
  return stripNonProse(bodyMd)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function numbersIn(text) {
  const out = new Set();
  const t = text.toLowerCase();
  for (const m of t.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)) out.add(m[0].replace(/[$,%]/g, '').replace(/,$/, ''));
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) out.add(String(n));
  }
  return out;
}

/**
 * Deterministic specifics check. `supportText` is the allowed source material.
 * @returns {Array<{level: 'error'|'warn', check: string, type: string, sentence: string, detail: string}>}
 */
export function findUngroundedSpecifics(bodyMd, supportText, { currentYear = new Date().getFullYear() } = {}) {
  const support = normalize(supportText);
  const supportNumbers = numbersIn(supportText);
  supportNumbers.add(String(currentYear));
  const findings = [];
  const seen = new Set();
  const add = (f) => {
    const key = `${f.check}|${f.type}|${f.sentence}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...f, source: 'rules' });
  };

  for (const sentence of sentencesOf(bodyMd)) {
    for (const m of sentence.matchAll(RELATIVE_TIME_RE)) {
      if (!support.includes(normalize(m[0]))) {
        add({
          level: 'error', check: 'ungrounded', type: 'time_reference', sentence,
          detail: `time reference "${m[0]}" is not in the source material`,
        });
      }
    }
    for (const m of sentence.matchAll(MESSAGE_ME_RE)) {
      if (!support.includes(m[1].toLowerCase())) {
        add({
          level: 'error', check: 'ungrounded', type: 'event', sentence,
          detail: `"${m[0]}" describes a conversation the source material does not contain`,
        });
      }
    }
    for (const m of sentence.matchAll(PERSON_SPEECH_RE)) {
      const speech = new RegExp(`\\b${m[1]}\\b[^.!?\\n]{0,60}\\b(?:told|asked|said|messaged|emailed|called|wrote|mentioned)\\b`, 'i');
      if (!speech.test(support)) {
        add({
          level: 'error', check: 'ungrounded', type: 'event', sentence,
          detail: `"${m[0].slice(0, 60)}" describes something a ${m[1]} said that the source material does not contain`,
        });
      }
    }
    const unsupportedNumbers = [...numbersIn(sentence)].filter((n) => !supportNumbers.has(n));
    if (unsupportedNumbers.length) {
      add({
        level: 'warn', check: 'ungrounded-figure', type: 'figure', sentence,
        detail: `figure(s) ${unsupportedNumbers.join(', ')} not found in the source material`,
      });
    }
  }
  return findings;
}

// ----------------------------------------------------------------- model layer

export function buildGroundingPrompt({ bodyMd, inputs }) {
  const source = inputs.ragFlag
    ? `Content-database chunks (no voice memo was recorded):\n${inputs.ragChunks}`
    : `Voice memo transcript:\n${inputs.transcript}`;
  const facts = [
    `- The autoblog system's price is ${CLIENT.autoblogPrice}.`,
    `- The autoblog system costs a client ${CLIENT.autoblogRunCost} to run.`,
    ...(CLIENT.canonicalFacts ?? []).map((f) => `- ${f}`),
  ].join('\n');
  const points = (inputs.talkingPoints ?? []).length
    ? inputs.talkingPoints.map((p, i) => `[TP${i + 1}] ${p.point}`).join('\n')
    : '(none)';

  return `You are a fact-grounding auditor for a blog draft written in ${CLIENT.firstName}'s voice. Everything concrete in the draft must be supported by the SOURCE MATERIAL below. Your job is to find what is not.

## SOURCE MATERIAL

${source}

Approved facts:
${facts}

Previously published talking points (restating these is allowed):
${points}

Topic: ${inputs.topicTitle}${inputs.topicDescription ? `\nTopic description: ${inputs.topicDescription}` : ''}

## DRAFT

${bodyMd}

## WHAT TO FLAG

Flag every sentence that asserts something concrete the source material does not support. Concrete means:
- event: an anecdote, conversation, message, or something that happened ("a business owner messaged me last week")
- figure: a number, price, percentage, date, time reference, or duration
- named_entity: a person, company, product, or study that is not named in the source
- third_party_claim: something a third party said, announced, published, or does
- stance: an opinion, recommendation, or hedge attributed to ${CLIENT.firstName} that he did not express. Includes finishing a thought the transcript leaves unfinished or trails off from.
- process_claim: a claim about ${CLIENT.firstName}'s own process ("in my research", "when I tested this") that the source does not describe
- embellishment: a supported idea decorated with unsupported detail

Do NOT flag: transitions, rhetorical framing, explanations of reasoning, paraphrases of supported ideas, calls to action, headings that summarize supported content, or internal links. A paraphrase of a supported idea is supported. A named client or vendor is supported only if the source names it.

Severity. This check gates publishing, so "high" is reserved for things that are plainly made up:
- "high": (1) something presented as a specific real occurrence: a conversation, message, or outcome involving particular people or a particular time ("a business owner messaged me last week"); (2) a specific price, percentage, year, count, or duration tied to a real event, product, or the author's own work; (3) a named person, company, product, or study not in the source; (4) a named third party said, announced, or does something the source does not say; (5) an opinion, hedge, or recommendation attributed to ${CLIENT.firstName} that he did not express, including finishing a thought the transcript leaves unfinished; (6) a claim about his own research or testing ("in my research") that the source does not describe.
- "low": embellishment of a supported idea; a generic or hypothetical illustration ("a business owner hits a point where the next move is 'I guess I need to hire someone'" describes a pattern, not an event, unless it claims it really happened to someone specific); a loose general statement or round-number generalization ("for the last twenty years"); a plausible general experience claim consistent with his stated background ("I've watched this happen").
When unsure between the two, choose "low".

## OUTPUT

Return ONLY a JSON object, no preamble, no code fence:

{"ungrounded":[{"sentence":"the EXACT sentence from the draft","type":"event|figure|named_entity|third_party_claim|stance|process_claim|embellishment","severity":"high|low","why":"one short sentence"}]}

Return {"ungrounded":[]} if everything concrete is supported. At most 15 items, most severe first.`;
}

/** Parse the verifier response, keeping only items whose sentence is really in the draft. */
export function parseGroundingResponse(text, bodyMd) {
  const parsed = parseJsonResponse(text, 'grounding check');
  const list = Array.isArray(parsed) ? parsed : parsed?.ungrounded;
  if (!Array.isArray(list)) throw new Error('grounding check did not return an "ungrounded" array');
  const body = plain(bodyMd);
  const findings = [];
  let dropped = 0;
  for (const item of list) {
    if (!item?.sentence || !item?.type) { dropped += 1; continue; }
    // The sentence must really be in the draft; a paraphrase cannot be acted on.
    if (!body.includes(plain(String(item.sentence)).slice(0, 80))) { dropped += 1; continue; }
    findings.push({
      level: item.severity === 'low' ? 'warn' : 'error',
      check: item.severity === 'low' ? 'ungrounded-detail' : 'ungrounded',
      type: item.type,
      sentence: String(item.sentence),
      detail: item.why ? String(item.why) : 'not supported by the source material',
      source: 'model',
    });
  }
  return { findings, dropped };
}

/**
 * Run both layers. `call(label, prompt, maxTokens)` is the engine's recording
 * wrapper around the model client.
 * @returns {Promise<{checked: boolean, findings: Array, droppedUnverifiable: number, error?: string}>}
 */
export async function runGroundingCheck({ pkg, inputs, call, label = 'grounding' }) {
  const bodyMd = pkg.post.body_md;
  const rules = findUngroundedSpecifics(bodyMd, buildSupportText(inputs));

  let modelFindings = [];
  let dropped = 0;
  let error = null;
  try {
    const response = await call(label, buildGroundingPrompt({ bodyMd, inputs }), 4096);
    ({ findings: modelFindings, dropped } = parseGroundingResponse(response, bodyMd));
  } catch (err) {
    // The rules layer still stands; a verifier hiccup must not kill a post
    // that already generated.
    error = err.message;
  }

  // One finding per sentence+type; the model's wording wins over the rules'.
  const merged = [];
  const seen = new Set();
  for (const f of [...modelFindings, ...rules]) {
    const key = `${f.sentence}|${f.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  return { checked: error === null, findings: merged, droppedUnverifiable: dropped, ...(error ? { error } : {}) };
}

/**
 * Turn grounding findings into lint findings. Error-level ones are capped so
 * the corrective pass is not handed an unmanageable list; the remainder is
 * demoted to a warning that still shows in the review panel.
 */
export function groundingToLintFindings(grounding) {
  const out = [];
  let errors = 0;
  for (const f of grounding.findings ?? []) {
    let level = f.level;
    if (level === 'error') {
      errors += 1;
      if (errors > MAX_ERROR_FINDINGS) level = 'warn';
    }
    out.push({
      level,
      check: f.check,
      detail: `[${f.type}] "${f.sentence.slice(0, 160)}": ${f.detail}`,
    });
  }
  if (grounding.error) {
    out.push({ level: 'warn', check: 'grounding-unavailable', detail: `verifier call failed, rules layer only: ${grounding.error}` });
  }
  return out;
}
