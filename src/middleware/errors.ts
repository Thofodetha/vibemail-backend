import { httpStatus } from "../providers/gmail/errors";
import {
  BodyTooLargeError,
  InvalidPageTokenError,
  InvalidRecipientError,
  MessageNotFoundError,
  PersistenceFailedError,
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  SentNotPersistedError,
  ThreadNotFoundError,
  UnauthenticatedError,
  UpstreamError,
  ValidationError,
} from "../types/errors";

// The error envelope of CONTRACT 1.4 and the one function that turns typed errors into it
// (CONTRACT 5.2). Messages are fixed, human-readable strings: nothing from the underlying error
// is copied into a response, because those errors can carry tokens and internal addresses.

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryAfterSeconds?: number;
  };
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/** Maps any thrown value to the response it should produce. Unknown errors become a bare `INTERNAL`. */
export function describeApiError(error: unknown): ApiError {
  if (error instanceof UnauthenticatedError) {
    return {
      status: 401,
      code: "UNAUTHENTICATED",
      message: "A valid Bearer token is required.",
    };
  }
  if (error instanceof ReauthRequiredError) {
    return {
      status: 401,
      code: "GMAIL_REAUTH_REQUIRED",
      message: "Gmail access was revoked or has expired. Sign in again.",
    };
  }
  if (error instanceof ScopeInsufficientError) {
    return {
      status: 403,
      code: "GMAIL_SCOPE_INSUFFICIENT",
      message: "The granted Gmail permissions are not enough. Sign in again and allow access.",
    };
  }
  if (error instanceof ValidationError) {
    return {
      status: 400,
      code: "VALIDATION_FAILED",
      message: "The request failed validation.",
      details: { fields: error.fields },
    };
  }
  if (error instanceof RateLimitedError) {
    return {
      status: 429,
      code: "GMAIL_RATE_LIMITED",
      message: "Gmail is rate limiting this account. Try again later.",
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  if (error instanceof InvalidPageTokenError) {
    return { status: 400, code: "INVALID_PAGE_TOKEN", message: "The page token is not valid." };
  }
  if (error instanceof InvalidRecipientError) {
    return {
      status: 400,
      code: "INVALID_RECIPIENT",
      message: "Gmail rejected a recipient address.",
      ...(error.field === undefined ? {} : { details: { field: error.field } }),
    };
  }
  if (error instanceof BodyTooLargeError) {
    return { status: 413, code: "BODY_TOO_LARGE", message: "The message is too large." };
  }
  if (error instanceof ThreadNotFoundError) {
    return { status: 404, code: "THREAD_NOT_FOUND", message: "The thread does not exist." };
  }
  if (error instanceof MessageNotFoundError) {
    return { status: 404, code: "MESSAGE_NOT_FOUND", message: "The message does not exist." };
  }
  if (error instanceof SentNotPersistedError) {
    return {
      status: 500,
      code: "PERSISTENCE_FAILED",
      message:
        "The message was sent, but it could not be stored. Do not send it again; it will appear shortly.",
      details: { sent: true, gmailId: error.sentId, threadId: error.threadId },
    };
  }
  if (error instanceof PersistenceFailedError) {
    return {
      status: 500,
      code: "PERSISTENCE_FAILED",
      message: "Gmail was updated, but the change could not be stored. Retrying is safe.",
    };
  }
  if (error instanceof UpstreamError) {
    const gmailStatus = httpStatus(error.detail);
    return {
      status: 502,
      code: "GMAIL_UPSTREAM_ERROR",
      message: "Gmail failed to answer. Try again later.",
      ...(gmailStatus === undefined ? {} : { details: { gmailStatus } }),
    };
  }
  return { status: 500, code: "INTERNAL", message: "Something went wrong on the server." };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function errorResponse(
  { status, code, message, details, retryAfterSeconds }: ApiError,
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
  return jsonResponse(status, body, headers);
}

/** Server-side failures worth logging (never client mistakes or the user's own auth state). */
export function isServerFault(apiError: ApiError): boolean {
  return apiError.status >= 500;
}

/** A log-safe description: the name, the message and any HTTP status. Never the error object itself. */
export function describeForLog(error: unknown): string {
  if (error instanceof Error) {
    const detail = "detail" in error ? httpStatus((error as { detail?: unknown }).detail) : undefined;
    return `${error.name}: ${error.message}${detail === undefined ? "" : ` (upstream ${detail})`}`;
  }
  return "non-error value thrown";
}
