# VibeMail Engine Contract

Status: draft for review. Version 0.3, 2026-11-04.

Changes from 0.2: removed the daily cron route (watch renewal and catch-up sync) and the Row Level Security requirement. Both are recorded in section 7 as known gaps.

Changes from 0.1: database is Supabase Postgres (was Neon); Gmail push notifications (Pub/Sub), an initial sync of 50 messages and a sync-state table are now in scope; the Gmail seam is a provider abstraction (`MailProvider`) plus token, message and sync-state stores; acceptance criteria and the two-session rule are reorganised around the seven units in `build_sequence.md`.

This document is the single source of truth for what the VibeMail engine must do, how its endpoints behave, what a stored message looks like, and the order in which the two build sessions work. If code and this document disagree, one of them is wrong and the disagreement is resolved here first. `build_sequence.md` defines the order of the seven build units and what is verified at each; section 6 maps those units onto the two sessions.

## 1. Overview and conventions

### 1.1 Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router route handlers (Node.js runtime), TypeScript, deployed as Vercel Functions |
| Auth | Better Auth, Google provider; Google sign-in **is** the login |
| Database | Supabase Postgres, accessed through Prisma v7 (`adapter-pg`, custom output path). Supabase is used **only as Postgres**: the app does not use Supabase Auth, Storage or the Data API. |
| Validation | Zod |
| Tests | Vitest |
| Upstream | Gmail API v1 (`users.messages.*`, `users.history.list`, `users.watch`) |
| Push | Google Cloud Pub/Sub (push subscription to the webhook in 3.5) |

Supabase connections: runtime queries use `DATABASE_URL` (the transaction pooler); migrations use `DIRECT_URL` (a direct connection).

### 1.2 How the engine works

- The user signs in with Google. Better Auth creates the user, the session and the stored Google tokens (in its own `account` table) in one step.
- Every JSON endpoint except the webhook route authenticates with the Better Auth session cookie.
- **Token persistence.** Gmail access tokens are refreshed automatically when expired, with one refresh and one retry per request. Every token change (a refreshed access token and its expiry, or a rotated refresh token) is written back through the `TokenStore` before the next Gmail call, so the stored tokens always equal the tokens in use.
- **Reads.** `GET /api/messages` reads Gmail live, then upserts the results into the `Message` table. Gmail is the source of truth.
- **Initial sync.** After a user's first successful sign-in, the engine starts a Gmail watch, stores up to the 50 most recent INBOX messages, and records the sync cursor (3.6).
- **Delta sync.** Gmail pushes a notification to Pub/Sub on mailbox changes; Pub/Sub calls the webhook (3.5), which fetches only what changed since the stored cursor via `history.list` and upserts or deletes rows.

### 1.3 OAuth scopes and Google Cloud setup

Scopes: `openid email profile https://www.googleapis.com/auth/gmail.modify`

`gmail.modify` is accepted by `messages.list`, `messages.get`, `messages.send`, `messages.modify`, `history.list` and `users.watch`, so it is the only Gmail scope requested. It is a Google *restricted* scope. Full Google OAuth verification is out of scope (section 7); the live smoke test runs on a Google Cloud project in "Testing" status with the tester's account added as a test user. In that status Google expires refresh tokens after 7 days.

Pub/Sub prerequisites (manual, one-time, outside the engine):
- A Pub/Sub topic in the **same Google Cloud project** as the OAuth client, named in `PUBSUB_TOPIC` (`projects/<project-id>/topics/<name>`).
- `gmail-api-push@system.gserviceaccount.com` granted publish rights on that topic.
- A push subscription on that topic targeting `POST /api/webhooks/gmail`, configured with an OIDC token (service account in `PUBSUB_PUSH_SERVICE_ACCOUNT`, audience in `PUBSUB_AUDIENCE`).

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

`Content-Type: application/json`. The OAuth callback is the exception (3.1): it is a browser redirect and carries its error as a query parameter.

### 1.5 Shared errors

Every session-authenticated JSON endpoint (3.2, 3.3, 3.4) can return these in addition to its own. The webhook route uses the same Gmail-derived codes where noted.

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No session cookie, or the session is invalid or expired. |
| `GMAIL_REAUTH_REQUIRED` | 401 | Gmail returned 401 and the token refresh failed with `invalid_grant` (refresh token revoked or expired), or no Google account is linked to the session. Client must re-run Google sign-in. |
| `GMAIL_SCOPE_INSUFFICIENT` | 403 | Gmail returned 403 `insufficientPermissions`. The granted scopes no longer include `gmail.modify`. |
| `VALIDATION_FAILED` | 400 | Request failed Zod validation. `details.fields` maps field path to message. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail returned 429, or 403 with reason `rateLimitExceeded` / `userRateLimitExceeded`. `retryAfterSeconds` is set when Gmail supplied `Retry-After`. |
| `GMAIL_UPSTREAM_ERROR` | 502 | Gmail returned 5xx, the network failed, or Gmail returned an unmapped 4xx. `details.gmailStatus` holds the upstream status when there was one. |
| `INTERNAL` | 500 | Any other unexpected server error. |

### 1.6 IDs

- `gmailId` is Gmail's message ID. It is the only message identifier clients use, and the `{gmailId}` path parameter. It must match `^[A-Za-z0-9_-]{1,64}$`, else `VALIDATION_FAILED`.
- `id` (a cuid) is the internal primary key. It appears in responses but is never accepted as input.

### 1.7 The `StoredMessage` response type

Every message returned by the API has this shape. It is the row in 4.1 with `from*` columns folded into `from`, and `internalDate` serialised as ISO 8601.

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

## 2. Acceptance criteria

The project is complete when **every** box below can be ticked with evidence (a passing test, a command output, or a log or screenshot from the smoke test). "No skipped tests" means zero `skip`, `todo` or `only` in the suite.

Criteria are grouped by the session that proves them (section 6). The unit numbers refer to `build_sequence.md`.

### 2.1 Session 1: server logic, proven against fakes

- [ ] **AC-1** (unit 1) The `MailProvider`, `TokenStore`, `MessageStore` and `SyncStateStore` interfaces in 5.2 compile with `tsc --noEmit` and define every method listed there. Both the Gmail implementation and the fake implement `MailProvider`.
- [ ] **AC-2** (unit 2) The OAuth callback matches 3.1: success sets a session and redirects to `/inbox`; every failure redirects to `/login?error=<CODE>` using only the codes in that section. Tested against mocked Google token and userinfo endpoints.
- [ ] **AC-3** (unit 2) Token persistence: after an expired access token is refreshed, the `TokenStore` holds the new access token and expiry before the retried Gmail call is made, and a rotated refresh token is persisted too. A refresh failing with `invalid_grant` yields `GMAIL_REAUTH_REQUIRED`. A test asserts stored tokens equal the tokens used on the next call.
- [ ] **AC-4** (unit 3) Initial sync (3.6) stores exactly the 50 most recent INBOX messages when the mailbox has at least 50, starts the watch **before** listing, and records the cursor. Every stored message deep-equals the section 4 model for a set of recorded Gmail fixtures (plain, multipart/alternative, attachment, reply, missing-header).
- [ ] **AC-5** (unit 3) `GET /api/messages` matches 3.2 for validation, response shape, pagination and every listed error.
- [ ] **AC-6** (unit 4) The webhook matches 3.5: given a notification, it calls `history.list` from the **stored** cursor (not the notification's `historyId`), fetches exactly the changed messages, upserts or deletes the right rows, and advances the cursor to the `historyId` returned by Gmail. A `history.list` 404 triggers a full resync.
- [ ] **AC-7** (unit 5) `POST /api/messages/send` matches 3.3 for validation, MIME construction, reply threading, response shape and every listed error.
- [ ] **AC-8** (unit 5) `POST /api/messages/{gmailId}/read` matches 3.4, including idempotency, and every listed error.
- [ ] **AC-9** (unit 6) All four core endpoints (3.1 to 3.4) respond correctly in a local preview (`next dev`) wired to fakes (6.3).
- [ ] **AC-10** Every error code in sections 1.5 and 3 has at least one automated test that triggers it and asserts the HTTP status (or redirect), the `code`, and the envelope shape.
- [ ] **AC-11** Services and route handlers reach Gmail only through `MailProvider`, tokens only through `TokenStore`, messages only through `MessageStore`, and sync state only through `SyncStateStore`. No route handler imports `googleapis`, `fetch`es Gmail, or imports Prisma.
- [ ] **AC-12** No response body, log line or error `message` ever contains an access token, refresh token, authorization code, Pub/Sub JWT or full message body in an error path.
- [ ] **AC-13** **Session 1 gate:** `pnpm typecheck`, `pnpm lint` and `pnpm test` exit 0 with no skipped tests, using only fakes and in-memory stores.

### 2.2 Session 2: schema, database and live verification

- [ ] **AC-14** The `prisma/schema.prisma` models match section 4 field for field (name, type, nullability, constraints, indexes), plus the Better Auth tables for the installed Better Auth version.
- [ ] **AC-15** The migration is applied to the Supabase database through `DIRECT_URL`.
- [ ] **AC-16** The Prisma-backed `TokenStore`, `MessageStore` and `SyncStateStore` pass the same store test suites as the in-memory ones.
- [ ] **AC-17** (unit 2, live) The OAuth flow completes against Google, tokens are stored in the Supabase `account` table, and a forced refresh works with no token mismatch (stored tokens equal the tokens used on the following Gmail call).
- [ ] **AC-18** (unit 3, live) Initial sync against a real mailbox stores 50 rows in Supabase, and each row deep-equals the section 4 model.
- [ ] **AC-19** (unit 4, live) A real Pub/Sub notification, triggered by a real mailbox change, reaches the deployed webhook, which fetches the correct delta by history ID and updates Supabase.
- [ ] **AC-20** (unit 5, live) A message sends successfully through the Gmail API on behalf of an authenticated user, and mark-as-read updates both Gmail and the row.
- [ ] **AC-21** (unit 6) All four core endpoints respond correctly in a local preview wired to the real stores and Gmail provider, and on a Vercel preview deployment. The webhook route is deployed with its auth configured.
- [ ] **AC-22** (unit 7) The full test suite passes against a live Supabase instance with no skipped tests.
- [ ] **AC-23** One live smoke run on a Google test account: sign in, initial sync runs, list the inbox, send a message to the same account, see it in the list, mark it read, and observe the webhook delta update the row, ending with the row at `isRead = true` and no `UNREAD` in `labelIds`.
- [ ] **AC-24** `.env.example` and `.env.local` exist and list every variable the project reads: `DATABASE_URL`, `DIRECT_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBSUB_TOPIC`, `PUBSUB_AUDIENCE`, `PUBSUB_PUSH_SERVICE_ACCOUNT`. `.env.local` is in `.gitignore`.

## 3. Endpoint contracts

All endpoints run on the Node.js runtime and are never cached (`Cache-Control: no-store`). The four **core endpoints** are 3.1 to 3.4; 3.5 is a machine-to-machine route; 3.6 is an internal routine, not an HTTP endpoint.

### 3.1 OAuth callback

`GET /api/auth/callback/google`

Owned by Better Auth. The contract below fixes the *observable* behaviour.

**Sign-in request requirements** (what the app asks Google for): the scopes in 1.3, `access_type=offline` and `prompt=consent`, so Google always returns a refresh token.

**Request (query parameters, set by Google)**

| Param | Type | Notes |
|---|---|---|
| `code` | string | Authorization code. Present on success. |
| `state` | string | Must match the value Better Auth issued for this browser. |
| `scope` | string | Space-separated scopes the user actually granted. Must include `https://www.googleapis.com/auth/gmail.modify`. |
| `error` | string | Present instead of `code` when the user denied access or Google failed. |

**Success**

- `302 Found`, `Location: /inbox`, with `Set-Cookie` for the Better Auth session.
- Side effects: user and account rows exist; the account holds the access token, refresh token, expiry and granted scopes (persisted through `TokenStore`). If the account has no completed initial sync, one is scheduled to run **after** the redirect is sent (3.6). A failing initial sync never changes the redirect.

**Failure.** Always `302 Found` to `/login?error=<CODE>`. No session cookie is set and no usable session may exist afterwards.

| Code | Trigger |
|---|---|
| `OAUTH_ACCESS_DENIED` | Google sent `error=access_denied` (user cancelled or denied consent). |
| `OAUTH_STATE_MISMATCH` | `state` is missing, unknown, expired, or does not match the browser's state cookie. |
| `OAUTH_CODE_EXCHANGE_FAILED` | `code` is missing, or Google's token endpoint rejected it (`invalid_grant`, `invalid_client`, network failure). |
| `OAUTH_MISSING_SCOPES` | The user unchecked `gmail.modify` on Google's granular consent screen, so `scope` lacks it. |
| `OAUTH_NO_REFRESH_TOKEN` | Google's token response contained no `refresh_token`. |
| `OAUTH_INTERNAL` | Any other failure, including any Google `error` value other than `access_denied`, and database errors. |

**Implementation note.** Better Auth redirects errors with its own native codes. Session 1 maps those onto the table above (via a Better Auth hook or a thin wrapper) and records the mapping in a test. The native-to-contract mapping must be checked against the installed Better Auth version.

### 3.2 Message list

`GET /api/messages`

**Request (query parameters)**

| Param | Type | Default | Rules |
|---|---|---|---|
| `pageToken` | string | none | Opaque. Pass back exactly the `nextPageToken` from the previous response. |
| `maxResults` | integer | `25` | 1 to 100 inclusive. Out of range is `VALIDATION_FAILED`, never clamped. |
| `labelIds` | string | `INBOX` | Comma-separated Gmail label IDs (system IDs like `INBOX`, `SENT`, `UNREAD`, or user label IDs). 1 to 10 labels. Present but empty is `VALIDATION_FAILED`. Multiple labels are AND-ed: a message must carry all of them. |
| `q` | string | none | Gmail search syntax. Max 500 characters. Combined with `labelIds` (both apply). |

**Success: `200 OK`**

```ts
type ListMessagesResponse = {
  messages: StoredMessage[];        // Gmail order (newest first); at most maxResults
  nextPageToken: string | null;     // Gmail's token passed through; null on the last page
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

`POST /api/messages/send`

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

`send` is **not idempotent**. A client that retries after a timeout may send the message twice. There is no idempotency key in v0.3.

**Errors** (plus 1.5)

| Code | HTTP | Trigger |
|---|---|---|
| `INVALID_RECIPIENT` | 400 | The request passed validation but Gmail rejected a recipient header (`400 invalidArgument`). `details.field` names `to`, `cc` or `bcc` when determinable. |
| `BODY_TOO_LARGE` | 413 | Request body exceeds 1 MB, or Gmail rejected the message for size. |
| `THREAD_NOT_FOUND` | 404 | Gmail returned 404 for the given `threadId`. |

### 3.4 Mark as read

`POST /api/messages/{gmailId}/read`

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

`POST /api/webhooks/gmail`

Called by a Pub/Sub push subscription, not by browsers. Not a session route.

**Authentication.** Pub/Sub sends `Authorization: Bearer <OIDC JWT>`. The receiver verifies the signature against Google's public certificates, that `aud` equals `PUBSUB_AUDIENCE`, and that the token's `email` equals `PUBSUB_PUSH_SERVICE_ACCOUNT` with `email_verified: true`.

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

1. Verify the JWT. Decode `message.data` into `{ emailAddress, historyId }`.
2. Resolve the account: the Better Auth user whose email equals `emailAddress` (case-insensitive) and who has a linked Google account. None found: acknowledge and ignore.
3. Load the account's `GmailSyncState`. None found: acknowledge and ignore (no cursor to work from).
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
| `401` | error envelope, `WEBHOOK_UNAUTHORIZED` | JWT missing, invalid, wrong audience or wrong service account. |
| `400` | error envelope, `WEBHOOK_PAYLOAD_INVALID` | Body is not a valid push envelope, or `message.data` does not decode to `{ emailAddress, historyId }`. |
| `429` / `502` / `500` | error envelope, `GMAIL_RATE_LIMITED` / `GMAIL_UPSTREAM_ERROR` / `INTERNAL` | Transient failure. Pub/Sub retries. A partial failure must not advance the cursor. |

Processing is idempotent: re-delivered or duplicated notifications upsert the same rows and leave the cursor correct. Gmail drops notifications beyond one per second per mailbox and may drop others. Because each delta runs from the stored cursor, a dropped notification is recovered by the next notification for that mailbox; with no catch-up job (section 7), rows may be stale until then.

### 3.6 Initial sync (internal routine)

Not an HTTP endpoint. Runs for an account with no completed initial sync: scheduled after a successful callback (3.1) whenever the account has none.

1. Call `users.watch` with `topicName = PUBSUB_TOPIC` and no label filter. Save `GmailSyncState` with `historyId` = the response `historyId`, `watchExpiration` from the response `expiration`, and `initialSyncCompletedAt = null`.
2. List the 50 most recent INBOX messages (`labelIds=INBOX`, `maxResults=50`).
3. Fetch each with `format=full` (concurrency 10) and upsert them atomically.
4. Set `initialSyncCompletedAt` to now.

The watch is started first so no change can fall into a gap: anything that happens during steps 2 to 4 appears in the history after the saved cursor and is picked up by the next delta sync. The routine is safe to re-run. If it fails part-way it leaves `initialSyncCompletedAt = null` and runs again at the account's next sign-in.

## 4. Data model

### 4.1 Stored message (`Message`)

One row per Gmail message per linked Google account. Source column: the field path in the Gmail `users.messages.get` response (`format=full`), or **app** when the engine supplies the value.

| Field | Type (Prisma v7) | Null | Source |
|---|---|---|---|
| `id` | `String` (`@id @default(cuid())`) | no | app |
| `userId` | `String` (FK to Better Auth `user.id`) | no | app: signed-in session |
| `accountId` | `String` (FK to Better Auth `account.id`) | no | app: the user's Google account row |
| `gmailId` | `String` | no | `id` |
| `threadId` | `String` | no | `threadId` |
| `historyId` | `String` | no | `historyId` (a uint64, kept as a string) |
| `internalDate` | `DateTime` | no | `internalDate` (epoch milliseconds as a string, converted to UTC) |
| `labelIds` | `String[]` | no (default `[]`) | `labelIds` |
| `isRead` | `Boolean` | no | app-derived: `!labelIds.includes("UNREAD")`. Always set at write time so it matches `labelIds`. |
| `snippet` | `String` | no (default `""`) | `snippet` |
| `sizeEstimate` | `Int` | no | `sizeEstimate` |
| `subject` | `String` | yes | `payload.headers[name="Subject"].value` |
| `fromName` | `String` | yes | `payload.headers[name="From"]`, display-name part |
| `fromEmail` | `String` | yes | `payload.headers[name="From"]`, address part |
| `to` | `Json` (`EmailAddress[]`, default `[]`) | no | `payload.headers[name="To"]`, parsed |
| `cc` | `Json` (`EmailAddress[]`, default `[]`) | no | `payload.headers[name="Cc"]`, parsed |
| `bcc` | `Json` (`EmailAddress[]`, default `[]`) | no | `payload.headers[name="Bcc"]`, parsed. Gmail only returns this on messages the account sent. |
| `rfc822MessageId` | `String` | yes | `payload.headers[name="Message-ID"].value` |
| `inReplyTo` | `String` | yes | `payload.headers[name="In-Reply-To"].value` |
| `references` | `String[]` | no (default `[]`) | `payload.headers[name="References"].value`, split on whitespace |
| `bodyText` | `String` | yes | first non-attachment part with `mimeType = text/plain`, depth-first through `payload.parts`; a single-part message uses `payload` itself. `body.data` is base64url-decoded using the part's charset (default UTF-8). |
| `bodyHtml` | `String` | yes | same walk, `mimeType = text/html` |
| `attachments` | `Json` (`AttachmentMeta[]`, default `[]`) | no | every part with non-empty `filename`: `{ partId: parts[].partId, filename: parts[].filename, mimeType: parts[].mimeType, size: parts[].body.size, attachmentId: parts[].body.attachmentId }`. Bytes are never stored. |
| `syncedAt` | `DateTime` | no | app: time of the last upsert from Gmail |
| `createdAt` | `DateTime` (`@default(now())`) | no | app |
| `updatedAt` | `DateTime` (`@updatedAt`) | no | app |

**Parsing rules**

- Header names are matched case-insensitively. A missing header gives `null` (or `[]` for list-valued fields), never an empty string.
- `from`, `to`, `cc`, `bcc` are parsed as RFC 5322 address lists. Display names are unquoted and RFC 2047-decoded.
- `isRead` and `labelIds` must never disagree. The parser derives one from the other in a single place.

**Constraints and indexes**

- `@@unique([accountId, gmailId])`. This is the upsert key.
- `@@index([userId, internalDate(sort: Desc)])`
- `@@index([userId, threadId])`
- Both foreign keys use `onDelete: Cascade`.

Rows are deleted only by the delta sync, when Gmail reports a message as permanently deleted (3.5).

### 4.2 Sync state (`GmailSyncState`)

One row per linked Google account. It holds the cursor the delta sync resumes from and the watch lifetime.

| Field | Type (Prisma v7) | Null | Source |
|---|---|---|---|
| `accountId` | `String` (`@id`, FK to Better Auth `account.id`, `onDelete: Cascade`) | no | app |
| `userId` | `String` (FK to Better Auth `user.id`, `onDelete: Cascade`) | no | app |
| `historyId` | `String` | no | the sync cursor. Set from the `users.watch` response `historyId` at initial sync, then from the `users.history.list` response `historyId` after each delta sync. |
| `watchExpiration` | `DateTime` | no | `users.watch` response `expiration` (epoch milliseconds as a string, converted to UTC) |
| `initialSyncCompletedAt` | `DateTime` | yes | app: set when 3.6 finishes; null until then |
| `lastDeltaAt` | `DateTime` | yes | app: time of the last successful delta sync |
| `createdAt` | `DateTime` (`@default(now())`) | no | app |
| `updatedAt` | `DateTime` (`@updatedAt`) | no | app |

### 4.3 Conventions for both models

**Prisma v7 rules.** Use `adapter-pg` and a custom generator output path. No v6 patterns.

**Better Auth tables.** The `user`, `session`, `account` and `verification` tables that Better Auth needs are part of the schema Session 2 reviews and merges. They are generated by the Better Auth CLI for the installed version. This contract does not redefine them. The `account` table is where Google tokens live.

## 5. Interfaces both sessions code against

These interfaces are the seam between the sessions. Session 1 implements the Gmail provider, the fakes and the in-memory stores; Session 2 implements the Prisma-backed stores.

### 5.1 Domain types

Session 1 defines its own plain TypeScript types for messages (matching 1.7 and 4.1) and sync state (4.2). It must not import types generated by Prisma.

### 5.2 Interfaces

```ts
// The provider abstraction. Bound to one account; refreshes tokens internally (AC-3).
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

interface TokenStore {
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

`MailProvider` implementations throw typed errors from the catalog in 1.5 and section 3 (for example `GmailReauthRequiredError`, `GmailRateLimitedError`). Route handlers translate them to the envelope in one shared function.

## 6. Two-session build and sequencing rule

### 6.1 Roles

| | Session 1: Server logic | Session 2: Schema and live verification |
|---|---|---|
| Builds | Interfaces (5.2), the Gmail `MailProvider`, token persistence listener, message parser, MIME builder, initial sync, delta sync, route handlers (3.1 to 3.5), Zod schemas, error mapping, Better Auth configuration, fakes, in-memory stores, composition root (6.3) | `schema.prisma` (the 4.1 and 4.2 models plus Better Auth tables), the migration, the Prisma-backed stores, env wiring, the Supabase migration, the Pub/Sub topic and subscription, the live smoke test, the Vercel preview |
| Tests | Vitest with a fake `MailProvider`, recorded Gmail fixtures, mocked Google token endpoints and in-memory stores. Better Auth runs on its in-memory adapter in tests. No database is needed. | The shared store test suites against the Prisma stores, then the live-Supabase suite and the live smoke test |
| Must not touch | `schema.prisma`, migrations, `prisma/` | Route handlers, services and error mapping, except the one place in the composition root that constructs the real stores |

### 6.2 The rule

> **Server logic ships and its tests pass before the schema is reviewed or merged.**

Concretely:

1. **Pre-condition.** The project folder is a git repository with a mainline branch. (It is not one today.)
2. **Session 1 runs alone.** No `schema.prisma`, migration or Prisma client is created, edited, reviewed or merged while Session 1 is open.
3. **Session 1 gate (AC-13).** `pnpm typecheck`, `pnpm lint` and `pnpm test` exit 0 with no skipped tests, AC-1 to AC-12 are met, and Session 1's work is merged to the mainline. "Shipped" means merged, not just committed.
4. **Session 2 starts only after the gate.** Its first task is to review the schema draft against section 4 and the store interfaces in section 5, then merge it.
5. **Session 2 done (AC-14 to AC-24).**
6. **Back-pressure.** If Session 2 finds the contract or an interface wrong, it stops, records the change in this document, and returns to Session 1. It does not patch the server logic itself.

### 6.3 Build units across the sessions

The seven units in `build_sequence.md` are built in order. Because the schema may not exist until the Session 1 gate passes, any verify step that needs the live database is verified **twice**: against fakes in Session 1, then live in Session 2. Nothing in the unit order changes.

| Unit | Session 1 verify (fakes) | Session 2 verify (live) |
|---|---|---|
| 1. Provider abstraction interface | AC-1 | none |
| 2. Gmail OAuth layer with token persistence listener | AC-2, AC-3 | AC-17 (Supabase tokens, refresh with no mismatch) |
| 3. Sync and read layer | AC-4, AC-5 | AC-18 (50 rows in Supabase match the model) |
| 4. Pub/Sub webhook receiver | AC-6 | AC-19 (real notification, correct delta by history ID) |
| 5. Send layer (send and mark-as-read) | AC-7, AC-8 | AC-20 (real send on behalf of an authenticated user) |
| 6. Vercel API function entry points | AC-9 | AC-21 (local preview on real wiring, plus Vercel preview) |
| 7. Integration tests | none | AC-22 (full suite on live Supabase, zero skipped) |

**Composition root.** Session 1 provides one module that wires the app's dependencies. Setting `VIBEMAIL_FAKES=1` selects the fake provider, in-memory stores and Better Auth's in-memory adapter, so the four core endpoints can run in a local preview without Google or a database (AC-9). Session 2 adds the Prisma stores and the real wiring behind the same module. Production builds refuse to start with `VIBEMAIL_FAKES` set.

## 7. Out of scope for v0.3

- Attachments (sending, downloading, or storing bytes)
- Marking messages unread, toggling, or batch read
- Label-filtered watches, and pull-based Pub/Sub subscriptions
- Provisioning the Pub/Sub topic and subscription from code (they are created by hand, 1.3)
- Google OAuth app verification and security assessment for restricted scopes
- Production monitoring, alerting and SLOs
- Idempotency keys for send
- Multiple Gmail accounts per user (one Google account per user)
- Trash, archive, label management and drafts
- Supabase Auth, Storage, Realtime and the Data API
- **Known gap: watch renewal and catch-up sync.** Gmail stops pushing 7 days after a watch starts unless `users.watch` is called again, and it may drop notifications. With no renewal job, push sync silently stops about 7 days after sign-in; after that, rows are refreshed only when `GET /api/messages` is called.
- **Known gap: Row Level Security.** Supabase exposes `public` tables through its Data API by default, so until RLS (or a non-exposed schema) is added, every table, including the `account` table that holds Google tokens, is reachable with the project's public anon key.
