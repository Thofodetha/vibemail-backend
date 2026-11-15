import type { ReadStateMailProvider } from "../providers/gmail/provider";
import {
  MessageNotFoundError,
  PersistenceFailedError,
  ValidationError,
} from "../types/errors";
import type { MessageContext, MessageStore, StoredMessage } from "../types/message";

const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface MarkReadDeps {
  provider: ReadStateMailProvider;
  messages: MessageStore;
}

/**
 * Marks a message read and stores the result (CONTRACT 3.4). Idempotent: marking an already-read
 * message succeeds and returns the same row. There is no way to mark a message unread here.
 *
 * Gmail is the source of truth, so the order is: change it there, read it back, then store it.
 *
 * @throws ValidationError for a malformed id
 * @throws MessageNotFoundError when Gmail has no such message
 * @throws PersistenceFailedError when Gmail was updated but the database write failed; retrying is safe
 */
export async function markRead(
  deps: MarkReadDeps,
  ctx: MessageContext,
  gmailId: string,
): Promise<StoredMessage> {
  if (!GMAIL_ID.test(gmailId)) {
    throw new ValidationError({ gmailId: "is not a valid message id" });
  }

  await deps.provider.setRead(gmailId, true);

  const message = await deps.provider.getMessage(gmailId);
  if (message === null) {
    // It existed a moment ago for the modify call, so it was deleted in between.
    throw new MessageNotFoundError("the message no longer exists");
  }

  try {
    const [stored] = await deps.messages.upsertMessages(ctx, [message]);
    if (!stored) throw new Error("the store returned no row");
    return stored;
  } catch (error) {
    throw new PersistenceFailedError("the change could not be stored", error);
  }
}
