
# VibeMail Engine

VibeMail is a **data-liberation and synchronization layer** for Gmail. It pulls your email data out of Gmail through OAuth2, reshapes it into a clean data model, and stores it in its own database — then exposes that data through a simple REST API that any app could build on top of.

Gmail is the teaching vehicle here. The reusable pattern this project demonstrates is **Extract → Structure → Embed**: pull data out of a third-party API, normalize it into your own model, and store it yourself. The same pattern applies beyond Gmail (Slack, Calendar, Notion, etc.).

This is a learning project built as part of the Zero To Mastery Claude Code Bootcamp (Module 4: Worktree Architecture & Parallel Sessions).

## What it does

- Authenticates with Gmail via OAuth2 and persists encrypted tokens
- Syncs the 50 most recent messages on first connection
- Receives new mail in real time via Google Pub/Sub push notifications (no polling)
- Sends mail and updates read/unread state through Gmail, two-way synced
- Exposes everything through a versioned REST API at `/api/v1`
- Returns typed, consistent error responses

## Tech stack

- Node 20, TypeScript (strict mode)
- `googleapis` (Gmail API + OAuth2 client)
- Supabase (Postgres + JS client) for storage
- Jest + Supertest for testing
- Deployed as Vercel Serverless Functions

## Architecture: two parallel sessions

This repo is built using a two-session Claude Code workflow, running in separate git worktrees:

| Session | Branch | Owns |
|---|---|---|
| **Server Logic** | `main` | `src/`, `api/` |
| **Schema** | `schema` | `migrations/`, `types/` |

**Sequencing rule:** the schema session cannot be merged until the server logic session's tests pass (`npm test` exits 0 with no skipped tests). Schema work can be drafted in parallel, but review and merge are gated behind that.

See `CONTRACT.md` for the full API contract (endpoint shapes, error codes, and the message data model) and `build_sequence.md` for the atomic build order.

## Project status

🚧 Pre-implementation. `src/`, `api/`, and `tests/` are currently empty — the contract, build sequence, and toolchain are set up and both sessions are verified to understand their scope. Core engine build is next.

## Getting started

```
npm install
cp .env.example .env
npx tsc --noEmit
npm test
```

See `.env.example` for the required environment variables.
