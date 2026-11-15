import type { DeltaMailProvider } from "../providers/gmail/provider";
import { CursorExpiredError } from "../types/errors";
import type { MessageContext, MessageStore } from "../types/message";
import type { ProviderMessage } from "../types/provider";
import type { SyncStateStore } from "../types/stores";
import {
  FETCH_CONCURRENCY,
  mapWithConcurrency,
  runFullResync,
  type InitialSyncDeps,
} from "./index";

export interface DeltaSyncDeps {
  provider: DeltaMailProvider & InitialSyncDeps["provider"];
  messages: MessageStore;
  syncState: SyncStateStore;
  now?: () => Date;
}

export type DeltaSyncResult =
  | { status: "processed"; upserted: number; deleted: number }
  | { status: "resynced"; stored: number }
  | { status: "not-synced" };

/** History ids are unsigned 64-bit integers kept as text. Non-numeric values are treated as newer. */
function isNewer(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    return true;
  }
}

/**
 * Delta sync (CONTRACT 3.5, steps 4 to 7): replay what changed since the **stored** cursor.
 *
 * The cursor is never taken from a Pub/Sub notification. It resumes from the stored value and,
 * once every write has succeeded, moves to the history position the last page of `listChanges`
 * returned. A failure at any point leaves the cursor where it was, so the next run starts from
 * the same place; every write is an idempotent upsert or delete, so replays are harmless.
 *
 * - A message deleted anywhere in the range is deleted.
 * - Every other message that was added or had labels changed is re-fetched and upserted.
 * - A re-fetch that returns nothing (404) counts as deleted.
 * - If the provider says the cursor expired, run a full resync instead.
 */
export async function runDeltaSync(
  deps: DeltaSyncDeps,
  ctx: MessageContext & { pubsubTopic: string },
): Promise<DeltaSyncResult> {
  const now = deps.now ?? (() => new Date());
  const state = await deps.syncState.get(ctx.accountId);
  if (!state) return { status: "not-synced" };

  const deleted = new Set<string>();
  const refetch = new Set<string>();
  let cursor = state.historyId;
  try {
    let pageToken: string | undefined;
    for (;;) {
      const page = await deps.provider.listChanges({ since: state.historyId, pageToken });
      for (const change of page.changes) {
        if (change.type === "deleted") deleted.add(change.id);
        else refetch.add(change.id);
      }
      cursor = page.cursor;
      if (page.nextPageToken === null) break;
      pageToken = page.nextPageToken;
    }
  } catch (error) {
    if (error instanceof CursorExpiredError) {
      const { stored } = await runFullResync(deps, ctx);
      return { status: "resynced", stored };
    }
    throw error;
  }

  const toFetch = [...refetch].filter((id) => !deleted.has(id));
  const fetched = await mapWithConcurrency(toFetch, FETCH_CONCURRENCY, async (id) => ({
    id,
    message: await deps.provider.getMessage(id),
  }));
  const upserts: ProviderMessage[] = [];
  for (const { id, message } of fetched) {
    if (message === null) deleted.add(id);
    else upserts.push(message);
  }

  const messageCtx = { userId: ctx.userId, accountId: ctx.accountId };
  if (upserts.length > 0) {
    await deps.messages.upsertMessages(messageCtx, upserts);
  }
  if (deleted.size > 0) {
    await deps.messages.deleteMessages({ accountId: ctx.accountId }, [...deleted]);
  }

  // Re-read before writing so a concurrent change to the row (a watch renewal, another run) is kept,
  // and never move the cursor backwards if another run already advanced it past this one.
  const latest = (await deps.syncState.get(ctx.accountId)) ?? state;
  await deps.syncState.save({
    ...latest,
    historyId: isNewer(cursor, latest.historyId) ? cursor : latest.historyId,
    lastDeltaAt: now(),
  });
  return { status: "processed", upserted: upserts.length, deleted: deleted.size };
}
