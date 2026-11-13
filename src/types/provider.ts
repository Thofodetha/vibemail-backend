// Provider abstraction: the contract every email provider implementation satisfies.
//
// Provider-agnostic by design. This file imports nothing and names no vendor.
// Identifiers and cursors are opaque strings that only the issuing provider can
// interpret. Callers must not parse, compare or construct them.

/** A provider's identifier for one message. Opaque. */
export type MessageId = string;

/** A provider's identifier for one conversation thread. Opaque. */
export type ThreadId = string;

/** Continuation token for a paged listing. Opaque. */
export type PageToken = string;

/**
 * A position in the provider's change history. Opaque.
 * Returned by `watchChanges` and `listChanges`, and passed back as `since`.
 */
export type SyncCursor = string;

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface AttachmentMeta {
  partId: string;
  filename: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  /** Null when the provider inlines the content and offers no separate handle. */
  attachmentId: string | null;
}

/**
 * One message in normalised form. The provider's parser produces it from the
 * wire format, so nothing outside the provider ever sees vendor payloads.
 */
export interface ProviderMessage {
  id: MessageId;
  threadId: ThreadId;
  /** The provider's change-history position at the time of reading. */
  cursor: SyncCursor;
  receivedAt: Date;
  labelIds: string[];
  /**
   * Derived from `labelIds` by the provider's parser, in one place, so the two
   * can never disagree.
   */
  isRead: boolean;
  snippet: string;
  /** Bytes, approximate. */
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
}

export interface ProviderTokens {
  accessToken: string;
  /** Absent on refresh results: providers usually do not re-issue it. */
  refreshToken?: string;
  expiresAt: Date;
}

/**
 * Sign-in and token operations. Stateless: usable before any account exists.
 * The redirect URI and scopes are implementation configuration, not arguments.
 */
export interface ProviderAuth {
  /**
   * Builds the URL the user is sent to for consent.
   * `state` is a caller-generated nonce that the provider echoes back on redirect.
   */
  getAuthorizationUrl(p: { state: string }): Promise<string>;

  /**
   * Exchanges the authorization code for tokens, verifies the identity
   * assertion, and reports who signed in and which scopes were granted.
   * `tokens.refreshToken` is undefined when the provider issued none; the
   * caller decides whether that is an error.
   *
   * @throws CodeExchangeFailedError when the code is missing, rejected, or the
   *   identity assertion fails verification.
   */
  exchangeCode(p: { code: string }): Promise<{
    tokens: ProviderTokens;
    grantedScopes: string[];
    identity: { subject: string; email: string };
  }>;

  /**
   * Explicitly refreshes an access token. For forced refresh and for providers
   * that do not refresh on their own. A `MailProvider` is expected to refresh
   * automatically whenever its access token has expired.
   *
   * @throws ReauthRequiredError when the refresh token is revoked or expired.
   */
  refreshAccessToken(p: { refreshToken: string }): Promise<ProviderTokens>;
}

/**
 * Mailbox operations, bound to one account's credentials at construction.
 *
 * Implementations throw these typed errors: `ReauthRequiredError`,
 * `ScopeInsufficientError`, `RateLimitedError`, `UpstreamError`, plus the
 * specific ones tagged below.
 */
export interface MailProvider {
  /**
   * Lists message ids, newest first. Several `labelIds` are AND-ed.
   * `query` uses the provider's own search syntax.
   *
   * @throws InvalidPageTokenError when `pageToken` is not accepted.
   */
  listMessages(p: {
    labelIds: string[];
    query?: string;
    maxResults: number;
    pageToken?: PageToken;
  }): Promise<{
    ids: MessageId[];
    nextPageToken: PageToken | null;
    resultSizeEstimate: number;
  }>;

  /** Fetches one message in full. Resolves null when it does not exist. */
  getMessage(id: MessageId): Promise<ProviderMessage | null>;

  /**
   * Sends a complete RFC 5322 message. The provider applies any wire encoding
   * its API requires. A retried call can send twice: this is not idempotent.
   *
   * @throws ThreadNotFoundError when `threadId` does not exist.
   */
  sendMessage(p: {
    rawMime: string;
    threadId?: ThreadId;
  }): Promise<{ id: MessageId; threadId: ThreadId }>;

  /**
   * Marks a message read (`true`) or unread (`false`). Idempotent.
   *
   * @throws MessageNotFoundError when the message does not exist.
   */
  setRead(id: MessageId, isRead: boolean): Promise<void>;

  /**
   * Starts (or renews) push notifications to `destination`, a provider-defined
   * notification channel. Returns the cursor from which changes are reported
   * and when the watch lapses unless renewed.
   */
  watchChanges(p: { destination: string }): Promise<{
    cursor: SyncCursor;
    expiresAt: Date;
  }>;

  /**
   * Lists changes made after `since`, oldest first, one page at a time.
   * `cursor` on the last page is the position to store for the next call.
   *
   * @throws CursorExpiredError when `since` is too old; callers then do a full resync.
   */
  listChanges(p: { since: SyncCursor; pageToken?: PageToken }): Promise<{
    changes: { type: "added" | "deleted" | "labelsChanged"; id: MessageId }[];
    nextPageToken: PageToken | null;
    cursor: SyncCursor;
  }>;
}
