-- 0003_messages.sql
-- CONTRACT.md §4.3. One row per Gmail message per linked Google account.
-- Column names are the snake_case of the API field names. "to" and "references"
-- are reserved words in Postgres, so they are quoted here and wherever they are
-- referenced in SQL.
-- Idempotent: safe to run any number of times.

begin;

create table if not exists public.messages (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null
                                references public.users (id) on delete cascade,
  account_id        uuid        not null
                                references public.gmail_accounts (id) on delete cascade,
  gmail_id          text        not null,
  thread_id         text        not null,
  history_id        text        not null,   -- a uint64, kept as text
  internal_date     timestamptz not null,
  label_ids         text[]      not null default '{}',
  is_read           boolean     not null,   -- derived by the app: not (label_ids contains 'UNREAD')
  snippet           text        not null default '',
  size_estimate     integer     not null,
  subject           text,
  from_name         text,
  from_email        text,
  "to"              jsonb       not null default '[]',   -- EmailAddress[]
  cc                jsonb       not null default '[]',   -- EmailAddress[]
  bcc               jsonb       not null default '[]',   -- EmailAddress[]
  rfc822_message_id text,
  in_reply_to       text,
  "references"      text[]      not null default '{}',
  body_text         text,
  body_html         text,
  attachments       jsonb       not null default '[]',   -- AttachmentMeta[]
  synced_at         timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null,
  constraint messages_account_id_gmail_id_key unique (account_id, gmail_id)  -- the upsert key
);

create index if not exists messages_user_id_internal_date_idx
  on public.messages (user_id, internal_date desc);

create index if not exists messages_user_id_thread_id_idx
  on public.messages (user_id, thread_id);

commit;
