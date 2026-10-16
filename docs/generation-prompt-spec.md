# Generation Prompt Spec — Four-Stage Pipeline

The generation engine (`lib/generation/`) turns a transcript (or RAG chunks)
into a polished post plus social drafts through one pre-pass and three main
Claude calls. Client-specific values come from `lib/client-config.js`; the
static voice foundation comes from `docs/tov-profile-template.md`. This is the
most valuable reusable asset in the template — keep it well-commented.

## Runtime inputs (per run)

`topicTitle`, `topicDescription`, `primaryKeyword`, `guidingQuestions`,
`transcript`, `priorPosts` (last 5, each `{ title, url }` carrying the full
`/blog/` URL, for internal-linking + repetition avoidance), `ragFlag`,
`ragChunks` (only when `ragFlag` is true), `talkingPoints` (closest previously
published ideas, see below) and `priorBodies` (published post text, for the
verbatim-reuse lint). `lib/generation/inputs.js` builds all of these for both
the cron and the manual draft endpoint. The static TOV profile and the two
internal-link pools are injected from config. Prompts use a prior post's `url`
verbatim — never assemble a post URL from its slug.

## Pre-pass — dynamic TOV extraction

A lightweight call that runs before the main calls whenever a memo exists. It
reads the raw transcript and returns a small JSON object — dominant phrases,
energy level, specific references, opinions expressed — that is folded into the
later calls as a per-recording supplement to the static profile. In a
multi-speaker transcript it extracts only the client's own speech.

## Call 1 — Structure pass

A content strategist plans the post section by section, deciding where the
client's actual words and opinions belong, choosing one internal link from each
pool, and emitting the hook, H1, H2 plan, conclusion, and SEO metadata. The
transcript is treated as the primary source, not a launching pad.

## Call 2 — Draft pass

Writes the full post in the client's voice using Call 1's plan as the blueprint.
Enforces ~30 numbered rules: first person, short sentences and paragraphs, no em
dashes, a banned-cliché list, no parallelisms, no narrative-hook openers, no
questions as section openers, contractions, fragments where natural, specificity
over abstraction, keyword placement (4–6× in body, in H1 / first paragraph /
one H2 / the conclusion), and a hard anti-fabrication rule (no invented stats or
client stories; figures only if the client said them).

## Call 3 — Polish + social drafts

Runs every quality gate over the draft, then writes a LinkedIn draft and a
Facebook draft, and emits a single JSON package (post fields + social text) for
the automation to parse, plus a craft audit stored for editor review.

## Openings, anonymity, and what may be asserted

Openers are a thesis statement synopsis (1-3 sentences stating the position the
post takes), not a scene. A scene forced the model to invent one whenever the
transcript had none. A real client fact may carry the opener only when it comes
from the transcript or a talking point and proves the thesis.

Concrete assertions must trace to the transcript, the approved facts in
`client-config.js` (`pricingFacts`, `canonicalFacts`), or a
published talking point. Rules 29-33 in Call 2 ban invented events and relative
time, invented process claims ("in my research"), completing a thought the
transcript leaves unfinished, client names (`anonymizeNames`), and repeating a
misstated public fact. When the source material cannot carry 1,200 words the
draft is padded with rehashed talking points and plain on-topic reasoning, or
simply runs shorter (not below 1,000), never with invention.

## Talking points (`lib/talking-points.js`, table `talking_points`)

When a post is published its final text is distilled by one model call into
6-12 reusable ideas (stance, claim, client_fact, how_to, metric), each restated
in neutral words, anonymized, embedded, and stored with the post it came from.
Generation retrieves the closest points for the topic; Calls 1-3 may rehash
them (never quote, never present them as said in the recording) and may link to
the source post. The link-sweep workflow extracts points for newly published
posts (it needs `OPENAI_API_KEY` for embeddings);
`npm run talking-points:backfill` does it by hand (`-- --dry-run` to preview).

## Grounding check (`lib/generation/grounding.js`)

An independent second look after Call 3, because the model's own craft audit
grades its own homework. Two layers: rules (relative-time phrases, "someone
messaged me" narratives, figures that appear nowhere in the source) and a
verifier call that lists every sentence asserting something concrete the source
does not support. High-severity findings are error-level lint findings, which
triggers the one corrective pass (re-checked afterward) and, if any survive,
sets `grounding_report.blocking` so auto-publish holds the post. Low-severity
findings (embellishments) show in the admin "Fact check" panel as warnings.

## Link catalog (`lib/catalog.js`, table `content_catalog`)

Every blog post and every Substack post (from its public feed and sitemap) is
stored with an embedding. The structure pass is offered the closest entries as
real link targets, and the pre-pass extracts spoken requests ("system link to
that post, please") with a description of the post meant; each is matched against
the catalog and handed to Call 1 as a link to include, with its match strength.
Spoken instructions to the system are never quoted in the post. A URL only ever
comes from this table. The sweep workflow refreshes it at most every 12 hours
(needs `OPENAI_API_KEY`).

## Recording check (`lib/transcript-check.js`)

Uploads are transcribed with Whisper's `verbose_json`, and the segment timing is
checked for gaps, looping filler, segments the transcriber distrusts, too few
words for the audio length, and a mid-sentence ending. Findings are shown to the
person who just recorded, stored on the memo (`voice_memos.transcript_check`, only
when something is wrong), and passed to the prompts as a "recording problems"
section so a missing stretch is treated as unknown and a cut-off thought is not
finished for the speaker.

## Learning from edits (`lib/edit-lessons.js`, table `edit_lessons`)

`posts.body_md_generated` keeps the model's draft (the admin overwrites
`body_md` with the editor's version). After publishing, the draft and the
published text are compared: `posts.edit_similarity` records how much survived, and
one model call proposes generalizable rules ("never open with an anecdote the
recording does not contain"). Proposals are `pending` until the editor approves
them in the admin Settings tab; only approved lessons are injected into Calls
1-3. The extraction prompt is told not to propose lessons that contradict the
voice profile (honest hedges and fragments stay).

## Programmatic gates (`lib/generation/lint.js`)

Independent of the model's self-audit, `lintGenerationResult` checks H1 count,
header colons, em dashes, the banned-phrase and narrative-hook lists, keyword
count, word count, both internal links present, slug/meta lengths, whether
the conclusion names the client, client names anywhere in the post or its
metadata (error), known public-fact slips such as the ChatGPT launch year
(error), and verbatim reuse of already-published posts (error; 12+ identical
words). `checkH1` is reused at publish time as a hard
fail: a post body without exactly one H1 is never published.
