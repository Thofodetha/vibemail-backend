import type { MessageContext, StoredMessage } from "../types/message";
import type {
  AttachmentMeta,
  EmailAddress,
  ProviderMessage,
} from "../types/provider";

// Mapping between the domain message and the `messages` table (CONTRACT 4.3). Pure functions, so
// the mapping is unit-tested without a database. Used by both the in-memory and Supabase stores.

/** One row of `public.messages`, column names as in the migration. */
export interface MessageRow {
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
}

/** What an upsert sends: `id` and `created_at` are left out so an existing row keeps them. */
export type MessageUpsertRow = Omit<MessageRow, "id" | "created_at">;

export function toUpsertRow(
  ctx: MessageContext,
  message: ProviderMessage,
  now: Date,
): MessageUpsertRow {
  const stamp = now.toISOString();
  return {
    user_id: ctx.userId,
    account_id: ctx.accountId,
    gmail_id: message.id,
    thread_id: message.threadId,
    history_id: message.cursor,
    internal_date: message.receivedAt.toISOString(),
    label_ids: message.labelIds,
    is_read: message.isRead,
    snippet: message.snippet,
    size_estimate: message.sizeEstimate,
    subject: message.subject,
    from_name: message.from?.name ?? null,
    from_email: message.from?.email ?? null,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    rfc822_message_id: message.rfc822MessageId,
    in_reply_to: message.inReplyTo,
    references: message.references,
    body_text: message.bodyText,
    body_html: message.bodyHtml,
    attachments: message.attachments,
    synced_at: stamp,
    updated_at: stamp,
  };
}

export function fromRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    gmailId: row.gmail_id,
    threadId: row.thread_id,
    historyId: row.history_id,
    internalDate: new Date(row.internal_date).toISOString(),
    labelIds: row.label_ids,
    isRead: row.is_read,
    snippet: row.snippet,
    sizeEstimate: row.size_estimate,
    subject: row.subject,
    from:
      row.from_email === null
        ? null
        : { name: row.from_name, email: row.from_email },
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    rfc822MessageId: row.rfc822_message_id,
    inReplyTo: row.in_reply_to,
    references: row.references,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments: row.attachments,
    syncedAt: new Date(row.synced_at).toISOString(),
  };
}
