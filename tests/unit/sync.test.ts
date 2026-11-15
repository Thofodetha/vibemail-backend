import {
  InMemoryMessageStore,
  InMemorySyncStateStore,
} from "../../src/db/in-memory";
import type { ReadableMailProvider } from "../../src/providers/gmail/provider";
import {
  FETCH_CONCURRENCY,
  INITIAL_SYNC_MESSAGE_LIMIT,
  runInitialSync,
} from "../../src/sync";
import type { MessageStore } from "../../src/types/message";
import type { ProviderMessage } from "../../src/types/provider";
import type { SyncState } from "../../src/types/stores";

const ctx = { userId: "user-1", accountId: "acct-1", pubsubTopic: "projects/p/topics/t" };
const NOW = new Date("2026-11-14T12:00:00.000Z");

function message(index: number): ProviderMessage {
  return {
    id: `m${String(index).padStart(4, "0")}`,
    threadId: `t${index}`,
    cursor: String(1000 + index),
    receivedAt: new Date(1_700_000_000_000 - index * 60_000),
    labelIds: ["INBOX"],
    isRead: true,
    snippet: `snippet ${index}`,
    sizeEstimate: 100,
    subject: `Subject ${index}`,
    from: { name: "Ann", email: "ann@example.com" },
    to: [{ name: null, email: "me@example.com" }],
    cc: [],
    bcc: [],
    rfc822MessageId: null,
    inReplyTo: null,
    references: [],
    bodyText: `body ${index}`,
    bodyHtml: null,
    attachments: [],
  };
}

/** A mailbox of `size` INBOX messages, newest first, that serves at most `pageCap` ids per page. */
class FakeInbox implements ReadableMailProvider {
  readonly listCalls: { labelIds: string[]; maxResults: number; pageToken?: string }[] = [];
  readonly watchCalls: string[] = [];
  gone = new Set<string>();
  failOn: string | null = null;
  inFlight = 0;
  maxInFlight = 0;
  watchResult = { cursor: "9001", expiresAt: new Date("2026-11-21T00:00:00.000Z") };
  watchError: Error | null = null;

  constructor(
    private readonly size: number,
    private readonly pageCap = 100,
  ) {}

  async listMessages(p: { labelIds: string[]; maxResults: number; pageToken?: string }) {
    this.listCalls.push({ ...p });
    const start = p.pageToken === undefined ? 0 : Number(p.pageToken);
    const end = Math.min(start + Math.min(p.maxResults, this.pageCap), this.size);
    const ids = Array.from({ length: end - start }, (_, i) => message(start + i).id);
    return {
      ids,
      nextPageToken: end < this.size ? String(end) : null,
      resultSizeEstimate: this.size,
    };
  }

  async getMessage(id: string): Promise<ProviderMessage | null> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (id === this.failOn) throw new Error(`Gmail failed on ${id}`);
      if (this.gone.has(id)) return null;
      return message(Number(id.slice(1)));
    } finally {
      this.inFlight -= 1;
    }
  }

  async watchChanges(p: { destination: string }) {
    this.watchCalls.push(p.destination);
    if (this.watchError) throw this.watchError;
    return this.watchResult;
  }
}

function setup(inbox: FakeInbox, existing?: Partial<SyncState>) {
  const messages = new InMemoryMessageStore();
  const syncState = new InMemorySyncStateStore();
  const deps = { provider: inbox, messages, syncState, now: () => NOW };
  const seeded: SyncState = {
    accountId: ctx.accountId,
    userId: ctx.userId,
    historyId: "500",
    watchExpiration: new Date("2026-11-20T00:00:00.000Z"),
    initialSyncCompletedAt: null,
    lastDeltaAt: null,
    ...existing,
  };
  return { deps, messages, syncState, seed: () => syncState.save(seeded) };
}

describe("runInitialSync", () => {
  it("stores exactly the 50 most recent INBOX messages when the mailbox has more", async () => {
    const inbox = new FakeInbox(120);
    const { deps, messages, seed } = setup(inbox);
    await seed();

    expect(await runInitialSync(deps, ctx)).toEqual({ status: "completed", stored: 50 });

    const stored = messages.all(ctx.accountId);
    expect(INITIAL_SYNC_MESSAGE_LIMIT).toBe(50);
    expect(stored).toHaveLength(50);
    expect(stored.map((m) => m.gmailId)).toEqual(
      Array.from({ length: 50 }, (_, i) => message(i).id),
    );
  });

  it("follows pageToken across pages when Gmail returns fewer ids than asked", async () => {
    const inbox = new FakeInbox(120, 20);
    const { deps, messages, seed } = setup(inbox);
    await seed();

    await runInitialSync(deps, ctx);

    expect(inbox.listCalls.map((c) => c.pageToken)).toEqual([undefined, "20", "40"]);
    expect(inbox.listCalls.every((c) => c.labelIds.join() === "INBOX")).toBe(true);
    // Each page asks only for what is still missing.
    expect(inbox.listCalls.map((c) => c.maxResults)).toEqual([50, 30, 10]);
    expect(messages.all(ctx.accountId)).toHaveLength(50);
  });

  it("stores everything when the mailbox has fewer than 50 messages", async () => {
    const inbox = new FakeInbox(7);
    const { deps, messages, seed } = setup(inbox);
    await seed();
    expect(await runInitialSync(deps, ctx)).toEqual({ status: "completed", stored: 7 });
    expect(messages.all(ctx.accountId)).toHaveLength(7);
  });

  it("handles an empty inbox", async () => {
    const inbox = new FakeInbox(0);
    const { deps, messages, syncState, seed } = setup(inbox);
    await seed();
    expect(await runInitialSync(deps, ctx)).toEqual({ status: "completed", stored: 0 });
    expect(messages.all(ctx.accountId)).toHaveLength(0);
    expect((await syncState.get(ctx.accountId))?.initialSyncCompletedAt).toEqual(NOW);
  });

  it("fetches at most 10 messages at once", async () => {
    const inbox = new FakeInbox(60);
    const { deps, seed } = setup(inbox);
    await seed();
    await runInitialSync(deps, ctx);
    expect(FETCH_CONCURRENCY).toBe(10);
    expect(inbox.maxInFlight).toBeGreaterThan(1);
    expect(inbox.maxInFlight).toBeLessThanOrEqual(10);
  });

  it("writes all messages in one upsert call", async () => {
    const inbox = new FakeInbox(60);
    const { deps, messages, seed } = setup(inbox);
    await seed();
    const upsert = jest.spyOn(messages, "upsertMessages");
    await runInitialSync(deps, ctx);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[1]).toHaveLength(50);
  });

  it("skips a message deleted between listing and fetching", async () => {
    const inbox = new FakeInbox(10);
    inbox.gone.add(message(3).id);
    const { deps, messages, seed } = setup(inbox);
    await seed();
    expect(await runInitialSync(deps, ctx)).toEqual({ status: "completed", stored: 9 });
    expect(messages.all(ctx.accountId).map((m) => m.gmailId)).not.toContain(message(3).id);
  });

  it("marks the sync completed without touching the stored history cursor", async () => {
    const inbox = new FakeInbox(5);
    const { deps, syncState, seed } = setup(inbox, { historyId: "500" });
    await seed();

    await runInitialSync(deps, ctx);

    expect(await syncState.get(ctx.accountId)).toEqual({
      accountId: ctx.accountId,
      userId: ctx.userId,
      historyId: "500", // not 1004, the newest message's historyId, and not the watch's 9001
      watchExpiration: new Date("2026-11-20T00:00:00.000Z"),
      initialSyncCompletedAt: NOW,
      lastDeltaAt: null,
    });
    expect(inbox.watchCalls).toEqual([]);
  });

  it("starts the watch itself, before listing, when sign-in left no sync state", async () => {
    const inbox = new FakeInbox(5);
    const { deps, syncState } = setup(inbox);

    await runInitialSync(deps, ctx);

    expect(inbox.watchCalls).toEqual([ctx.pubsubTopic]);
    expect(await syncState.get(ctx.accountId)).toEqual({
      accountId: ctx.accountId,
      userId: ctx.userId,
      historyId: "9001",
      watchExpiration: inbox.watchResult.expiresAt,
      initialSyncCompletedAt: NOW,
      lastDeltaAt: null,
    });
  });

  it("writes nothing, and leaves the sync unfinished, when the watch cannot start", async () => {
    const inbox = new FakeInbox(5);
    inbox.watchError = new Error("topic not found");
    const { deps, messages, syncState } = setup(inbox);

    await expect(runInitialSync(deps, ctx)).rejects.toThrow("topic not found");

    expect(inbox.listCalls).toHaveLength(0);
    expect(messages.all(ctx.accountId)).toHaveLength(0);
    expect(await syncState.get(ctx.accountId)).toBeNull();
  });

  it("writes no messages and leaves the sync unfinished when a fetch fails", async () => {
    const inbox = new FakeInbox(20);
    inbox.failOn = message(11).id;
    const { deps, messages, syncState, seed } = setup(inbox);
    await seed();

    await expect(runInitialSync(deps, ctx)).rejects.toThrow("Gmail failed on");

    expect(messages.all(ctx.accountId)).toHaveLength(0);
    expect((await syncState.get(ctx.accountId))?.initialSyncCompletedAt).toBeNull();
  });

  it("leaves the sync unfinished when the write fails, and succeeds when run again", async () => {
    const inbox = new FakeInbox(5);
    const { deps, messages, syncState, seed } = setup(inbox);
    await seed();
    const real = messages.upsertMessages.bind(messages);
    jest
      .spyOn(messages, "upsertMessages")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation(real);

    await expect(runInitialSync(deps, ctx)).rejects.toThrow("database unavailable");
    expect((await syncState.get(ctx.accountId))?.initialSyncCompletedAt).toBeNull();

    expect(await runInitialSync(deps, ctx)).toEqual({ status: "completed", stored: 5 });
    expect(messages.all(ctx.accountId)).toHaveLength(5);
  });

  it("does nothing when the initial sync already completed", async () => {
    const inbox = new FakeInbox(5);
    const done = new Date("2026-11-01T00:00:00.000Z");
    const { deps, messages, syncState, seed } = setup(inbox, { initialSyncCompletedAt: done });
    await seed();

    expect(await runInitialSync(deps, ctx)).toEqual({ status: "already-completed" });

    expect(inbox.listCalls).toHaveLength(0);
    expect(messages.all(ctx.accountId)).toHaveLength(0);
    expect((await syncState.get(ctx.accountId))?.initialSyncCompletedAt).toEqual(done);
  });

  it("is idempotent: a re-run after a partial failure does not duplicate rows", async () => {
    const inbox = new FakeInbox(5);
    const { deps, messages, seed } = setup(inbox);
    await seed();
    const store: MessageStore = messages;
    await store.upsertMessages(
      { userId: ctx.userId, accountId: ctx.accountId },
      [message(0), message(1)],
    );

    await runInitialSync(deps, ctx);

    expect(messages.all(ctx.accountId)).toHaveLength(5);
  });
});
