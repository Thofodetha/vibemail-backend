import { InMemoryMessageStore } from "../../src/db/in-memory";
import { fromRow, toUpsertRow, type MessageRow } from "../../src/db/message-rows";
import type { ProviderMessage } from "../../src/types/provider";
import { allFixtures, alternative, plain, reply, withAttachment } from "./fixtures/gmail";

const ctx = { userId: "user-1", accountId: "acct-1" };

describe("message row mapping (CONTRACT 4.3)", () => {
  it("maps a message to the messages-table columns", () => {
    const now = new Date("2026-11-14T10:00:00.000Z");
    const row = toUpsertRow(ctx, reply.expected, now);
    expect(row).toEqual({
      user_id: "user-1",
      account_id: "acct-1",
      gmail_id: "18f0a1b2c3d4e800",
      thread_id: "18f0a1b2c3d4e5f6",
      history_id: "100400",
      internal_date: "2023-11-15T01:13:20.000Z",
      label_ids: ["INBOX", "UNREAD"],
      is_read: false,
      snippet: "Yes, noon works",
      size_estimate: 3300,
      subject: "Re: Lunch?",
      from_name: "Ann Lee",
      from_email: "ann@example.com",
      to: [{ name: null, email: "me@example.com" }],
      cc: [
        { name: "Cara", email: "cara@example.com" },
        { name: null, email: "dan@example.com" },
      ],
      bcc: [],
      rfc822_message_id: "<CAF2def@mail.example.com>",
      in_reply_to: "<CAF1abc@mail.example.com>",
      references: ["<CAF0root@mail.example.com>", "<CAF1abc@mail.example.com>"],
      body_text: "Yes, noon works",
      body_html: null,
      attachments: [],
      synced_at: "2026-11-14T10:00:00.000Z",
      updated_at: "2026-11-14T10:00:00.000Z",
    });
  });

  it("leaves id and created_at out of the upsert, so an existing row keeps them", () => {
    const row = toUpsertRow(ctx, plain.expected, new Date());
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("created_at");
  });

  it("stores a missing From as two nulls and reads it back as null", () => {
    const message: ProviderMessage = { ...plain.expected, from: null };
    const upsert = toUpsertRow(ctx, message, new Date());
    expect(upsert.from_name).toBeNull();
    expect(upsert.from_email).toBeNull();
    const row: MessageRow = { ...upsert, id: "id-1", created_at: upsert.synced_at };
    expect(fromRow(row).from).toBeNull();
  });

  it("round-trips every fixture to the API shape of CONTRACT 1.7", () => {
    for (const fixture of Object.values(allFixtures)) {
      const upsert = toUpsertRow(ctx, fixture.expected, new Date("2026-11-14T10:00:00.000Z"));
      const stored = fromRow({ ...upsert, id: "id-1", created_at: upsert.synced_at });
      expect(stored).toEqual({
        id: "id-1",
        gmailId: fixture.expected.id,
        threadId: fixture.expected.threadId,
        historyId: fixture.expected.cursor,
        internalDate: fixture.expected.receivedAt.toISOString(),
        labelIds: fixture.expected.labelIds,
        isRead: fixture.expected.isRead,
        snippet: fixture.expected.snippet,
        sizeEstimate: fixture.expected.sizeEstimate,
        subject: fixture.expected.subject,
        from: fixture.expected.from,
        to: fixture.expected.to,
        cc: fixture.expected.cc,
        bcc: fixture.expected.bcc,
        rfc822MessageId: fixture.expected.rfc822MessageId,
        inReplyTo: fixture.expected.inReplyTo,
        references: fixture.expected.references,
        bodyText: fixture.expected.bodyText,
        bodyHtml: fixture.expected.bodyHtml,
        attachments: fixture.expected.attachments,
        syncedAt: "2026-11-14T10:00:00.000Z",
      });
    }
  });
});

describe("InMemoryMessageStore", () => {
  it("returns the stored messages in input order, with fresh ids", async () => {
    const store = new InMemoryMessageStore();
    const stored = await store.upsertMessages(ctx, [
      withAttachment.expected,
      plain.expected,
      alternative.expected,
    ]);
    expect(stored.map((m) => m.gmailId)).toEqual([
      withAttachment.expected.id,
      plain.expected.id,
      alternative.expected.id,
    ]);
    expect(new Set(stored.map((m) => m.id)).size).toBe(3);
  });

  it("upserts on (account, gmailId): a second write updates the row and keeps its id", async () => {
    const store = new InMemoryMessageStore();
    const [first] = await store.upsertMessages(ctx, [plain.expected]);
    const [second] = await store.upsertMessages(ctx, [
      { ...plain.expected, labelIds: ["INBOX"], isRead: true },
    ]);
    expect(second?.id).toBe(first?.id);
    expect(second?.isRead).toBe(true);
    expect(store.all(ctx.accountId)).toHaveLength(1);
  });

  it("keeps two accounts' copies of the same Gmail id apart", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages(ctx, [plain.expected]);
    await store.upsertMessages({ userId: "user-2", accountId: "acct-2" }, [plain.expected]);
    expect(store.all("acct-1")).toHaveLength(1);
    expect(store.all("acct-2")).toHaveLength(1);
  });

  it("collapses a duplicate id inside one batch to a single row", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages(ctx, [plain.expected, { ...plain.expected, snippet: "later" }]);
    const rows = store.all(ctx.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snippet).toBe("later");
  });

  it("deletes only the named messages for the account and counts them", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages(ctx, [plain.expected, alternative.expected]);
    expect(
      await store.deleteMessages({ accountId: "acct-1" }, [plain.expected.id, "never-stored"]),
    ).toBe(1);
    expect(store.all("acct-1").map((m) => m.gmailId)).toEqual([alternative.expected.id]);
    expect(await store.deleteMessages({ accountId: "acct-other" }, [alternative.expected.id])).toBe(0);
  });
});
