import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The OAuth `state` nonce (CONTRACT 3.1): a random value kept in an HttpOnly, SameSite=Lax, Secure
// cookie for ten minutes and echoed back by Google. The callback accepts a sign-in only if the two
// match, which ties the callback to the browser that started it.

export const STATE_COOKIE = "vibemail_oauth_state";
export const STATE_MAX_AGE_SECONDS = 600;
/** Scoped to the sign-in routes so the cookie is not sent with API calls. */
const COOKIE_PATH = "/api/v1/auth/google";

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

const ATTRIBUTES = `Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;

/** The `Set-Cookie` value that stores the nonce. */
export function stateCookie(value: string): string {
  return `${STATE_COOKIE}=${value}; Max-Age=${STATE_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;
}

/** The `Set-Cookie` value that deletes it. */
export function clearedStateCookie(): string {
  return `${STATE_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}

export function readStateCookie(cookieHeader: string | null): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE) {
      const value = rest.join("=");
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/** Constant-time comparison; false when either side is missing. */
export function stateMatches(cookieValue: string | undefined, queryState: string | null): boolean {
  if (!cookieValue || !queryState) return false;
  const a = createHash("sha256").update(cookieValue).digest();
  const b = createHash("sha256").update(queryState).digest();
  return timingSafeEqual(a, b);
}
