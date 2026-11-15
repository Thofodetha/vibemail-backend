import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import callbackRoute from "../../api/v1/auth/google/callback";
import startRoute from "../../api/v1/auth/google/index";
import listRoute from "../../api/v1/messages/index";
import readRoute from "../../api/v1/messages/[id]/read";
import sendRoute from "../../api/v1/messages/send";
import webhookRoute from "../../api/webhook/gmail";
import { buildContainer, getContainer, resetContainer } from "../../src/app/container";
import type { VercelHandler } from "../../src/app/route";
import type { InMemoryMessageStore } from "../../src/db/in-memory";
import { signJwt, verifyJwt } from "../../src/middleware/jwt";

// These drive the real Vercel Function handlers in `api/` in-process, wired to the fake provider
// and in-memory stores (VIBEMAIL_FAKES=1): the same wiring the local preview uses.

const FRONTEND = "https://app.example.com";
const SECRET = "test-secret-with-enough-length-0123456789";
const WEBHOOK_TOKEN = "webhook-shared-secret";
const BASE = "https://api.example.com";

const SAVED_ENV = { ...process.env };

function useEnv(overrides: Record<string, string | undefined> = {}) {
  process.env = {
    ...SAVED_ENV,
    VIBEMAIL_FAKES: "1",
    JWT_SECRET: SECRET,
    FRONTEND_URL: FRONTEND,
    GOOGLE_REDIRECT_URI: `${BASE}/api/v1/auth/google/callback`,
    GOOGLE_PUBSUB_VERIFICATION_TOKEN: WEBHOOK_TOKEN,
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  resetContainer();
}

beforeEach(() => {
  useEnv();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...SAVED_ENV };
  resetContainer();
});

const call = (handler: VercelHandler, path: string, init: RequestInit = {}) =>
  handler.fetch(new Request(`${BASE}${path}`, init));

const authed = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
});

const postJson = (token: string, body: unknown): RequestInit =>
  authed(token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

interface Envelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Runs the full browser flow against the fake provider and returns the session JWT. */
async function signIn(): Promise<string> {
  const start = await call(startRoute, "/api/v1/auth/google");
  const consent = new URL(start.headers.get("location") ?? "");
  const state = consent.searchParams.get("state") ?? "";
  const cookie = /vibemail_oauth_state=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1];
  const back = await call(
    callbackRoute,
    `${consent.pathname}${consent.search}`,
    { headers: { Cookie: `vibemail_oauth_state=${cookie}` } },
  );
  expect(state).not.toBe("");
  const target = new URL(back.headers.get("location") ?? "");
  const token = new URLSearchParams(target.hash.slice(1)).get("token");
  if (!token) throw new Error(`sign-in failed: ${back.headers.get("location")}`);
  await getContainer().idle(); // let the scheduled initial sync finish
  return token;
}

describe("sign-in flow", () => {
  it("start redirects to consent with a state nonce and sets the cookie", async () => {
    const response = await call(startRoute, "/api/v1/auth/google");
    expect(response.status).toBe(302);
    const consent = new URL(response.headers.get("location") ?? "");
    expect(consent.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(response.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it("completes end to end: callback redirects to the frontend with a JWT for the new user", async () => {
    const token = await signIn();
    const { userId } = verifyJwt(token, SECRET);
    const account = await getContainer().accounts.getAccountForUser(userId);
    expect(account?.email).toBe("demo@vibemail.test");
  });

  it("stores the encrypted-token account and schedules the initial sync of the 50 newest messages", async () => {
    await signIn();
    const container = getContainer();
    const account = await container.accounts.findAccountByEmail("demo@vibemail.test");
    expect(account).not.toBeNull();
    const state = await container.syncState.get(account?.accountId ?? "");
    expect(state?.initialSyncCompletedAt).toBeInstanceOf(Date);
    const stored = (container.messages as InMemoryMessageStore).all(account?.accountId ?? "");
    expect(stored).toHaveLength(50);
    expect(stored[0]?.gmailId).toBe("fake0000");
  });

  it("schedules the initial sync once, and skips it for an account that has completed one", async () => {
    const container = getContainer();
    await signIn(); // first sign-in: the sync is scheduled and completes
    const account = await container.accounts.findAccountByEmail("demo@vibemail.test");
    const result = {
      userId: account?.userId ?? "",
      accountId: account?.accountId ?? "",
      email: "demo@vibemail.test",
      watch: "started" as const,
    };

    expect(await container.afterSignIn(result)).toBe("skipped");

    // A new account has no completed sync, so one is scheduled.
    const fresh = await container.accounts.upsertGoogleAccount({
      googleSub: "another-sub",
      email: "other@example.com",
      scopes: [],
    });
    expect(await container.afterSignIn({ ...result, ...fresh, email: "other@example.com" })).toBe("scheduled");
    await container.idle();
  });

  it("does not store the 50 messages twice on a second sign-in", async () => {
    await signIn();
    await signIn();
    const container = getContainer();
    const account = await container.accounts.findAccountByEmail("demo@vibemail.test");
    expect((container.messages as InMemoryMessageStore).all(account?.accountId ?? "")).toHaveLength(50);
  });

  it("redirects to /login with a code when the state does not match, and never to the frontend callback", async () => {
    const response = await call(callbackRoute, "/api/v1/auth/google/callback?code=x&state=forged", {
      headers: { Cookie: "vibemail_oauth_state=something-else" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${FRONTEND}/login?error=OAUTH_STATE_MISMATCH`);
  });

  it("redirects with OAUTH_CODE_EXCHANGE_FAILED for a code the provider did not issue", async () => {
    const response = await call(callbackRoute, "/api/v1/auth/google/callback?code=forged&state=s", {
      headers: { Cookie: "vibemail_oauth_state=s" },
    });
    expect(response.headers.get("location")).toBe(`${FRONTEND}/login?error=OAUTH_CODE_EXCHANGE_FAILED`);
  });

  it("rejects other methods on both sign-in routes with the envelope", async () => {
    for (const route of [startRoute, callbackRoute]) {
      const response = await call(route, "/api/v1/auth/google", { method: "POST" });
      expect(response.status).toBe(405);
      expect(((await response.json()) as Envelope).error.code).toBe("METHOD_NOT_ALLOWED");
    }
  });
});

describe("authentication on the three protected routes", () => {
  const routes: [string, VercelHandler, string, RequestInit][] = [
    ["GET /api/v1/messages", listRoute, "/api/v1/messages", { method: "GET" }],
    [
      "POST /api/v1/messages/send",
      sendRoute,
      "/api/v1/messages/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: [{ email: "a@example.com" }], subject: "s", bodyText: "b" }),
      },
    ],
    ["POST /api/v1/messages/{id}/read", readRoute, "/api/v1/messages/fake0000/read", { method: "POST" }],
  ];

  it.each(routes)("%s rejects a request with no token: 401 UNAUTHENTICATED", async (_n, route, path, init) => {
    const response = await call(route, path, init);
    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
    expect(response.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it.each(routes)("%s rejects a malformed token, a wrong-secret token and an expired token", async (_n, route, path, init) => {
    await signIn();
    const userId = (await getContainer().accounts.findAccountByEmail("demo@vibemail.test"))?.userId ?? "";
    const tokens = [
      "garbage",
      signJwt(userId, "a-completely-different-secret"),
      signJwt(userId, SECRET, new Date(Date.now() - 2 * 3600 * 1000)),
    ];
    for (const token of tokens) {
      const response = await call(route, path, authed(token, init));
      expect(response.status).toBe(401);
      expect(((await response.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
    }
  });

  it.each(routes)("%s asks a user with no Gmail account to sign in again", async (_n, route, path, init) => {
    const response = await call(route, path, authed(signJwt("user-with-no-account", SECRET), init));
    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope).error.code).toBe("GMAIL_REAUTH_REQUIRED");
  });
});

describe("GET /api/v1/messages", () => {
  it("returns the first 25 inbox messages, newest first, with a next page token and CORS", async () => {
    const token = await signIn();
    const response = await call(listRoute, "/api/v1/messages", authed(token));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    const body = (await response.json()) as {
      messages: { gmailId: string; internalDate: string }[];
      nextPageToken: string | null;
      resultSizeEstimate: number;
    };
    expect(body.messages).toHaveLength(25);
    expect(body.messages[0]?.gmailId).toBe("fake0000");
    expect(body.nextPageToken).toBe("25");
    expect(body.resultSizeEstimate).toBe(60);
    const dates = body.messages.map((m) => Date.parse(m.internalDate));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("pages with the token until the last page, which has none", async () => {
    const token = await signIn();
    const seen: string[] = [];
    let pageToken: string | null = null;
    do {
      const path: string = `/api/v1/messages?maxResults=25${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const body = (await (await call(listRoute, path, authed(token))).json()) as {
        messages: { gmailId: string }[];
        nextPageToken: string | null;
      };
      seen.push(...body.messages.map((m) => m.gmailId));
      pageToken = body.nextPageToken;
    } while (pageToken);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it("ANDs the labels and applies q", async () => {
    const token = await signIn();
    const unread = (await (
      await call(listRoute, "/api/v1/messages?labelIds=INBOX,UNREAD&maxResults=100", authed(token))
    ).json()) as { messages: { isRead: boolean; labelIds: string[] }[] };
    expect(unread.messages.length).toBeGreaterThan(0);
    expect(unread.messages.every((m) => !m.isRead && m.labelIds.includes("UNREAD"))).toBe(true);

    const found = (await (
      await call(listRoute, "/api/v1/messages?q=Demo%20message%207", authed(token))
    ).json()) as { messages: { subject: string }[] };
    expect(found.messages.map((m) => m.subject)).toEqual(["Demo message 7"]);
  });

  it.each([
    ["maxResults=0", "maxResults"],
    ["maxResults=101", "maxResults"],
    ["labelIds=", "labelIds"],
    ["q=" + "a".repeat(501), "q"],
  ])("answers 400 VALIDATION_FAILED for %s, naming the field", async (query, field) => {
    const token = await signIn();
    const response = await call(listRoute, `/api/v1/messages?${query}`, authed(token));
    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toHaveProperty(["fields", field]);
  });

  it("answers 400 INVALID_PAGE_TOKEN for a token the provider rejects", async () => {
    const token = await signIn();
    const response = await call(listRoute, "/api/v1/messages?pageToken=not-a-token", authed(token));
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope).error.code).toBe("INVALID_PAGE_TOKEN");
  });

  it("answers 500 INTERNAL without leaking the cause, and logs it", async () => {
    const token = await signIn();
    jest
      .spyOn(getContainer().messages, "upsertMessages")
      .mockRejectedValue(new Error("connection to db-7.internal refused"));
    const response = await call(listRoute, "/api/v1/messages", authed(token));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "INTERNAL", message: "Something went wrong on the server." },
    });
    expect(text).not.toContain("db-7");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("request failed"));
  });
});

describe("POST /api/v1/messages/send", () => {
  const message = { to: [{ name: "Ann", email: "ann@example.com" }], subject: "Hello", bodyText: "Hi Ann" };

  it("sends, stores the sent copy and answers 201 with the stored message", async () => {
    const token = await signIn();
    const response = await call(sendRoute, "/api/v1/messages/send", postJson(token, message));
    expect(response.status).toBe(201);
    const { message: sent } = (await response.json()) as {
      message: { gmailId: string; subject: string; to: unknown[]; labelIds: string[]; from: { email: string }; isRead: boolean; bodyText: string };
    };
    expect(sent).toMatchObject({
      subject: "Hello",
      labelIds: ["SENT"],
      isRead: true,
      bodyText: "Hi Ann",
      from: { email: "demo@vibemail.test" },
      to: [{ name: "Ann", email: "ann@example.com" }],
    });

    const listed = (await (
      await call(listRoute, "/api/v1/messages?labelIds=SENT", authed(token))
    ).json()) as { messages: { gmailId: string }[] };
    expect(listed.messages.map((m) => m.gmailId)).toContain(sent.gmailId);
  });

  it("sends a reply into an existing thread and keeps the reply headers", async () => {
    const token = await signIn();
    const response = await call(
      sendRoute,
      "/api/v1/messages/send",
      postJson(token, {
        ...message,
        bodyHtml: "<p>Hi Ann</p>",
        threadId: "fakethread0000",
        inReplyTo: "<fake-0@vibemail.test>",
      }),
    );
    expect(response.status).toBe(201);
    const { message: sent } = (await response.json()) as {
      message: { threadId: string; inReplyTo: string; references: string[]; bodyHtml: string };
    };
    expect(sent.threadId).toBe("fakethread0000");
    expect(sent.inReplyTo).toBe("<fake-0@vibemail.test>");
    expect(sent.references).toEqual(["<fake-0@vibemail.test>"]);
    expect(sent.bodyHtml).toBe("<p>Hi Ann</p>");
  });

  it("answers 404 THREAD_NOT_FOUND for a thread that does not exist", async () => {
    const token = await signIn();
    const response = await call(
      sendRoute,
      "/api/v1/messages/send",
      postJson(token, { ...message, threadId: "nosuchthread", inReplyTo: "<x@example.com>" }),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as Envelope).error.code).toBe("THREAD_NOT_FOUND");
  });

  it("answers 400 VALIDATION_FAILED listing every bad field", async () => {
    const token = await signIn();
    const response = await call(
      sendRoute,
      "/api/v1/messages/send",
      postJson(token, { to: [{ email: "nope" }], subject: "a\r\nBcc: evil@example.com" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys((body.error.details?.fields ?? {}) as object).sort()).toEqual([
      "body",
      "subject",
      "to[0].email",
    ]);
  });

  it("rejects a non-JSON content type and invalid JSON as VALIDATION_FAILED", async () => {
    const token = await signIn();
    const wrongType = await call(
      sendRoute,
      "/api/v1/messages/send",
      authed(token, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" }),
    );
    expect(wrongType.status).toBe(400);
    expect(((await wrongType.json()) as Envelope).error.code).toBe("VALIDATION_FAILED");

    const badJson = await call(
      sendRoute,
      "/api/v1/messages/send",
      authed(token, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" }),
    );
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as Envelope).error.details).toEqual({ fields: { body: "must be valid JSON" } });
  });

  it("answers 413 BODY_TOO_LARGE for a body over 1 MiB", async () => {
    const token = await signIn();
    const response = await call(
      sendRoute,
      "/api/v1/messages/send",
      postJson(token, { ...message, bodyText: "a".repeat(1_048_576 + 10) }),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as Envelope).error.code).toBe("BODY_TOO_LARGE");
  });

  it("tells the client not to retry when the message was sent but could not be stored", async () => {
    const token = await signIn();
    jest.spyOn(getContainer().messages, "upsertMessages").mockRejectedValue(new Error("database unavailable"));
    const response = await call(sendRoute, "/api/v1/messages/send", postJson(token, message));
    expect(response.status).toBe(500);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe("PERSISTENCE_FAILED");
    expect(body.error.details).toMatchObject({ sent: true, gmailId: expect.any(String) });
    expect(body.error.message).toMatch(/do not send it again/i);
  });

  it("rejects GET with 405", async () => {
    const response = await call(sendRoute, "/api/v1/messages/send", { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });
});

describe("POST /api/v1/messages/{gmailId}/read", () => {
  it("marks an unread message read and stores it", async () => {
    const token = await signIn();
    const response = await call(readRoute, "/api/v1/messages/fake0000/read", authed(token, { method: "POST" }));
    expect(response.status).toBe(200);
    const { message } = (await response.json()) as { message: { gmailId: string; isRead: boolean; labelIds: string[] } };
    expect(message.gmailId).toBe("fake0000");
    expect(message.isRead).toBe(true);
    expect(message.labelIds).not.toContain("UNREAD");

    const unread = (await (
      await call(listRoute, "/api/v1/messages?labelIds=UNREAD&maxResults=100", authed(token))
    ).json()) as { messages: { gmailId: string }[] };
    expect(unread.messages.map((m) => m.gmailId)).not.toContain("fake0000");
  });

  it("is idempotent: marking it again is 200 with the same message", async () => {
    const token = await signIn();
    const first = await call(readRoute, "/api/v1/messages/fake0000/read", authed(token, { method: "POST" }));
    const second = await call(readRoute, "/api/v1/messages/fake0000/read", authed(token, { method: "POST" }));
    expect(second.status).toBe(200);
    const a = (await first.json()) as { message: { id: string } };
    const b = (await second.json()) as { message: { id: string } };
    expect(b.message.id).toBe(a.message.id);
  });

  it("answers 404 MESSAGE_NOT_FOUND for a message that does not exist", async () => {
    const token = await signIn();
    const response = await call(readRoute, "/api/v1/messages/nosuchmessage/read", authed(token, { method: "POST" }));
    expect(response.status).toBe(404);
    expect(((await response.json()) as Envelope).error.code).toBe("MESSAGE_NOT_FOUND");
  });

  it("answers 400 VALIDATION_FAILED for a malformed id, and for a bad percent-escape", async () => {
    const token = await signIn();
    for (const id of ["bad!id", "%E0%A4%A", "x".repeat(65)]) {
      const response = await call(readRoute, `/api/v1/messages/${id}/read`, authed(token, { method: "POST" }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as Envelope).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("answers 500 PERSISTENCE_FAILED, safe to retry, when only the database write fails", async () => {
    const token = await signIn();
    jest.spyOn(getContainer().messages, "upsertMessages").mockRejectedValue(new Error("database unavailable"));
    const response = await call(readRoute, "/api/v1/messages/fake0003/read", authed(token, { method: "POST" }));
    expect(response.status).toBe(500);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe("PERSISTENCE_FAILED");
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toMatch(/retrying is safe/i);
  });

  it("rejects PATCH and GET with 405", async () => {
    for (const method of ["PATCH", "GET"]) {
      const response = await call(readRoute, "/api/v1/messages/fake0000/read", { method });
      expect(response.status).toBe(405);
    }
  });
});

describe("CORS preflight", () => {
  const paths: [VercelHandler, string][] = [
    [startRoute, "/api/v1/auth/google"],
    [callbackRoute, "/api/v1/auth/google/callback"],
    [listRoute, "/api/v1/messages"],
    [sendRoute, "/api/v1/messages/send"],
    [readRoute, "/api/v1/messages/fake0000/read"],
  ];

  it.each(paths)("answers OPTIONS on %# with 204 and the headers, without authentication", async (route, path) => {
    const response = await call(route, path, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(response.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(await response.text()).toBe("");
  });
});

describe("POST /webhook/gmail", () => {
  const notification = (emailAddress: string) => ({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: "12345" })).toString("base64"),
      messageId: "1",
      publishTime: "2026-11-14T12:00:00Z",
    },
    subscription: "projects/p/subscriptions/s",
  });
  const post = (token: string | null, body: unknown) =>
    call(webhookRoute, `/api/webhook/gmail${token === null ? "" : `?token=${token}`}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("is reachable at /webhook/gmail through the rewrite in vercel.json", () => {
    const config = JSON.parse(readFileSync(join(__dirname, "../../vercel.json"), "utf8")) as {
      rewrites: { source: string; destination: string }[];
    };
    expect(config.rewrites).toContainEqual({
      source: "/webhook/gmail",
      destination: "/api/webhook/gmail",
    });
  });

  it("rejects a missing or wrong token with 401 and the envelope", async () => {
    for (const token of [null, "wrong"]) {
      const response = await post(token, notification("demo@vibemail.test"));
      expect(response.status).toBe(401);
      expect(((await response.json()) as Envelope).error.code).toBe("WEBHOOK_UNAUTHORIZED");
    }
  });

  it("answers 400 for a body that is not a Pub/Sub envelope, only after the token is checked", async () => {
    expect((await post(WEBHOOK_TOKEN, "not json at all")).status).toBe(400);
    expect((await post(WEBHOOK_TOKEN, { hello: "world" })).status).toBe(400);
    expect((await post("wrong", "not json at all")).status).toBe(401);
  });

  it("acknowledges a notification for an unknown mailbox without doing anything", async () => {
    const response = await post(WEBHOOK_TOKEN, notification("stranger@example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored", reason: "UNKNOWN_ACCOUNT" });
  });

  it("processes a notification for a signed-in mailbox", async () => {
    await signIn();
    const response = await post(WEBHOOK_TOKEN, notification("demo@vibemail.test"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "processed", upserted: 0, deleted: 0 });
  });

  it("is not a browser endpoint: no CORS headers, and OPTIONS and GET are 405", async () => {
    const posted = await post(WEBHOOK_TOKEN, notification("stranger@example.com"));
    expect(posted.headers.get("access-control-allow-origin")).toBeNull();
    for (const method of ["OPTIONS", "GET"]) {
      const response = await call(webhookRoute, "/api/webhook/gmail", { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("configuration", () => {
  it("answers 500 INTERNAL, without naming the missing setting, when the app is misconfigured", async () => {
    useEnv({ JWT_SECRET: undefined });
    const response = await call(listRoute, "/api/v1/messages");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("INTERNAL");
    expect(text).not.toContain("JWT_SECRET");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("JWT_SECRET"));
  });

  it("refuses fake mode in production", () => {
    expect(() => buildContainer({ ...process.env, NODE_ENV: "production" })).toThrow("must not be set in production");
    expect(() => buildContainer({ ...process.env, VERCEL_ENV: "production" })).toThrow("must not be set in production");
  });

  it("allows fake mode in preview and development", () => {
    expect(buildContainer({ ...process.env, VERCEL_ENV: "preview" }).fakes).toBe(true);
    expect(buildContainer({ ...process.env, NODE_ENV: "development" }).fakes).toBe(true);
  });

  it("requires JWT_SECRET and a valid FRONTEND_URL", () => {
    expect(() => buildContainer({ ...process.env, JWT_SECRET: "" })).toThrow("JWT_SECRET");
    expect(() => buildContainer({ ...process.env, FRONTEND_URL: "" })).toThrow("FRONTEND_URL");
    expect(() => buildContainer({ ...process.env, FRONTEND_URL: "not a url" })).toThrow();
  });

  it("wires the real Gmail and Supabase stack when fakes are off, and demands all its settings", () => {
    const real = {
      JWT_SECRET: SECRET,
      FRONTEND_URL: FRONTEND,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: `${BASE}/api/v1/auth/google/callback`,
      GOOGLE_PUBSUB_TOPIC: "projects/p/topics/t",
      GOOGLE_PUBSUB_VERIFICATION_TOKEN: WEBHOOK_TOKEN,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    expect(buildContainer(real).fakes).toBe(false);
    for (const missing of Object.keys(real).filter((k) => k !== "JWT_SECRET" && k !== "FRONTEND_URL")) {
      expect(() => buildContainer({ ...real, [missing]: undefined })).toThrow();
    }
  });

  it("reuses one container across requests in a function instance", () => {
    expect(getContainer()).toBe(getContainer());
  });
});
