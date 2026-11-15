import { InMemoryMessageStore } from "../../src/db/in-memory";
import type { ComposeMailProvider } from "../../src/providers/gmail/provider";
import { parseSendRequest, sendMail, type SendDeps } from "../../src/send";
import {
  BodyTooLargeError,
  InvalidRecipientError,
  ReauthRequiredError,
  SentNotPersistedError,
  ThreadNotFoundError,
  ValidationError,
} from "../../src/types/errors";
import type { ProviderMessage } from "../../src/types/provider";
import { id, makeMessage } from "./fixtures/mailbox";

const ctx = { userId: "user-1", accountId: "acct-1", fromEmail: "me@example.com" };
const SENT = { id: id(7), threadId: "t7" };
const DATE = new Date("2023-11-14T22:13:20.000Z");

class FakeCompose implements ComposeMailProvider {
  readonly log: string[] = [];
  sendCalls: { rawMime: string; threadId?: string }[] = [];
  fetchCalls: string[] = [];
  sendError: Error | null = null;
  fetchError: Error | null = null;
  readBack: ProviderMessage | null = makeMessage(7);

  async sendMessage(p: { rawMime: string; threadId?: string }) {
    this.log.push("send");
    this.sendCalls.push(p);
    if (this.sendError) throw this.sendError;
    return SENT;
  }

  async getMessage(messageId: string) {
    this.log.push("get");
    this.fetchCalls.push(messageId);
    if (this.fetchError) throw this.fetchError;
    return this.readBack;
  }
}

function setup() {
  const provider = new FakeCompose();
  const messages = new InMemoryMessageStore();
  const deps: SendDeps = { provider, messages, mime: { date: DATE, boundary: "BOUND" } };
  return { provider, messages, deps };
}

const request = (extra: Record<string, unknown> = {}) =>
  parseSendRequest({
    to: [{ name: "Ann", email: "ann@example.com" }],
    subject: "Hello",
    bodyText: "Hi Ann",
    ...extra,
  });

describe("sendMail", () => {
  it("sends, reads the message back and stores it, returning the stored row", async () => {
    const { provider, messages, deps } = setup();

    const stored = await sendMail(deps, ctx, request());

    expect(provider.log).toEqual(["send", "get"]);
    expect(provider.fetchCalls).toEqual([SENT.id]);
    expect(stored.gmailId).toBe(SENT.id);
    expect(stored).toEqual(messages.all(ctx.accountId)[0]);
  });

  it("builds the message from the signed-in account's address", async () => {
    const { provider, deps } = setup();
    await sendMail(deps, ctx, request());
    const raw = provider.sendCalls[0]?.rawMime ?? "";
    expect(raw).toContain("From: me@example.com\r\n");
    expect(raw).toContain("To: Ann <ann@example.com>\r\n");
    expect(raw).toContain("Subject: Hello\r\n");
  });

  it("includes cc, bcc and an HTML alternative", async () => {
    const { provider, deps } = setup();
    await sendMail(
      deps,
      ctx,
      request({
        cc: [{ email: "cara@example.com" }],
        bcc: [{ email: "dan@example.com" }],
        bodyHtml: "<p>Hi Ann</p>",
      }),
    );
    const raw = provider.sendCalls[0]?.rawMime ?? "";
    expect(raw).toContain("Cc: cara@example.com\r\n");
    expect(raw).toContain("Bcc: dan@example.com\r\n");
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="BOUND"');
  });

  it("passes the thread id and sets the reply headers when replying", async () => {
    const { provider, deps } = setup();
    await sendMail(
      deps,
      ctx,
      request({ threadId: "18f0a1b2c3d4e5f6", inReplyTo: "<CAF1abc@mail.example.com>" }),
    );
    expect(provider.sendCalls[0]?.threadId).toBe("18f0a1b2c3d4e5f6");
    const raw = provider.sendCalls[0]?.rawMime ?? "";
    expect(raw).toContain("In-Reply-To: <CAF1abc@mail.example.com>\r\n");
    expect(raw).toContain("References: <CAF1abc@mail.example.com>\r\n");
  });

  it("sends no thread id for a new conversation", async () => {
    const { provider, deps } = setup();
    await sendMail(deps, ctx, request());
    expect(provider.sendCalls[0]?.threadId).toBeUndefined();
  });
});

describe("sendMail: failures before the message is sent", () => {
  it.each([
    ["a bad recipient", new InvalidRecipientError("bad", "to")],
    ["a missing thread", new ThreadNotFoundError("no thread")],
    ["a revoked grant", new ReauthRequiredError("revoked")],
  ])("passes %s through, reads and stores nothing", async (_label, error) => {
    const { provider, messages, deps } = setup();
    provider.sendError = error;

    await expect(sendMail(deps, ctx, request())).rejects.toBe(error);

    expect(provider.fetchCalls).toHaveLength(0);
    expect(messages.all(ctx.accountId)).toHaveLength(0);
  });

  it("refuses an oversized body without sending", async () => {
    const { provider, deps } = setup();
    const big = request({ bodyText: "a".repeat(1_048_576), bodyHtml: "<p>x</p>" });
    await expect(sendMail(deps, ctx, big)).rejects.toThrow(BodyTooLargeError);
    expect(provider.sendCalls).toHaveLength(0);
  });

  it("accepts a body exactly at the limit", async () => {
    const { deps } = setup();
    await expect(
      sendMail(deps, ctx, request({ bodyText: "a".repeat(1_048_576) })),
    ).resolves.toBeDefined();
  });

  it("refuses to send a message whose headers were tampered with after validation", async () => {
    const { provider, deps } = setup();
    const tampered = { ...request(), subject: "Hi\r\nBcc: evil@example.com" };
    await expect(sendMail(deps, ctx, tampered)).rejects.toThrow(ValidationError);
    expect(provider.sendCalls).toHaveLength(0);
  });
});

describe("sendMail: failures after the message is sent", () => {
  it("reports SentNotPersistedError with the new ids when the read-back fails", async () => {
    const { provider, messages, deps } = setup();
    const cause = new Error("Gmail 503");
    provider.fetchError = cause;

    const error = await sendMail(deps, ctx, request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SentNotPersistedError);
    expect((error as SentNotPersistedError).sentId).toBe(SENT.id);
    expect((error as SentNotPersistedError).threadId).toBe(SENT.threadId);
    expect((error as SentNotPersistedError).detail).toBe(cause);
    expect(messages.all(ctx.accountId)).toHaveLength(0);
  });

  it("reports it when the sent message cannot be found on read-back", async () => {
    const { provider, deps } = setup();
    provider.readBack = null;
    await expect(sendMail(deps, ctx, request())).rejects.toThrow(SentNotPersistedError);
  });

  it("reports it when the database write fails", async () => {
    const { messages, deps } = setup();
    jest.spyOn(messages, "upsertMessages").mockRejectedValue(new Error("database unavailable"));
    const error = await sendMail(deps, ctx, request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentNotPersistedError);
    expect(((error as SentNotPersistedError).detail as Error).message).toBe("database unavailable");
  });

  it("never sends twice: the send is attempted once whatever happens afterwards", async () => {
    const { provider, deps } = setup();
    provider.fetchError = new Error("boom");
    await expect(sendMail(deps, ctx, request())).rejects.toThrow(SentNotPersistedError);
    expect(provider.sendCalls).toHaveLength(1);
  });
});
