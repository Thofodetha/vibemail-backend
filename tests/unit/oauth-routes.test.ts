import { randomBytes } from "node:crypto";
import {
  InMemoryAccountStore,
  InMemorySyncStateStore,
  InMemoryTokenRowStore,
} from "../../src/db/in-memory";
import { EncryptedTokenStore } from "../../src/db/token-store";
import { verifyJwt } from "../../src/middleware/jwt";
import { handleOAuthCallback, startSignIn, type CallbackDeps } from "../../src/middleware/oauth";
import {
  clearedStateCookie,
  readStateCookie,
  STATE_COOKIE,
} from "../../src/middleware/state";
import { GMAIL_MODIFY_SCOPE } from "../../src/providers/gmail/auth";
import { completeSignIn } from "../../src/providers/gmail/signin";
import { CodeExchangeFailedError } from "../../src/types/errors";
import type { ProviderAuth } from "../../src/types/provider";

const FRONTEND = "https://app.example.com";
const SECRET = "test-secret-with-enough-length-0123456789";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const STATE = "the-state-nonce";

type Exchange = Awaited<ReturnType<ProviderAuth["exchangeCode"]>>;
const GOOD: Exchange = {
  tokens: { accessToken: "at", refreshToken: "rt", expiresAt: new Date(10_000) },
  grantedScopes: ["openid", "email", "profile", GMAIL_MODIFY_SCOPE],
  identity: { subject: "google-sub-1", email: "User@Example.com" },
};

function setup(exchange: () => Promise<Exchange> = async () => GOOD) {
  const accounts = new InMemoryAccountStore();
  const rows = new InMemoryTokenRowStore();
  const tokens = new EncryptedTokenStore(rows, randomBytes(32));
  const syncState = new InMemorySyncStateStore();
  const exchangeCode = jest.fn(exchange);
  const auth: ProviderAuth = {
    getAuthorizationUrl: async ({ state }) => `https://accounts.example/consent?state=${state}`,
    exchangeCode,
    refreshAccessToken: async () => {
      throw new Error("not used");
    },
  };
  const afterSignIn = jest.fn(async () => undefined);
  const onError = jest.fn();
  const deps: CallbackDeps = {
    signIn: (code) =>
      completeSignIn(
        {
          auth,
          accounts,
          tokens,
          syncState,
          startWatch: async () => ({ cursor: "1", expiresAt: new Date(20_000) }),
        },
        { code },
      ),
    afterSignIn,
    frontendUrl: FRONTEND,
    jwtSecret: SECRET,
    now: () => NOW,
    onError,
  };
  return { auth, deps, accounts, rows, exchangeCode, afterSignIn, onError };
}

const callback = (
  deps: CallbackDeps,
  query: Record<string, string>,
  cookie: string | null = `${STATE_COOKIE}=${STATE}`,
) => {
  const url = new URL("https://api.example.com/api/v1/auth/google/callback");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return handleOAuthCallback(deps, new Request(url, { headers: cookie ? { Cookie: cookie } : {} }));
};

const location = (response: Response) => response.headers.get("location") ?? "";

describe("startSignIn", () => {
  it("redirects to the consent URL with the nonce, and stores the same nonce in a cookie", async () => {
    const { auth } = setup();
    const response = await startSignIn({ auth });

    expect(response.status).toBe(302);
    const state = new URL(location(response)).searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(readStateCookie(cookie.split(";")[0] ?? "")).toBe(state);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
  });

  it("uses a new nonce every time", async () => {
    const { auth } = setup();
    const a = new URL(location(await startSignIn({ auth }))).searchParams.get("state");
    const b = new URL(location(await startSignIn({ auth }))).searchParams.get("state");
    expect(a).not.toBe(b);
  });
});

describe("handleOAuthCallback: success", () => {
  it("redirects to the frontend with a JWT in the URL fragment for the new user", async () => {
    const { deps, accounts } = setup();
    const response = await callback(deps, { code: "good", state: STATE });

    expect(response.status).toBe(302);
    const target = new URL(location(response));
    expect(target.origin + target.pathname).toBe(`${FRONTEND}/auth/callback`);
    expect(target.search).toBe(""); // the token is never in the query string
    const token = new URLSearchParams(target.hash.slice(1)).get("token") ?? "";
    const found = await accounts.findAccountByEmail("user@example.com");
    expect(verifyJwt(token, SECRET, NOW)).toEqual({ userId: found?.userId });
  });

  it("clears the state cookie", async () => {
    const { deps } = setup();
    const response = await callback(deps, { code: "good", state: STATE });
    expect(response.headers.get("set-cookie")).toBe(clearedStateCookie());
  });

  it("hands the sign-in result to afterSignIn, which schedules the initial sync", async () => {
    const { deps, afterSignIn } = setup();
    await callback(deps, { code: "good", state: STATE });
    expect(afterSignIn).toHaveBeenCalledTimes(1);
    expect(afterSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com", watch: "started" }),
    );
  });

  it("still redirects with a token when afterSignIn fails", async () => {
    const { deps, afterSignIn, onError } = setup();
    afterSignIn.mockRejectedValueOnce(new Error("sync scheduler down"));
    const response = await callback(deps, { code: "good", state: STATE });
    expect(location(response)).toContain("#token=");
    expect(onError).toHaveBeenCalled();
  });

  it("ignores a trailing slash on FRONTEND_URL", async () => {
    const { deps } = setup();
    const response = await callback({ ...deps, frontendUrl: `${FRONTEND}/` }, { code: "good", state: STATE });
    expect(location(response).startsWith(`${FRONTEND}/auth/callback#token=`)).toBe(true);
  });
});

describe("handleOAuthCallback: failures redirect to /login?error=<CODE>", () => {
  async function expectFailure(response: Response, code: string) {
    expect(response.status).toBe(302);
    expect(location(response)).toBe(`${FRONTEND}/login?error=${code}`);
    expect(location(response)).not.toContain("token");
    expect(response.headers.get("set-cookie")).toBe(clearedStateCookie());
  }

  it("reports a user who denied access", async () => {
    const { deps, exchangeCode } = setup();
    await expectFailure(await callback(deps, { error: "access_denied", state: STATE }), "OAUTH_ACCESS_DENIED");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("reports any other Google error as internal", async () => {
    const { deps } = setup();
    await expectFailure(await callback(deps, { error: "server_error", state: STATE }), "OAUTH_INTERNAL");
  });

  it("checks Google's error before the state", async () => {
    const { deps } = setup();
    await expectFailure(await callback(deps, { error: "access_denied" }, null), "OAUTH_ACCESS_DENIED");
  });

  it.each([
    ["a state that does not match the cookie", { code: "c", state: "other" }, `${STATE_COOKIE}=${STATE}`],
    ["no state parameter", { code: "c" }, `${STATE_COOKIE}=${STATE}`],
    ["no cookie", { code: "c", state: STATE }, null],
    ["an expired cookie", { code: "c", state: STATE }, "unrelated=1"],
  ])("reports %s, without exchanging the code or writing anything", async (_label, query, cookie) => {
    const { deps, exchangeCode, accounts, rows } = setup();
    await expectFailure(await callback(deps, query, cookie), "OAUTH_STATE_MISMATCH");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(accounts.accountCount).toBe(0);
    expect(rows.rows.size).toBe(0);
  });

  it("reports a missing code as a failed exchange", async () => {
    const { deps } = setup(async () => {
      throw new CodeExchangeFailedError("authorization code is missing");
    });
    await expectFailure(await callback(deps, { state: STATE }), "OAUTH_CODE_EXCHANGE_FAILED");
  });

  it("reports a code Google rejected", async () => {
    const { deps, accounts } = setup(async () => {
      throw new CodeExchangeFailedError("rejected");
    });
    await expectFailure(await callback(deps, { code: "used", state: STATE }), "OAUTH_CODE_EXCHANGE_FAILED");
    expect(accounts.accountCount).toBe(0);
  });

  it("reports a user who unticked the mailbox permission", async () => {
    const { deps, accounts } = setup(async () => ({
      ...GOOD,
      grantedScopes: ["openid", "email", "profile"],
    }));
    await expectFailure(await callback(deps, { code: "c", state: STATE }), "OAUTH_MISSING_SCOPES");
    expect(accounts.accountCount).toBe(0);
  });

  it("reports a response with no refresh token", async () => {
    const { deps, accounts } = setup(async () => ({
      ...GOOD,
      tokens: { accessToken: "at", expiresAt: new Date(1) },
    }));
    await expectFailure(await callback(deps, { code: "c", state: STATE }), "OAUTH_NO_REFRESH_TOKEN");
    expect(accounts.accountCount).toBe(0);
  });

  it("reports an unexpected failure as internal, logs it and does not leak it", async () => {
    const { deps, onError } = setup(async () => {
      throw new Error("connection to db-7.internal refused");
    });
    const response = await callback(deps, { code: "c", state: STATE });
    await expectFailure(response, "OAUTH_INTERNAL");
    expect(location(response)).not.toContain("db-7");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a failure to sign the token as internal rather than throwing", async () => {
    const { deps, onError } = setup();
    const response = await callback({ ...deps, jwtSecret: "" }, { code: "c", state: STATE });
    await expectFailure(response, "OAUTH_INTERNAL");
    expect(onError).toHaveBeenCalled();
  });

  it("never runs afterSignIn on a failure", async () => {
    const { deps, afterSignIn } = setup(async () => {
      throw new CodeExchangeFailedError("rejected");
    });
    await callback(deps, { code: "c", state: STATE });
    expect(afterSignIn).not.toHaveBeenCalled();
  });
});
