# Autoblog Pipeline Template

A reusable, voice-memo-driven blog content pipeline for content-focused clients.
The client records a 2–3 minute voice note on a scheduled topic; the system
transcribes it (Whisper), generates a blog post plus LinkedIn and Facebook
drafts in the client's voice (Claude, three-call pipeline), publishes the post
as static HTML to their site, and logs the social drafts to a Google Sheet.
When no memo is recorded by publish time, an optional RAG fallback generates
from prior content. An editor-review toggle gates publishing until you trust it
to run autonomously.

Every generated draft also passes through an **external link injection sweep**
(`lib/links/`): factual claims are extracted, authoritative external sources
are found, vetted (competitor / trust / freshness / relevancy gates), and
injected as citation links — with borderline candidates flagged for manual
review in the admin panel. Publishing is blocked until the sweep has checked
a draft.

Generation is also held to a fact standard and builds memory over time. An
independent **grounding check** flags anything concrete in a draft that the
recording does not support (invented anecdotes, relative time, figures, finished
thoughts, client names) and holds auto-publish until a human looks. Published
posts are distilled into **talking points** that later drafts rehash, a **link
catalog** lets "link to that post" in a memo resolve to a real URL, uploads get a
**recording check** for dropped audio, and the system proposes **lessons** from
the editor's own edits that the editor approves in `/admin`. See "Quality gates
and memory" below.

This repo is the **template**. To deploy for a client you fill in one config
file, one voice profile, and a `.env`, then run the launch checklist.

---

## Prerequisites

Accounts / API keys before starting: **Vercel**, **GitHub** (a repo for the
client's site), **Supabase**, **Anthropic** (Claude), **OpenAI** (Whisper +
embeddings), **Google Cloud** (OAuth client + a service account with the
Sheets API enabled), **Resend**, **Twilio** (WhatsApp, currently shelved),
**SerpApi** (link-injection candidate sourcing; the free plan allows 250
searches a month, about 5 per post), and a **Google account** for
the social-log sheet. Node 18+ locally (Node 22 in the link-sweep workflow).

---

## Setup sequence

1. **Supabase** — create a project, open the SQL editor, replace the
   topic-category CHECK values in `supabase/schema.sql` (marked "REPLACE PER
   CLIENT"), then run it. `schema.sql` already includes every migration through
   0004, including the `service_role` grants (Supabase no longer grants access to
   new public tables automatically, so without them every read of the new tables
   fails with "permission denied"). An EXISTING deployment instead applies
   `supabase/migrations/0002` to `0004` in order. `pgvector` is needed for talking
   points and the link catalog as well as the RAG fallback.
2. **GitHub** — create the client's site repo, push this filled template to it.
3. **Vercel** — import the repo, add the env vars (below), deploy.
4. **Google OAuth** — create an OAuth client; authorized redirect URI is
   `<deployment-origin>/api/auth/google`.
5. **Twilio / Resend** — get credentials; verify the Resend sender domain.
6. **Google Sheet (social log)** — create a GCP service account, enable the
   Sheets API, share the client's social-log sheet with the service-account
   email as Editor. Set `GOOGLE_SHEETS_SPREADSHEET_ID` and the base64-encoded
   JSON key in `GOOGLE_SERVICE_ACCOUNT_KEY`.
7. **Link sweep (GitHub Actions)** — `.github/workflows/link-sweep.yml` runs
   `scripts/sweep-and-publish.js` every 30 minutes. Add the secrets it lists
   (`SERPAPI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_REPO`, `GITHUB_BRANCH`,
   `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY`,
   `VERIFY_BASE_URL`, plus `OPENAI_API_KEY` for the talking-points and catalog
   steps, which skip themselves without it, and optionally `RESEND_API_KEY` for
   the quota alert emails) to the repo's Actions secrets.
8. **Link-client onboarding** — after the site is live, run
   `npm run links:onboard` once. It crawls the client's own site, extracts
   `business_type` + `market`, and stores them in `system_config` so the
   sweep's competitor filter knows who the client is.
9. **Memory** — once the first posts are published, run
   `npm run talking-points:backfill` (add `-- --dry-run` to preview). After that
   the sweep workflow keeps talking points, the link catalog, and edit lessons
   current on its own. Approve proposed lessons in `/admin` > Settings.

---

## Configuration

Two places, no client values anywhere else:

- **`lib/client-config.js`** — every non-secret client value (name, domains,
  phone, emails, social URLs, service areas, timezone, topic categories,
  internal-link pools, blog/CTA copy, admin brand). Replace every
  `{{PLACEHOLDER}}`. The HTML templates and generation prompts read from here.
- **`lib/client-config.js` guardrails** — set `anonymizeNames` (client names that
  must never appear in a post), `canonicalFacts` (public facts the speaker tends to
  misstate), `pricingFacts` (prices and fees the model may state; empty if none),
  and `linkClaimGuidance` (what kinds of sentences are worth an outside source for
  this client's blog). `substackDomain` feeds the link catalog from a Substack
  (feed + sitemap); leave it empty for a client without one.
- **`.env`** — secrets and infra (copy `.env.example`). The same values go into
  the Vercel project. Where each comes from is annotated in `.env.example`.

`npm run preflight` reports anything still unfilled.

---

## Client-specific setup

- **Voice profile** — `docs/tov-profile-template.md`. Record 4–5 real client
  conversations, pull transcripts, and extract the voice patterns per the
  instructions in that file. This is loaded verbatim into every generation run
  and is the single biggest driver of output quality.
- **Topics + keywords** — formats in `content/seed/topics.example.json` and
  `content/seed/keywords.example.json`. Each topic needs `order_index`,
  `title`, `description`, `primary_keyword`, a literal `scheduled_date`, a
  `category` (one of `CLIENT.topicCategories`), exactly 2
  `supporting_keywords` (terms that must exist in keywords.json), and 3–4
  `guiding_questions`. Keywords are `{ term, tier }` with tier `primary` or
  `secondary` (a Tier 1 / Tier 2-3 strategy doc maps to primary / secondary).
  Copy your filled files to `content/seed/topics.json` + `keywords.json` and
  seed all three tables with `npm run seed:topics-keywords` (`-- --dry-run`
  to validate first).
- **Auto-scheduled topic seeding (alternative)** — `npm run seed topics <file>
  --start-date YYYY-MM-DD` schedules topic 1 on the start date and each
  subsequent one 6 days later, but does not seed keywords.
- **Topic categories** — keep four places in sync: `CLIENT.topicCategories`,
  the two `category` CHECKs in `supabase/schema.sql` (topics + images), and
  the category `<option>`s in `admin/index.html`. (`scripts/seed.js` and the
  admin APIs read from config.)
- **AI topic generation context** — `CLIENT.topicAgentContext` (who the client
  is, their market and specialties) drives the admin panel's "Generate Topics"
  and bulk-upload extraction. `CLIENT.altTextKeywords` drives image alt-text
  generation on upload.

---

## Deploy

Connect the GitHub repo to Vercel, set all env vars in the Vercel project, and
deploy. Posts publish with **no build step** — the publish flow renders static
HTML and commits it; Vercel serves it directly. `vercel.json` defines the two
cron jobs and clean URLs.

---

## First run

1. Seed the database (topics + keywords).
2. Test generation offline first: `npm run dev:mock` serves the admin UI with
   mock data at `/admin/?role=editor` and `/admin/?role=creator` — no
   credentials needed.
3. With real keys in `.env`, run a live generation:
   `node scripts/test-generation.js --topic <file> --transcript <file>`.
   Read the output against the voice profile and iterate the prompts in
   `lib/generation/` as needed.
4. Do a full dry run with the **editor toggle ON**: record a memo in `/admin`,
   let it generate, review and publish, confirm the post is live.

---

## Going live

Follow `docs/launch-checklist.md`: provision services, run the live dry run with
editor toggle ON, DNS cutover, then flip the editor toggle OFF in Supabase
`system_config` once you trust the output to publish unattended.

---

## External link injection

- **Flow:** the publish cron only generates and saves drafts as
  `pending_review`. The GitHub Actions sweep
  (`scripts/sweep-and-publish.js`, every 30 min) then extracts claims from
  each unchecked draft, finds candidate sources (SerpApi), gates them
  (competitor / trust / freshness / relevancy), injects passing links into
  the markdown, and — when the editor toggle is OFF — auto-publishes checked
  drafts. With the toggle ON, the admin Review tab shows the injected /
  flagged links (contradiction warnings included) and the Publish button
  stays disabled until the sweep has stamped the draft.
- **Tuning:** thresholds, caps, freshness max-age, and recheck intervals live
  in `lib/links/config.js`. The client's own domains are excluded
  automatically (from client-config).
- **Utilities:** `npm run links:inject -- --post <slug> --apply` (manual
  escape hatch; also has a `--file` mode for loose drafts),
  `npm run links:recheck` (liveness/trust drift recheck),
  `npm run links:onboard` (client profile, run once at setup).

---

## Quality gates and memory

All of this lives in `lib/` and is described in `docs/generation-prompt-spec.md`.

- **Thesis openers, no invention.** Posts open with a thesis statement, not a
  scene (a scene forced the draft to invent one whenever the recording had none).
  The prompts ban invented events, relative time, process claims, completing a
  thought the recording leaves unfinished, client names, and repeating a
  misstated public fact.
- **Grounding check** (`lib/generation/grounding.js`). Rules plus a verifier
  call. High-severity findings trigger one corrective pass; any that survive set
  `posts.grounding_report.blocking`, which holds auto-publish. Everything shows in
  the admin Review tab's "Fact check" panel.
- **Talking points** (`lib/talking-points.js`). Published posts are distilled
  into anonymized, restated ideas; later drafts may rehash them (never quote;
  a verbatim-reuse lint enforces it).
- **Link catalog** (`lib/catalog.js`). Blog posts and Substack posts as real link
  targets; a spoken "system, link to that post" is matched to one.
- **Recording check** (`lib/transcript-check.js`). Whisper's timing data is
  checked for gaps, looping filler, and a thin transcript; warnings show right
  after upload and reach the prompts.
- **Edit lessons** (`lib/edit-lessons.js`). `posts.body_md_generated` keeps the
  model's draft; after publishing, draft vs published yields proposed rules that
  only take effect once approved in `/admin` > Settings.
- **Link sweep resilience.** The sweep reads the SerpApi quota first (a free
  call). With none left it stamps posts `quota_exhausted`, keeps them retryable
  for 96 hours, and alerts the editor; a post whose searches all fail is retried
  instead of being stamped "checked" with zero links.
- Tests: `npm run test:quality` and `node scripts/test-cron.js`.

---

## Maintenance

- **SerpApi quota.** `/admin` > Settings shows searches left and a daily history,
  recorded by the sweep every 30 minutes. A free plan resets on its renewal date;
  if the number does not jump back up then, the plan is not resetting. Roughly
  5 searches are spent per post.
- **Edit lessons.** Check `/admin` > Settings now and then and approve or reject
  what the system proposes from your edits. Nothing is used until approved.
- **Model updates** — the generation model id is in
  `lib/generation/prompts.js` (`GENERATION_MODEL`); the embedding model in
  `lib/embeddings.js`. Update when providers retire models.
- **Cron / DST** — `vercel.json` cron schedules are in UTC. At each daylight-
  saving transition, shift the hours by one so publishing stays at the intended
  local time. `npm run preflight` reports the current offset.
- **Adding topics** — append to the topic list and re-run `npm run seed topics`
  (upserts are idempotent on `order_index`).

---

## Architecture notes

- **Single-commit publish (non-obvious, important).** Each publish commits the
  post file, the blog index, the JSON manifest, and the sitemap in **one**
  atomic commit via the GitHub Git Data API (`lib/github.js`). Never split this
  into two commits: a second commit in quick succession can trigger a Vercel
  race where the later build cancels the first and the site freezes at an
  intermediate state with no error thrown.
- **Three-call generation** (`lib/generation/`) is the core reusable asset:
  a dynamic-TOV pre-pass, then structure → draft → polish, with programmatic
  lint gates independent of the model's own self-audit. See
  `docs/generation-prompt-spec.md`.
- **Cron generates; Actions publishes.** The Vercel publish cron only
  generates and saves `pending_review` drafts (its many sequential steps
  stay inside serverless limits); the link sweep and auto-publish run
  out-of-band in GitHub Actions (`scripts/sweep-and-publish.js`) where the
  sweep's search/fetch/LLM calls aren't bounded by a function timeout.
  Published posts are also indexed into `content_chunks` as future RAG
  sources.
- **Reminder ladder.** The reminder cron emails the creator 3, 2, and 1 days
  before each scheduled date (`reminder_sent_3d/_2d/_1d` statuses); a
  recorded topic drops out of the ladder. WhatsApp reminders are shelved but
  the transport remains in `lib/notify.js`.
- **Image library.** Admin image uploads commit the file into the repo,
  insert an `images` row by category, and auto-generate SEO alt text via
  Claude vision; the publish cron loosely links one unused image per post by
  topic category.
- **RAG fallback is optional.** It adds the `pgvector` extension, the
  `content_chunks` table, and an embeddings backfill (`npm run index-embeddings`
  via `scripts/index-embeddings.js`). If a client doesn't need no-memo
  generation, skip the RAG section of `schema.sql` and it stays dormant.
- **Mock mode** drives the whole stack offline (`PIPELINE_MOCK=1` / `--mock`):
  `npm run dev:mock`, `node scripts/test-cron.js`. Mock verifies plumbing and
  branching, not writing quality or semantic RAG relevance — those need live
  keys.
