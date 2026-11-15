import {
  ProviderError,
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  UpstreamError,
} from "../../types/errors";

interface GoogleErrorShape {
  message?: unknown;
  response?: { data?: { error?: unknown } };
}

/**
 * True when Google's token endpoint rejected a refresh token or code with `invalid_grant`
 * (revoked, expired, or already used). `google-auth-library` throws a GaxiosError whose
 * message is `invalid_grant` and whose body carries `error: "invalid_grant"`.
 */
export function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as GoogleErrorShape;
  return (
    shape.message === "invalid_grant" ||
    shape.response?.data?.error === "invalid_grant"
  );
}

/** The HTTP status of a failed Google call, if the error carries one (GaxiosError, or a plain object). */
export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const shape = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  for (const candidate of [shape.response?.status, shape.status, shape.code]) {
    const value = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value < 600) {
      return value;
    }
  }
  return undefined;
}

/** The `reason` of the first error in a Gmail API error body (`insufficientPermissions`, `rateLimitExceeded`, ...). */
function googleReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const shape = error as {
    response?: { data?: { error?: { errors?: { reason?: unknown }[] } } };
  };
  const reason = shape.response?.data?.error?.errors?.[0]?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Seconds from a `Retry-After` header, as a plain object or a `Headers`. Only the delta-seconds form is read. */
function retryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as { response?: { headers?: unknown } }).response?.headers;
  let raw: unknown;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get(name: string): unknown }).get("retry-after");
  } else if (typeof headers === "object" && headers !== null) {
    raw = (headers as Record<string, unknown>)["retry-after"];
  }
  const seconds = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
]);

/** Maps a failure from a Google call to a provider-neutral typed error. */
export function mapGoogleError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isInvalidGrant(error)) {
    return new ReauthRequiredError(
      "the refresh token was revoked or has expired",
      error,
    );
  }
  const status = httpStatus(error);
  const reason = googleReason(error);
  if (status === 403 && reason === "insufficientPermissions") {
    return new ScopeInsufficientError("the granted scopes do not allow this call", error);
  }
  if (status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    return new RateLimitedError(
      "Google is rate limiting this account",
      error,
      retryAfterSeconds(error),
    );
  }
  return new UpstreamError("Google request failed", error);
}
