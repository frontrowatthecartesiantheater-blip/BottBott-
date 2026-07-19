-- Set the five BottBott topic categories on topics.category and images.category,
-- replacing the template's example CHECK values. The two constraints must stay
-- in sync with CLIENT.topicCategories in lib/client-config.js and the
-- <option>s in admin/index.html.
--
-- Apply via the Supabase SQL editor or `supabase db push`.
--
-- PRE-FLIGHT (run first; both must return 0 rows before applying):
--   select distinct category from topics
--     where category not in ('ai-roi-efficiency', 'ai-powered-operations',
--       'founder-productivity', 'ai-content-visibility', 'case-studies');
--   select distinct category from images
--     where category not in ('ai-roi-efficiency', 'ai-powered-operations',
--       'founder-productivity', 'ai-content-visibility', 'case-studies');

-- Drop the old constraints by name rather than stacking new ones. The topics
-- constraint was declared inline on the column, so Postgres auto-named it
-- topics_category_check; images_category_check was named explicitly.
alter table topics drop constraint if exists topics_category_check;
alter table topics add constraint topics_category_check
  check (category in (
    'ai-roi-efficiency',
    'ai-powered-operations',
    'founder-productivity',
    'ai-content-visibility',
    'case-studies'
  ));

alter table images drop constraint if exists images_category_check;
alter table images add constraint images_category_check
  check (category in (
    'ai-roi-efficiency',
    'ai-powered-operations',
    'founder-productivity',
    'ai-content-visibility',
    'case-studies'
  ));
