import {
  ProviderError,
  ReauthRequiredError,
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

/** Maps a failure from a Google call to a provider-neutral typed error. */
export function mapGoogleError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isInvalidGrant(error)) {
    return new ReauthRequiredError(
      "the refresh token was revoked or has expired",
      error,
    );
  }
  return new UpstreamError("Google request failed", error);
}
