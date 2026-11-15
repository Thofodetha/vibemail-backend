# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

VibeMail is a data liberation sync engine. It extracts a user's Gmail data through OAuth2 into Supabase, exposes it through a REST API at `/api/v1`, and runs as Vercel serverless functions.

## Stack

Node 20, TypeScript in strict mode, `googleapis`, the Supabase JS client, Jest with supertest, deployed on Vercel.

## State of the repo

Server logic for build units 1 to 6 is built and unit-tested against fakes. Nothing has run against Google or a live Supabase yet. What exists: `src/types/provider.ts` (the provider interfaces); `src/providers/gmail/` (OAuth, the `tokens` listener, message parser, `GmailMailProvider`, watch, `completeSignIn`) and `src/providers/fake/` (the fake provider for `VIBEMAIL_FAKES=1`); `src/db/` (AES-256-GCM token encryption, in-memory and Supabase stores); `src/sync/` (initial sync, delta sync with a full resync on an expired cursor, the message list); `src/send/` (`sendMail`, `markRead`); `src/webhook/gmail.ts` (the receiver, which answers 200 only after the delta is stored); `src/middleware/` (error envelope, JWT, CORS, the OAuth state cookie and the sign-in routes' logic); `src/app/` (the composition root and the route wrapper); and `api/`, the six Vercel Functions. A message that was sent but could not be stored raises `SentNotPersistedError`, reported as `PERSISTENCE_FAILED` with `sent: true`, never as a retryable error. Not done: build unit 7 and the live criteria (AC-19 to AC-24), the schema merge, and any run of `npx vercel dev`. The Supabase stores are untested until the schema merges. The other real content is two planning documents and the toolchain config. Read these before writing code:

- `CONTRACT.md` — endpoint contracts with typed errors, the stored-message data model (each field mapped to its Gmail API source), acceptance criteria, and the build rules.
- `build_sequence.md` — seven build units that must be done in order; a unit is finished only when its one-line verify step passes. `CONTRACT.md` §6.3 maps each unit to acceptance criteria.

## Commands

- Typecheck: `npx tsc --noEmit` (TypeScript here is the `@typescript/typescript6` package aliased as `typescript`). It covers `src/`, `api/` and `tests/`.
- Tests: Jest 30 + ts-jest, configured in `jest.config.js` as two projects. `npm test` runs `tests/unit` (fakes only, no network or database; the merge gate). `npm run test:integration` runs `tests/integration` against live Supabase and exits 1 ("No tests found") until build unit 7 adds tests. A single file or test is `npx jest path/to/file.test.ts --selectProjects unit -t "test name"`. Put the path **before** `--selectProjects`: the flag takes every following argument as a project name, so a path after it is swallowed and the whole suite runs.
- Build: `npm run build` (`npx tsc`) emits to `dist/`, which is gitignored.
- API collection: `docs/vibemail-api.postman_collection.json` (Postman v2.1; import it, set `baseUrl`). One folder per endpoint, a happy path and one request per contract error code; errors a client cannot cause carry a saved example and skip their test. It was checked with Newman against the real handlers in fake mode (all 55 requests, 0 failures); keep it in step with CONTRACT.md when routes or error codes change.
- Local preview: `vercel` is a devDependency, so `npx vercel dev`. Set `VIBEMAIL_FAKES=1` (plus `JWT_SECRET` and `FRONTEND_URL`) to run every route on the fake provider and in-memory stores, with no Google or database: the fake consent URL redirects straight back to the callback. Production refuses to start with it set. The first `vercel dev` run needs a linked Vercel project, which has not been set up here. `tests/unit/routes.test.ts` drives the same handlers in-process.

## Layout

Directories and what they hold:

- `api/` — Vercel Function entry points, in the Web-standard `export default { fetch(request) }` form, each a few lines over `defineRoute` (`src/app/route.ts`): `api/v1/auth/google/index.ts`, `api/v1/auth/google/callback.ts`, `api/v1/messages/index.ts`, `api/v1/messages/send.ts`, `api/v1/messages/[id]/read.ts`, `api/webhook/gmail.ts`. The webhook is reached at `/webhook/gmail` through the rewrite in `vercel.json`. Keep these thin.
- `src/providers/gmail` and `src/providers/fake` — mail providers behind one abstraction (`src/types/provider.ts`); `src/providers/imap` is not built.
- `src/sync`, `src/send`, `src/webhook`, `src/db`, `src/middleware`, `src/app`, `src/types` — logic the entry points call. `src/app` holds the composition root (`container.ts`, which wires real or fake dependencies) and the route wrapper; `src/cron` is not built.
- `tests/unit`, `tests/integration` — integration tests run against a live Supabase instance with zero skipped tests (build unit 7).
- `migrations/` and `types/` at the top level do not exist yet. They belong to the schema session (below). `src/types/` belongs to the server logic session.

## Two-session architecture

Work is split between two sessions with disjoint ownership.

| | Server logic session | Schema session |
|---|---|---|
| Branch | `main` | `schema` |
| Owns | `src/` and `api/` | `migrations/` and `types/` |

A session does not edit the other's directories. In particular the schema session never writes to `src/db/`; database access code is server logic.

### Sequencing rule

The schema session cannot be merged until the server logic tests pass: `npm test` must exit 0. Today it exits 1 because no test script exists, so jest has to be set up and passing first. `CONTRACT.md` §6 is stricter than this rule: it also bars *reviewing* the schema before that gate.

Verify steps that need the live database run twice: against fakes first (server logic session), then live once the schema is merged (`CONTRACT.md` §6.3).

## Never do

- Never use `any` as a TypeScript type.
- Never poll the Gmail API for new messages. Use Pub/Sub push notifications to the webhook.
- Never store OAuth tokens in plaintext. Encrypt them before they reach Supabase (`ENCRYPTION_KEY` in `.env.example`).
- Never make a Gmail API call without the `googleapis` OAuth2 client, which handles token refresh automatically. Attach a listener to its `tokens` event so refreshed tokens are persisted (build unit 2).
- Never write to `src/db/` from the schema session.
- Never merge the schema session before `npm test` exits 0.
- Never hardcode credentials. Every secret comes from the environment; `.env.example` lists the variables.

## Coding conventions

- Every error response uses the error envelope in `CONTRACT.md` §1.4 (`{ error: { code, message, details?, retryAfterSeconds? } }`) with the typed codes from the contract. The one exception is the OAuth callback, a browser redirect that reports failures as `?error=<CODE>`.
- Every list endpoint paginates with a cursor (the contract's `pageToken` / `nextPageToken`), never with offsets.
- All client endpoints sit under `/api/v1`.
- Every endpoint requires a JWT Bearer token except the OAuth callback.
- The Pub/Sub webhook is at `/webhook/gmail`, **not** under `/api/v1`. It is not a user endpoint: Pub/Sub cannot send a user's JWT, so it is verified with `GOOGLE_PUBSUB_VERIFICATION_TOKEN` passed as a `?token=` query parameter (`CONTRACT.md` §3.5). Vercel serves files under `api/` at `/api/...`, so reaching `/webhook/gmail` needs a rewrite in the Vercel config to the function in `api/webhook/` (there is no Vercel config yet).

## Data and sync rules (from CONTRACT.md)

- Gmail is the source of truth. List, send and mark-read call Gmail, then upsert into the message table keyed `(accountId, gmailId)`. `isRead` is derived from the absence of the `UNREAD` label and set in one place so it can never disagree with `labelIds`.
- Delta sync resumes from the **stored** history cursor, never from the `historyId` in a Pub/Sub notification. Renewing a Gmail watch returns a current `historyId`; it must not overwrite the stored cursor, or every change since the last sync is skipped.
- Application code reaches Gmail, tokens, messages and sync state only through interfaces (`ProviderAuth`, `MailProvider`, `AccountStore`, `TokenStore`, `MessageStore`, `SyncStateStore`, `CONTRACT.md` §5.2). This is what lets the server logic session run entirely on fakes. `ProviderAuth` and `MailProvider` live in `src/types/provider.ts` and are provider-agnostic: no vendor names or types, and opaque ids and cursors.
- Send is not idempotent; a retried request can send twice.

## Decisions and open items

`CONTRACT.md` v0.8 matches this file, and its section 8 records ten decisions the owner confirmed on 2026-11-11 (webhook token auth, JWT in a URL fragment, list reads Gmail live, single-origin CORS, app-level AES-256-GCM, the two test scripts, ownership of `tests/` and root config, plain-SQL migrations, parallel schema drafting). Do not change them without the owner's say-so.

Still undecided: `src/providers/imap` and `api/cron` exist in the scaffold but nothing specifies them; watch renewal and Row Level Security are known gaps (`CONTRACT.md` §7). Ask before building on any of these.

## Gotchas

- `tsconfig.json` must keep `"rootDir": "."`. With `outDir` set and no `rootDir`, TypeScript 6 fails the emitting build with TS5011, and `tsc --noEmit` does not show it. A `rootDir` of `./src` fails with TS6059 once any file exists under `api/` or `tests/`.
- TypeScript 6 includes no `@types` packages by default, so `tsconfig.json` lists `"types": ["node", "jest"]`. Add any other global-providing `@types` package there, or its globals will not typecheck.
- `.env` is gitignored; `.env.example` is tracked.
