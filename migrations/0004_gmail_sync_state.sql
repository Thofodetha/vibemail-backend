-- 0004_gmail_sync_state.sql
-- CONTRACT.md §4.4. One row per Gmail account: the cursor the delta sync resumes
-- from, and the watch lifetime.
-- Idempotent: safe to run any number of times.

begin;

create table if not exists public.gmail_sync_state (
  account_id                uuid        primary key
                                        references public.gmail_accounts (id) on delete cascade,
  user_id                   uuid        not null
                                        references public.users (id) on delete cascade,
  history_id                text        not null,   -- the sync cursor
  watch_expiration          timestamptz not null,
  initial_sync_completed_at timestamptz,
  last_delta_at             timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null
);

commit;
