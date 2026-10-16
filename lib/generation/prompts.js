// Prompt builders for the four-stage generation pipeline (pre-pass + three
// calls). Implements docs/generation-prompt-spec.md. Client-specific values
// (name, description, link pools) come from client-config.js; the static
// voice profile is loaded from docs/tov-profile-bottbott.md.
//
// Notes:
//   - Internal link pools come from CLIENT.internalLinkPoolA/B.
//   - No image inputs (image handling is out of scope for v1).
//   - Openers are thesis statements, not scenes (decision 2026-10-15): a scene
//     forced the model to invent one whenever the transcript had none.
//   - Anything concrete must trace to the transcript, the approved facts in
//     client-config, or a previously published talking point. The independent
//     check for that lives in lib/generation/grounding.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLIENT } from '../client-config.js';

export const GENERATION_MODEL = 'claude-sonnet-5';

// The static tone-of-voice profile for this build. The unfilled
// docs/tov-profile-template.md stays in the repo as the starting point for
// future client builds.
export const STATIC_TOV = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'tov-profile-bottbott.md'),
  'utf8',
);

const POOL_A_LINKS = CLIENT.internalLinkPoolA;
const POOL_B_LINKS = CLIENT.internalLinkPoolB
  .map((l) => `- ${l.label}: ${l.url}\n  Use when: ${l.useWhen}`)
  .join('\n');

const CANONICAL_FACTS = (CLIENT.canonicalFacts ?? []).map((f) => `- ${f}`).join('\n') || '- (none listed)';

// Pricing is a fact like any other: the config value wins over a figure recalled
// out loud in a memo. Empty list = the client's posts state no prices.
const PRICING_LIST = (CLIENT.pricingFacts ?? []).map((f) => `- ${f}`).join('\n');
const PRICING_RULE = PRICING_LIST
  ? `Any price, fee, or running cost in the post must come from these approved facts or, failing that, from the transcript; if the transcript gives a figure that differs from one here, use the one here. Never state a price from memory.\n${PRICING_LIST}`
  : 'No prices or fees are approved for this client. State none.';
const PRICING_SECTION = PRICING_LIST ? `## PRICING FACTS\n\n${PRICING_RULE}\n\n` : '';

const FACTS_AND_ANONYMITY = `Canonical public facts. These override the transcript if the speaker misstated one; never repeat a misstated date or detail, state the fact correctly or leave the detail out:
${CANONICAL_FACTS}

Client anonymity: never name a client, a client's company, or a client's founder or staff, even if the transcript does. Describe them by role and industry ("a plumbing company owner", "a local real estate agent"). Third-party tools and vendors may be named when the transcript names them.`;

function talkingPointsBlock(talkingPoints) {
  if (!talkingPoints?.length) {
    return 'None available for this topic. Rely on the transcript and on plain, on-topic reasoning.';
  }
  return talkingPoints.map((p, i) => {
    const client = p.client_ref ? `; client: ${p.client_ref}` : '';
    return `[TP${i + 1}] (${p.kind}${client}) ${p.point}\n    From the published post "${p.source_title}": ${p.source_url}`;
  }).join('\n');
}

// The recording may contain things said TO the system rather than FOR the post.
const SPOKEN_INSTRUCTIONS = `The transcript may contain spoken instructions to the system, such as "system, link to that post, please". They are instructions, not content: carry them out, and never quote or paraphrase them in the post.

`;

function lessonsBlock(lessons) {
  if (!lessons?.length) return '';
  return `## LESSONS FROM ${CLIENT.firstName}'S OWN EDITS (approved by the client)

${CLIENT.firstName} has corrected earlier drafts in these ways. Do not repeat the mistakes:
${lessons.map((l) => `- ${l}`).join('\n')}

`;
}

function catalogBlock(catalog) {
  if (!catalog?.length) return '';
  const rows = catalog
    .map((e) => `- [${e.source}] ${e.title}: ${e.url}${e.summary ? ` (${String(e.summary).slice(0, 160)})` : ''}`)
    .join('\n');
  return `## LINK CATALOG (${CLIENT.firstName}'s own published posts related to this topic)

${rows}

These are real URLs. Any of them is a valid internal link target alongside the pools above, and counts toward the internal-link limit. Use a URL exactly as given; never build one from a title or slug. Prefer a specific post here over a site's home page: use a home page only when no catalog post fits. Entries tagged [substack] are the client's other writing, so use one only when this post genuinely refers to it.

`;
}

function requestedLinksBlock(requestedLinks) {
  if (!requestedLinks?.length) return '';
  const rows = requestedLinks.map((r) => (r.match
    ? `- ${CLIENT.firstName} said "${r.mention}" about "${r.describes}". Matching post: ${r.match.title}: ${r.match.url} (match strength ${Number(r.match.similarity).toFixed(2)}; judge whether it is really the post meant).`
    : `- ${CLIENT.firstName} said "${r.mention}" about "${r.describes}". No matching post was found. Do not guess a URL; leave the link out.`)).join('\n');
  return `## LINKS REQUESTED IN THE RECORDING

${rows}

Include each matching post as one of the chosen internal links (it counts toward the internal-link limit) unless the match is clearly the wrong post.

`;
}

function recordingProblemsBlock(check) {
  const warnings = check?.warnings ?? [];
  if (!warnings.length) return '';
  return `## RECORDING PROBLEMS

The audio had problems, so this transcript is probably incomplete or contains filler the transcriber invented:
${warnings.map((w) => `- ${w.detail}`).join('\n')}

Treat anything missing as unknown. Do not reconstruct what the speaker might have said in a gap, do not continue a thought where the recording breaks off, and ignore looping filler ("Yeah. Yeah.").

`;
}

export function buildPrePassPrompt({ transcript }) {
  return `You are extracting tone-of-voice signals from a voice memo transcript.
If the transcript contains multiple speakers, extract ONLY from ${CLIENT.fullName}'s own speech. Nothing said by any other speaker qualifies as a signal, a reference, or an opinion.
Return ONLY a JSON object with these five keys. No preamble, no explanation.

{
  "dominant_phrases": ["phrase 1", "phrase 2", "phrase 3"],
  "energy_level": "relaxed | conversational | animated",
  "specific_references": ["any local places, street names, neighborhoods, landmarks, or named people mentioned"],
  "opinions_expressed": ["any strong takes, preferences, or opinions ${CLIENT.firstName} stated — these are gold, use them"],
  "link_requests": [{"mention": "the exact words", "describes": "what the post is about"}]
}

"link_requests" lists any moment where ${CLIENT.firstName} asks for a link or points to an earlier post or piece of their own writing (for example "I recently published a post about that, system link to that post, please"). "mention" is the exact words; "describes" is what that post is about, taken from the surrounding speech. Use an empty array if there are none.

Transcript:
${transcript}`;
}

function sourceMaterialBlock({ ragFlag, ragChunks, transcript, guidingQuestions }) {
  if (ragFlag) {
    return `NOTE: No voice memo was recorded for this post. Content should be generated from the existing content database. Draw on the chunks below as the primary input. Treat them with the same extraction-first discipline as a transcript — pull specific phrases, references, and opinions. Do not invent new claims.

RAG source chunks:
${ragChunks}`;
  }
  return `Voice memo transcript:
${transcript}

Questions ${CLIENT.firstName} was asked before recording:
${guidingQuestions.map((q) => `- ${q}`).join('\n')}`;
}

export function buildCall1Prompt(inputs) {
  const {
    topicTitle, topicDescription, primaryKeyword,
    dynamicTov, priorPosts, talkingPoints, editorLessons, catalog, requestedLinks, transcriptCheck, ragFlag,
  } = inputs;
  return `You are a blog content strategist planning a post for ${CLIENT.siteDomain}, a content and SEO hub for ${CLIENT.fullName}, ${CLIENT.description}.

## YOUR TASK

Plan the content structure for this post. Your job is to decide what goes in each section and WHERE in the post ${CLIENT.firstName}'s actual words and experiences from the transcript belong. Do not write the post yet — plan it.

## TOPIC

Title: ${topicTitle}
Description: ${topicDescription || 'No description provided.'}
Primary keyword: ${primaryKeyword}

${PRICING_SECTION}## CANONICAL FACTS AND CLIENT ANONYMITY

${FACTS_AND_ANONYMITY}

## SOURCE MATERIAL

${sourceMaterialBlock(inputs)}

${ragFlag ? '' : SPOKEN_INSTRUCTIONS}${recordingProblemsBlock(transcriptCheck)}## PREVIOUSLY PUBLISHED TALKING POINTS

These are ideas ${CLIENT.firstName} has already published, restated neutrally. They are a reserve for thin spots, not a source of new claims.

${talkingPointsBlock(talkingPoints)}

Rules for using them:
- The transcript comes first. Use a talking point only where the transcript is thin or a section needs supporting context, and only when it is on topic. Skip any that do not fit.
- Rehash, never repeat: the draft will restate the idea in fresh words. It must not reuse sentences or distinctive phrasing from the point or from the post it came from.
- A talking point is never something said in this recording. Do not plan it as a transcript anchor.
- A talking point's source post is a valid internal link target ("I wrote about this in [anchor](url)"). Use its URL exactly as given. It counts toward the internal-link limit below.
- Client descriptions in talking points are already anonymized. Keep them anonymous.

${lessonsBlock(editorLessons)}## CLIENT VOICE — STATIC PROFILE

${STATIC_TOV}

## DYNAMIC TOV SIGNALS FROM THIS RECORDING

${JSON.stringify(dynamicTov, null, 2)}

## RECENT POSTS (avoid repeating these topics or angles)

${JSON.stringify(priorPosts, null, 2)}

## INTERNAL LINK TARGETS

For this post, select up to 3 internal links total, following these rules:
- At least one link must come from Pool A.
- A Pool B link may only be used when its "Use when" condition is genuinely met by this post's content. If no Pool B condition is met, use Pool A links only. If a Pool B entry is a site's home page, prefer a specific post from the LINK CATALOG (when provided) over it.
- Do not force links. Only include a link if it is genuinely relevant to what this post covers; fewer is fine.
- Space the links across the post rather than clustering them in one section.

Pool A — ${CLIENT.siteDomain} static pages:
${POOL_A_LINKS}

Pool B — approved off-site links, treated as internal links for this blog. Each may be used ONLY when its stated condition is met by the post:
${POOL_B_LINKS}

A recent post from the RECENT POSTS list above, the source post of a talking point, or an entry in the LINK CATALOG (when one is provided below), is also a valid target when one is genuinely more relevant than anything in the pools. Use that post's "url" field exactly as given. Never build a post URL yourself from a slug or a title.

${requestedLinksBlock(requestedLinks)}${catalogBlock(catalog)}## EXTRACTION RULE — CRITICAL

The transcript is the primary source, not a launching pad. Your plan must:
- Identify at least 2-3 specific things ${CLIENT.firstName} actually said (phrases, opinions, anecdotes, local references) and assign each one to a specific section.
- If ${CLIENT.firstName} expressed an opinion or told a story, that is the anchor for one section. Build around it, not over it.
- If a planned section has no corresponding transcript content, say so explicitly and fill it one of two ways: (a) a talking point (name it, e.g. TP2) that the draft will rehash, or (b) plain, on-topic reasoning that explains the idea in terms of the reader's time or money and asserts no new facts, anecdotes, figures, names, or attributions. The draft writer will not invent.
- Never plan content that contradicts or ignores what ${CLIENT.firstName} said. If he expressed a nuanced position, preserve it.
- If the transcript trails off or ends mid-thought, plan the idea only as far as the speaker took it. Do not complete the thought for them.

## OUTPUT FORMAT

Produce your plan in this exact structure:

PRIMARY KEYWORD: [confirm]
SECONDARY KEYWORDS: [2-3 natural variations or related terms that can be distributed through the post]

CHOSEN INTERNAL LINKS: [list 1-3, each with pool (A or B), URL, anchor text suggestion, planned placement (early, mid-post, or near end), and one-sentence relevance rationale. At least one from Pool A. If fewer links are relevant, list fewer.]

OPENING HOOK: [1-3 sentences stating this post's thesis: the position ${CLIENT.firstName} takes and why it matters to the reader, in the client's own words from the transcript wherever possible. A thesis-statement synopsis, not a scene. Do not invent an anecdote, a conversation, a client, or a time reference such as "last week". A real client fact may appear only if it comes from the transcript or a talking point and directly proves the thesis. Not a question. Not "In today's market."]

PROPOSED H1: [must contain primary keyword, reads naturally, max 65 characters]

SECTIONS:
[For each section, use this format:]

## [H2 heading — specific, not generic, title case]
- Purpose: [what this section accomplishes for the reader]
- Key content: [2-4 bullets]
- Transcript anchor: [the specific thing ${CLIENT.firstName} said that belongs here; or "talking point TPn"; or "none: plain reasoning only"]
- Keyword placement: [where PRIMARY_KEYWORD or a secondary keyword fits naturally in this section]
- Dynamic TOV to use: [any dominant phrase, specific reference, or opinion from DYNAMIC_TOV that fits here]

[Repeat for each section — target 4-6 H2 sections total]

CONCLUSION SECTION:
- H2 heading: [a declarative statement, NOT "Conclusion" or "Final Thoughts"]
- Purpose: Move the reader to a next step. Do not summarize. Do not repeat what the post already covered.
- CTA direction: [specific: what service, what action]
- Voice: First person ("I've been through this kind of transaction before...")

SEO METADATA PLAN:
- Meta title: [55 chars max, keyword front-loaded. Do not append "| ${CLIENT.fullName}" or any name suffix, the character limit does not allow room for it. Save the name for the meta description instead.]
- Meta description: [155 chars max, includes keyword, addresses search intent]
- URL slug: [lowercase, hyphens, keyword-rich, max 50 chars]

WORD COUNT TARGET: 1,200-1,500 words (${CLIENT.firstName}'s arguments need room at this length — do not compress). If the source material cannot carry that length honestly, plan only what it supports, never fewer than 1,000 words, using talking points and plain reasoning rather than invention.`;
}

export function buildCall2Prompt(inputs) {
  const { call1Output, transcript, dynamicTov, primaryKeyword, ragFlag, talkingPoints, editorLessons, transcriptCheck } = inputs;

  const transcriptBlock = ragFlag
    ? `This post is generated from the content database (no voice memo). Use the RAG source material from the structure plan as your primary input. Apply the same extraction discipline — pull specific language and anchor sections to it.`
    : `${transcript}

This transcript is the PRIMARY source, not a reference. Every section should have roots in something ${CLIENT.firstName} actually said. Where the transcript is thin on a section, use the talking points below or plain, on-topic reasoning that asserts nothing new. Do not invent.`;

  return `You are an expert blog writer working exclusively in the voice of ${CLIENT.fullName}, ${CLIENT.description}. You write for ${CLIENT.siteDomain}.

Your job: write the full post using the structure plan below. The structure is already decided. Your job is to execute it in ${CLIENT.firstName}'s voice.

## STRUCTURE PLAN (follow this exactly)

${call1Output}

## TRANSCRIPT (your primary source material)

${transcriptBlock}

${recordingProblemsBlock(transcriptCheck)}## PREVIOUSLY PUBLISHED TALKING POINTS (rehash only)

${talkingPointsBlock(talkingPoints)}

A talking point may support a section the plan assigns to it. Restate the idea in fresh words: never copy a sentence or distinctive phrase from the point or its source post, and never present it as something said in this recording. To point readers to its source post, use a markdown link with the URL given, only if the structure plan includes that link.

## CANONICAL FACTS AND CLIENT ANONYMITY

${FACTS_AND_ANONYMITY}

${lessonsBlock(editorLessons)}## CLIENT VOICE — STATIC PROFILE (non-negotiable constraints)

${STATIC_TOV}

## DYNAMIC TOV SIGNALS FROM THIS RECORDING

${JSON.stringify(inputs.dynamicTov, null, 2)}

---

## VOICE RULES — CRITICAL, READ FIRST

These are non-negotiable. Violations will be caught and flagged in the polish pass.

1. FIRST PERSON throughout. "I've rebuilt this pipeline three times," not "${CLIENT.fullName} has."
2. SENTENCE RHYTHM is mixed by design. Short punchy sentences for impact; long sentences are permitted past 40 words when the thought requires carrying an idea to its full consequence. Do not enforce an average sentence length.
3. PARAGRAPH LENGTH varies by purpose. A one-sentence paragraph is a deliberate beat. A long paragraph telling one story is correct. Never split or merge paragraphs for uniformity.
4. NO EM DASHES. Completely banned. Replace with a period and a new sentence, or a comma.
5. NO AI CLICHÉS: "navigate," "landscape," "straightforward," "leverage," "robust," "utilize," "holistic," "comprehensive," "it's important to note," "in today's market," "in today's world," "when it comes to," "not just X but Y," "at the end of the day."
6. NO PARALLELISMS. Never write "This isn't about X, it's about Y." Never write "It's not X. It's Y." Never write "The bar isn't X because A. The bar is Y because B." If you catch yourself building a parallel contrast, rewrite as a plain statement.
7. NO QUESTIONS as section openers. Start with a fact, a moment, or a direct statement.
8. NO PASSIVE VOICE hedging. "I've made mistakes" is ${CLIENT.firstName}. "Mistakes were made" is not.
9. NO SUPERLATIVES without evidence. "The best in the business" is not ${CLIENT.firstName}. A specific, verifiable claim (like a real number of years doing the work) is.
10. CONTRACTIONS: use them. "I've," "you'll," "don't," "it's," "that's." ${CLIENT.firstName} speaks like a person.
11. CONDITIONAL LANGUAGE is fine and authentic for ${CLIENT.firstName}: "I think," "probably," "maybe." These are not hedges — they are honest. But only where the speaker said them: do not add a "maybe" or "I'm not fully sold" they never expressed.
12. FRAGMENTS are fine when voice-appropriate. Short, punchy fragments that match how ${CLIENT.firstName} actually talks read as authentic.
13. SPECIFICITY over abstraction. A concrete detail that comes from the transcript beats a vague claim ("I have extensive experience"). A concrete detail you made up is fabrication, not specificity.
14. AUTHENTIC RESTRAINT on CTAs. ${CLIENT.firstName}'s version is a plain, low-pressure invitation to discuss, per the closing pattern in the TOV profile. Not "don't hesitate to reach out."

## STRUCTURAL RULES

15. OPENING HOOK: Use the thesis-statement opener from the structure plan: 1-3 sentences stating the position this post takes and why it matters to the reader. No scene-setting, no anecdote or conversation the transcript does not contain, no throat-clearing.
16. H1 immediately after the hook. Not buried.
17. H1 appears ONCE only. Do not repeat it.
18. TITLE CASE on all headers. Punctuation in headers is permitted and encouraged where the heading needs it: colons, commas, quotation marks.
19. CONCLUSION must NOT summarize. Move the reader forward. What should they do next?
20. CONCLUSION H2 must be a declarative statement, not a label. Not "Conclusion." Not "Final Thoughts."
21. INTERNAL LINKS: Inject every link from the structure plan naturally within relevant paragraphs. Use markdown link syntax. Example: "...which is why [a descriptive anchor phrase](https://${CLIENT.siteDomain}/relevant-page) matters here."

## KEYWORD RULES

22. PRIMARY KEYWORD must be present in the body text, phrased the way a person would actually say it. Never repeat it to hit a number, and never contort a sentence to fit it in — if a natural opportunity is not there, leave it out.
23. Primary keyword in: H1, and the first or second paragraph. Anywhere else only where it reads naturally.
24. No awkward keyword noun phrases. Stacked keyword nouns that nobody would say out loud are not natural; phrase the keyword the way a person actually speaks it.

## ANTI-FABRICATION — HARD RULE

25. Do not invent client stories, case studies, statistics, or specific outcome numbers.
26. If illustrating a point, use hypothetical framing ("Say a family comes to me after...") or draw directly from what ${CLIENT.firstName} said in the transcript.
27. No percentages or specific figures unless ${CLIENT.firstName} said them. A figure stated by another speaker in the transcript does not qualify, even if ${CLIENT.firstName} heard it. Reframe qualitatively instead.
28. PRICING: ${PRICING_RULE}
29. NO INVENTED EVENTS OR TIMING. Do not write that someone messaged, emailed, asked, or told ${CLIENT.firstName} anything, and do not use relative time ("last week," "a few years ago," "five years ago") unless the transcript or a talking point says it. A thesis opener needs neither.
30. NO INVENTED PROCESS. Do not claim "in my research," "when I tested this," or similar unless the transcript describes it.
31. NEVER FINISH THE SPEAKER'S THOUGHT. If the transcript trails off, repeats filler, or ends mid-sentence, end the idea where the speaker did. Do not supply a stance, recommendation, or hedge they did not state.
32. CLIENT ANONYMITY and CANONICAL FACTS above are hard rules. Never name a client. Never repeat a misstated public fact.
33. LENGTH WITHOUT INVENTION. If the source material cannot carry 1,200 words, add (a) rehashed talking points and (b) plain explanatory reasoning that says what the idea means for the reader's time or money. Never add anecdotes, figures, quotes, named sources, or attributions to reach the count. A post that stops at what is supported (not below 1,000 words) is better than a padded one.
34. SPOKEN INSTRUCTIONS ARE NOT CONTENT. If the transcript contains something said to the system ("system, link to that post"), act on it through the structure plan and never quote or paraphrase it in the post.

## SEO METADATA

At the very end of your output, after the post body, include this block exactly:

---SEO_METADATA---
meta_title: [from structure plan, 55 chars max]
meta_description: [from structure plan, 155 chars max]
url_slug: [from structure plan]
primary_keyword: ${primaryKeyword}
---END_METADATA---

## OUTPUT

Write the complete post in markdown. Start with the opening hook, then the H1, then body sections with H2/H3 headers, then the conclusion. End with the SEO metadata block. Sections are separated by H2 headings ONLY. Do NOT insert horizontal rules or "---" divider lines between sections in the post body; the only "---" permitted anywhere in your output is the SEO metadata delimiter at the very end.

Target: 1,200-1,500 words for the body (not counting the metadata block), subject to rule 33.`;
}

export function buildCall3Prompt(inputs) {
  const { call2Output, transcript, primaryKeyword, dynamicTov, ragFlag, ragChunks, talkingPoints, editorLessons } = inputs;

  const linkedinSource = ragFlag
    ? `No voice memo available. Base the LinkedIn post on the published blog post content and ${CLIENT.firstName}'s static TOV profile.`
    : `Voice memo transcript (draw authentic language from here):
${transcript}

Dynamic TOV signals:
${JSON.stringify(dynamicTov, null, 2)}`;

  const facebookSource = ragFlag
    ? `No voice memo available. Base the Facebook post on the blog content and static TOV profile.`
    : `Voice memo transcript:
${transcript}`;

  // The fabrication check needs the ground truth to check against.
  const groundTruth = ragFlag
    ? `Content-database chunks the draft was built from:\n${ragChunks}`
    : `Voice memo transcript:\n${transcript}`;

  return `You are an expert SEO editor and social media copywriter. You have three jobs in this call:

1. Polish the blog post draft to publication standard.
2. Write a LinkedIn post draft.
3. Write a Facebook post draft.

Then produce a single JSON output package for the automation system.

---

## CLIENT VOICE — STATIC PROFILE (the reference for every polish decision)

${STATIC_TOV}

---

## SOURCE MATERIAL (ground truth for the fabrication check)

${groundTruth}

Previously published talking points (restating these is allowed):
${talkingPointsBlock(talkingPoints)}

${FACTS_AND_ANONYMITY}

${lessonsBlock(editorLessons)}---

## PART 1 — POLISH THE DRAFT

### Draft to polish:
${call2Output}

### Polish ground rule — hard limit

Polishing is editing, not rewriting. Do not add content that was not in the draft. Do not change any factual claim, figure, price, product name, client detail, date, or URL, EXCEPT to remove something the source material does not support or to correct a canonical fact. If something appears wrong and is not covered by those two exceptions, flag it in the craft audit rather than changing it.

### Polish checklist — work through every item:

VOICE CHECKS:
- [ ] First person throughout (not third-person self-referential)
- [ ] Contractions used naturally

AI-TELL REMOVAL — find and fix every instance:
- [ ] EM DASHES (—): completely banned. Replace with period + new sentence, or comma. Zero tolerance.
- [ ] "navigate" / "navigating" → rewrite
- [ ] "landscape" → rewrite
- [ ] "straightforward" → rewrite
- [ ] "leverage" → rewrite
- [ ] "robust" → rewrite
- [ ] "utilize" → use "use"
- [ ] "holistic" → rewrite
- [ ] "comprehensive" → rewrite
- [ ] "it's important to note" → delete or rewrite
- [ ] "in today's market" / "in today's world" → delete
- [ ] "when it comes to" → rewrite
- [ ] "not just X but Y" constructions → rewrite as plain statement
- [ ] "at the end of the day" → delete
- [ ] "This isn't about X, it's about Y" → rewrite
- [ ] "It's not X. It's Y." parallel constructions → rewrite
- [ ] "X isn't A because B. X is C because D." paired contrasts → rewrite as one plain statement
- [ ] Any sequence of 3+ sentences starting the same way (I... I... I... or This... This... This...) → break the pattern
- [ ] Any sequence of 3+ sentences with identical grammatical structure → vary

NARRATIVE HOOK OPENERS — banned completely:
- "Here's the part that stings"
- "Here's what nobody talks about"
- "This is the part that quietly..."
- "This is what most people miss"
- "And here's why that matters"
- Any sentence beginning with "Here's" used as a dramatic setup before a reveal

These are AI narrative hooks: dramatic setups that promise a hidden truth before delivering it. ${CLIENT.firstName} doesn't frame things this way. He states things directly. If any of these appear in the draft, rewrite as a plain declarative sentence. "Here's the thing" used as a plain mid-argument transition is ${CLIENT.firstName}'s own and stays.

SEO CHECKS:
- [ ] Primary keyword reads naturally everywhere it appears — flag it in the craft audit if it appears unnaturally often or reads as stuffed. Do not add instances.
- [ ] All planned internal links (1-3, per the structure plan) present in markdown format, read naturally in context, and are not clustered together, spaced across the post

STRUCTURAL CHECKS:
- [ ] Opening hook is 1-3 sentences stating the post's thesis (a position, not a scene). If the draft opens with an anecdote, conversation, or time reference the source material does not support, replace it with a thesis statement assembled from claims already in the draft
- [ ] H1 line ("# Title") appears immediately after the hook. The polished post MUST contain exactly one H1 — keep the draft's H1 (edit its wording if needed), and never delete it outright
- [ ] If the draft has more than one H1, keep the first and demote or remove the extras — deduplicating must never leave zero H1s
- [ ] Body length: do not shrink the post by cutting whole sections, and do not pad it. Tighten sentences and fix the checklist items. A post that lands under 1,200 words because the source material is thin is acceptable (not under 1,000)
- [ ] NO horizontal rules / "---" divider lines between sections — delete any (markdown "---" renders as <hr>); sections are separated by H2 headings only. The SEO metadata "---" delimiter at the very end is the sole exception.
- [ ] All headers in Title Case
- [ ] Conclusion does NOT summarize — it moves the reader forward
- [ ] Conclusion H2 is a declarative statement, not "Conclusion" or "Final Thoughts"
- [ ] CTA is a plain, low-pressure invitation to discuss, matching the closing pattern in the TOV profile — not generic ("don't hesitate to reach out"), not a phone call
- [ ] Blank line between all paragraphs

FABRICATION CHECK (check every sentence against the SOURCE MATERIAL above):
- [ ] No invented case studies or unnamed client stories → remove and reframe qualitatively
- [ ] No invented statistics or specific percentages → remove and reframe
- [ ] No claims attributed to unnamed studies → remove
- [ ] No invented events or conversations ("someone messaged me") and no relative time ("last week," "five years ago") the source does not contain → remove
- [ ] No claimed process ("in my research," "when I tested this") the source does not describe → remove
- [ ] No stance, hedge, or recommendation attributed to ${CLIENT.firstName} that they did not express, including a completed thought where the transcript trails off → remove
- [ ] No client names anywhere (body, headings, socials, metadata) → replace with a role and industry description
- [ ] No misstated canonical facts → correct them
- [ ] Anything copied from a talking point or an earlier post sentence for sentence → restate in new words

After polishing, output the clean post. Then continue to Part 2.

---

## PART 2 — LINKEDIN DRAFT

Write a LinkedIn post based on this topic and voice memo.

Rules:
- 200-300 words
- Draw from the voice memo transcript for authenticity — ${CLIENT.firstName}'s actual phrasing, specific references, or opinions expressed
- First person, ${CLIENT.firstName}'s voice (use the static TOV profile)
- Open with the post's thesis or a specific observation from the transcript — not a question, not "In today's market", not an invented scene
- Professional but conversational — this is LinkedIn, not a press release
- Close with a soft CTA: invite people to book a call or share if useful.
- End the post with a "link in comments" line, exactly: Full post linked in comments
- Never include a URL or a "[POST_URL]" placeholder anywhere in the text. The post link is pasted into the comments separately, not in the body.
- No hashtag soup. Maximum 2-3 relevant hashtags if they fit naturally, otherwise none.
- No em dashes. Same voice rules as the blog post.
- Same fabrication and client-anonymity rules as the blog post.

${linkedinSource}

---

## PART 3 — FACEBOOK DRAFT

Write a Facebook post based on this topic.

Rules:
- 50 words maximum — this should be punchy and human
- Draw the most authentic, specific line from the voice memo — one thing ${CLIENT.firstName} actually said or would say
- Conversational, plain, local — this is Facebook, not a press release
- End with a "link in comments" line, exactly: Link in comments
- Never include a URL or a "[POST_URL]" placeholder anywhere in the text. The post link is pasted into the comments separately.
- No hashtags on Facebook
- No em dashes

${facebookSource}

---

## PART 4 — JSON OUTPUT PACKAGE

After the polished post and both social drafts, output this JSON block exactly. This is parsed by the automation system — format must be exact.

|||OUTPUT_START|||
{
  "post": {
    "title": "[H1 from polished post]",
    "slug": "[url_slug from SEO metadata]",
    "meta_title": "[meta_title from SEO metadata, 55 chars max]",
    "meta_description": "[meta_description from SEO metadata, 155 chars max]",
    "primary_keyword": "${primaryKeyword}",
    "body_md": "[full polished post body in markdown — escaped for JSON]",
    "internal_links": ["[URL 1]", "[URL 2]", "[URL 3]"] (1-3 entries, omit array entirely if none used),
    "rag_fallback": ${ragFlag}
  },
  "social": {
    "linkedin": "[full LinkedIn draft text — escaped for JSON]",
    "facebook": "[full Facebook draft text — escaped for JSON]"
  }
}
|||OUTPUT_END|||

This JSON block is required. Do not skip it. The automation cannot complete without it.

---

## CRAFT AUDIT (internal — not published, stored in Supabase for review)

After the JSON block, produce a compact audit log:

CRAFT AUDIT:
- Word count: [X words]
- Primary keyword count: [X instances]
- Em dashes found and removed: [X]
- AI-tell phrases removed: [list]
- Parallel constructions rewritten: [list or "none found"]
- Internal links verified: [each internal link URL, or "none"]
- Fabrication issues found: [list or "none"]
- Remaining concerns: [anything needing human review, or "none"]`;
}

// One bounded corrective pass: fed the model's own Call 3 response plus the
// error-level lint findings, asking for surgical fixes only. The response
// must reuse the exact Call 3 output format so parseCall3Response works
// unchanged on it. `sourceMaterial` (transcript or RAG chunks) is supplied
// when any finding is a grounding finding, so a fix restates what the source
// actually says instead of guessing.
export function buildLintRevisionPrompt({ call3Response, findings, sourceMaterial = null }) {
  const hasGrounding = findings.some((f) => f.check === 'ungrounded');
  const source = hasGrounding && sourceMaterial
    ? `\nSOURCE MATERIAL (the only things the post may assert):\n${sourceMaterial}\n`
    : '';
  return `Your previous response is below. An automated lint pass found rule violations that must be corrected before the post can be used.

VIOLATIONS TO FIX:
${findings.map((f) => `- [${f.check}] ${f.detail}`).join('\n')}
${source}
Fix EXACTLY these violations and change NOTHING else — same content, same structure, same voice, same links.
- A narrative-hook opener ("Here's what nobody...", "This is the part that...") must be restated as a plain declarative sentence.
- An em dash must be replaced with a period, comma, or reworded sentence.
- A banned phrase must be reworded to say the same thing plainly.
- A missing internal link must be re-inserted using markdown link syntax.
- A client name must be replaced with a role and industry description ("a plumbing company owner") everywhere it appears.
- A known-fact error must be corrected to the canonical fact (${(CLIENT.canonicalFacts ?? []).join(' ') || 'none listed'}).
- A verbatim-reuse finding means a run of words was copied from an earlier post; restate that passage in new words.
- An ungrounded sentence must be removed, or restated as only what the source material actually says. Never invent a replacement detail, anecdote, figure, or time reference. If removing a sentence leaves the opening without a hook, open with a plain thesis statement built from claims already in the post. If removing it leaves a section thin, tighten the section; do not fill it with new claims.

Return your corrected response in EXACTLY the same format as before: the polished post, the social drafts, the |||OUTPUT_START|||...|||OUTPUT_END||| JSON package, then the CRAFT AUDIT section. Apply every fix consistently in the post body, the JSON package, and the social drafts.

YOUR PREVIOUS RESPONSE:
${call3Response}`;
}
