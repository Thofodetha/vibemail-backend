import jwt from "jsonwebtoken";
import { InMemoryAccountStore } from "../../src/db/in-memory";
import {
  allowedOrigin,
  corsHeaders,
  preflightResponse,
  withCors,
} from "../../src/middleware/cors";
import {
  describeApiError,
  describeForLog,
  errorResponse,
  isServerFault,
  jsonResponse,
} from "../../src/middleware/errors";
import {
  authenticate,
  bearerToken,
  JWT_LIFETIME_SECONDS,
  signJwt,
  verifyJwt,
} from "../../src/middleware/jwt";
import {
  clearedStateCookie,
  newState,
  readStateCookie,
  stateCookie,
  stateMatches,
  STATE_COOKIE,
} from "../../src/middleware/state";
import {
  BodyTooLargeError,
  InvalidPageTokenError,
  InvalidRecipientError,
  MessageNotFoundError,
  PersistenceFailedError,
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  SentNotPersistedError,
  ThreadNotFoundError,
  UnauthenticatedError,
  UpstreamError,
  ValidationError,
} from "../../src/types/errors";

describe("describeApiError: the typed error to envelope mapping", () => {
  const cases: [string, unknown, number, string][] = [
    ["UnauthenticatedError", new UnauthenticatedError(), 401, "UNAUTHENTICATED"],
    ["ReauthRequiredError", new ReauthRequiredError("x"), 401, "GMAIL_REAUTH_REQUIRED"],
    ["ScopeInsufficientError", new ScopeInsufficientError("x"), 403, "GMAIL_SCOPE_INSUFFICIENT"],
    ["ValidationError", new ValidationError({ to: "is required" }), 400, "VALIDATION_FAILED"],
    ["RateLimitedError", new RateLimitedError("x"), 429, "GMAIL_RATE_LIMITED"],
    ["InvalidPageTokenError", new InvalidPageTokenError("x"), 400, "INVALID_PAGE_TOKEN"],
    ["InvalidRecipientError", new InvalidRecipientError("x"), 400, "INVALID_RECIPIENT"],
    ["BodyTooLargeError", new BodyTooLargeError("x"), 413, "BODY_TOO_LARGE"],
    ["ThreadNotFoundError", new ThreadNotFoundError("x"), 404, "THREAD_NOT_FOUND"],
    ["MessageNotFoundError", new MessageNotFoundError("x"), 404, "MESSAGE_NOT_FOUND"],
    ["PersistenceFailedError", new PersistenceFailedError("x"), 500, "PERSISTENCE_FAILED"],
    ["SentNotPersistedError", new SentNotPersistedError("m1", "t1"), 500, "PERSISTENCE_FAILED"],
    ["UpstreamError", new UpstreamError("x"), 502, "GMAIL_UPSTREAM_ERROR"],
    ["an unknown Error", new Error("boom"), 500, "INTERNAL"],
    ["a thrown string", "boom", 500, "INTERNAL"],
  ];

  it.each(cases)("%s -> %i %s", (_name, error, status, code) => {
    expect(describeApiError(error)).toMatchObject({ status, code });
  });

  it("lists the offending fields for a validation failure", () => {
    expect(describeApiError(new ValidationError({ to: "is required", subject: "bad" })).details).toEqual({
      fields: { to: "is required", subject: "bad" },
    });
  });

  it("tells the client a sent message must not be sent again", () => {
    const mapped = describeApiError(new SentNotPersistedError("m1", "t1"));
    expect(mapped.details).toEqual({ sent: true, gmailId: "m1", threadId: "t1" });
    expect(mapped.message).toMatch(/do not send it again/i);
  });

  it("says retrying is safe for a stored-change failure that did not send anything", () => {
    expect(describeApiError(new PersistenceFailedError("x")).message).toMatch(/retrying is safe/i);
    expect(describeApiError(new PersistenceFailedError("x")).details).toBeUndefined();
  });

  it("passes through retryAfterSeconds, the upstream status and the bad recipient field", () => {
    expect(describeApiError(new RateLimitedError("x", undefined, 30)).retryAfterSeconds).toBe(30);
    expect(describeApiError(new RateLimitedError("x")).retryAfterSeconds).toBeUndefined();
    expect(describeApiError(new UpstreamError("x", { response: { status: 503 } })).details).toEqual({
      gmailStatus: 503,
    });
    expect(describeApiError(new UpstreamError("x", new Error("network"))).details).toBeUndefined();
    expect(describeApiError(new InvalidRecipientError("x", "cc")).details).toEqual({ field: "cc" });
    expect(describeApiError(new InvalidRecipientError("x")).details).toBeUndefined();
  });

  it("never copies text from the underlying error into the response", () => {
    const secret = "Bearer ya29.super-secret-token at db-7.internal";
    for (const error of [
      new Error(secret),
      new UpstreamError(secret, { message: secret }),
      new ReauthRequiredError(secret),
      new PersistenceFailedError(secret),
    ]) {
      expect(JSON.stringify(describeApiError(error))).not.toContain("ya29");
      expect(JSON.stringify(describeApiError(error))).not.toContain("db-7");
    }
  });

  it("builds the envelope of CONTRACT 1.4 with a JSON content type", async () => {
    const response = errorResponse(describeApiError(new ValidationError({ to: "x" })));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "The request failed validation.",
        details: { fields: { to: "x" } },
      },
    });
  });

  it("omits details and retryAfterSeconds when there are none", async () => {
    const body = (await errorResponse(describeApiError(new Error("x"))).json()) as {
      error: Record<string, unknown>;
    };
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  });

  it("only server-side failures count as faults worth logging", () => {
    expect(isServerFault(describeApiError(new Error("x")))).toBe(true);
    expect(isServerFault(describeApiError(new UpstreamError("x")))).toBe(true);
    expect(isServerFault(describeApiError(new UnauthenticatedError()))).toBe(false);
    expect(isServerFault(describeApiError(new ValidationError({})))).toBe(false);
  });

  it("logs a name, message and status but not a request's headers", () => {
    const leaky = new UpstreamError("Google request failed", {
      response: { status: 500 },
      config: { headers: { Authorization: "Bearer ya29.secret" } },
    });
    const line = describeForLog(leaky);
    expect(line).toBe("UpstreamError: Google request failed (upstream 500)");
    expect(line).not.toContain("ya29");
  });

  it("builds a JSON response with extra headers", async () => {
    const response = jsonResponse(201, { ok: true }, { "X-Test": "1" });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("JWT", () => {
  const SECRET = "test-secret-with-enough-length-0123456789";
  const NOW = new Date("2026-11-14T12:00:00.000Z");

  it("signs HS256 with sub, iat and an exp one hour later", () => {
    const token = signJwt("user-1", SECRET, NOW);
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe("HS256");
    expect(decoded?.payload).toEqual({
      sub: "user-1",
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + JWT_LIFETIME_SECONDS,
    });
    expect(JWT_LIFETIME_SECONDS).toBe(3600);
  });

  it("verifies its own token and returns the user id", () => {
    expect(verifyJwt(signJwt("user-1", SECRET, NOW), SECRET, NOW)).toEqual({ userId: "user-1" });
  });

  it("rejects an expired token, and accepts one just inside its hour", () => {
    const token = signJwt("user-1", SECRET, NOW);
    const justInside = new Date(NOW.getTime() + (JWT_LIFETIME_SECONDS - 1) * 1000);
    const expired = new Date(NOW.getTime() + (JWT_LIFETIME_SECONDS + 1) * 1000);
    expect(verifyJwt(token, SECRET, justInside).userId).toBe("user-1");
    expect(() => verifyJwt(token, SECRET, expired)).toThrow(UnauthenticatedError);
  });

  it("rejects a token signed with another secret", () => {
    expect(() => verifyJwt(signJwt("user-1", "another-secret-entirely", NOW), SECRET, NOW)).toThrow(
      UnauthenticatedError,
    );
  });

  it("rejects a tampered payload", () => {
    const [header, , signature] = signJwt("user-1", SECRET, NOW).split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 3600 }),
    ).toString("base64url");
    expect(() => verifyJwt(`${header}.${forged}.${signature}`, SECRET, NOW)).toThrow(UnauthenticatedError);
  });

  it("rejects the `none` algorithm", () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: "user-1",
      exp: NOW.getTime() / 1000 + 3600,
    })}.`;
    expect(() => verifyJwt(unsigned, SECRET, NOW)).toThrow(UnauthenticatedError);
  });

  it("rejects any algorithm but HS256, even with the right secret", () => {
    const iat = NOW.getTime() / 1000;
    const hs512 = jwt.sign({ sub: "user-1", iat, exp: iat + 3600 }, SECRET, { algorithm: "HS512" });
    expect(() => verifyJwt(hs512, SECRET, NOW)).toThrow(UnauthenticatedError);
  });

  it("rejects a token with no expiry or no subject", () => {
    const iat = NOW.getTime() / 1000;
    const noExp = jwt.sign({ sub: "user-1", iat }, SECRET, { algorithm: "HS256" });
    const noSub = jwt.sign({ iat, exp: iat + 3600 }, SECRET, { algorithm: "HS256" });
    const emptySub = jwt.sign({ sub: "", iat, exp: iat + 3600 }, SECRET, { algorithm: "HS256" });
    for (const token of [noExp, noSub, emptySub]) {
      expect(() => verifyJwt(token, SECRET, NOW)).toThrow(UnauthenticatedError);
    }
  });

  it.each(["", "not-a-jwt", "a.b.c", "....", "Bearer x"])("rejects the garbage %p", (garbage) => {
    expect(() => verifyJwt(garbage, SECRET, NOW)).toThrow(UnauthenticatedError);
  });

  it("refuses to sign or verify with an empty secret", () => {
    expect(() => signJwt("user-1", "", NOW)).toThrow("JWT_SECRET");
    expect(() => verifyJwt("x.y.z", "", NOW)).toThrow("JWT_SECRET");
  });
});

describe("bearerToken", () => {
  it("reads the token, with the scheme in any case", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("BEARER abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
  });

  it.each([null, "", "abc", "Basic abc", "Bearer", "Bearer ", "Bearer a b", "Token abc"])(
    "rejects %p",
    (header) => {
      expect(() => bearerToken(header)).toThrow(UnauthenticatedError);
    },
  );
});

describe("authenticate", () => {
  const SECRET = "test-secret-with-enough-length-0123456789";
  const NOW = new Date("2026-11-14T12:00:00.000Z");

  async function setup() {
    const accounts = new InMemoryAccountStore();
    const { userId, accountId } = await accounts.upsertGoogleAccount({
      googleSub: "sub-1",
      email: "User@Example.com",
      scopes: [],
    });
    const request = (token: string | null) =>
      new Request("https://api.example.com/api/v1/messages", {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      });
    return { accounts, userId, accountId, request, deps: { jwtSecret: SECRET, accounts, now: () => NOW } };
  }

  it("returns the user and their Gmail account for a valid token", async () => {
    const { deps, request, userId, accountId } = await setup();
    expect(await authenticate(request(signJwt(userId, SECRET, NOW)), deps)).toEqual({
      userId,
      accountId,
      email: "user@example.com",
    });
  });

  it("rejects a request with no token", async () => {
    const { deps, request } = await setup();
    await expect(authenticate(request(null), deps)).rejects.toThrow(UnauthenticatedError);
  });

  it("rejects an expired token", async () => {
    const { deps, request, userId } = await setup();
    const old = new Date(NOW.getTime() - 2 * 3600 * 1000);
    await expect(authenticate(request(signJwt(userId, SECRET, old)), deps)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it("requires sign-in again when the user has no linked Gmail account", async () => {
    const { deps, request } = await setup();
    await expect(authenticate(request(signJwt("a-user-with-no-account", SECRET, NOW)), deps)).rejects.toThrow(
      ReauthRequiredError,
    );
  });
});

describe("CORS", () => {
  const FRONTEND = "https://app.example.com";

  it("allows exactly the frontend origin, the two headers and the three methods", () => {
    expect(corsHeaders(FRONTEND)).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    });
  });

  it("reduces FRONTEND_URL to an origin, dropping any path, query or trailing slash", () => {
    expect(allowedOrigin("https://app.example.com/")).toBe("https://app.example.com");
    expect(allowedOrigin("https://app.example.com/dashboard?x=1")).toBe("https://app.example.com");
    expect(allowedOrigin("http://localhost:3001")).toBe("http://localhost:3001");
  });

  it("answers a preflight with 204 and the headers, and an empty body", async () => {
    const response = preflightResponse(FRONTEND);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(await response.text()).toBe("");
  });

  it("adds the headers to a response and keeps the ones it has", () => {
    const response = withCors(jsonResponse(200, {}, { "X-Keep": "yes" }), FRONTEND);
    expect(response.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(response.headers.get("x-keep")).toBe("yes");
  });
});

describe("OAuth state cookie", () => {
  it("makes unguessable, unique nonces", () => {
    const a = newState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newState()).not.toBe(a);
  });

  it("is HttpOnly, Secure, SameSite=Lax, ten minutes and scoped to the sign-in routes", () => {
    const cookie = stateCookie("nonce");
    expect(cookie).toBe(
      `${STATE_COOKIE}=nonce; Max-Age=600; Path=/api/v1/auth/google; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("is deleted with Max-Age=0 and the same attributes", () => {
    expect(clearedStateCookie()).toBe(
      `${STATE_COOKIE}=; Max-Age=0; Path=/api/v1/auth/google; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("is read back from a Cookie header among other cookies", () => {
    expect(readStateCookie(`a=1; ${STATE_COOKIE}=abc_-123; b=2`)).toBe("abc_-123");
    expect(readStateCookie(`${STATE_COOKIE}=with=equals`)).toBe("with=equals");
  });

  it.each([null, "", "other=1", `${STATE_COOKIE}=`, `x${STATE_COOKIE}=abc`])(
    "reads nothing from %p",
    (header) => {
      expect(readStateCookie(header)).toBeUndefined();
    },
  );

  it("matches only equal values", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "abcd")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
    expect(stateMatches(undefined, "abc")).toBe(false);
    expect(stateMatches(undefined, null)).toBe(false);
    expect(stateMatches("", "")).toBe(false);
  });
});
