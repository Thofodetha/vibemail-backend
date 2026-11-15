import type { SignInResult } from "../providers/gmail/signin";
import {
  CodeExchangeFailedError,
  MissingScopesError,
  NoRefreshTokenError,
} from "../types/errors";
import type { ProviderAuth } from "../types/provider";
import { signJwt } from "./jwt";
import {
  clearedStateCookie,
  newState,
  readStateCookie,
  stateCookie,
  stateMatches,
} from "./state";

// The two browser-facing sign-in routes (CONTRACT 3.1). Both answer with redirects: this is the one
// place the error envelope is not used, because the caller is a browser navigating, not a script.
// A failure sends the browser to `${FRONTEND_URL}/login?error=<CODE>`.

export type OAuthErrorCode =
  | "OAUTH_ACCESS_DENIED"
  | "OAUTH_STATE_MISMATCH"
  | "OAUTH_CODE_EXCHANGE_FAILED"
  | "OAUTH_MISSING_SCOPES"
  | "OAUTH_NO_REFRESH_TOKEN"
  | "OAUTH_INTERNAL";

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** `GET /api/v1/auth/google`: remember a fresh nonce in a cookie and send the browser to Google. */
export async function startSignIn(deps: { auth: ProviderAuth }): Promise<Response> {
  const state = newState();
  const consentUrl = await deps.auth.getAuthorizationUrl({ state });
  return redirect(consentUrl, [stateCookie(state)]);
}

export interface CallbackDeps {
  /** Exchanges the code, checks scopes, stores the account and tokens, starts the watch. */
  signIn: (code: string) => Promise<SignInResult>;
  /** Runs after a successful sign-in, before the redirect is built. Its failure never changes the redirect. */
  afterSignIn: (result: SignInResult) => Promise<unknown>;
  frontendUrl: string;
  jwtSecret: string;
  now?: () => Date;
  /** Receives unexpected failures (database, encryption) for logging. */
  onError?: (error: unknown) => void;
}

function errorCodeFor(error: unknown): OAuthErrorCode {
  if (error instanceof CodeExchangeFailedError) return "OAUTH_CODE_EXCHANGE_FAILED";
  if (error instanceof MissingScopesError) return "OAUTH_MISSING_SCOPES";
  if (error instanceof NoRefreshTokenError) return "OAUTH_NO_REFRESH_TOKEN";
  return "OAUTH_INTERNAL";
}

/**
 * `GET /api/v1/auth/google/callback`. In order: Google's `error`, then the `state` against the
 * cookie (which is cleared either way), then the sign-in. On success the browser is redirected to
 * `${FRONTEND_URL}/auth/callback#token=<JWT>`; the token travels in the URL fragment, which
 * browsers do not send to servers. No JWT is issued and nothing is written on any failure.
 */
export async function handleOAuthCallback(
  deps: CallbackDeps,
  request: Request,
): Promise<Response> {
  const base = deps.frontendUrl.replace(/\/+$/, "");
  const clear = [clearedStateCookie()];
  const fail = (code: OAuthErrorCode) => redirect(`${base}/login?error=${code}`, clear);

  const params = new URL(request.url).searchParams;

  const googleError = params.get("error");
  if (googleError !== null) {
    return fail(googleError === "access_denied" ? "OAUTH_ACCESS_DENIED" : "OAUTH_INTERNAL");
  }

  const cookie = readStateCookie(request.headers.get("cookie"));
  if (!stateMatches(cookie, params.get("state"))) {
    return fail("OAUTH_STATE_MISMATCH");
  }

  let result: SignInResult;
  try {
    result = await deps.signIn(params.get("code") ?? "");
  } catch (error) {
    const code = errorCodeFor(error);
    if (code === "OAUTH_INTERNAL") deps.onError?.(error);
    return fail(code);
  }

  try {
    await deps.afterSignIn(result);
  } catch (error) {
    deps.onError?.(error);
  }

  let token: string;
  try {
    token = signJwt(result.userId, deps.jwtSecret, deps.now?.());
  } catch (error) {
    deps.onError?.(error);
    return fail("OAUTH_INTERNAL");
  }
  return redirect(`${base}/auth/callback#token=${token}`, clear);
}
