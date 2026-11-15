import { randomBytes } from "node:crypto";
import {
  InMemoryAccountStore,
  InMemorySyncStateStore,
  InMemoryTokenRowStore,
} from "../../src/db/in-memory";
import { EncryptedTokenStore } from "../../src/db/token-store";
import { GMAIL_MODIFY_SCOPE } from "../../src/providers/gmail/auth";
import { completeSignIn, type SignInDeps } from "../../src/providers/gmail/signin";
import type { WatchResult } from "../../src/providers/gmail/watch";
import {
  CodeExchangeFailedError,
  MissingScopesError,
  NoRefreshTokenError,
} from "../../src/types/errors";
import type { ProviderAuth, ProviderTokens } from "../../src/types/provider";

type Exchange = Awaited<ReturnType<ProviderAuth["exchangeCode"]>>;

const GOOD: Exchange = {
  tokens: {
    accessToken: "plain-access-token",
    refreshToken: "plain-refresh-token",
    expiresAt: new Date(10_000),
  },
  grantedScopes: ["openid", "email", "profile", GMAIL_MODIFY_SCOPE],
  identity: { subject: "google-sub-1", email: "User@Example.com" },
};

const WATCH: WatchResult = { cursor: "777", expiresAt: new Date(20_000) };

function setup(opts: {
  exchange?: () => Promise<Exchange>;
  startWatch?: SignInDeps["startWatch"];
} = {}) {
  const accounts = new InMemoryAccountStore();
  const rows = new InMemoryTokenRowStore();
  const tokens = new EncryptedTokenStore(rows, randomBytes(32));
  const syncState = new InMemorySyncStateStore();
  const startWatch = jest.fn(opts.startWatch ?? (async () => WATCH));
  const onWatchError = jest.fn();
  const auth: ProviderAuth = {
    getAuthorizationUrl: async () => "",
    exchangeCode: opts.exchange ?? (async () => GOOD),
    refreshAccessToken: async (): Promise<ProviderTokens> => {
      throw new Error("not used");
    },
  };
  const deps: SignInDeps = { auth, accounts, tokens, syncState, startWatch, onWatchError };
  return { deps, accounts, rows, tokens, syncState, startWatch, onWatchError };
}

describe("completeSignIn", () => {
  it("stores the account, the encrypted tokens and the watch state", async () => {
    const { deps, accounts, rows, tokens, syncState, startWatch } = setup();

    const result = await completeSignIn(deps, { code: "code" });

    expect(result.watch).toBe("started");
    expect(result.email).toBe("user@example.com");
    expect(await accounts.findAccountByEmail("USER@example.com")).toEqual({
      userId: result.userId,
      accountId: result.accountId,
    });
    expect(await tokens.getTokens(result.accountId)).toEqual(GOOD.tokens);
    const stored = JSON.stringify(rows.rows.get(result.accountId));
    expect(stored).not.toContain("plain-access-token");
    expect(stored).not.toContain("plain-refresh-token");
    expect(startWatch).toHaveBeenCalledWith(result.accountId);
    expect(await syncState.get(result.accountId)).toEqual({
      accountId: result.accountId,
      userId: result.userId,
      historyId: "777",
      watchExpiration: new Date(20_000),
      initialSyncCompletedAt: null,
      lastDeltaAt: null,
    });
  });

  it("starts the watch only after the tokens are stored", async () => {
    const { deps, tokens } = setup({
      startWatch: async (accountId) => {
        // The watch needs the tokens, so they must already be readable here.
        expect(await tokens.getTokens(accountId)).not.toBeNull();
        return WATCH;
      },
    });
    await completeSignIn(deps, { code: "code" });
  });

  it("writes nothing when the code exchange fails", async () => {
    const { deps, accounts, rows, startWatch } = setup({
      exchange: async () => {
        throw new CodeExchangeFailedError("rejected");
      },
    });
    await expect(completeSignIn(deps, { code: "bad" })).rejects.toThrow(CodeExchangeFailedError);
    expect(accounts.accountCount).toBe(0);
    expect(rows.rows.size).toBe(0);
    expect(startWatch).not.toHaveBeenCalled();
  });

  it("writes nothing when the mailbox scope was not granted", async () => {
    const { deps, accounts, rows } = setup({
      exchange: async () => ({ ...GOOD, grantedScopes: ["openid", "email", "profile"] }),
    });
    await expect(completeSignIn(deps, { code: "c" })).rejects.toThrow(MissingScopesError);
    expect(accounts.accountCount).toBe(0);
    expect(rows.rows.size).toBe(0);
  });

  it("writes nothing when Google issued no refresh token", async () => {
    const { deps, accounts, rows } = setup({
      exchange: async () => ({
        ...GOOD,
        tokens: { accessToken: "at", expiresAt: new Date(1) },
      }),
    });
    await expect(completeSignIn(deps, { code: "c" })).rejects.toThrow(NoRefreshTokenError);
    expect(accounts.accountCount).toBe(0);
    expect(rows.rows.size).toBe(0);
  });

  it("checks the scope before the refresh token", async () => {
    const { deps } = setup({
      exchange: async () => ({
        ...GOOD,
        grantedScopes: ["openid"],
        tokens: { accessToken: "at", expiresAt: new Date(1) },
      }),
    });
    await expect(completeSignIn(deps, { code: "c" })).rejects.toThrow(MissingScopesError);
  });

  it("still succeeds, keeping the account and tokens, when the watch fails", async () => {
    const boom = new Error("topic not found");
    const { deps, tokens, syncState, onWatchError } = setup({
      startWatch: async () => {
        throw boom;
      },
    });

    const result = await completeSignIn(deps, { code: "code" });

    expect(result.watch).toBe("failed");
    expect(onWatchError).toHaveBeenCalledWith(boom);
    expect(await tokens.getTokens(result.accountId)).toEqual(GOOD.tokens);
    expect(await syncState.get(result.accountId)).toBeNull();
  });

  it("is idempotent for the same Google account: same ids, no duplicate rows", async () => {
    const { deps, accounts } = setup();
    const first = await completeSignIn(deps, { code: "a" });
    const second = await completeSignIn(deps, { code: "b" });
    expect(second.userId).toBe(first.userId);
    expect(second.accountId).toBe(first.accountId);
    expect(accounts.accountCount).toBe(1);
  });

  it("keeps the stored cursor and sync progress when a returning user renews the watch", async () => {
    const { deps, syncState } = setup();
    const first = await completeSignIn(deps, { code: "a" });
    const existing = await syncState.get(first.accountId);
    if (!existing) throw new Error("sync state missing");
    await syncState.save({
      ...existing,
      historyId: "500",
      initialSyncCompletedAt: new Date(15_000),
      lastDeltaAt: new Date(16_000),
    });

    // Renewing the watch reports a much newer history position.
    const renewed: WatchResult = { cursor: "99999", expiresAt: new Date(30_000) };
    await completeSignIn({ ...deps, startWatch: async () => renewed }, { code: "b" });

    expect(await syncState.get(first.accountId)).toEqual({
      accountId: first.accountId,
      userId: first.userId,
      historyId: "500",
      watchExpiration: new Date(30_000),
      initialSyncCompletedAt: new Date(15_000),
      lastDeltaAt: new Date(16_000),
    });
  });
});
