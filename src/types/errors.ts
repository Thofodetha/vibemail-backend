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
