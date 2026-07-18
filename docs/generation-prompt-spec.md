# Generation Prompt Spec — Four-Stage Pipeline

The generation engine (`lib/generation/`) turns a transcript (or RAG chunks)
into a polished post plus social drafts through one pre-pass and three main
Claude calls. Client-specific values come from `lib/client-config.js`; the
static voice foundation comes from `docs/tov-profile-template.md`. This is the
most valuable reusable asset in the template — keep it well-commented.

## Runtime inputs (per run)

`topicTitle`, `topicDescription`, `primaryKeyword`, `guidingQuestions`,
`transcript`, `priorPosts` (last 5, for internal-linking + repetition
avoidance), `ragFlag`, `ragChunks` (only when `ragFlag` is true). The static
TOV profile and the two internal-link pools are injected from config.

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

## Programmatic gates (`lib/generation/lint.js`)

Independent of the model's self-audit, `lintGenerationResult` checks H1 count,
header colons, em dashes, the banned-phrase and narrative-hook lists, keyword
count, word count, both internal links present, slug/meta lengths, and whether
the conclusion names the client. `checkH1` is reused at publish time as a hard
fail: a post body without exactly one H1 is never published.
