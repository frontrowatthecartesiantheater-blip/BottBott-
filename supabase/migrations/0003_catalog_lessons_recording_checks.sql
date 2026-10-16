-- 0003: link catalog (blog + Substack), edit lessons, recording checks.
-- Additive and idempotent: safe to re-run, touches no existing data.
-- Apply AFTER 0002.
--
--   content_catalog           the author's own published posts (blog and Substack)
--                             with embeddings, so "link to that post" in a voice
--                             memo, and related-post links, resolve to a specific URL
--                             instead of the Substack home page.
--   edit_lessons              generalizable lessons extracted from the difference
--                             between the system's draft and the post as published.
--                             Nothing reaches the prompts until the editor approves it.
--   posts.lessons_extracted_at / posts.edit_similarity
--                             bookkeeping: each published post is compared once;
--                             edit_similarity is 1.0 for "published untouched" and
--                             falls as the editor changes more.
--   voice_memos.transcript_check
--                             Whisper-based findings (gaps, looping filler, thin
--                             transcript) so a corrupted recording is flagged
--                             instead of silently producing a short transcript.

alter table voice_memos add column if not exists transcript_check jsonb;
alter table posts add column if not exists lessons_extracted_at timestamptz;
alter table posts add column if not exists edit_similarity numeric;

-- ---------------------------------------------------------------- edit_lessons

create table if not exists edit_lessons (
  id             uuid primary key default gen_random_uuid(),
  source_post_id uuid references posts(id) on delete cascade,
  category       text not null default 'other'
                   check (category in ('opener', 'invention', 'facts', 'links', 'style', 'structure', 'other')),
  lesson         text not null,            -- an instruction the drafting prompts can follow
  before_text    text,                     -- short quote from the system's draft
  after_text     text,                     -- short quote of what the editor changed it to
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz
);

create index if not exists edit_lessons_status_idx on edit_lessons (status);
alter table edit_lessons enable row level security;

-- ------------------------------------------------------------- content_catalog

create table if not exists content_catalog (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('blog', 'substack')),
  url          text not null unique,
  title        text not null,
  summary      text,
  published_at timestamptz,
  embedding    vector(1536),
  synced_at    timestamptz not null default now()
);

create index if not exists content_catalog_embedding_idx
  on content_catalog using hnsw (embedding vector_cosine_ops);
alter table content_catalog enable row level security;

-- Closest catalog entries to a query, optionally limited to one source.
create or replace function match_content_catalog(
  query_embedding vector(1536),
  match_count     int  default 6,
  source_filter   text default null
)
returns table (
  id           uuid,
  source       text,
  url          text,
  title        text,
  summary      text,
  published_at timestamptz,
  similarity   float
)
language sql stable
as $$
  select
    c.id, c.source, c.url, c.title, c.summary, c.published_at,
    1 - (c.embedding <=> query_embedding) as similarity
  from content_catalog c
  where c.embedding is not null
    and (source_filter is null or c.source = source_filter)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
