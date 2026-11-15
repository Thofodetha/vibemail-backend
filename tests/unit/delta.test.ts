import {
  InMemoryMessageStore,
  InMemorySyncStateStore,
} from "../../src/db/in-memory";
import { runDeltaSync } from "../../src/sync/delta";
import type { SyncState } from "../../src/types/stores";
import { FakeMailbox, id, makeMessage } from "./fixtures/mailbox";

const ctx = { userId: "user-1", accountId: "acct-1", pubsubTopic: "projects/p/topics/t" };
const NOW = new Date("2026-11-14T12:00:00.000Z");
const COMPLETED = new Date("2026-11-10T00:00:00.000Z");

function seededState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    accountId: ctx.accountId,
    userId: ctx.userId,
    historyId: "500",
    watchExpiration: new Date("2026-11-20T00:00:00.000Z"),
    initialSyncCompletedAt: COMPLETED,
    lastDeltaAt: null,
    ...overrides,
  };
}

async function setup(mailbox: FakeMailbox, state: SyncState | null = seededState()) {
  const messages = new InMemoryMessageStore();
  const syncState = new InMemorySyncStateStore();
  if (state) await syncState.save(state);
  const deps = { provider: mailbox, messages, syncState, now: () => NOW };
  return { deps, messages, syncState };
}

const stored = (messages: InMemoryMessageStore) =>
  messages.all(ctx.accountId).map((m) => m.gmailId).sort();

describe("runDeltaSync", () => {
  it("does nothing for an account with no sync state", async () => {
    const mailbox = new FakeMailbox();
    const { deps } = await setup(mailbox, null);
    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "not-synced" });
    expect(mailbox.changeCalls).toHaveLength(0);
  });

  it("replays from the stored cursor across every page, then advances to the last page's cursor", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [
      { changes: [{ type: "added", id: id(1) }, { type: "added", id: id(2) }], cursor: "510" },
      { changes: [{ type: "labelsChanged", id: id(3) }], cursor: "520" },
    ];
    const { deps, messages, syncState } = await setup(mailbox);

    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "processed", upserted: 3, deleted: 0 });

    // The same stored cursor is used for every page; the page token does the paging.
    expect(mailbox.changeCalls).toEqual([
      { since: "500", pageToken: undefined },
      { since: "500", pageToken: "p1" },
    ]);
    expect(stored(messages)).toEqual([id(1), id(2), id(3)]);
    expect(await syncState.get(ctx.accountId)).toEqual(
      seededState({ historyId: "520", lastDeltaAt: NOW }),
    );
  });

  it("fetches a message once even when several events mention it", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [
      {
        changes: [
          { type: "added", id: id(1) },
          { type: "labelsChanged", id: id(1) },
          { type: "labelsChanged", id: id(1) },
        ],
        cursor: "510",
      },
    ];
    const { deps } = await setup(mailbox);
    await runDeltaSync(deps, ctx);
    expect(mailbox.fetchCalls).toEqual([id(1)]);
  });

  it("deletes a message that was deleted anywhere in the range, and never fetches it", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [
      {
        changes: [
          { type: "added", id: id(1) },
          { type: "labelsChanged", id: id(1) },
          { type: "deleted", id: id(1) },
          { type: "added", id: id(2) },
        ],
        cursor: "510",
      },
    ];
    const { deps, messages } = await setup(mailbox);
    await messages.upsertMessages(
      { userId: ctx.userId, accountId: ctx.accountId },
      [makeMessage(1)],
    );

    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "processed", upserted: 1, deleted: 1 });

    expect(mailbox.fetchCalls).toEqual([id(2)]);
    expect(stored(messages)).toEqual([id(2)]);
  });

  it("treats a re-fetch that finds nothing (404) as deleted", async () => {
    const mailbox = new FakeMailbox();
    mailbox.missing.add(id(1));
    mailbox.pages = [
      { changes: [{ type: "added", id: id(1) }, { type: "added", id: id(2) }], cursor: "510" },
    ];
    const { deps, messages } = await setup(mailbox);
    await messages.upsertMessages(
      { userId: ctx.userId, accountId: ctx.accountId },
      [makeMessage(1)],
    );

    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "processed", upserted: 1, deleted: 1 });
    expect(stored(messages)).toEqual([id(2)]);
  });

  it("writes nothing but still advances the cursor when there are no changes", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [{ changes: [], cursor: "777" }];
    const { deps, messages, syncState } = await setup(mailbox);
    const upsert = jest.spyOn(messages, "upsertMessages");
    const remove = jest.spyOn(messages, "deleteMessages");

    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "processed", upserted: 0, deleted: 0 });

    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect((await syncState.get(ctx.accountId))?.historyId).toBe("777");
  });

  it("writes all upserts in one call", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [
      {
        changes: Array.from({ length: 25 }, (_, i) => ({ type: "added" as const, id: id(i) })),
        cursor: "510",
      },
    ];
    const { deps, messages } = await setup(mailbox);
    const upsert = jest.spyOn(messages, "upsertMessages");
    await runDeltaSync(deps, ctx);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[1]).toHaveLength(25);
  });

  it("leaves the cursor and every row alone when a fetch fails", async () => {
    const mailbox = new FakeMailbox();
    mailbox.failFetch.add(id(2));
    mailbox.pages = [
      { changes: [{ type: "added", id: id(1) }, { type: "added", id: id(2) }], cursor: "510" },
    ];
    const { deps, messages, syncState } = await setup(mailbox);

    await expect(runDeltaSync(deps, ctx)).rejects.toThrow("Gmail failed on");

    expect(stored(messages)).toEqual([]);
    expect(await syncState.get(ctx.accountId)).toEqual(seededState());
  });

  it("does not advance the cursor when a write fails, and converges when run again", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [
      {
        changes: [{ type: "added", id: id(1) }, { type: "deleted", id: id(9) }],
        cursor: "510",
      },
    ];
    const { deps, messages, syncState } = await setup(mailbox);
    const realDelete = messages.deleteMessages.bind(messages);
    jest
      .spyOn(messages, "deleteMessages")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation(realDelete);

    await expect(runDeltaSync(deps, ctx)).rejects.toThrow("database unavailable");
    expect((await syncState.get(ctx.accountId))?.historyId).toBe("500");

    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "processed", upserted: 1, deleted: 1 });
    expect((await syncState.get(ctx.accountId))?.historyId).toBe("510");
    expect(stored(messages)).toEqual([id(1)]);
  });

  it("compares history ids as numbers, so 99 -> 100 advances", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [{ changes: [], cursor: "100" }];
    const { deps, syncState } = await setup(mailbox, seededState({ historyId: "99" }));
    await runDeltaSync(deps, ctx);
    expect((await syncState.get(ctx.accountId))?.historyId).toBe("100");
  });

  it("never moves the cursor backwards, and keeps changes another run made to the row", async () => {
    const mailbox = new FakeMailbox();
    mailbox.pages = [{ changes: [], cursor: "520" }];
    const { deps, syncState } = await setup(mailbox);
    const renewed = new Date("2026-11-27T00:00:00.000Z");
    // Another run advanced the cursor and the watch was renewed while this one was working.
    jest
      .spyOn(syncState, "get")
      .mockResolvedValueOnce(seededState())
      .mockResolvedValueOnce(seededState({ historyId: "900", watchExpiration: renewed }));
    const save = jest.spyOn(syncState, "save");

    await runDeltaSync(deps, ctx);

    expect(save).toHaveBeenCalledWith(
      seededState({ historyId: "900", watchExpiration: renewed, lastDeltaAt: NOW }),
    );
  });
});

describe("runDeltaSync when the cursor has expired", () => {
  it("resyncs in full: fresh watch, the 50 most recent messages, and the watch's cursor", async () => {
    const mailbox = new FakeMailbox();
    mailbox.expired = true;
    mailbox.inbox = [makeMessage(0), makeMessage(1), makeMessage(2)];
    const lastDelta = new Date("2026-11-12T00:00:00.000Z");
    const { deps, messages, syncState } = await setup(
      mailbox,
      seededState({ lastDeltaAt: lastDelta }),
    );

    expect(await runDeltaSync(deps, ctx)).toEqual({ status: "resynced", stored: 3 });

    expect(mailbox.watchCalls).toEqual([ctx.pubsubTopic]);
    expect(stored(messages)).toEqual([id(0), id(1), id(2)]);
    expect(await syncState.get(ctx.accountId)).toEqual({
      accountId: ctx.accountId,
      userId: ctx.userId,
      historyId: "9001",
      watchExpiration: mailbox.watchResult.expiresAt,
      initialSyncCompletedAt: NOW,
      lastDeltaAt: lastDelta,
    });
  });

  it("keeps the old cursor when the resync fails, so the next notification retries", async () => {
    const mailbox = new FakeMailbox();
    mailbox.expired = true;
    mailbox.inbox = [makeMessage(0)];
    mailbox.failFetch.add(id(0));
    const { deps, messages, syncState } = await setup(mailbox);

    await expect(runDeltaSync(deps, ctx)).rejects.toThrow("Gmail failed on");

    expect(stored(messages)).toEqual([]);
    expect(await syncState.get(ctx.accountId)).toEqual(seededState());
  });
});
