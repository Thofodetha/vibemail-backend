-- 0001_users.sql
-- CONTRACT.md §4.1. Idempotent: safe to run any number of times.
-- updated_at has no default: the application sets it on every write (§4).

begin;

create table if not exists public.users (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null unique,   -- stored lowercase by the app
  created_at timestamptz not null default now(),
  updated_at timestamptz not null
);

commit;
