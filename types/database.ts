// Row types for the tables created by migrations/0001-0004 (CONTRACT.md §4).
// Property names are the Postgres column names. Timestamps (timestamptz) are ISO 8601
// strings, as the Supabase JS client returns them. These types do not depend on src/.

export type EmailAddress = { name: string | null; email: string };

export type AttachmentMeta = {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
};

/** public.users (§4.1) */
export type UserRow = {
  id: string;
  email: string;
  created_at: string;
  updated_at: string;
};

/** public.gmail_accounts (§4.2). The *_enc columns are AES-256-GCM ciphertext (§1.9). */
export type GmailAccountRow = {
  id: string;
  user_id: string;
  google_sub: string;
  email: string;
  access_token_enc: string;
  refresh_token_enc: string;
  token_expires_at: string;
  scopes: string[];
  created_at: string;
  updated_at: string;
};

/** public.messages (§4.3) */
export type MessageRow = {
  id: string;
  user_id: string;
  account_id: string;
  gmail_id: string;
  thread_id: string;
  history_id: string;
  internal_date: string;
  label_ids: string[];
  is_read: boolean;
  snippet: string;
  size_estimate: number;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  rfc822_message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  body_text: string | null;
  body_html: string | null;
  attachments: AttachmentMeta[];
  synced_at: string;
  created_at: string;
  updated_at: string;
};

/** public.gmail_sync_state (§4.4) */
export type GmailSyncStateRow = {
  account_id: string;
  user_id: string;
  history_id: string;
  watch_expiration: string;
  initial_sync_completed_at: string | null;
  last_delta_at: string | null;
  created_at: string;
  updated_at: string;
};
