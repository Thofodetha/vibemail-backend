import type { ComposeMailProvider } from "../providers/gmail/provider";
import { BodyTooLargeError, SentNotPersistedError } from "../types/errors";
import type { MessageContext, MessageStore, StoredMessage } from "../types/message";
import { buildMime, type BuildOptions } from "./mime";
import { MAX_BODY_BYTES, parseSendRequest, type SendRequest } from "./request";

export { parseSendRequest, type SendRequest } from "./request";
export { buildMime } from "./mime";

export interface SendDeps {
  provider: ComposeMailProvider;
  messages: MessageStore;
  /** Test hooks for the message `Date` header and multipart boundary. */
  mime?: BuildOptions;
}

/**
 * Sends a message as the signed-in user and stores the sent copy (CONTRACT 3.3).
 *
 * 1. Build the RFC 5322 message. `From` is the account's own address (`ctx.fromEmail`).
 * 2. Send it. Gmail's reply holds only the new message's id and thread id.
 * 3. Fetch the sent message in full and upsert it. The send response has no `historyId`,
 *    `internalDate` or headers, which the stored row needs, so the message is read back.
 *
 * Sending is **not idempotent**, and it happens exactly once: nothing here retries it. If step 3
 * fails the message is already out, so this throws `SentNotPersistedError` (carrying the new ids)
 * rather than an ordinary error a client would retry. The delta sync stores the copy when Gmail
 * announces it.
 *
 * @param request already validated with `parseSendRequest`
 * @throws BodyTooLargeError, ValidationError, InvalidRecipientError, ThreadNotFoundError,
 *   SentNotPersistedError, and the provider's auth and rate-limit errors
 */
export async function sendMail(
  deps: SendDeps,
  ctx: MessageContext & { fromEmail: string },
  request: SendRequest,
): Promise<StoredMessage> {
  const bodyBytes =
    Buffer.byteLength(request.bodyText ?? "", "utf8") +
    Buffer.byteLength(request.bodyHtml ?? "", "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(`the message body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const rawMime = buildMime(request, ctx.fromEmail, deps.mime);
  const sent = await deps.provider.sendMessage({ rawMime, threadId: request.threadId });

  try {
    const message = await deps.provider.getMessage(sent.id);
    if (message === null) {
      throw new Error("the sent message could not be read back");
    }
    const [stored] = await deps.messages.upsertMessages(
      { userId: ctx.userId, accountId: ctx.accountId },
      [message],
    );
    if (!stored) {
      throw new Error("the store returned no row for the sent message");
    }
    return stored;
  } catch (error) {
    throw new SentNotPersistedError(sent.id, sent.threadId, error);
  }
}
