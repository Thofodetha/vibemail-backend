import type {
  AttachmentMeta,
  EmailAddress,
  ProviderMessage,
} from "./provider";

/** A message as the API returns it (CONTRACT 1.7): the row in 4.3 with `from_*` folded into `from`. */
export interface StoredMessage {
  id: string;
  gmailId: string;
  threadId: string;
  historyId: string;
  /** ISO 8601 UTC. */
  internalDate: string;
  labelIds: string[];
  isRead: boolean;
  snippet: string;
  sizeEstimate: number;
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  /** ISO 8601 UTC. */
  syncedAt: string;
}

export interface MessageContext {
  userId: string;
  accountId: string;
}

export interface MessageStore {
  /**
   * Atomic: every row is written or none are. Upserts on `(accountId, gmailId)`, so re-running
   * is safe. Returns the stored messages in the same order as the input.
   */
  upsertMessages(
    ctx: MessageContext,
    messages: ProviderMessage[],
  ): Promise<StoredMessage[]>;
  /** Removes the given messages for the account and returns how many rows were removed. */
  deleteMessages(
    ctx: { accountId: string },
    gmailIds: string[],
  ): Promise<number>;
}
