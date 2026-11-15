import { randomBytes } from "node:crypto";
import type { Auth } from "googleapis";
import { InMemoryTokenRowStore } from "../../src/db/in-memory";
import { EncryptedTokenStore } from "../../src/db/token-store";
import {
  attachTokenPersistence,
  createAuthorizedClient,
  createOAuth2Client,
  GMAIL_MODIFY_SCOPE,
  gmailAuthConfigFromEnv,
  GmailAuth,
  refreshStoredTokens,
  type GmailAuthConfig,
  type GoogleOAuthClient,
} from "../../src/providers/gmail/auth";
import {
  CodeExchangeFailedError,
  ReauthRequiredError,
  UpstreamError,
} from "../../src/types/errors";
import type { ProviderAuth, ProviderTokens } from "../../src/types/provider";
import type { TokenStore } from "../../src/types/stores";

const config: GmailAuthConfig = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/api/v1/auth/google/callback",
};

const GRANTED = `openid email profile ${GMAIL_MODIFY_SCOPE}`;

function fakeClient(parts: Partial<GoogleOAuthClient>): () => GoogleOAuthClient {
  const client: GoogleOAuthClient = {
    generateAuthUrl: () => {
      throw new Error("generateAuthUrl not stubbed");
    },
    getToken: async () => {
      throw new Error("getToken not stubbed");
    },
    verifyIdToken: async () => {
      throw new Error("verifyIdToken not stubbed");
    },
    refreshAccessToken: async () => {
      throw new Error("refreshAccessToken not stubbed");
    },
    setCredentials: () => undefined,
    ...parts,
  };
  return () => client;
}

const okPayload = { getPayload: () => ({ sub: "sub-1", email: "User@Example.com" }) };

describe("GmailAuth.getAuthorizationUrl", () => {
  it("asks for offline access with forced consent, the mailbox scope and the state", async () => {
    const url = new URL(await new GmailAuth(config).getAuthorizationUrl({ state: "nonce-123" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("nonce-123");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      GMAIL_MODIFY_SCOPE,
    ]);
  });
});

describe("GmailAuth.exchangeCode", () => {
  const credentials: Auth.Credentials = {
    access_token: "at",
    refresh_token: "rt",
    id_token: "idt",
    expiry_date: 1_000_000,
    scope: GRANTED,
  };

  it("returns tokens, granted scopes and the verified identity", async () => {
    const verifyIdToken = jest.fn(async () => okPayload);
    const auth = new GmailAuth(
      config,
      fakeClient({ getToken: async () => ({ tokens: credentials }), verifyIdToken }),
    );
    expect(await auth.exchangeCode({ code: "code" })).toEqual({
      tokens: { accessToken: "at", refreshToken: "rt", expiresAt: new Date(1_000_000) },
      grantedScopes: ["openid", "email", "profile", GMAIL_MODIFY_SCOPE],
      identity: { subject: "sub-1", email: "User@Example.com" },
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "idt",
      audience: config.clientId,
    });
  });

  it("reports an undefined refresh token when Google issued none", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        getToken: async () => ({ tokens: { ...credentials, refresh_token: null } }),
        verifyIdToken: async () => okPayload,
      }),
    );
    expect((await auth.exchangeCode({ code: "code" })).tokens.refreshToken).toBeUndefined();
  });

  it("fails without calling Google when the code is empty", async () => {
    const getToken = jest.fn();
    const auth = new GmailAuth(config, fakeClient({ getToken }));
    await expect(auth.exchangeCode({ code: "" })).rejects.toThrow(CodeExchangeFailedError);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("fails when the token endpoint rejects the code", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        getToken: async () => {
          throw { message: "invalid_grant" };
        },
      }),
    );
    await expect(auth.exchangeCode({ code: "used" })).rejects.toThrow(CodeExchangeFailedError);
  });

  it("fails when the response has no ID token", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({ getToken: async () => ({ tokens: { ...credentials, id_token: null } }) }),
    );
    await expect(auth.exchangeCode({ code: "c" })).rejects.toThrow(CodeExchangeFailedError);
  });

  it("fails when the ID token does not verify", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        getToken: async () => ({ tokens: credentials }),
        verifyIdToken: async () => {
          throw new Error("bad signature");
        },
      }),
    );
    await expect(auth.exchangeCode({ code: "c" })).rejects.toThrow(CodeExchangeFailedError);
  });

  it("fails when the ID token carries no email", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        getToken: async () => ({ tokens: credentials }),
        verifyIdToken: async () => ({ getPayload: () => ({ sub: "sub-1" }) }),
      }),
    );
    await expect(auth.exchangeCode({ code: "c" })).rejects.toThrow(CodeExchangeFailedError);
  });
});

describe("GmailAuth.refreshAccessToken", () => {
  it("exchanges the refresh token for a new access token", async () => {
    const setCredentials = jest.fn();
    const auth = new GmailAuth(
      config,
      fakeClient({
        setCredentials,
        refreshAccessToken: async () => ({
          credentials: { access_token: "new-at", refresh_token: "rt", expiry_date: 5000 },
        }),
      }),
    );
    // The library echoes the old refresh token back; it must not be reported as a new one.
    expect(await auth.refreshAccessToken({ refreshToken: "rt" })).toEqual({
      accessToken: "new-at",
      refreshToken: undefined,
      expiresAt: new Date(5000),
    });
    expect(setCredentials).toHaveBeenCalledWith({ refresh_token: "rt" });
  });

  it("reports a rotated refresh token", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        refreshAccessToken: async () => ({
          credentials: { access_token: "a", refresh_token: "rt-2", expiry_date: 1 },
        }),
      }),
    );
    expect((await auth.refreshAccessToken({ refreshToken: "rt" })).refreshToken).toBe("rt-2");
  });

  it("maps invalid_grant to ReauthRequiredError", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        refreshAccessToken: async () => {
          throw { message: "invalid_grant", response: { data: { error: "invalid_grant" } } };
        },
      }),
    );
    await expect(auth.refreshAccessToken({ refreshToken: "revoked" })).rejects.toThrow(
      ReauthRequiredError,
    );
  });

  it("maps any other failure to UpstreamError", async () => {
    const auth = new GmailAuth(
      config,
      fakeClient({
        refreshAccessToken: async () => {
          throw new Error("socket hang up");
        },
      }),
    );
    await expect(auth.refreshAccessToken({ refreshToken: "rt" })).rejects.toThrow(UpstreamError);
  });
});

describe("gmailAuthConfigFromEnv", () => {
  it("reads the three OAuth settings", () => {
    expect(
      gmailAuthConfigFromEnv({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "http://localhost/cb",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret", redirectUri: "http://localhost/cb" });
  });

  it("fails when any is missing", () => {
    expect(() => gmailAuthConfigFromEnv({ GOOGLE_CLIENT_ID: "id" })).toThrow("must be set");
  });
});

function tokenStore() {
  const rows = new InMemoryTokenRowStore();
  const store = new EncryptedTokenStore(rows, randomBytes(32));
  return { rows, store };
}

describe("token persistence listener", () => {
  it("writes a refreshed access token back, keeping the stored refresh token", async () => {
    const { store } = tokenStore();
    await store.saveTokens("acct", {
      accessToken: "old-at",
      refreshToken: "rt",
      expiresAt: new Date(1000),
    });
    const client = createOAuth2Client(config);
    const persistence = attachTokenPersistence(client, "acct", store);

    // A refresh event has no refresh_token.
    client.emit("tokens", { access_token: "new-at", expiry_date: 9000 });
    await persistence.flush();

    expect(await store.getTokens("acct")).toEqual({
      accessToken: "new-at",
      refreshToken: "rt",
      expiresAt: new Date(9000),
    });
  });

  it("ignores an event that carries no access token", async () => {
    const { store } = tokenStore();
    const save = jest.spyOn(store, "saveTokens");
    const client = createOAuth2Client(config);
    const persistence = attachTokenPersistence(client, "acct", store);
    client.emit("tokens", { refresh_token: "only-a-refresh-token" });
    await persistence.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("surfaces a failed write when flushed, so the request cannot succeed silently", async () => {
    const failing: TokenStore = {
      getTokens: async () => null,
      saveTokens: async () => {
        throw new Error("database unavailable");
      },
    };
    const client = createOAuth2Client(config);
    const persistence = attachTokenPersistence(client, "acct", failing);
    client.emit("tokens", { access_token: "at", expiry_date: 1 });
    await expect(persistence.flush()).rejects.toThrow("database unavailable");
    await expect(persistence.flush()).resolves.toBeUndefined();
  });
});

describe("createAuthorizedClient", () => {
  it("refuses an account with no stored tokens", async () => {
    const { store } = tokenStore();
    await expect(createAuthorizedClient({ config, tokens: store }, "none")).rejects.toThrow(
      ReauthRequiredError,
    );
  });

  it("refreshes an expired token through the real client and persists it (AC-3)", async () => {
    const { rows, store } = tokenStore();
    await store.saveTokens("acct", {
      accessToken: "expired-at",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const { client, persistence } = await createAuthorizedClient(
      { config, tokens: store },
      "acct",
    );

    // Stub only the HTTP layer; the library's own refresh and `tokens` event logic runs.
    const request = jest.fn(async () => ({
      status: 200,
      data: { access_token: "fresh-at", expires_in: 3600, token_type: "Bearer" },
    }));
    (client.transporter as unknown as { request: typeof request }).request = request;

    expect((await client.getAccessToken()).token).toBe("fresh-at");
    await persistence.flush();

    expect(request).toHaveBeenCalledTimes(1);
    const stored = await store.getTokens("acct");
    // Stored tokens equal the client's final credentials, with no mismatch.
    expect(stored).toEqual({
      accessToken: client.credentials.access_token,
      refreshToken: client.credentials.refresh_token,
      expiresAt: new Date(client.credentials.expiry_date ?? 0),
    });
    expect(stored?.accessToken).toBe("fresh-at");
    expect(stored?.refreshToken).toBe("rt");
    // ... and the database holds ciphertext only.
    const raw = rows.rows.get("acct");
    expect(JSON.stringify(raw)).not.toContain("fresh-at");
    expect(raw?.accessTokenEnc).not.toBe("fresh-at");
  });
});

describe("refreshStoredTokens", () => {
  function authReturning(result: () => Promise<ProviderTokens>) {
    const refreshAccessToken = jest.fn(async (_p: { refreshToken: string }) => result());
    const auth: ProviderAuth = {
      getAuthorizationUrl: async () => "",
      exchangeCode: async () => {
        throw new Error("not used");
      },
      refreshAccessToken,
    };
    return { auth, refreshAccessToken };
  }

  it("uses the stored refresh token and stores the new access token", async () => {
    const { store } = tokenStore();
    await store.saveTokens("acct", {
      accessToken: "old",
      refreshToken: "stored-rt",
      expiresAt: new Date(1),
    });
    const { auth, refreshAccessToken } = authReturning(async () => ({
      accessToken: "new",
      expiresAt: new Date(9000),
    }));

    const result = await refreshStoredTokens({ auth, tokens: store }, "acct");

    expect(refreshAccessToken).toHaveBeenCalledWith({ refreshToken: "stored-rt" });
    expect(result).toEqual({
      accessToken: "new",
      refreshToken: "stored-rt",
      expiresAt: new Date(9000),
    });
    expect(await store.getTokens("acct")).toEqual(result);
  });

  it("requires re-authentication when nothing is stored", async () => {
    const { store } = tokenStore();
    const { auth, refreshAccessToken } = authReturning(async () => {
      throw new Error("not reached");
    });
    await expect(refreshStoredTokens({ auth, tokens: store }, "none")).rejects.toThrow(
      ReauthRequiredError,
    );
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("leaves the stored tokens untouched when the refresh token was revoked", async () => {
    const { store } = tokenStore();
    await store.saveTokens("acct", {
      accessToken: "old",
      refreshToken: "revoked-rt",
      expiresAt: new Date(1),
    });
    const { auth } = authReturning(async () => {
      throw new ReauthRequiredError("revoked");
    });

    await expect(refreshStoredTokens({ auth, tokens: store }, "acct")).rejects.toThrow(
      ReauthRequiredError,
    );
    expect((await store.getTokens("acct"))?.accessToken).toBe("old");
  });
});
