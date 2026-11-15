import { MissingScopesError, NoRefreshTokenError } from "../../types/errors";
import type { ProviderAuth } from "../../types/provider";
import type {
  AccountStore,
  SyncStateStore,
  TokenStore,
} from "../../types/stores";
import { GMAIL_MODIFY_SCOPE } from "./auth";
import type { WatchResult } from "./watch";

export interface SignInDeps {
  auth: ProviderAuth;
  accounts: AccountStore;
  tokens: TokenStore;
  syncState: SyncStateStore;
  /** Starts the mailbox watch for an account whose tokens are already stored (see `gmailStartWatch`). */
  startWatch: (accountId: string) => Promise<WatchResult>;
  /** Called with the failure when the watch could not be started. Sign-in still succeeds. */
  onWatchError?: (error: unknown) => void;
}

export interface SignInResult {
  userId: string;
  accountId: string;
  email: string;
  /** `failed` means no push notifications yet: the initial sync starts the watch again. */
  watch: "started" | "failed";
}

/**
 * The server side of the OAuth callback (CONTRACT 3.1, steps 2 to 4, plus the watch):
 * exchange the code, check scopes and the refresh token, upsert the account, store the
 * tokens encrypted, then start the mailbox watch and record its cursor and expiry.
 *
 * Nothing is written unless every check passes. The watch is best-effort: if it fails,
 * the account and tokens are kept and sign-in still succeeds.
 *
 * @throws CodeExchangeFailedError, MissingScopesError, NoRefreshTokenError
 */
export async function completeSignIn(
  deps: SignInDeps,
  p: { code: string },
): Promise<SignInResult> {
  const { tokens, grantedScopes, identity } = await deps.auth.exchangeCode({
    code: p.code,
  });
  if (!grantedScopes.includes(GMAIL_MODIFY_SCOPE)) {
    throw new MissingScopesError("the mailbox scope was not granted");
  }
  if (!tokens.refreshToken) {
    throw new NoRefreshTokenError("Google issued no refresh token");
  }

  const { userId, accountId } = await deps.accounts.upsertGoogleAccount({
    googleSub: identity.subject,
    email: identity.email,
    scopes: grantedScopes,
  });
  await deps.tokens.saveTokens(accountId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });

  const email = identity.email.toLowerCase();
  try {
    const watch = await deps.startWatch(accountId);
    const existing = await deps.syncState.get(accountId);
    await deps.syncState.save(
      existing
        ? // A returning user: renewing the watch returns a current historyId, which must not
          // replace the stored cursor or every change since the last sync would be skipped.
          { ...existing, watchExpiration: watch.expiresAt }
        : {
            accountId,
            userId,
            historyId: watch.cursor,
            watchExpiration: watch.expiresAt,
            initialSyncCompletedAt: null,
            lastDeltaAt: null,
          },
    );
    return { userId, accountId, email, watch: "started" };
  } catch (error) {
    deps.onWatchError?.(error);
    return { userId, accountId, email, watch: "failed" };
  }
}
