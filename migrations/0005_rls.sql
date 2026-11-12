-- 0005_rls.sql
-- Row Level Security for the four tables in 0001-0004 (CONTRACT.md §4.6).
--
-- Model:
--   * RLS is enabled on every table.
--   * anon has no access at all.
--   * authenticated may only SELECT its own rows from users, messages and
--     gmail_sync_state. It has no grant and no policy on gmail_accounts, so the
--     encrypted tokens are never readable through the Data API. It has no
--     INSERT / UPDATE / DELETE anywhere: every write goes through the app.
--   * The app connects with the service-role key, which bypasses RLS and keeps
--     its own table grants. The policies below are therefore dormant for the app
--     and only take effect for requests that carry a Supabase-compatible JWT
--     (auth.uid() is null otherwise, which matches no row).
--
-- Idempotent: enabling RLS, revoke and grant are naturally repeatable, and each
-- policy is dropped before it is recreated.

begin;

alter table public.users            enable row level security;
alter table public.gmail_accounts   enable row level security;
alter table public.messages         enable row level security;
alter table public.gmail_sync_state enable row level security;

-- Start from nothing for the two client-facing roles, then grant back the minimum.
revoke all on table
  public.users, public.gmail_accounts, public.messages, public.gmail_sync_state
  from anon, authenticated;

grant select on table
  public.users, public.messages, public.gmail_sync_state
  to authenticated;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists gmail_sync_state_select_own on public.gmail_sync_state;
create policy gmail_sync_state_select_own on public.gmail_sync_state
  for select to authenticated
  using (user_id = (select auth.uid()));

commit;
