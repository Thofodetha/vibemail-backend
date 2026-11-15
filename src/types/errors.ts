// Provider-neutral typed errors (CONTRACT 5.2). Entry points translate these to the
// HTTP error envelope in one shared function. Only the errors used so far exist;
// the rest of the 5.2 list is added with the code that throws them.

export class ProviderError extends Error {
  /** The underlying failure, when there is one. Never shown to clients. */
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = new.target.name;
    this.detail = detail;
  }
}

/** The refresh token is revoked, expired or missing: the user must sign in again. */
export class ReauthRequiredError extends ProviderError {}

/** The authorization code was missing or rejected, or the identity assertion failed verification. */
export class CodeExchangeFailedError extends ProviderError {}

/** The provider failed in a way the caller cannot fix (network, 5xx, malformed response). */
export class UpstreamError extends ProviderError {}

/** Sign-in succeeded but the user did not grant the mailbox scope the engine needs. */
export class MissingScopesError extends ProviderError {}

/** Sign-in succeeded but the provider issued no refresh token. */
export class NoRefreshTokenError extends ProviderError {}

/** The stored history cursor is too old for the provider to replay: the caller must resync in full. */
export class CursorExpiredError extends ProviderError {}

/** The granted scopes no longer allow the call: the user must grant access again. */
export class ScopeInsufficientError extends ProviderError {}

/** The provider is throttling this account. Retrying later may succeed. */
export class RateLimitedError extends ProviderError {}

/** A request failed validation. `fields` maps each offending field to what is wrong with it. */
export class ValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super(`validation failed: ${Object.keys(fields).join(", ")}`);
    this.name = "ValidationError";
    this.fields = fields;
  }
}

/** The provider rejected a recipient header. `field` names `to`, `cc` or `bcc` when that can be told. */
export class InvalidRecipientError extends ProviderError {
  readonly field: "to" | "cc" | "bcc" | undefined;

  constructor(message: string, field?: "to" | "cc" | "bcc", detail?: unknown) {
    super(message, detail);
    this.field = field;
  }
}

/** The message is larger than the engine or the provider accepts. */
export class BodyTooLargeError extends ProviderError {}

/** The thread a reply was addressed to does not exist. */
export class ThreadNotFoundError extends ProviderError {}

/**
 * The message WAS sent, but it could not be fetched back or stored. Sending is not idempotent, so
 * callers must not retry: the message is already in the recipient's hands, and the delta sync will
 * store the copy in Sent when Gmail announces it.
 */
export class SentNotPersistedError extends ProviderError {
  readonly sentId: string;
  readonly threadId: string;

  constructor(sentId: string, threadId: string, detail?: unknown) {
    super("the message was sent but could not be stored", detail);
    this.sentId = sentId;
    this.threadId = threadId;
  }
}
