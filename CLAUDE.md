# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

VibeMail is a data liberation sync engine. It extracts a user's Gmail data through OAuth2 into Supabase, exposes it through a REST API at `/api/v1`, and runs as Vercel serverless functions.

## Stack

Node 20, TypeScript in strict mode, `googleapis`, the Supabase JS client, Jest with supertest, deployed on Vercel.

## State of the repo

Pre-implementation. Every directory under `api/`, `src/` and `tests/` is empty; the only real content is two planning documents and the toolchain config. Read these before writing code:

- `CONTRACT.md` — endpoint contracts with typed errors, the stored-message data model (each field mapped to its Gmail API source), acceptance criteria, and the build rules.
- `build_sequence.md` — seven build units that must be done in order; a unit is finished only when its one-line verify step passes. `CONTRACT.md` §6.3 maps each unit to acceptance criteria.

## Commands

There are no working scripts yet: `npm test` is npm's placeholder and exits 1. Installed tooling, none of it configured:

- Typecheck: `npx tsc --noEmit` (TypeScript here is the `@typescript/typescript6` package aliased as `typescript`).
- Tests: Jest 30 + ts-jest + supertest are installed but there is no jest config, so ts-jest has to be set up before any test runs. After that, a single test is `npx jest path/to/file.test.ts -t "test name"`. The contract (§6.3) defines two scripts that do not exist yet: `npm test` (fakes only, no network; the merge gate) and `npm run test:integration` (live Supabase).
- Local preview (build unit 6): `vercel` is a devDependency, so `npx vercel dev`.

## Layout

Directory names show the intended split; nothing is implemented in them.

- `api/` — Vercel Function entry points: `api/v1/auth/google`, `api/v1/messages`, `api/webhook`, `api/cron`. Keep these thin.
- `src/providers/gmail` and `src/providers/imap` — mail providers behind one abstraction (build unit 1).
- `src/sync`, `src/send`, `src/webhook`, `src/cron`, `src/db`, `src/middleware`, `src/types` — logic the entry points call.
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
- Application code reaches Gmail, tokens, messages and sync state only through interfaces (`MailProvider`, `AccountStore`, `TokenStore`, `MessageStore`, `SyncStateStore`, `CONTRACT.md` §5.2). This is what lets the server logic session run entirely on fakes.
- Send is not idempotent; a retried request can send twice.

## Decisions and open items

`CONTRACT.md` v0.4 matches this file, and its section 8 records ten decisions the owner confirmed on 2026-11-11 (webhook token auth, JWT in a URL fragment, list reads Gmail live, single-origin CORS, app-level AES-256-GCM, the two test scripts, ownership of `tests/` and root config, plain-SQL migrations, parallel schema drafting). Do not change them without the owner's say-so.

Still undecided: `src/providers/imap` and `api/cron` exist in the scaffold but nothing specifies them; watch renewal and Row Level Security are known gaps (`CONTRACT.md` §7). Ask before building on any of these.

## Gotchas

- `tsconfig.json` sets `rootDir: ./src` but `include` also lists `api/**/*`. `tsc` fails with TS6059 as soon as any file exists under `api/` (reproduced on a scratch copy). Fix the config before adding the first entry point.
- `.gitignore` ends with a literal `EOF` line, which ignores a file named `EOF`. `.env` is ignored.
