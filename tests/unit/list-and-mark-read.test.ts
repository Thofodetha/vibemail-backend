import { InMemoryMessageStore } from "../../src/db/in-memory";
import { markRead } from "../../src/send/mark-read";
import { listStoredMessages, parseListQuery } from "../../src/sync/read";
import {
  InvalidPageTokenError,
  MessageNotFoundError,
  PersistenceFailedError,
  UpstreamError,
  ValidationError,
} from "../../src/types/errors";
import type { ProviderMessage } from "../../src/types/provider";
import { id, makeMessage } from "./fixtures/mailbox";

const ctx = { userId: "user-1", accountId: "acct-1" };
const params = (query: string) => new URLSearchParams(query);

function fieldsOf(query: string): Record<string, string> {
  try {
    parseListQuery(params(query));
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("expected a ValidationError");
}

describe("parseListQuery", () => {
  it("defaults to the first page of the inbox, 25 at a time", () => {
    expect(parseListQuery(params(""))).toEqual({ labelIds: ["INBOX"], maxResults: 25 });
  });

  it("reads every parameter", () => {
    expect(
      parseListQuery(params("pageToken=abc123&maxResults=50&labelIds=INBOX,UNREAD,Label_42&q=from%3Aann")),
    ).toEqual({
      labelIds: ["INBOX", "UNREAD", "Label_42"],
      maxResults: 50,
      pageToken: "abc123",
      query: "from:ann",
    });
  });

  it.each(["1", "100"])("accepts maxResults=%s at the edges", (value) => {
    expect(parseListQuery(params(`maxResults=${value}`)).maxResults).toBe(Number(value));
  });

  it.each(["0", "101", "-1", "1.5", "abc", "", "1e2", " 5", "5 "])(
    "rejects maxResults=%p instead of clamping it",
    (value) => {
      expect(fieldsOf(`maxResults=${encodeURIComponent(value)}`)).toHaveProperty("maxResults");
    },
  );

  it.each(["", ",", "INBOX,", ",INBOX", "IN BOX", "INBOX,,UNREAD", "a/b"])(
    "rejects labelIds=%p",
    (value) => {
      expect(fieldsOf(`labelIds=${encodeURIComponent(value)}`)).toHaveProperty("labelIds");
    },
  );

  it("accepts ten labels and rejects eleven", () => {
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join(",");
    expect(parseListQuery(params(`labelIds=${labels(10)}`)).labelIds).toHaveLength(10);
    expect(fieldsOf(`labelIds=${labels(11)}`)).toHaveProperty("labelIds");
  });

  it("accepts a 500-character q and rejects 501", () => {
    expect(parseListQuery(params(`q=${"a".repeat(500)}`)).query).toHaveLength(500);
    expect(fieldsOf(`q=${"a".repeat(501)}`)).toHaveProperty("q");
  });

  it("treats an empty q as no search, but an empty pageToken as an error", () => {
    expect(parseListQuery(params("q=")).query).toBeUndefined();
    expect(fieldsOf("pageToken=")).toHaveProperty("pageToken");
  });

  it("ignores parameters it does not know", () => {
    expect(parseListQuery(params("includeSpamTrash=true&foo=bar"))).toEqual({
      labelIds: ["INBOX"],
      maxResults: 25,
    });
  });

  it("reports every problem at once", () => {
    expect(Object.keys(fieldsOf("maxResults=0&labelIds=&pageToken=")).sort()).toEqual([
      "labelIds",
      "maxResults",
      "pageToken",
    ]);
  });
});

class FakeLister {
  ids: string[] = [];
  nextPageToken: string | null = null;
  estimate = 999;
  missing = new Set<string>();
  failFetch = new Set<string>();
  listError: Error | null = null;
  listCalls: { labelIds: string[]; query?: string; maxResults: number; pageToken?: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;

  async listMessages(p: { labelIds: string[]; query?: string; maxResults: number; pageToken?: string }) {
    this.listCalls.push({ ...p });
    if (this.listError) throw this.listError;
    return { ids: this.ids, nextPageToken: this.nextPageToken, resultSizeEstimate: this.estimate };
  }

  async getMessage(messageId: string): Promise<ProviderMessage | null> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (this.failFetch.has(messageId)) throw new Error(`Gmail failed on ${messageId}`);
      if (this.missing.has(messageId)) return null;
      return makeMessage(Number(messageId.slice(1)));
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe("listStoredMessages", () => {
  const query = { labelIds: ["INBOX"], maxResults: 25 };

  it("passes the filters to Gmail and returns the stored rows in Gmail's order", async () => {
    const provider = new FakeLister();
    provider.ids = [id(3), id(1), id(2)];
    provider.nextPageToken = "next";
    const messages = new InMemoryMessageStore();

    const page = await listStoredMessages({ provider, messages }, ctx, {
      labelIds: ["INBOX", "UNREAD"],
      query: "from:ann",
      maxResults: 3,
      pageToken: "p1",
    });

    expect(provider.listCalls).toEqual([
      { labelIds: ["INBOX", "UNREAD"], query: "from:ann", maxResults: 3, pageToken: "p1" },
    ]);
    expect(page.messages.map((m) => m.gmailId)).toEqual([id(3), id(1), id(2)]);
    expect(page.nextPageToken).toBe("next");
    expect(page.resultSizeEstimate).toBe(999);
    expect(messages.all(ctx.accountId)).toHaveLength(3);
  });

  it("writes the whole page in one upsert", async () => {
    const provider = new FakeLister();
    provider.ids = [id(1), id(2), id(3)];
    const messages = new InMemoryMessageStore();
    const upsert = jest.spyOn(messages, "upsertMessages");
    await listStoredMessages({ provider, messages }, ctx, query);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[1]).toHaveLength(3);
  });

  it("skips a message deleted between listing and fetching, keeping the page token", async () => {
    const provider = new FakeLister();
    provider.ids = [id(1), id(2), id(3)];
    provider.missing.add(id(2));
    provider.nextPageToken = "more";
    const page = await listStoredMessages({ provider, messages: new InMemoryMessageStore() }, ctx, query);
    expect(page.messages.map((m) => m.gmailId)).toEqual([id(1), id(3)]);
    expect(page.nextPageToken).toBe("more");
  });

  it("returns an empty last page without writing", async () => {
    const provider = new FakeLister();
    const messages = new InMemoryMessageStore();
    const upsert = jest.spyOn(messages, "upsertMessages");
    expect(await listStoredMessages({ provider, messages }, ctx, query)).toEqual({
      messages: [],
      nextPageToken: null,
      resultSizeEstimate: 999,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fetches at most ten messages at once", async () => {
    const provider = new FakeLister();
    provider.ids = Array.from({ length: 40 }, (_, i) => id(i));
    await listStoredMessages({ provider, messages: new InMemoryMessageStore() }, ctx, query);
    expect(provider.maxInFlight).toBeGreaterThan(1);
    expect(provider.maxInFlight).toBeLessThanOrEqual(10);
  });

  it("fails the whole request, storing nothing, when any fetch fails", async () => {
    const provider = new FakeLister();
    provider.ids = [id(1), id(2), id(3)];
    provider.failFetch.add(id(2));
    const messages = new InMemoryMessageStore();
    await expect(listStoredMessages({ provider, messages }, ctx, query)).rejects.toThrow("Gmail failed on");
    expect(messages.all(ctx.accountId)).toHaveLength(0);
  });

  it("passes provider errors through, such as a rejected page token", async () => {
    const provider = new FakeLister();
    provider.listError = new InvalidPageTokenError("bad token");
    await expect(
      listStoredMessages({ provider, messages: new InMemoryMessageStore() }, ctx, { ...query, pageToken: "x" }),
    ).rejects.toThrow(InvalidPageTokenError);
  });
});

class FakeReadState {
  readonly log: string[] = [];
  setReadError: Error | null = null;
  readBack: ProviderMessage | null = { ...makeMessage(4), labelIds: ["INBOX"], isRead: true };

  async setRead(messageId: string, isRead: boolean) {
    this.log.push(`setRead(${messageId},${isRead})`);
    if (this.setReadError) throw this.setReadError;
  }

  async getMessage(messageId: string) {
    this.log.push(`get(${messageId})`);
    return this.readBack;
  }
}

describe("markRead", () => {
  it("marks the message read in Gmail, reads it back and stores it", async () => {
    const provider = new FakeReadState();
    const messages = new InMemoryMessageStore();

    const stored = await markRead({ provider, messages }, ctx, id(4));

    expect(provider.log).toEqual([`setRead(${id(4)},true)`, `get(${id(4)})`]);
    expect(stored.isRead).toBe(true);
    expect(stored.gmailId).toBe(id(4));
    expect(messages.all(ctx.accountId)).toEqual([stored]);
  });

  it("is idempotent: marking an already-read message returns the same row", async () => {
    const provider = new FakeReadState();
    const messages = new InMemoryMessageStore();
    const first = await markRead({ provider, messages }, ctx, id(4));
    const second = await markRead({ provider, messages }, ctx, id(4));
    expect(second.id).toBe(first.id);
    expect(messages.all(ctx.accountId)).toHaveLength(1);
  });

  it.each(["", "has space", "a/b", "x".repeat(65), "bad!id"])("rejects the id %p without calling Gmail", async (bad) => {
    const provider = new FakeReadState();
    await expect(markRead({ provider, messages: new InMemoryMessageStore() }, ctx, bad)).rejects.toThrow(
      ValidationError,
    );
    expect(provider.log).toEqual([]);
  });

  it("reports a missing message and reads and stores nothing", async () => {
    const provider = new FakeReadState();
    provider.setReadError = new MessageNotFoundError("gone");
    const messages = new InMemoryMessageStore();
    await expect(markRead({ provider, messages }, ctx, id(4))).rejects.toThrow(MessageNotFoundError);
    expect(provider.log).toEqual([`setRead(${id(4)},true)`]);
    expect(messages.all(ctx.accountId)).toHaveLength(0);
  });

  it("reports a message deleted between the change and the read-back as not found", async () => {
    const provider = new FakeReadState();
    provider.readBack = null;
    await expect(markRead({ provider, messages: new InMemoryMessageStore() }, ctx, id(4))).rejects.toThrow(
      MessageNotFoundError,
    );
  });

  it("reports PersistenceFailedError, safe to retry, when the database write fails", async () => {
    const provider = new FakeReadState();
    const messages = new InMemoryMessageStore();
    jest.spyOn(messages, "upsertMessages").mockRejectedValue(new Error("database unavailable"));
    const error = await markRead({ provider, messages }, ctx, id(4)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PersistenceFailedError);
    expect(((error as PersistenceFailedError).detail as Error).message).toBe("database unavailable");
  });

  it("does not call a Gmail failure a persistence failure", async () => {
    const provider = new FakeReadState();
    provider.setReadError = new UpstreamError("503");
    await expect(markRead({ provider, messages: new InMemoryMessageStore() }, ctx, id(4))).rejects.toThrow(
      UpstreamError,
    );
  });
});
