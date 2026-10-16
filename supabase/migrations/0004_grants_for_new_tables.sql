-- 0004: let the service role use the tables added in 0002 and 0003.
--
-- Supabase no longer grants access to new tables in the public schema
-- automatically (the older tables predate that change). Without these grants
-- every read or write from the app fails with "permission denied for table ...",
-- including the match_* functions. The service role is what the app and the
-- GitHub workflow use; anon and authenticated stay locked out (RLS is on, with no
-- policies), so a leaked public key still exposes nothing.
--
-- Idempotent: safe to re-run.

grant all on table talking_points  to service_role;
grant all on table edit_lessons    to service_role;
grant all on table content_catalog to service_role;

grant execute on function match_talking_points(vector, int, uuid) to service_role;
grant execute on function match_content_catalog(vector, int, text) to service_role;
