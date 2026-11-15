import {
  InMemoryAccountStore,
  InMemoryMessageStore,
  InMemorySyncStateStore,
} from "../../src/db/in-memory";
import {
  handleGmailWebhook,
  verificationTokenFromEnv,
  type WebhookDeps,
} from "../../src/webhook/gmail";
import {
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  UpstreamError,
} from "../../src/types/errors";
import type { SyncState } from "../../src/types/stores";
import { FakeMailbox, id, makeMessage } from "./fixtures/mailbox";

const TOKEN = "s3cret-verification-token";
const TOPIC = "projects/p/topics/t";
const NOW = new Date("2026-11-14T12:00:00.000Z");

function envelope(
  data: Record<string, unknown>,
  encoding: "base64" | "base64url" = "base64",
) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(data), "utf8").toString(encoding),
      messageId: "123456",
      publishTime: "2026-11-14T11:59:59Z",
    },
    subscription: "projects/p/subscriptions/s",
  };
}

const notification = (overrides: Record<string, unknown> = {}) =>
  envelope({ emailAddress: "user@example.com", historyId: "99999999", ...overrides });

async function setup() {
  const accounts = new InMemoryAccountStore();
  const syncState = new InMemorySyncStateStore();
  const messages = new InMemoryMessageStore();
  const mailbox = new FakeMailbox();
  const { userId, accountId } = await accounts.upsertGoogleAccount({
    googleSub: "sub-1",
    email: "User@Example.com",
    scopes: [],
  });
  const state: SyncState = {
    accountId,
    userId,
    historyId: "500",
    watchExpiration: new Date("2026-11-20T00:00:00.000Z"),
    initialSyncCompletedAt: new Date("2026-11-10T00:00:00.000Z"),
    lastDeltaAt: null,
  };
  await syncState.save(state);

  const providerFor = jest.fn(async (_accountId: string) => mailbox);
  const onError = jest.fn();
  const deps: WebhookDeps = {
    verificationToken: TOKEN,
    pubsubTopic: TOPIC,
    accounts,
    syncState,
    messages,
    providerFor,
    now: () => NOW,
    onError,
  };
  return { deps, accounts, syncState, messages, mailbox, providerFor, onError, userId, accountId, state };
}

/** Sends with an explicit token, including none: `undefined` must not fall back to the valid one. */
const callWithToken = (deps: WebhookDeps, body: unknown, token: string | undefined) =>
  handleGmailWebhook(deps, { token, body });

const call = (deps: WebhookDeps, body: unknown) => callWithToken(deps, body, TOKEN);

describe("webhook authentication", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong", "not-the-token"],
    ["wrong, same length", "x".repeat(TOKEN.length)],
    ["a prefix of the right one", TOKEN.slice(0, -1)],
    ["the right one plus more", `${TOKEN}extra`],
  ])("rejects a %s token with 401 and reads nothing else", async (_label, token) => {
    const { deps, accounts, providerFor } = await setup();
    const find = jest.spyOn(accounts, "findAccountByEmail");

    // Even a malformed body is 401, not 400: the token is checked first.
    const response = await callWithToken(deps, "garbage", token);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: "WEBHOOK_UNAUTHORIZED", message: expect.any(String) },
    });
    expect(find).not.toHaveBeenCalled();
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("refuses everything when the configured secret is empty", async () => {
    const { deps } = await setup();
    const empty = { ...deps, verificationToken: "" };
    expect((await callWithToken(empty, notification(), "")).status).toBe(401);
    expect((await callWithToken(empty, notification(), undefined)).status).toBe(401);
  });

  it("reads the secret from the environment and refuses an unset one", () => {
    expect(verificationTokenFromEnv({ GOOGLE_PUBSUB_VERIFICATION_TOKEN: "abc" })).toBe("abc");
    expect(() => verificationTokenFromEnv({})).toThrow("GOOGLE_PUBSUB_VERIFICATION_TOKEN");
    expect(() => verificationTokenFromEnv({ GOOGLE_PUBSUB_VERIFICATION_TOKEN: "" })).toThrow();
  });
});

describe("webhook payload validation", () => {
  const bad: [string, unknown][] = [
    ["a string body", "hello"],
    ["a null body", null],
    ["an array body", []],
    ["no message", { subscription: "s" }],
    ["a message without data", { message: { messageId: "1" } }],
    ["non-string data", { message: { data: 42 } }],
    ["data that is not JSON", { message: { data: Buffer.from("not json").toString("base64") } }],
    ["empty data", { message: { data: "" } }],
    ["data that is a JSON array", { message: { data: Buffer.from("[1]").toString("base64") } }],
    ["no emailAddress", envelope({ historyId: "1" })],
    ["an emailAddress without @", envelope({ emailAddress: "nobody", historyId: "1" })],
    ["a numeric emailAddress", envelope({ emailAddress: 7, historyId: "1" })],
    ["no historyId", envelope({ emailAddress: "a@b.com" })],
    ["a negative historyId", envelope({ emailAddress: "a@b.com", historyId: -5 })],
    ["a non-numeric historyId", envelope({ emailAddress: "a@b.com", historyId: "abc" })],
  ];

  it.each(bad)("rejects %s with 400", async (_label, body) => {
    const { deps, providerFor } = await setup();
    const response = await call(deps, body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "WEBHOOK_PAYLOAD_INVALID", message: expect.any(String) },
    });
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("accepts the historyId as a string or a number", async () => {
    const { deps, mailbox } = await setup();
    mailbox.pages = [{ changes: [], cursor: "510" }];
    expect((await call(deps, notification({ historyId: 12345 }))).status).toBe(200);
    expect((await call(deps, notification({ historyId: "12345" }))).status).toBe(200);
  });

  it("decodes both standard base64 and base64url", async () => {
    const { deps, mailbox } = await setup();
    mailbox.pages = [{ changes: [], cursor: "510" }];
    // Padding characters that differ between the two alphabets.
    const extra = { filler: "????>>>>~~~~????>>>>" };
    const standard = notification(extra);
    const url = envelope(
      { emailAddress: "user@example.com", historyId: "1", ...extra },
      "base64url",
    );
    expect(standard.message.data).toMatch(/[+/]/);
    expect(url.message.data).toMatch(/[-_]/);
    expect((await call(deps, standard)).body).toMatchObject({ status: "processed" });
    expect((await call(deps, url)).body).toMatchObject({ status: "processed" });
  });
});

describe("webhook outcomes that retrying cannot fix", () => {
  it("acknowledges and ignores an unknown mailbox", async () => {
    const { deps, providerFor } = await setup();
    const response = await call(deps, notification({ emailAddress: "stranger@example.com" }));
    expect(response).toEqual({ status: 200, body: { status: "ignored", reason: "UNKNOWN_ACCOUNT" } });
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("matches the mailbox case-insensitively", async () => {
    const { deps, mailbox } = await setup();
    mailbox.pages = [{ changes: [], cursor: "510" }];
    const response = await call(deps, notification({ emailAddress: "USER@EXAMPLE.COM" }));
    expect(response.body).toMatchObject({ status: "processed" });
  });

  it("ignores an account that has no sync state", async () => {
    const { deps, accounts, providerFor } = await setup();
    await accounts.upsertGoogleAccount({ googleSub: "sub-2", email: "new@example.com", scopes: [] });
    const response = await call(deps, notification({ emailAddress: "new@example.com" }));
    expect(response).toEqual({ status: 200, body: { status: "ignored", reason: "NOT_SYNCED" } });
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("ignores an account whose tokens are gone, without logging it as a failure", async () => {
    const { deps, providerFor, onError } = await setup();
    providerFor.mockRejectedValueOnce(new ReauthRequiredError("no tokens"));
    const response = await call(deps, notification());
    expect(response).toEqual({ status: 200, body: { status: "ignored", reason: "REAUTH_REQUIRED" } });
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores an account that revoked the mailbox scope", async () => {
    const { deps, mailbox } = await setup();
    jest.spyOn(mailbox, "listChanges").mockRejectedValue(new ScopeInsufficientError("scope"));
    const response = await call(deps, notification());
    expect(response).toEqual({ status: 200, body: { status: "ignored", reason: "SCOPE_INSUFFICIENT" } });
  });
});

describe("webhook delta processing", () => {
  it("replays from the stored cursor, ignoring the notification's historyId", async () => {
    const { deps, mailbox, messages, syncState, accountId, providerFor } = await setup();
    mailbox.pages = [
      {
        changes: [
          { type: "added", id: id(1) },
          { type: "labelsChanged", id: id(2) },
          { type: "deleted", id: id(9) },
        ],
        cursor: "520",
      },
    ];

    const response = await call(deps, notification({ historyId: "99999999" }));

    expect(response).toEqual({
      status: 200,
      body: { status: "processed", upserted: 2, deleted: 1 },
    });
    expect(providerFor).toHaveBeenCalledWith(accountId);
    // The delta starts at the stored 500, not at the notification's 99999999 ...
    expect(mailbox.changeCalls[0]?.since).toBe("500");
    // ... and the cursor ends at what history.list returned, not at the notification's value.
    expect((await syncState.get(accountId))?.historyId).toBe("520");
    expect(messages.all(accountId).map((m) => m.gmailId).sort()).toEqual([id(1), id(2)]);
  });

  it("is not thrown off by an old notification arriving late", async () => {
    const { deps, mailbox, syncState, accountId } = await setup();
    mailbox.pages = [{ changes: [], cursor: "520" }];
    await call(deps, notification({ historyId: "1" }));
    expect((await syncState.get(accountId))?.historyId).toBe("520");
    expect(mailbox.changeCalls[0]?.since).toBe("500");
  });

  it("reports a full resync as processed", async () => {
    const { deps, mailbox, syncState, accountId } = await setup();
    mailbox.expired = true;
    mailbox.inbox = [makeMessage(0), makeMessage(1)];
    const response = await call(deps, notification());
    expect(response).toEqual({ status: 200, body: { status: "processed", upserted: 2, deleted: 0 } });
    expect((await syncState.get(accountId))?.historyId).toBe("9001");
  });

  it("answers 200 only after the delta is stored", async () => {
    const { deps, mailbox, messages, accountId } = await setup();
    mailbox.pages = [{ changes: [{ type: "added", id: id(1) }], cursor: "520" }];
    let release: () => void = () => undefined;
    mailbox.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let settled = false;
    const pending = call(deps, notification()).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toBe(false);
    expect(messages.all(accountId)).toHaveLength(0);

    release();
    expect((await pending).status).toBe(200);
    expect(messages.all(accountId)).toHaveLength(1);
  });
});

describe("webhook failures Pub/Sub should retry", () => {
  async function failing(error: unknown) {
    const ctx = await setup();
    jest.spyOn(ctx.mailbox, "listChanges").mockRejectedValue(error);
    const response = await call(ctx.deps, notification());
    return { ...ctx, response };
  }

  it("answers 429 for rate limiting, logs it, and leaves the cursor", async () => {
    const error = new RateLimitedError("slow down");
    const { response, onError, syncState, accountId, state } = await failing(error);
    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: { code: "GMAIL_RATE_LIMITED", message: expect.any(String) },
    });
    expect(onError).toHaveBeenCalledWith(error);
    expect(await syncState.get(accountId)).toEqual(state);
  });

  it("answers 502 when Gmail fails", async () => {
    const { response } = await failing(new UpstreamError("503"));
    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: { code: "GMAIL_UPSTREAM_ERROR", message: expect.any(String) },
    });
  });

  it("answers 500 for anything else, without leaking the cause", async () => {
    const { response, onError } = await failing(new Error("connection to db-7.internal refused"));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "INTERNAL", message: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain("db-7.internal");
    expect(onError).toHaveBeenCalled();
  });

  it("answers 500 when the account lookup itself fails", async () => {
    const ctx = await setup();
    jest.spyOn(ctx.accounts, "findAccountByEmail").mockRejectedValue(new Error("db down"));
    const response = await call(ctx.deps, notification());
    expect(response.status).toBe(500);
  });

  it("does not advance the cursor when only part of the delta could be fetched", async () => {
    const ctx = await setup();
    ctx.mailbox.failFetch.add(id(2));
    ctx.mailbox.pages = [
      { changes: [{ type: "added", id: id(1) }, { type: "added", id: id(2) }], cursor: "520" },
    ];
    const response = await call(ctx.deps, notification());
    expect(response.status).toBe(500);
    expect(await ctx.syncState.get(ctx.accountId)).toEqual(ctx.state);
    expect(ctx.messages.all(ctx.accountId)).toHaveLength(0);
  });
});
