import jwt from "jsonwebtoken";
import { ReauthRequiredError, UnauthenticatedError } from "../types/errors";
import type { AccountStore } from "../types/stores";

// The app's own session token (CONTRACT 1.8): HS256, signed with JWT_SECRET, claims `sub` (the
// internal user id), `iat` and `exp` (one hour later). There is no refresh: when it expires the
// client signs in again. Verification accepts HS256 only, so `none` and key-confusion tokens fail.

export const JWT_LIFETIME_SECONDS = 3600;

function requireSecret(secret: string): void {
  if (!secret) throw new Error("JWT_SECRET must be set");
}

export function signJwt(userId: string, secret: string, now: Date = new Date()): string {
  requireSecret(secret);
  const iat = Math.floor(now.getTime() / 1000);
  return jwt.sign({ sub: userId, iat, exp: iat + JWT_LIFETIME_SECONDS }, secret, {
    algorithm: "HS256",
  });
}

/** @throws UnauthenticatedError for anything other than a valid, unexpired HS256 token with a subject. */
export function verifyJwt(token: string, secret: string, now: Date = new Date()): { userId: string } {
  requireSecret(secret);
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      clockTimestamp: Math.floor(now.getTime() / 1000),
    });
  } catch {
    throw new UnauthenticatedError("the token is invalid or expired");
  }
  if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub === "") {
    throw new UnauthenticatedError("the token has no subject");
  }
  // A token that never expires is not one this service issued.
  if (typeof payload.exp !== "number") {
    throw new UnauthenticatedError("the token has no expiry");
  }
  return { userId: payload.sub };
}

/** Reads `Authorization: Bearer <token>`. The scheme is case-insensitive. */
export function bearerToken(header: string | null): string {
  const match = header ? /^Bearer +(\S+)$/i.exec(header.trim()) : null;
  if (!match?.[1]) throw new UnauthenticatedError("no Bearer token");
  return match[1];
}

export interface AuthenticatedUser {
  userId: string;
  accountId: string;
  email: string;
}

/**
 * Authenticates a request: a valid Bearer JWT, then the user's Gmail account (one per user).
 *
 * @throws UnauthenticatedError for a missing or bad token
 * @throws ReauthRequiredError when the user has no linked Gmail account
 */
export async function authenticate(
  request: Request,
  deps: { jwtSecret: string; accounts: AccountStore; now?: () => Date },
): Promise<AuthenticatedUser> {
  const token = bearerToken(request.headers.get("authorization"));
  const { userId } = verifyJwt(token, deps.jwtSecret, deps.now?.());
  const account = await deps.accounts.getAccountForUser(userId);
  if (!account) throw new ReauthRequiredError("the user has no linked Gmail account");
  return { userId, accountId: account.accountId, email: account.email };
}
