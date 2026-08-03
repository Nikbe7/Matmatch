-- Local development seed. Applied by `supabase db reset` / `supabase start`.
--
-- This file is NOT pushed to the cloud project — `supabase db push` applies
-- migrations only. That separation is the point: the application role is created
-- without a password by the migration (a password in a committed migration would be
-- a credential installed in production), and gets a well-known throwaway one here so
-- local tests can connect.
--
-- The cloud project's password is set once, by hand, in the dashboard SQL editor:
--   alter role matmatch_app with password '<generated>';
-- See README.md.

alter role matmatch_app with password 'matmatch_local_dev';
