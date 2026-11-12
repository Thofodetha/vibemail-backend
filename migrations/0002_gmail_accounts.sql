-- 0002_gmail_accounts.sql
-- CONTRACT.md §4.2. One Gmail account per user; holds the encrypted Google tokens.
-- access_token_enc / refresh_token_enc are AES-256-GCM ciphertext written by the
-- app (§1.9); the database never sees plaintext tokens.
-- Idempotent: safe to run any number of times.

begin;

create table if not exists public.gmail_accounts (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null unique
                                references public.users (id) on delete cascade,
  google_sub        text        not null unique,
  email             text        not null unique,   -- stored lowercase by the app
  access_token_enc  text        not null,
  refresh_token_enc text        not null,
  token_expires_at  timestamptz not null,
  scopes            text[]      not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null
);

commit;
