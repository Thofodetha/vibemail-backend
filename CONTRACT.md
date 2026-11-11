# VibeMail Engine Contract

Status: draft for review. Version 0.4, 2026-11-11.

Changes from 0.3: the stack now matches `CLAUDE.md`. Plain Vercel Functions replace Next.js route handlers; the Supabase JS client replaces Prisma and Better Auth; the app issues its own JWT Bearer tokens; Jest replaces Vitest; client routes live under `/api/v1` and the Pub/Sub webhook is at `/webhook/gmail`. The engine now owns the sign-in start endpoint, the user and Gmail-account tables, token encryption and CORS. The two sessions are split by branch and by directory. Section 8 records the decisions the owner confirmed on 2026-11-11.

Earlier changes: 0.3 removed the daily cron route and the Row Level Security requirement. 0.2 moved the database to Supabase and added Pub/Sub push, the 50-message initial sync and the sync-state table.

This document is the single source of truth for what the VibeMail engine must do, how its endpoints behave, what a stored message looks like, and the order in which the two build sessions work. If code and this document disagree, one of them is wrong and the disagreement is resolved here first. `build_sequence.md` defines the order of the seven build units and what is verified at each; section 6 maps those units onto the two sessions. `CLAUDE.md` holds the working rules (never-do list, conventions); where it and this document differ on stack, authentication or routes, `CLAUDE.md` wins and this document is corrected.

## 1. Overview and conventions

### 1.1 Stack

| Layer | Choice |
|---|---|
| Runtime | Node 20, TypeScript in strict mode, deployed as Vercel serverless functions |
| HTTP | Plain Node request/response handlers in `api/`; no web framework |
| Gmail | `googleapis`, always through its OAuth2 client |
| Database | Supabase Postgres, accessed through the Supabase JS client (`@supabase/supabase-js`) with the service-role key. Supabase is used **only as Postgres**: no Supabase Auth, Storage or Realtime. |
| App authentication | Own JWT Bearer tokens (`jsonwebtoken`), issued by the OAuth callback |
| Tests | Jest with supertest |
| Push | Google Cloud Pub/Sub (push subscription to the webhook in 3.5) |

### 1.2 How the engine works

- The user signs in with Google through the sign-in start endpoint and the callback (3.1). The callback stores the user, the Gmail account and the **encrypted** Google tokens in Supabase, then hands the browser the app's own JWT.
- Every endpoint under `/api/v1` except the sign-in start and the callback requires `Authorization: Bearer <JWT>` (1.8). The webhook is outside `/api/v1` and is verified separately (3.5).
- **Gmail client.** Every Gmail call goes through the `googleapis` OAuth2 client, which refreshes expired access tokens automatically. A listener on the client's `tokens` event writes every token change back through the `TokenStore` (encrypted, 1.9) before the request finishes. Google omits `refresh_token` from refresh events, so a save without one keeps the stored refresh token.
- **Reads.** `GET /api/v1/messages` reads Gmail live, then **upserts** the results into the `messages` table. Gmail is the source of truth.
- **Initial sync.** After a user's first successful sign-in, the engine starts a Gmail watch, stores up to the 50 most recent INBOX messages, and records the sync cursor (3.6).
- **Delta sync.** Gmail pushes a notification to Pub/Sub on mailbox changes; Pub/Sub calls the webhook (3.5), which fetches only what changed since the stored cursor via `history.list` and upserts or deletes rows. The engine never polls Gmail for new messages.

### 1.3 OAuth scopes and Google Cloud setup

Scopes: `openid email profile https://www.googleapis.com/auth/gmail.modify`

`gmail.modify` is accepted by `messages.list`, `messages.get`, `messages.send`, `messages.modify`, `history.list` and `users.watch`, so it is the only Gmail scope requested. It is a Google *restricted* scope. Full Google OAuth verification is out of scope (section 7); the live smoke test runs on a Google Cloud project in "Testing" status with the tester's account added as a test user. In that status Google expires refresh tokens after 7 days.

Pub/Sub prerequisites (manual, one-time, outside the engine):
- A Pub/Sub topic in the **same Google Cloud project** as the OAuth client, named in `GOOGLE_PUBSUB_TOPIC` (`projects/<project-id>/topics/<name>`).
- `gmail-api-push@system.gserviceaccount.com` granted publish rights on that topic.
- A push subscription on that topic whose endpoint is `https://<host>/webhook/gmail?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>`.

### 1.4 Error envelope (all JSON endpoints)

```ts
type ErrorResponse = {
  error: {
    code: string;                 // typed code from the tables in this document
    message: string;              // human-readable, safe to show, never contains tokens
    details?: Record<string, unknown>;
    retryAfterSeconds?: number;   // present on GMAIL_RATE_LIMITED when known
  };
};
```

`Content-Type: application/json`. The sign-in callback is the exception (3.1): it is a browser redirect and carries its error as a query parameter.

### 1.5 Shared errors

Every JWT-authenticated JSON endpoint (3.2, 3.3, 3.4) can return these in addition to its own. The webhook uses the same Gmail-derived codes where noted.

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | `Authorization` header missing, not a Bearer token, or the JWT is malformed, has a bad signature, or is expired. |
| `GMAIL_REAUTH_REQUIRED` | 401 | Gmail returned 401 and the token refresh failed with `invalid_grant` (refresh token revoked or expired), or the user has no linked Gmail account. Client must re-run sign-in. |
| `GMAIL_SCOPE_INSUFFICIENT` | 403 | Gmail returned 403 `insufficientPermissions`. The granted scopes no longer include `gmail.modify`. |
| `VALIDATION_FAILED` | 400 | Request failed validation. `details.fields` maps field path to message. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail returned 429, or 403 with reason `rateLimitExceeded` / `userRateLimitExceeded`. `retryAfterSeconds` is set when Gmail supplied `Retry-After`. |
| `GMAIL_UPSTREAM_ERROR` | 502 | Gmail returned 5xx, the network failed, or Gmail returned an unmapped 4xx. `details.gmailStatus` holds the upstream status when there was one. |
| `INTERNAL` | 500 | Any other unexpected server error. |

### 1.6 IDs

- `gmailId` is Gmail's message ID. It is the only message identifier clients use, and the `{gmailId}` path parameter. It must match `^[A-Za-z0-9_-]{1,64}$`, else `VALIDATION_FAILED`.
- `id` (a uuid) is the internal primary key. It appears in responses but is never accepted as input.

### 1.7 The `StoredMessage` response type

Every message returned by the API has this shape. It is the row in 4.3 with the `from_*` columns folded into `from`, names in camelCase, and `internalDate` serialised as ISO 8601.

```ts
type EmailAddress = { name: string | null; email: string };

type AttachmentMeta = {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;                    // bytes, from body.size
  attachmentId: string | null;     // from body.attachmentId
};

type StoredMessage = {
  id: string;
  gmailId: string;
  threadId: string;
  historyId: string;
  internalDate: string;            // ISO 8601 UTC
  labelIds: string[];
  isRead: boolean;
  snippet: string;
  sizeEstimate: number;
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  syncedAt: string;                // ISO 8601 UTC
};
```

### 1.8 Authentication and CORS

**JWT.** HS256, signed with `JWT_SECRET`. Claims: `sub` (the internal user id, a uuid), `iat`, `exp` (one hour after issue). There is no JWT refresh endpoint: when a token expires the client re-runs sign-in. Verification rejects any other algorithm.

**Which routes.** The sign-in start and the callback (3.1) require no JWT. The webhook (3.5) is not a user endpoint and uses its own check. Everything else requires the Bearer token. After verifying the JWT, the engine loads the user's Gmail account (one per user); none found is `GMAIL_REAUTH_REQUIRED`.

**CORS.** The frontend is a separate origin (`FRONTEND_URL`). Every `/api/v1` response carries `Access-Control-Allow-Origin: <FRONTEND_URL>`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Allow-Methods: GET, POST, OPTIONS`. `OPTIONS` requests are answered `204` without authentication. No other origin is allowed.

### 1.9 Token encryption

Google access and refresh tokens are never stored in plaintext. `TokenStore` encrypts before writing and decrypts after reading; plaintext tokens exist only in memory.

- Algorithm: AES-256-GCM. Key: `ENCRYPTION_KEY`, 32 random bytes, base64-encoded.
- A fresh random 12-byte IV for every value.
- Stored form: base64 of `IV ‖ ciphertext ‖ auth tag`.
- A value that fails authentication on decrypt is an `INTERNAL` error, never silently ignored.

## 2. Acceptance criteria

The project is complete when **every** box below can be ticked with evidence (a passing test, a command output, or a log or screenshot from the smoke test). "No skipped tests" means zero `skip`, `todo` or `only` in the suite.

Criteria are grouped by when they can be proven (section 6). The unit numbers refer to `build_sequence.md`.

### 2.1 Server logic session: proven against fakes, before the schema merges

- [ ] **AC-1** (unit 1) The `MailProvider`, `AccountStore`, `TokenStore`, `MessageStore` and `SyncStateStore` interfaces in 5.2 compile under `tsc --noEmit` in strict mode and define every method listed there. Both the Gmail implementation and the fake implement `MailProvider`.
- [ ] **AC-2** (unit 2) The sign-in start and callback match 3.1: success stores the account and redirects with a JWT; every failure redirects to `${FRONTEND_URL}/login?error=<CODE>` using only the codes in that section. Tested against mocked Google token and userinfo endpoints.
- [ ] **AC-3** (unit 2) Token handling: stored token values are AES-256-GCM ciphertext (a test asserts the stored string contains neither token); an expired access token is refreshed by the OAuth2 client and the `tokens` listener persists the result before the request finishes; a refresh event without a `refresh_token` keeps the stored one; a refresh failing with `invalid_grant` yields `GMAIL_REAUTH_REQUIRED`. A test asserts the stored tokens equal the client's final credentials.
- [ ] **AC-4** (unit 2) JWT authentication matches 1.8: a missing, non-Bearer, malformed, wrongly signed, wrong-algorithm or expired token gets `401 UNAUTHENTICATED` on every protected route; the start and callback routes work without a token.
- [ ] **AC-5** (unit 3) Initial sync (3.6) stores exactly the 50 most recent INBOX messages when the mailbox has at least 50, starts the watch **before** listing, and records the cursor. Every stored message deep-equals the section 4 model for a set of recorded Gmail fixtures (plain, multipart/alternative, attachment, reply, missing-header).
- [ ] **AC-6** (unit 3) `GET /api/v1/messages` matches 3.2 for validation, response shape, cursor pagination and every listed error.
- [ ] **AC-7** (unit 4) The webhook matches 3.5: given a notification, it calls `history.list` from the **stored** cursor (not the notification's `historyId`), fetches exactly the changed messages, upserts or deletes the right rows, and advances the cursor to the `historyId` returned by Gmail. A `history.list` 404 triggers a full resync. A request with a missing or wrong verification token is rejected.
- [ ] **AC-8** (unit 5) `POST /api/v1/messages/send` matches 3.3 for validation, MIME construction, reply threading, response shape and every listed error.
- [ ] **AC-9** (unit 5) `POST /api/v1/messages/{gmailId}/read` matches 3.4, including idempotency, and every listed error.
- [ ] **AC-10** (unit 6) All four core endpoints (3.1 to 3.4) respond correctly in a local preview (`npx vercel dev`) wired to fakes (6.3). `/webhook/gmail` reaches the webhook function through the rewrite, and a CORS preflight to `/api/v1` returns `204` with the headers in 1.8.
- [ ] **AC-11** Every error code in sections 1.5 and 3 has at least one automated test that triggers it and asserts the HTTP status (or redirect), the `code`, and the envelope shape.
- [ ] **AC-12** Only the Gmail provider imports `googleapis`, and only `src/db` imports `@supabase/supabase-js`. Entry points in `api/` stay thin and call services that depend on the interfaces in 5.2.
- [ ] **AC-13** No response body, log line or error `message` ever contains an access token, refresh token, authorization code, JWT, verification token or full message body in an error path. No credential is hardcoded; every secret is read from the environment.
- [ ] **AC-14** `src/` and `api/` contain no explicit `any` type (enforced by a unit test that scans the source).
- [ ] **AC-15** **Server logic gate:** `npx tsc --noEmit` and `npm test` exit 0 with no skipped tests. `npm test` runs only fakes and in-memory stores: no network, no database.

### 2.2 After the gate: schema merge and live verification

- [ ] **AC-16** The SQL files in `migrations/` create the tables in section 4 field for field (names, Postgres types, nullability, constraints, indexes), and the row types in `types/` match them.
- [ ] **AC-17** The migrations are applied, in filename order, to the Supabase database.
- [ ] **AC-18** The Supabase-backed `AccountStore`, `TokenStore`, `MessageStore` and `SyncStateStore` in `src/db` pass the same store test suites as the in-memory ones, run live (`npm run test:integration`).
- [ ] **AC-19** (unit 2, live) The OAuth flow completes against Google, the tokens in `gmail_accounts` are ciphertext (checked by querying the table), and a forced refresh persists the new tokens with no mismatch (stored tokens equal the tokens used on the following Gmail call).
- [ ] **AC-20** (unit 3, live) Initial sync against a real mailbox stores 50 rows in Supabase, and each row deep-equals the section 4 model.
- [ ] **AC-21** (unit 4, live) A real Pub/Sub notification, triggered by a real mailbox change, reaches the deployed webhook, which fetches the correct delta by history ID and updates Supabase.
- [ ] **AC-22** (unit 5, live) A message sends successfully through the Gmail API on behalf of an authenticated user, and mark-as-read updates both Gmail and the row.
- [ ] **AC-23** (unit 6) All four core endpoints respond correctly in a local preview wired to the real stores and Gmail provider, and on a Vercel preview deployment. The webhook rewrite and verification token are configured there.
- [ ] **AC-24** (unit 7) The full test suite, `npm test` and `npm run test:integration`, passes against a live Supabase instance with no skipped tests.
- [ ] **AC-25** One live smoke run on a Google test account: sign in, initial sync runs, list the inbox, send a message to the same account, see it in the list, mark it read, and observe the webhook delta update the row, ending with the row at `is_read = true` and no `UNREAD` in `label_ids`.
- [ ] **AC-26** `.env.example` lists every variable the project reads: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_VERIFICATION_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `ENCRYPTION_KEY`, `FRONTEND_URL`. `.env` is gitignored.

## 3. Endpoint contracts

All endpoints run on the Node.js runtime and are never cached (`Cache-Control: no-store`). The four **core endpoints** are 3.1 to 3.4; 3.5 is a machine-to-machine route; 3.6 is an internal routine, not an HTTP endpoint.

Entry points are Vercel Functions: `api/v1/auth/google/index.ts` and `api/v1/auth/google/callback.ts` (3.1), `api/v1/messages/index.ts` (3.2), `api/v1/messages/send.ts` (3.3), `api/v1/messages/[gmailId]/read.ts` (3.4) and `api/webhook/gmail.ts` (3.5). Vercel serves `api/` files under `/api/...`, so the webhook's public path `/webhook/gmail` needs a rewrite in the Vercel config.

### 3.1 Sign-in start and OAuth callback

#### Start

`GET /api/v1/auth/google` (no JWT required)

Creates a random `state` value, stores it in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie valid for 10 minutes, and responds `302` to Google's consent URL with: the scopes in 1.3, `redirect_uri = GOOGLE_REDIRECT_URI`, `access_type=offline`, `prompt=consent` (so Google always returns a refresh token), and the `state`.

#### Callback

`GET /api/v1/auth/google/callback` (no JWT required)

**Request (query parameters, set by Google)**

| Param | Type | Notes |
|---|---|---|
| `code` | string | Authorization code. Present on success. |
| `state` | string | Must equal the value in the state cookie. |
| `scope` | string | Space-separated scopes the user actually granted. Must include `https://www.googleapis.com/auth/gmail.modify`. |
| `error` | string | Present instead of `code` when the user denied access or Google failed. |

**Behaviour**

1. Check `error`, then `state` against the cookie. Clear the cookie either way.
2. Exchange `code` for tokens with the OAuth2 client. Verify the ID token and read `sub` and `email`.
3. Check the granted scopes and that a refresh token came back.
4. Upsert the user (by email, stored lowercase) and the Gmail account (by `google_sub`) through `AccountStore`; save the tokens through `TokenStore` (encrypted).
5. Issue the JWT (1.8).
6. Respond `302` to `${FRONTEND_URL}/auth/callback#token=<JWT>`. The token travels in the URL fragment, which browsers do not send to servers.
7. If the account has no completed initial sync, schedule one to run **after** the redirect is sent, using the platform's background-work facility (`waitUntil` from `@vercel/functions`; without it the function may be frozen once the response is sent). A failing initial sync never changes the redirect.

**Failure.** Always `302` to `${FRONTEND_URL}/login?error=<CODE>`. No JWT is issued and no account row is written or changed.

| Code | Trigger |
|---|---|
| `OAUTH_ACCESS_DENIED` | Google sent `error=access_denied` (user cancelled or denied consent). |
| `OAUTH_STATE_MISMATCH` | `state` is missing, or does not match the state cookie, or the cookie is absent or expired. |
| `OAUTH_CODE_EXCHANGE_FAILED` | `code` is missing, or Google's token endpoint rejected it (`invalid_grant`, `invalid_client`, network failure), or the ID token failed verification. |
| `OAUTH_MISSING_SCOPES` | The user unchecked `gmail.modify` on Google's granular consent screen, so `scope` lacks it. |
| `OAUTH_NO_REFRESH_TOKEN` | Google's token response contained no `refresh_token`. |
| `OAUTH_INTERNAL` | Any other failure, including any Google `error` value other than `access_denied`, and database or encryption errors. |

### 3.2 Message list

`GET /api/v1/messages`

**Request (query parameters)**

| Param | Type | Default | Rules |
|---|---|---|---|
| `pageToken` | string | none | The pagination cursor. Opaque. Pass back exactly the `nextPageToken` from the previous response. |
| `maxResults` | integer | `25` | 1 to 100 inclusive. Out of range is `VALIDATION_FAILED`, never clamped. |
| `labelIds` | string | `INBOX` | Comma-separated Gmail label IDs (system IDs like `INBOX`, `SENT`, `UNREAD`, or user label IDs). 1 to 10 labels. Present but empty is `VALIDATION_FAILED`. Multiple labels are AND-ed: a message must carry all of them. |
| `q` | string | none | Gmail search syntax. Max 500 characters. Combined with `labelIds` (both apply). |

**Success: `200 OK`**

```ts
type ListMessagesResponse = {
  messages: StoredMessage[];        // Gmail order (newest first); at most maxResults
  nextPageToken: string | null;     // Gmail's cursor passed through; null on the last page
  resultSizeEstimate: number;       // Gmail's estimate, passed through
};
```

**Behaviour**

1. `users.messages.list` with the params above. `includeSpamTrash` is not exposed or sent, so Gmail's default behaviour applies.
2. `users.messages.get` with `format=full` for each returned ID, with concurrency capped at 10.
3. Parse each result into the section 4 shape and upsert all of them in one `MessageStore` call (atomic).
4. Return the stored rows in the order Gmail listed them.

This endpoint never reads or changes the sync cursor. A message that disappears between steps 1 and 2 (Gmail 404) is skipped silently, so `messages.length` can be less than `maxResults` even when `nextPageToken` is non-null. Any other failure during step 2 fails the whole request with the mapped error. No partial pages.

**Errors** (plus 1.5)

| Code | HTTP | Trigger |
|---|---|---|
| `INVALID_PAGE_TOKEN` | 400 | Gmail rejected `pageToken` as invalid. |

### 3.3 Message send

`POST /api/v1/messages/send`

`Content-Type: application/json`. Request body capped at 1 MB.

**Request body**

```ts
type SendMessageRequest = {
  to: EmailAddress[];               // 1 to 100 entries
  cc?: EmailAddress[];
  bcc?: EmailAddress[];             // to + cc + bcc together: at most 100
  subject: string;                  // 0 to 998 chars, no CR or LF
  bodyText?: string;
  bodyHtml?: string;                // at least one of bodyText / bodyHtml is required
  threadId?: string;                // reply to a thread
  inReplyTo?: string;               // RFC 822 Message-ID being replied to
  references?: string[];            // defaults to [inReplyTo] when omitted
};
```

Validation rules:

- `EmailAddress.email` must be a syntactically valid address. `name`, when present, must not contain CR or LF.
- `threadId` and `inReplyTo` are all-or-nothing: either both or neither.
- Failures here are `VALIDATION_FAILED` with `details.fields`.

**Behaviour**

1. Build an RFC 2822 message. `From` is the signed-in account's email; non-ASCII subject and display names are RFC 2047 encoded; bodies are UTF-8. If both `bodyText` and `bodyHtml` are present the message is `multipart/alternative`.
2. When replying, set `In-Reply-To` and `References` headers.
3. base64url-encode the message and call `users.messages.send` with `raw` (and `threadId` when replying).
4. Call `users.messages.get` (`format=full`) on the returned ID and upsert.
5. Return the stored row.

**Success: `201 Created`**

```ts
type SendMessageResponse = { message: StoredMessage };
```

`send` is **not idempotent**. A client that retries after a timeout may send the message twice. There is no idempotency key in v0.4.

**Errors** (plus 1.5)

| Code | HTTP | Trigger |
|---|---|---|
| `INVALID_RECIPIENT` | 400 | The request passed validation but Gmail rejected a recipient header (`400 invalidArgument`). `details.field` names `to`, `cc` or `bcc` when determinable. |
| `BODY_TOO_LARGE` | 413 | Request body exceeds 1 MB, or Gmail rejected the message for size. |
| `THREAD_NOT_FOUND` | 404 | Gmail returned 404 for the given `threadId`. |

### 3.4 Mark as read

`POST /api/v1/messages/{gmailId}/read`

No request body.

**Behaviour**

1. `users.messages.modify` with `removeLabelIds: ["UNREAD"]`.
2. `users.messages.get` (`format=full`) and upsert.
3. Return the stored row.

Idempotent: marking an already-read message succeeds with `200` and the same body. There is no endpoint to mark a message unread. The label change produces a Gmail push notification; the resulting delta sync re-fetches the same message and upserts identical data, which is harmless.

**Success: `200 OK`**

```ts
type MarkReadResponse = { message: StoredMessage };   // message.isRead === true
```

**Errors** (plus 1.5)

| Code | HTTP | Trigger |
|---|---|---|
| `MESSAGE_NOT_FOUND` | 404 | Gmail returned 404 for `gmailId` (does not exist, was deleted, or belongs to another account). |
| `PERSISTENCE_FAILED` | 500 | Gmail was updated but the database upsert failed. Gmail is the source of truth and the next list or delta sync reconciles the row. Retrying is safe. |

### 3.5 Pub/Sub webhook receiver

`POST /webhook/gmail`

Called by a Pub/Sub push subscription, not by browsers. Not under `/api/v1`, and not a JWT route.

**Authentication.** The push subscription's endpoint carries `?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>` (1.3). The receiver compares it to the environment value in constant time. A missing or different token is `WEBHOOK_UNAUTHORIZED`, and nothing else is read from the request.

**Request body** (Pub/Sub push format)

```ts
type PubSubPush = {
  message: {
    data: string;                 // base64url JSON: { emailAddress: string; historyId: string }
    messageId: string;            // Pub/Sub id, unrelated to Gmail ids
    publishTime: string;
  };
  subscription: string;
};
```

**Behaviour**

1. Verify the token. Decode `message.data` into `{ emailAddress, historyId }`.
2. Resolve the account through `AccountStore` by `emailAddress` (lowercased). None found: acknowledge and ignore.
3. Load the account's `gmail_sync_state`. None found: acknowledge and ignore (no cursor to work from).
4. Call `history.list` with `startHistoryId` = the **stored** cursor (not the notification's `historyId`), all four history types, following `nextPageToken` to the end.
5. Reduce the history events to a net result: a message that was deleted anywhere in the range is deleted; every other message that was added or had labels added or removed is re-fetched (`messages.get`, `format=full`) and upserted. A re-fetch returning 404 counts as deleted.
6. Apply the upserts and deletes, then set the stored cursor to the `historyId` returned by the last `history.list` page.
7. If `history.list` returns 404 (cursor expired, usually after a week or more), run a full resync (3.6, steps 2 to 4 using a fresh watch) and reset the cursor.

The stored set after delta sync is therefore the initial 50 INBOX messages plus every message touched since, including messages outside INBOX such as SENT.

**Responses**

Pub/Sub treats any 2xx as an acknowledgement and retries anything else. Acknowledge what retrying cannot fix; fail what it can.

| Status | Body | When |
|---|---|---|
| `200 OK` | `{ "status": "processed", "upserted": n, "deleted": n }` | Steps 1 to 7 succeeded. |
| `200 OK` | `{ "status": "ignored", "reason": "UNKNOWN_ACCOUNT" \| "NOT_SYNCED" \| "REAUTH_REQUIRED" \| "SCOPE_INSUFFICIENT" }` | Nothing to do and a retry would not help. |
| `401` | error envelope, `WEBHOOK_UNAUTHORIZED` | Verification token missing or wrong. |
| `400` | error envelope, `WEBHOOK_PAYLOAD_INVALID` | Body is not a valid push envelope, or `message.data` does not decode to `{ emailAddress, historyId }`. |
| `429` / `502` / `500` | error envelope, `GMAIL_RATE_LIMITED` / `GMAIL_UPSTREAM_ERROR` / `INTERNAL` | Transient failure. Pub/Sub retries. A partial failure must not advance the cursor. |

Processing is idempotent: re-delivered or duplicated notifications upsert the same rows and leave the cursor correct. Gmail drops notifications beyond one per second per mailbox and may drop others. Because each delta runs from the stored cursor, a dropped notification is recovered by the next notification for that mailbox; with no catch-up job (section 7), rows may be stale until then.

### 3.6 Initial sync (internal routine)

Not an HTTP endpoint. Runs for an account with no completed initial sync: scheduled after a successful callback (3.1) whenever the account has none.

1. Call `users.watch` with `topicName = GOOGLE_PUBSUB_TOPIC` and no label filter. Save `gmail_sync_state` with `history_id` = the response `historyId`, `watch_expiration` from the response `expiration`, and `initial_sync_completed_at = null`.
2. List the 50 most recent INBOX messages (`labelIds=INBOX`, `maxResults=50`).
3. Fetch each with `format=full` (concurrency 10) and upsert them atomically.
4. Set `initial_sync_completed_at` to now.

The watch is started first so no change can fall into a gap: anything that happens during steps 2 to 4 appears in the history after the saved cursor and is picked up by the next delta sync. The routine is safe to re-run. If it fails part-way it leaves `initial_sync_completed_at = null` and runs again at the account's next sign-in.

## 4. Data model

Four tables, all in the `public` schema, created by SQL files in `migrations/`. Column names are the snake_case of the field names used in the API (`gmailId` is the column `gmail_id`). Primary keys are `uuid` with `default gen_random_uuid()`. Every foreign key is `on delete cascade`. `updated_at` is set by the application on every write; Postgres does not maintain it.

### 4.1 `users`

| Field | Postgres type | Null | Source |
|---|---|---|---|
| `id` | `uuid` (PK) | no | app |
| `email` | `text`, unique, stored lowercase | no | Google ID token claim `email` |
| `created_at` | `timestamptz` (default `now()`) | no | app |
| `updated_at` | `timestamptz` | no | app |

### 4.2 `gmail_accounts`

One per user. Holds the encrypted Google tokens.

| Field | Postgres type | Null | Source |
|---|---|---|---|
| `id` | `uuid` (PK) | no | app |
| `user_id` | `uuid`, unique, FK to `users.id` | no | app |
| `google_sub` | `text`, unique | no | Google ID token claim `sub` |
| `email` | `text`, unique, stored lowercase | no | Google ID token claim `email` |
| `access_token_enc` | `text` | no | token response `access_token`, encrypted (1.9) |
| `refresh_token_enc` | `text` | no | token response `refresh_token`, encrypted (1.9) |
| `token_expires_at` | `timestamptz` | no | token response `expiry_date` (epoch ms) |
| `scopes` | `text[]` | no | token response `scope`, split on spaces |
| `created_at` | `timestamptz` (default `now()`) | no | app |
| `updated_at` | `timestamptz` | no | app |

### 4.3 `messages`

One row per Gmail message per linked Google account. Source column: the field path in the Gmail `users.messages.get` response (`format=full`), or **app** when the engine supplies the value.

| Field | Postgres type | Null | Source |
|---|---|---|---|
| `id` | `uuid` (PK) | no | app |
| `userId` | `uuid`, FK to `users.id` | no | app: the authenticated user |
| `accountId` | `uuid`, FK to `gmail_accounts.id` | no | app: the user's Gmail account |
| `gmailId` | `text` | no | `id` |
| `threadId` | `text` | no | `threadId` |
| `historyId` | `text` | no | `historyId` (a uint64, kept as text) |
| `internalDate` | `timestamptz` | no | `internalDate` (epoch milliseconds as a string, converted to UTC) |
| `labelIds` | `text[]` (default `'{}'`) | no | `labelIds` |
| `isRead` | `boolean` | no | app-derived: `!labelIds.includes("UNREAD")`. Always set at write time so it matches `labelIds`. |
| `snippet` | `text` (default `''`) | no | `snippet` |
| `sizeEstimate` | `integer` | no | `sizeEstimate` |
| `subject` | `text` | yes | `payload.headers[name="Subject"].value` |
| `fromName` | `text` | yes | `payload.headers[name="From"]`, display-name part |
| `fromEmail` | `text` | yes | `payload.headers[name="From"]`, address part |
| `to` | `jsonb` (`EmailAddress[]`, default `'[]'`) | no | `payload.headers[name="To"]`, parsed |
| `cc` | `jsonb` (`EmailAddress[]`, default `'[]'`) | no | `payload.headers[name="Cc"]`, parsed |
| `bcc` | `jsonb` (`EmailAddress[]`, default `'[]'`) | no | `payload.headers[name="Bcc"]`, parsed. Gmail only returns this on messages the account sent. |
| `rfc822MessageId` | `text` | yes | `payload.headers[name="Message-ID"].value` |
| `inReplyTo` | `text` | yes | `payload.headers[name="In-Reply-To"].value` |
| `references` | `text[]` (default `'{}'`) | no | `payload.headers[name="References"].value`, split on whitespace |
| `bodyText` | `text` | yes | first non-attachment part with `mimeType = text/plain`, depth-first through `payload.parts`; a single-part message uses `payload` itself. `body.data` is base64url-decoded using the part's charset (default UTF-8). |
| `bodyHtml` | `text` | yes | same walk, `mimeType = text/html` |
| `attachments` | `jsonb` (`AttachmentMeta[]`, default `'[]'`) | no | every part with non-empty `filename`: `{ partId: parts[].partId, filename: parts[].filename, mimeType: parts[].mimeType, size: parts[].body.size, attachmentId: parts[].body.attachmentId }`. Bytes are never stored. |
| `syncedAt` | `timestamptz` | no | app: time of the last upsert from Gmail |
| `createdAt` | `timestamptz` (default `now()`) | no | app |
| `updatedAt` | `timestamptz` | no | app |

**Parsing rules**

- Header names are matched case-insensitively. A missing header gives `null` (or `[]` for list-valued fields), never an empty string.
- `from`, `to`, `cc`, `bcc` are parsed as RFC 5322 address lists. Display names are unquoted and RFC 2047-decoded.
- `isRead` and `labelIds` must never disagree. The parser derives one from the other in a single place.

**Constraints and indexes**

- Unique `(account_id, gmail_id)`. This is the upsert key.
- Index `(user_id, internal_date desc)`.
- Index `(user_id, thread_id)`.

Rows are deleted only by the delta sync, when Gmail reports a message as permanently deleted (3.5).

### 4.4 `gmail_sync_state`

One row per Gmail account. It holds the cursor the delta sync resumes from and the watch lifetime.

| Field | Postgres type | Null | Source |
|---|---|---|---|
| `account_id` | `uuid` (PK, FK to `gmail_accounts.id`) | no | app |
| `user_id` | `uuid`, FK to `users.id` | no | app |
| `history_id` | `text` | no | the sync cursor. Set from the `users.watch` response `historyId` at initial sync, then from the `users.history.list` response `historyId` after each delta sync. |
| `watch_expiration` | `timestamptz` | no | `users.watch` response `expiration` (epoch milliseconds as a string, converted to UTC) |
| `initial_sync_completed_at` | `timestamptz` | yes | app: set when 3.6 finishes; null until then |
| `last_delta_at` | `timestamptz` | yes | app: time of the last successful delta sync |
| `created_at` | `timestamptz` (default `now()`) | no | app |
| `updated_at` | `timestamptz` | no | app |

### 4.5 Ownership and conventions

- The **schema session** owns `migrations/` (plain SQL, applied in filename order) and `types/` (the TypeScript row types for these tables). It never touches `src/db/`.
- The **server logic session** owns `src/db/`, where the Supabase-backed stores live, and defines its own domain types in `src/types/`. It must not import from `types/` until the schema has merged.
- Supabase's Data API exposes `public` tables by default. See the Row Level Security gap in section 7.

## 5. Interfaces both sessions code against

These interfaces are the seam between the sessions. The server logic session implements the Gmail provider, the fakes, the in-memory stores and the Supabase-backed stores in `src/db`; the schema session supplies the tables those stores read and write.

### 5.1 Domain types

The server logic session defines its own plain TypeScript types for messages (matching 1.7 and 4.3), accounts and sync state (4.4) in `src/types/`. They do not depend on `types/`.

### 5.2 Interfaces

```ts
// The provider abstraction. Bound to one account; uses the googleapis OAuth2 client (AC-3).
interface MailProvider {
  listMessages(p: {
    labelIds: string[]; q?: string; maxResults: number; pageToken?: string;
  }): Promise<{ ids: string[]; nextPageToken: string | null; resultSizeEstimate: number }>;

  getMessage(id: string): Promise<ProviderMessage | null>;                // null on 404
  sendMessage(p: { raw: string; threadId?: string }): Promise<{ id: string; threadId: string }>;
  markRead(id: string): Promise<void>;                                    // throws MESSAGE_NOT_FOUND

  startWatch(p: { topicName: string }): Promise<{ historyId: string; expiration: Date }>;
  listHistory(p: { startHistoryId: string; pageToken?: string }): Promise<{
    events: { type: "added" | "deleted" | "labelsChanged"; id: string }[];
    nextPageToken: string | null;
    historyId: string;
  }>;                                                                     // throws HistoryExpiredError on 404
}

interface AccountStore {
  upsertGoogleAccount(p: {
    googleSub: string; email: string; scopes: string[];
  }): Promise<{ userId: string; accountId: string }>;                      // email lowercased
  getAccountForUser(userId: string): Promise<{ accountId: string; email: string } | null>;
  findAccountByEmail(email: string): Promise<{ userId: string; accountId: string } | null>;
}

interface TokenStore {
  // Encrypts on save and decrypts on read (1.9); callers only ever see plaintext in memory.
  getTokens(accountId: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date } | null>;
  saveTokens(accountId: string, t: { accessToken: string; refreshToken?: string; expiresAt: Date }): Promise<void>;
}

interface MessageStore {
  // Atomic: all rows are written or none are. Upserts on (accountId, gmailId).
  upsertMessages(ctx: { userId: string; accountId: string }, messages: ParsedMessage[]): Promise<StoredMessage[]>;  // same order as input
  deleteMessages(ctx: { accountId: string }, gmailIds: string[]): Promise<number>;                              // returns rows removed
}

interface SyncStateStore {
  get(accountId: string): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
```

`MailProvider` implementations throw typed errors from the catalog in 1.5 and section 3 (for example `GmailReauthRequiredError`, `GmailRateLimitedError`). Entry points translate them to the envelope in one shared function.

The Supabase JS client cannot run a multi-statement transaction, so `upsertMessages` must be a single bulk upsert statement for its atomicity guarantee to hold, and so must `deleteMessages`.

## 6. Two-session build and sequencing rule

### 6.1 Roles

| | Server logic session | Schema session |
|---|---|---|
| Branch | `main` | `schema` |
| Owns | `src/`, `api/`, `tests/`, and root config (`package.json`, `tsconfig.json`, the Vercel config) | `migrations/` and `types/` |
| Builds | Interfaces (5.2), the Gmail `MailProvider`, the `tokens` listener, encryption, JWT authentication, message parser, MIME builder, initial and delta sync, entry points (3.1 to 3.5), error mapping, fakes, in-memory stores, the Supabase-backed stores in `src/db`, the composition root (6.3) | The SQL migrations for section 4, the row types in `types/`, applying the migrations to Supabase, running the live suites |
| Tests | Jest with a fake `MailProvider`, recorded Gmail fixtures, mocked Google endpoints and in-memory stores; supertest drives the handlers through a thin HTTP wrapper. `npm test` needs no network or database. | Runs the live suite (`npm run test:integration`) and the smoke test; does not edit tests |
| Must not touch | `migrations/`, `types/` | `src/` (in particular `src/db/`), `api/` |

### 6.2 The rule

> **Server logic ships and its tests pass before the schema is reviewed or merged.**

Concretely:

1. **Branches.** The server logic session works on `main`. The schema session works on a `schema` branch cut from `main`.
2. **Drafting is allowed, review and merge are not.** The schema session may draft migrations on `schema` at any time. They are not reviewed and not merged until the gate in step 3 passes. Merging `schema` into `main` before then is forbidden.
3. **Server logic gate (AC-15).** `npx tsc --noEmit` and `npm test` exit 0 with no skipped tests, AC-1 to AC-14 are met, and the work is on `main`.
4. **After the gate.** The schema session's first task is to review the draft against section 4 and the store interfaces in section 5, then merge it. It then applies the migrations and runs the live suites.
5. **Done (AC-16 to AC-26).**
6. **Back-pressure.** If the schema session finds the contract or an interface wrong, it stops, records the change in this document, and returns to the server logic session. It does not patch `src/` or `api/` itself.

### 6.3 Build units across the sessions

The seven units in `build_sequence.md` are built in order. Because the schema may not merge until the server logic gate passes, any verify step that needs the live database is verified **twice**: against fakes first, then live. Nothing in the unit order changes.

| Unit | Verified against fakes (before the gate) | Verified live (after the schema merge) |
|---|---|---|
| 1. Provider abstraction interface | AC-1 | none |
| 2. Gmail OAuth layer with token persistence listener | AC-2, AC-3, AC-4 | AC-19 (Supabase tokens, refresh with no mismatch) |
| 3. Sync and read layer | AC-5, AC-6 | AC-20 (50 rows in Supabase match the model) |
| 4. Pub/Sub webhook receiver | AC-7 | AC-21 (real notification, correct delta by history ID) |
| 5. Send layer (send and mark-as-read) | AC-8, AC-9 | AC-22 (real send on behalf of an authenticated user) |
| 6. Vercel API function entry points | AC-10 | AC-23 (local preview on real wiring, plus Vercel preview) |
| 7. Integration tests | none | AC-24 (full suite on live Supabase, zero skipped) |

**Test scripts.** `npm test` runs the fake-backed suites and is the merge gate. `npm run test:integration` runs the live-Supabase suites. Unit 7's "full test suite" is both. The server logic session adds these scripts.

**Composition root.** The server logic session provides one module that wires the app's dependencies. Setting `VIBEMAIL_FAKES=1` selects the fake provider and in-memory stores, so the four core endpoints can run in a local preview without Google or a database (AC-10). Without it the module wires the real Gmail provider and the Supabase-backed stores. Production builds refuse to start with `VIBEMAIL_FAKES` set.

## 7. Out of scope for v0.4

- Attachments (sending, downloading, or storing bytes)
- Marking messages unread, toggling, or batch read
- JWT refresh, revocation and sign-out
- Label-filtered watches, and pull-based Pub/Sub subscriptions
- Provisioning the Pub/Sub topic and subscription from code (they are created by hand, 1.3)
- Google OAuth app verification and security assessment for restricted scopes
- Production monitoring, alerting and SLOs
- Idempotency keys for send
- Multiple Gmail accounts per user (one Google account per user)
- Trash, archive, label management and drafts
- Supabase Auth, Storage, Realtime
- The IMAP provider (`src/providers/imap`) and a cron route (`api/cron`, `src/cron`). The scaffold has these directories, but nothing here specifies them.
- **Known gap: watch renewal and catch-up sync.** Gmail stops pushing 7 days after a watch starts unless `users.watch` is called again, and it may drop notifications. With no renewal job, push sync silently stops about 7 days after sign-in; after that, rows are refreshed only when `GET /api/v1/messages` is called.
- **Known gap: Row Level Security.** Supabase exposes `public` tables through its Data API by default, so until RLS (or a non-exposed schema) is added, every table is reachable with the project's public anon key. The Google tokens are ciphertext (1.9), so they leak nothing usable without `ENCRYPTION_KEY`, but message content and user emails are readable. The service-role key the app uses bypasses RLS and is unaffected.

## 8. Decisions

Confirmed by the owner on 2026-11-11. Changing any of them needs the owner's say-so and a matching edit here and in `CLAUDE.md`.

1. **Webhook authentication.** A shared verification token in the push endpoint's query string (`GOOGLE_PUBSUB_VERIFICATION_TOKEN`). Accepted trade-off: the token appears in the subscription URL and may appear in request logs, and anyone who obtains it can forge notifications. A Pub/Sub-signed OIDC token was the alternative.
2. **How the JWT reaches the frontend.** A redirect to `${FRONTEND_URL}/auth/callback#token=<JWT>`, HS256, one-hour lifetime, no refresh endpoint. The frontend paths `/auth/callback` and `/login` are placeholders the frontend must match.
3. **Sign-in start is public.** `state` is a random nonce in a short-lived `HttpOnly` cookie.
4. **Reads versus "never poll".** `GET /api/v1/messages` reads Gmail live on each client request and upserts the result. That is an on-demand read, not polling for new messages. Serving the list from Supabase only was the alternative.
5. **CORS.** A single allowed origin, `FRONTEND_URL`; `OPTIONS` answered `204`.
6. **Encryption scheme.** App-level AES-256-GCM with a per-value IV and `ENCRYPTION_KEY` (1.9). Key rotation is not covered in v0.4.
7. **Test scripts.** `npm test` (fakes, the merge gate) and `npm run test:integration` (live), so the gate can pass before the schema merges.
8. **Ownership.** `tests/` and the root config, including the Vercel config with the `/webhook/gmail` rewrite, belong to the server logic session.
9. **Migration mechanism.** Plain SQL in `migrations/`, applied in filename order by the schema session (for example with `psql` against the direct connection). The Supabase CLI was not chosen.
10. **Branch parallelism.** The schema session may draft on its branch before the gate; only review and merge wait.

Still undecided and out of scope for v0.4: the IMAP provider and a cron route (section 7), watch renewal and catch-up sync, and Row Level Security (both known gaps in section 7).
