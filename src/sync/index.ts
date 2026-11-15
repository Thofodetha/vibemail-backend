import type { MessageContext, MessageStore } from "../types/message";
import type { ProviderMessage } from "../types/provider";
import type { SyncStateStore } from "../types/stores";
import type { ReadableMailProvider } from "../providers/gmail/provider";

/** How many of the most recent INBOX messages the initial sync stores (CONTRACT 3.6). */
export const INITIAL_SYNC_MESSAGE_LIMIT = 50;

/** How many `getMessage` calls run at once. */
export const FETCH_CONCURRENCY = 10;

export interface InitialSyncDeps {
  provider: ReadableMailProvider;
  messages: MessageStore;
  syncState: SyncStateStore;
  now?: () => Date;
}

export type InitialSyncResult =
  | { status: "completed"; stored: number }
  | { status: "already-completed" };

/** Runs `fn` over `items` with at most `limit` in flight, returning results in input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * The 50 most recent INBOX messages, newest first: list ids following `pageToken` (each page asks
 * only for the ids still missing, since Gmail may return fewer than asked while offering a next
 * page), then fetch each in full. A message that vanished in between is skipped.
 */
async function fetchRecentInbox(
  provider: ReadableMailProvider,
): Promise<ProviderMessage[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < INITIAL_SYNC_MESSAGE_LIMIT) {
    const page = await provider.listMessages({
      labelIds: ["INBOX"],
      maxResults: INITIAL_SYNC_MESSAGE_LIMIT - ids.length,
      pageToken,
    });
    ids.push(...page.ids);
    if (page.nextPageToken === null) break;
    pageToken = page.nextPageToken;
  }
  const fetched = await mapWithConcurrency(
    ids.slice(0, INITIAL_SYNC_MESSAGE_LIMIT),
    FETCH_CONCURRENCY,
    (id) => provider.getMessage(id),
  );
  return fetched.filter((m): m is ProviderMessage => m !== null);
}

/**
 * Full resync (CONTRACT 3.5 step 7), for when the stored history cursor has expired: start a fresh
 * watch, store the 50 most recent INBOX messages, and only then replace the cursor with the watch's.
 * The cursor changes last, so a failed resync leaves the old cursor and the next notification retries.
 */
export async function runFullResync(
  deps: InitialSyncDeps,
  ctx: MessageContext & { pubsubTopic: string },
): Promise<{ stored: number }> {
  const now = deps.now ?? (() => new Date());
  const watch = await deps.provider.watchChanges({ destination: ctx.pubsubTopic });
  const messages = await fetchRecentInbox(deps.provider);
  if (messages.length > 0) {
    await deps.messages.upsertMessages(
      { userId: ctx.userId, accountId: ctx.accountId },
      messages,
    );
  }
  const existing = await deps.syncState.get(ctx.accountId);
  await deps.syncState.save({
    accountId: ctx.accountId,
    userId: ctx.userId,
    historyId: watch.cursor,
    watchExpiration: watch.expiresAt,
    initialSyncCompletedAt: now(),
    lastDeltaAt: existing?.lastDeltaAt ?? null,
  });
  return { stored: messages.length };
}

/**
 * The initial sync (CONTRACT 3.6): store the 50 most recent INBOX messages and mark the sync done.
 *
 * 1. The watch comes first, so no change can fall into a gap. Sign-in normally started it already;
 *    this starts it only when no sync state exists. The stored history cursor is **never**
 *    overwritten here: it is where the delta sync resumes from.
 * 2. List INBOX ids newest first, following `pageToken`, until 50 ids or no more pages.
 * 3. Fetch each message in full (concurrency 10). A message that vanished meanwhile is skipped.
 * 4. Write all messages in one atomic upsert, then set `initialSyncCompletedAt`.
 *
 * If anything fails, nothing is written and `initialSyncCompletedAt` stays null, so the routine
 * can simply run again.
 */
export async function runInitialSync(
  deps: InitialSyncDeps,
  ctx: MessageContext & { pubsubTopic: string },
): Promise<InitialSyncResult> {
  const now = deps.now ?? (() => new Date());

  let state = await deps.syncState.get(ctx.accountId);
  if (state?.initialSyncCompletedAt) {
    return { status: "already-completed" };
  }
  if (!state) {
    const watch = await deps.provider.watchChanges({ destination: ctx.pubsubTopic });
    state = {
      accountId: ctx.accountId,
      userId: ctx.userId,
      historyId: watch.cursor,
      watchExpiration: watch.expiresAt,
      initialSyncCompletedAt: null,
      lastDeltaAt: null,
    };
    await deps.syncState.save(state);
  }

  const messages = await fetchRecentInbox(deps.provider);

  if (messages.length > 0) {
    await deps.messages.upsertMessages(
      { userId: ctx.userId, accountId: ctx.accountId },
      messages,
    );
  }

  // Re-read before writing: only `initialSyncCompletedAt` changes, whatever else moved meanwhile.
  const latest = (await deps.syncState.get(ctx.accountId)) ?? state;
  await deps.syncState.save({ ...latest, initialSyncCompletedAt: now() });
  return { status: "completed", stored: messages.length };
}
