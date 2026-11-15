import { google, type Auth } from "googleapis";
import {
  CodeExchangeFailedError,
  ReauthRequiredError,
  UpstreamError,
} from "../../types/errors";
import type { ProviderAuth, ProviderTokens } from "../../types/provider";
import type { StoredTokens, TokenStore } from "../../types/stores";
import { mapGoogleError } from "./errors";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** The scopes requested at sign-in (CONTRACT 1.3). `gmail.modify` covers list, send, mark-read, history and watch. */
export const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  GMAIL_MODIFY_SCOPE,
] as const;

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Reads the OAuth client settings from the environment. Nothing is hardcoded. */
export function gmailAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GmailAuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must be set",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** Every Gmail call goes through this client: it refreshes expired access tokens itself. */
export function createOAuth2Client(config: GmailAuthConfig): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
}

/** The slice of the OAuth2 client `GmailAuth` uses. The real client satisfies it; tests supply a fake. */
export interface GoogleOAuthClient {
  generateAuthUrl(options: Auth.GenerateAuthUrlOpts): string;
  getToken(code: string): Promise<{ tokens: Auth.Credentials }>;
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{
    getPayload(): { sub?: string; email?: string } | null | undefined;
  }>;
  refreshAccessToken(): Promise<{ credentials: Auth.Credentials }>;
  setCredentials(credentials: Auth.Credentials): void;
}

function splitScopes(scope: string | undefined): string[] {
  return scope ? scope.split(" ").filter((s) => s.length > 0) : [];
}

/** Sign-in and token operations over the `googleapis` OAuth2 client. */
export class GmailAuth implements ProviderAuth {
  /** A fresh client is made per call: `setCredentials` on a shared one would race between requests. */
  constructor(
    private readonly config: GmailAuthConfig,
    private readonly createClient: () => GoogleOAuthClient = () =>
      createOAuth2Client(config),
  ) {}

  async getAuthorizationUrl(p: { state: string }): Promise<string> {
    return this.createClient().generateAuthUrl({
      access_type: "offline", // so Google issues a refresh token
      prompt: "consent", // ... every time, not only on first consent
      scope: [...GMAIL_SCOPES],
      state: p.state,
    });
  }

  async exchangeCode(p: { code: string }): Promise<{
    tokens: ProviderTokens;
    grantedScopes: string[];
    identity: { subject: string; email: string };
  }> {
    if (!p.code) {
      throw new CodeExchangeFailedError("authorization code is missing");
    }
    const client = this.createClient();

    let credentials: Auth.Credentials;
    try {
      ({ tokens: credentials } = await client.getToken(p.code));
    } catch (error) {
      throw new CodeExchangeFailedError(
        "Google rejected the authorization code",
        error,
      );
    }
    if (!credentials.access_token || !credentials.id_token) {
      throw new CodeExchangeFailedError(
        "token response lacks an access token or an ID token",
      );
    }

    let payload: { sub?: string; email?: string } | null | undefined;
    try {
      const ticket = await client.verifyIdToken({
        idToken: credentials.id_token,
        audience: this.config.clientId,
      });
      payload = ticket.getPayload();
    } catch (error) {
      throw new CodeExchangeFailedError("ID token failed verification", error);
    }
    if (!payload?.sub || !payload.email) {
      throw new CodeExchangeFailedError("ID token lacks a subject or an email");
    }

    return {
      tokens: {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token ?? undefined,
        expiresAt: new Date(credentials.expiry_date ?? Date.now()),
      },
      grantedScopes: splitScopes(credentials.scope),
      identity: { subject: payload.sub, email: payload.email },
    };
  }

  async refreshAccessToken(p: { refreshToken: string }): Promise<ProviderTokens> {
    const client = this.createClient();
    client.setCredentials({ refresh_token: p.refreshToken });
    let credentials: Auth.Credentials;
    try {
      ({ credentials } = await client.refreshAccessToken());
    } catch (error) {
      throw mapGoogleError(error);
    }
    if (!credentials.access_token) {
      throw new UpstreamError("refresh response lacks an access token");
    }
    return {
      accessToken: credentials.access_token,
      // The library copies the old refresh token onto its result; only report a new one.
      refreshToken:
        credentials.refresh_token && credentials.refresh_token !== p.refreshToken
          ? credentials.refresh_token
          : undefined,
      expiresAt: new Date(credentials.expiry_date ?? Date.now()),
    };
  }
}

export interface TokenPersistence {
  /**
   * Resolves once every refresh seen so far has been written to the store. Rejects with the
   * first write failure, so a request whose token refresh was not persisted fails loudly.
   * Await it before a request finishes: the client's `tokens` event does not wait for the save.
   */
  flush(): Promise<void>;
}

/**
 * The token persistence listener. When the OAuth2 client refreshes an access token it emits
 * `tokens`; this writes the new token straight back through the `TokenStore`, which encrypts it.
 * Refresh events carry no `refresh_token`, so the store keeps the one it has.
 */
export function attachTokenPersistence(
  client: Auth.OAuth2Client,
  accountId: string,
  store: TokenStore,
): TokenPersistence {
  const inFlight = new Set<Promise<void>>();
  const failures: unknown[] = [];

  client.on("tokens", (tokens: Auth.Credentials) => {
    if (!tokens.access_token) return;
    const save = store
      .saveTokens(accountId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        // No expiry means treat it as already expired, so the next call refreshes again.
        expiresAt: new Date(tokens.expiry_date ?? Date.now()),
      })
      .catch((error: unknown) => {
        failures.push(error);
      })
      .finally(() => {
        inFlight.delete(save);
      });
    inFlight.add(save);
  });

  return {
    async flush(): Promise<void> {
      await Promise.all([...inFlight]);
      if (failures.length > 0) {
        const [first] = failures.splice(0, failures.length);
        throw first;
      }
    },
  };
}

/**
 * Builds the OAuth2 client for one account from its stored tokens, with the persistence
 * listener attached. `expiry_date` is set so the library refreshes proactively when the
 * access token is near expiry instead of waiting for a 401.
 *
 * @throws ReauthRequiredError when the account has no stored tokens.
 */
export async function createAuthorizedClient(
  deps: { config: GmailAuthConfig; tokens: TokenStore },
  accountId: string,
): Promise<{ client: Auth.OAuth2Client; persistence: TokenPersistence }> {
  const stored = await deps.tokens.getTokens(accountId);
  if (!stored) {
    throw new ReauthRequiredError("the account has no stored tokens");
  }
  const client = createOAuth2Client(deps.config);
  client.setCredentials({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
    expiry_date: stored.expiresAt.getTime(),
  });
  const persistence = attachTokenPersistence(client, accountId, deps.tokens);
  return { client, persistence };
}

/**
 * Explicit refresh: loads the stored (decrypted) refresh token, exchanges it for a new access
 * token, and stores the result (re-encrypted). For forced refresh; normal requests refresh
 * automatically through the client.
 *
 * @throws ReauthRequiredError when nothing is stored or Google reports `invalid_grant`.
 */
export async function refreshStoredTokens(
  deps: { auth: ProviderAuth; tokens: TokenStore },
  accountId: string,
): Promise<StoredTokens> {
  const stored = await deps.tokens.getTokens(accountId);
  if (!stored) {
    throw new ReauthRequiredError("the account has no stored tokens");
  }
  const refreshed = await deps.auth.refreshAccessToken({
    refreshToken: stored.refreshToken,
  });
  await deps.tokens.saveTokens(accountId, refreshed);
  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
}
