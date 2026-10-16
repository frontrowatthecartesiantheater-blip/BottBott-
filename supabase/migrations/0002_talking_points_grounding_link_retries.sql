-- 0002: talking points, grounding report, original-draft snapshot, link retries.
-- Additive and idempotent: safe to re-run, touches no existing data.
--
--   posts.body_md_generated        immutable snapshot of the model's draft, written
--                                  at generation time. The admin Save/Publish flow
--                                  overwrites body_md with the editor's version, so
--                                  without this the original system output is lost
--                                  (the original-vs-edit signal the system learns from).
--   posts.grounding_report         output of the grounding check: sentences the source
--                                  material does not support, and whether any block
--                                  auto-publish.
--   posts.links_status /           link-sweep bookkeeping. A post whose searches all
--   posts.links_attempts /         failed, or that was swept while the SerpApi quota
--   posts.links_report             was out, is marked retryable instead of being
--                                  stamped "checked" with zero links forever.
--                                  links_report keeps the sweep's skip reasons, which
--                                  were previously visible only in the Actions log.
--   posts.talking_points_extracted_at   stamp so each published post is distilled once.
--   talking_points                 reusable ideas extracted from published posts.

alter table posts add column if not exists body_md_generated           text;
alter table posts add column if not exists grounding_report            jsonb;
alter table posts add column if not exists links_status                text;
alter table posts add column if not exists links_attempts              integer not null default 0;
alter table posts add column if not exists links_report                jsonb;
alter table posts add column if not exists talking_points_extracted_at timestamptz;

-- ---------------------------------------------------------------- talking_points
-- One row per reusable idea from a published post, restated in neutral words
-- (never a verbatim sentence). Generation retrieves the closest points for a
-- new topic and may rehash them as supporting context. client_ref is an
-- anonymized label ("a plumbing company owner"); real client names
-- are never stored here.

create table if not exists talking_points (
  id             uuid primary key default gen_random_uuid(),
  source_post_id uuid not null references posts(id) on delete cascade,
  kind           text not null check (kind in ('stance', 'claim', 'client_fact', 'how_to', 'metric')),
  point          text not null,
  topics         text[] not null default '{}',
  client_ref     text,
  evidence_url   text,                      -- external source the post linked for this point, if any
  status         text not null default 'active' check (status in ('active', 'retired')),
  embedding      vector(1536),
  created_at     timestamptz not null default now(),
  unique (source_post_id, point)
);

create index if not exists talking_points_source_post_idx on talking_points (source_post_id);
create index if not exists talking_points_embedding_idx
  on talking_points using hnsw (embedding vector_cosine_ops);

alter table talking_points enable row level security;

-- Semantic lookup for generation: closest active points from published posts,
-- optionally excluding one post (the one being regenerated).
create or replace function match_talking_points(
  query_embedding  vector(1536),
  match_count      int  default 8,
  exclude_post_id  uuid default null
)
returns table (
  id             uuid,
  source_post_id uuid,
  source_slug    text,
  source_title   text,
  kind           text,
  point          text,
  topics         text[],
  client_ref     text,
  evidence_url   text,
  similarity     float
)
language sql stable
as $$
  select
    tp.id, tp.source_post_id, p.slug, p.title, tp.kind, tp.point, tp.topics,
    tp.client_ref, tp.evidence_url,
    1 - (tp.embedding <=> query_embedding) as similarity
  from talking_points tp
  join posts p on p.id = tp.source_post_id
  where tp.status = 'active'
    and tp.embedding is not null
    and p.status = 'published'
    and (exclude_post_id is null or tp.source_post_id <> exclude_post_id)
  order by tp.embedding <=> query_embedding
  limit match_count;
$$;
