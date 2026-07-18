-- Autoblog pipeline schema. Apply via the Supabase SQL editor or
-- `supabase db push` on a fresh project.
--
-- REGENERATED from the reference build's live migrations 0001-0009
-- (init, keywords rework, image categories, reminder ladder, link
-- injection, per-URL freshness, link surplus, link sweep), consolidated
-- into one fresh-project script. Per the extraction plan, never copy a
-- stale snapshot — regenerate from the source build's migrations at the
-- start of each new client build if the reference has moved on.
--
-- BEFORE RUNNING: replace the topic-category CHECK values (marked
-- "REPLACE PER CLIENT" below, in `topics` and `images`) with the client's
-- categories. Keep them in sync with CLIENT.topicCategories in
-- lib/client-config.js and the selects in admin/index.html.
--
-- The RAG store (content_chunks + match_content_chunks) is OPTIONAL. If you
-- are not using the no-voice-memo fallback, you can skip the `vector`
-- extension and everything under "RAG store" below.
--
-- Fully idempotent: IF NOT EXISTS everywhere, duplicate_object-guarded DO
-- blocks for enum types, so a partial run can be safely retried.

create extension if not exists vector;  -- optional: only needed for RAG fallback

-- ---------------------------------------------------------------- enums
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS; guard each enum so a retry
-- after a partial run does not abort the whole script.

do $$ begin
  create type topic_status as enum (
    'upcoming', 'reminder_sent', 'recorded', 'generating', 'published', 'auto_generated',
    -- three-step reminder ladder (the cron emails 3, 2, and 1 days out);
    -- legacy single-step 'reminder_sent' stays valid but nothing writes it.
    'reminder_sent_3d', 'reminder_sent_2d', 'reminder_sent_1d'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type post_status as enum ('draft', 'pending_review', 'published');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type image_source as enum ('owned', 'stock');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type chunk_source as enum ('voice_memo', 'post');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type link_risk_tier as enum ('trusted', 'standard');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------- topics

create table if not exists topics (
  id                uuid primary key default gen_random_uuid(),
  order_index       integer not null unique,
  title             text not null,
  description       text,           -- 1-2 sentences, injected as {{TOPIC_DESCRIPTION}}
  primary_keyword   text,           -- injected as {{PRIMARY_KEYWORD}}
  guiding_questions text[],         -- 3-4 questions shown to the creator before recording
  -- REPLACE PER CLIENT: must match CLIENT.topicCategories in lib/client-config.js
  category          text check (category in ('example-category-a', 'example-category-b')),
  scheduled_date    date,
  status            topic_status not null default 'upcoming',
  created_at        timestamptz not null default now()
);

create index if not exists topics_scheduled_date_idx on topics (scheduled_date);
create index if not exists topics_status_idx on topics (status);

-- ------------------------------------------------------------ voice_memos

create table if not exists voice_memos (
  id           uuid primary key default gen_random_uuid(),
  topic_id     uuid not null references topics(id),
  transcript   text not null,
  recorded_at  timestamptz not null default now(),
  tov_signals  jsonb           -- dynamic TOV extraction output (pre-pass)
);

create index if not exists voice_memos_topic_id_idx on voice_memos (topic_id);

-- ----------------------------------------------------------------- posts

create table if not exists posts (
  id               uuid primary key default gen_random_uuid(),
  topic_id         uuid references topics(id),
  voice_memo_id    uuid references voice_memos(id),  -- null = RAG fallback run
  slug             text not null unique,
  title            text not null,
  body_md          text not null,
  meta_title       text,
  meta_description text,
  primary_keyword  text,
  keywords_used    text[],
  internal_link_a  text,           -- first internal link used (null if none)
  internal_link_b  text,           -- second internal link used, may be null (0-2 links per post)
  image_used       text,           -- image library repo path, null when no image was linked
  rag_fallback     boolean not null default false,
  craft_audit      text,           -- Call 3 audit log, for editor review
  social_linkedin  text,           -- LinkedIn draft, held until publish
  social_facebook  text,           -- Facebook draft, held until publish
  status           post_status not null default 'draft',
  generated_at     timestamptz not null default now(),
  published_at     timestamptz,
  -- Link-sweep idempotency marker: the sweep targets pending_review posts
  -- where this is null and stamps it after a successful run (including
  -- zero-source runs). Null it manually to force a re-sweep of a post.
  links_checked_at timestamptz
);

create index if not exists posts_status_idx on posts (status);
create index if not exists posts_topic_id_idx on posts (topic_id);

-- -------------------------------------------------------------- keywords
-- Primary/secondary keyword tracking (the reworked design): each topic keeps
-- its own primary_keyword column; two supporting keywords are associated per
-- topic through the topic_keywords join table. Seed with
-- scripts/seed-topics-keywords.js.

create table if not exists keywords (
  id          uuid primary key default gen_random_uuid(),
  term        text not null unique,
  tier        text not null check (tier in ('primary', 'secondary')),
  created_at  timestamp with time zone default now()
);

-- Two supporting keyword associations per topic. on delete cascade keeps the
-- join table clean if a topic or keyword is ever removed.
create table if not exists topic_keywords (
  topic_id    uuid references topics(id) on delete cascade,
  keyword_id  uuid references keywords(id) on delete cascade,
  primary key (topic_id, keyword_id)
);

-- ---------------------------------------------------------------- images
-- Image library. Rows are inserted by the admin Image Upload flow
-- (api/admin/media.js); the publish cron loosely links one unused image per
-- post by category.

create table if not exists images (
  id              uuid primary key default gen_random_uuid(),
  filename        text not null unique,   -- site-root-relative repo path
  source          image_source not null,
  alt_text        text,
  used            boolean not null default false,
  used_in_post_id uuid references posts(id),
  category        text
);

-- REPLACE PER CLIENT: must match topics.category values above.
do $$ begin
  alter table images add constraint images_category_check
    check (category in ('example-category-a', 'example-category-b'));
exception
  when duplicate_object then null;
end $$;

create index if not exists images_category_idx on images (category);

-- ----------------------------------------------------------- system_config

create table if not exists system_config (
  key   text primary key,
  value text not null
);

insert into system_config (key, value) values
  ('editor_toggle', 'on'),
  ('publish_time', '06:02'),
  ('reminder_hours_before', '24'),
  ('fallback_cutoff', 'publish_time')
on conflict (key) do nothing;

-- The link pipeline's client profile rows (link_client_business_type,
-- link_client_market) are written by scripts/onboard-link-client.js.

-- ------------------------------------------------------- RAG store (OPTIONAL)
-- Chunked transcript / post body text with embeddings from OpenAI
-- text-embedding-3-small (1536 dims).

create table if not exists content_chunks (
  id          uuid primary key default gen_random_uuid(),
  source_type chunk_source not null,
  source_id   uuid not null,    -- voice_memos.id or posts.id per source_type
  chunk_index integer not null,
  content     text not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  unique (source_type, source_id, chunk_index)
);

create index if not exists content_chunks_embedding_idx
  on content_chunks using hnsw (embedding vector_cosine_ops);

-- Semantic search used by the RAG fallback (top-N chunks for a topic query).
create or replace function match_content_chunks(
  query_embedding vector(1536),
  match_count     int default 5
)
returns table (
  id          uuid,
  source_type chunk_source,
  source_id   uuid,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    id,
    source_type,
    source_id,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from content_chunks
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------- domains
-- External link injection: domain cache. One row per domain ever classified.
-- Cache hits are DB reads; API calls (search, fetch, Haiku/Sonnet scoring,
-- RDAP) only fire for domains not yet cached, so cost scales with unique new
-- domains, not post volume.
--
--   - liveness and trust drift are rechecked on independent clocks, keyed by
--     last_liveness_check / last_trust_check and risk_tier ('trusted' =
--     .gov/.edu/allowlisted domains, long recheck interval; 'standard' =
--     everything else, shorter interval).
--   - allowlisted is the per-client curated list that bypasses the freshness
--     max-age rule (.org gets no blanket pass).
--   - cross_mention_count tallies how often the domain surfaces across search
--     calls over time; it feeds the free trust-score proxy.
--   - freshness lives per-URL in url_freshness (publish date is a per-page
--     fact, not a per-domain one).

create table if not exists domains (
  domain              text primary key,          -- registrable domain, lowercase, no scheme
  business_type       text,                      -- Haiku-extracted; null = not yet classified
  market              text,                      -- Haiku-extracted geo/market; null = not yet classified
  is_competitor       boolean,                   -- computed: same business_type AND geo overlap with client
  trust_score         integer check (trust_score between 0 and 100),
  trust_signals       jsonb,                     -- component scores for auditability (age, structural, mentions, https)
  allowlisted         boolean not null default false,  -- curated per-client bypass of the freshness rule
  cross_mention_count integer not null default 0,
  risk_tier           link_risk_tier not null default 'standard',
  is_live             boolean,
  last_liveness_check timestamptz,
  last_trust_check    timestamptz,
  first_seen          timestamptz not null default now()
);

-- Competitor comparison query (candidate.business_type == client.business_type
-- AND market overlap) scans on these two columns together.
create index if not exists domains_business_type_market_idx
  on domains (business_type, market);

-- Recheck scheduler orders by time since last check, per tier.
create index if not exists domains_last_liveness_check_idx
  on domains (risk_tier, last_liveness_check);

-- ------------------------------------------------------------ url_freshness
-- Per-URL freshness verdicts. One-time and PERMANENT per page (a page's
-- publish date doesn't change); never touched by the recheck scheduler.

create table if not exists url_freshness (
  url               text primary key,          -- as fetched, fragment stripped (see urlCacheKey in lib/links/domains.js)
  domain            text not null references domains(domain),
  freshness_verdict boolean not null,          -- permanent, per page; never rechecked
  publish_date      date,                      -- null = undetectable
  reason            text,                      -- human-readable verdict rationale, for debugging/audit
  checked_at        timestamptz not null default now()
);

-- Non-unique domain reference: lets us find/clear all of a domain's URL
-- verdicts (e.g. if a domain is later allowlisted after some of its URLs
-- were rejected for staleness).
create index if not exists url_freshness_domain_idx on url_freshness (domain);

-- ------------------------------------------------------------ injected_links
-- Log of every link the pipeline injected, flagged for manual review, or
-- banked as surplus:
--   - 'injected' / 'flagged': the link, its scores at injection time, and
--     the injection date.
--   - 'surplus': candidates that passed every gate (competitor, trust,
--     freshness, relevancy) but were cut by the per-post cap (1 link per
--     ~400 words). Vetted, reusable work — offered to future posts in the
--     same topic category before those posts pay for a fresh web search.
--     Single-use: consumed_at is stamped on reuse (or when found dead) and
--     consumed rows are never offered again. Rows are never status-flipped:
--     a reused surplus row keeps its original discovery log; the new
--     injection writes its own status='injected' row.

create table if not exists injected_links (
  id                  uuid primary key default gen_random_uuid(),
  post_id             uuid references posts(id),   -- null for file-mode / test runs
  draft_ref           text,                        -- slug or filename when post_id is null
  url                 text not null,
  domain              text not null references domains(domain),
  anchor_text         text not null,
  claim               text,                        -- the claim the link supports
  relevancy_score     integer check (relevancy_score between 0 and 100),
  trust_score         integer check (trust_score between 0 and 100),
  relevancy_reasoning text,                        -- Sonnet's one-sentence rationale, shown in the admin review panel
  status              text not null check (status in ('injected', 'flagged', 'surplus')),
  injected_at         timestamptz not null default now(),
  topic_id            uuid references topics(id),  -- provenance: which run discovered the candidate; null for file-mode
  consumed_at         timestamptz,
  consumed_by_post_id uuid references posts(id),
  consumed_reason     text                         -- 'reused for new post' / 'dead URL: ...' — audit trail
);

create index if not exists injected_links_post_id_idx on injected_links (post_id);
create index if not exists injected_links_domain_idx on injected_links (domain);

-- Partial index matching exactly the surplus-reuse query: unconsumed surplus
-- rows for a set of topic ids.
create index if not exists injected_links_surplus_idx
  on injected_links (topic_id)
  where status = 'surplus' and consumed_at is null;

-- ------------------------------------------------------------------- RLS
-- All access goes through serverless functions using the service-role key,
-- which bypasses RLS. Enabling RLS with no policies denies everything to
-- the anon key, so a leaked anon key exposes nothing. ENABLE ROW LEVEL
-- SECURITY is a no-op if already enabled, so this is safe to re-run.

alter table topics         enable row level security;
alter table voice_memos    enable row level security;
alter table posts          enable row level security;
alter table keywords       enable row level security;
alter table topic_keywords enable row level security;
alter table images         enable row level security;
alter table system_config  enable row level security;
alter table content_chunks enable row level security;
alter table domains        enable row level security;
alter table url_freshness  enable row level security;
alter table injected_links enable row level security;
