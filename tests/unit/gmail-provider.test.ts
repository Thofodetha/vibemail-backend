import {
  GmailMailProvider,
  type GmailApi,
} from "../../src/providers/gmail/provider";
import type { TokenPersistence } from "../../src/providers/gmail/auth";
import {
  BodyTooLargeError,
  CursorExpiredError,
  InvalidRecipientError,
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  ThreadNotFoundError,
  UpstreamError,
} from "../../src/types/errors";
import { alternative, plain } from "./fixtures/gmail";

type ListFn = GmailApi["users"]["messages"]["list"];
type GetFn = GmailApi["users"]["messages"]["get"];
type HistoryFn = GmailApi["users"]["history"]["list"];
type SendFn = GmailApi["users"]["messages"]["send"];

function api(parts: { list?: ListFn; get?: GetFn; history?: HistoryFn; send?: SendFn }): GmailApi {
  return {
    users: {
      watch: async () => ({ data: { historyId: "42", expiration: "1800000000000" } }),
      history: {
        list:
          parts.history ??
          (async () => {
            throw new Error("history.list not stubbed");
          }),
      },
      messages: {
        list:
          parts.list ??
          (async () => {
            throw new Error("list not stubbed");
          }),
        get:
          parts.get ??
          (async () => {
            throw new Error("get not stubbed");
          }),
        send:
          parts.send ??
          (async () => {
            throw new Error("send not stubbed");
          }),
      },
    },
  };
}

const noopPersistence: TokenPersistence = { flush: async () => undefined };

describe("GmailMailProvider.listMessages", () => {
  it("passes the filters through and returns ids with the next page token", async () => {
    const list = jest.fn<ReturnType<ListFn>, Parameters<ListFn>>(async () => ({
      data: {
        messages: [{ id: "a" }, { id: null }, { id: "b" }],
        nextPageToken: "page-2",
        resultSizeEstimate: 321,
      },
    }));
    const provider = new GmailMailProvider(api({ list }), noopPersistence);

    const result = await provider.listMessages({
      labelIds: ["INBOX"],
      query: "from:ann",
      maxResults: 25,
      pageToken: "page-1",
    });

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      labelIds: ["INBOX"],
      q: "from:ann",
      maxResults: 25,
      pageToken: "page-1",
    });
    expect(result).toEqual({ ids: ["a", "b"], nextPageToken: "page-2", resultSizeEstimate: 321 });
  });

  it("reports no next page and no messages as null and []", async () => {
    const provider = new GmailMailProvider(
      api({ list: async () => ({ data: {} }) }),
      noopPersistence,
    );
    expect(await provider.listMessages({ labelIds: ["INBOX"], maxResults: 10 })).toEqual({
      ids: [],
      nextPageToken: null,
      resultSizeEstimate: 0,
    });
  });

  it("maps a revoked grant to ReauthRequiredError and other failures to UpstreamError", async () => {
    const revoked = new GmailMailProvider(
      api({
        list: async () => {
          throw { message: "invalid_grant" };
        },
      }),
      noopPersistence,
    );
    await expect(revoked.listMessages({ labelIds: [], maxResults: 1 })).rejects.toThrow(
      ReauthRequiredError,
    );

    const broken = new GmailMailProvider(
      api({
        list: async () => {
          throw new Error("503 backend error");
        },
      }),
      noopPersistence,
    );
    await expect(broken.listMessages({ labelIds: [], maxResults: 1 })).rejects.toThrow(
      UpstreamError,
    );
  });
});

describe("GmailMailProvider.getMessage", () => {
  it("requests the full format and parses the result", async () => {
    const get = jest.fn<ReturnType<GetFn>, Parameters<GetFn>>(async () => ({
      data: alternative.raw,
    }));
    const provider = new GmailMailProvider(api({ get }), noopPersistence);

    expect(await provider.getMessage("18f0a1b2c3d4e600")).toEqual(alternative.expected);
    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "18f0a1b2c3d4e600",
      format: "full",
    });
  });

  it("resolves null for a message that no longer exists (404)", async () => {
    const viaResponse = new GmailMailProvider(
      api({
        get: async () => {
          throw { response: { status: 404 } };
        },
      }),
      noopPersistence,
    );
    expect(await viaResponse.getMessage("gone")).toBeNull();

    const viaCode = new GmailMailProvider(
      api({
        get: async () => {
          throw { code: 404 };
        },
      }),
      noopPersistence,
    );
    expect(await viaCode.getMessage("gone")).toBeNull();
  });

  it("does not hide other failures as a missing message", async () => {
    const provider = new GmailMailProvider(
      api({
        get: async () => {
          throw { response: { status: 500 } };
        },
      }),
      noopPersistence,
    );
    await expect(provider.getMessage("x")).rejects.toThrow(UpstreamError);
  });

  it("rejects a response that is not a usable message", async () => {
    const provider = new GmailMailProvider(
      api({ get: async () => ({ data: { ...plain.raw, historyId: undefined } }) }),
      noopPersistence,
    );
    await expect(provider.getMessage("x")).rejects.toThrow(UpstreamError);
  });
});

describe("GmailMailProvider token persistence", () => {
  it("waits for a refreshed token to be persisted before returning", async () => {
    const order: string[] = [];
    const persistence: TokenPersistence = {
      flush: async () => {
        order.push("flush");
      },
    };
    const provider = new GmailMailProvider(
      api({
        list: async () => {
          order.push("list");
          return { data: { messages: [{ id: "a" }] } };
        },
      }),
      persistence,
    );
    await provider.listMessages({ labelIds: ["INBOX"], maxResults: 1 });
    expect(order).toEqual(["list", "flush"]);
  });

  it("fails the call when the refreshed token could not be saved, and does not blame Google", async () => {
    const persistence: TokenPersistence = {
      flush: async () => {
        throw new Error("database unavailable");
      },
    };
    const provider = new GmailMailProvider(
      api({ list: async () => ({ data: { messages: [] } }) }),
      persistence,
    );
    const failure = provider.listMessages({ labelIds: ["INBOX"], maxResults: 1 });
    await expect(failure).rejects.toThrow("database unavailable");
    await expect(failure).rejects.not.toBeInstanceOf(UpstreamError);
  });

  it("still flushes when the Gmail call itself fails", async () => {
    const flush = jest.fn(async () => undefined);
    const provider = new GmailMailProvider(
      api({
        get: async () => {
          throw new Error("boom");
        },
      }),
      { flush },
    );
    await expect(provider.getMessage("x")).rejects.toThrow(UpstreamError);
    expect(flush).toHaveBeenCalled();
  });
});

describe("GmailMailProvider.watchChanges", () => {
  it("starts the watch on the given destination", async () => {
    const provider = new GmailMailProvider(api({}), noopPersistence);
    expect(await provider.watchChanges({ destination: "projects/p/topics/t" })).toEqual({
      cursor: "42",
      expiresAt: new Date(1_800_000_000_000),
    });
  });
});

describe("GmailMailProvider.listChanges", () => {
  const history = {
    history: [
      {
        id: "201",
        messagesAdded: [{ message: { id: "new-1" } }, { message: { id: "new-2" } }],
      },
      {
        id: "202",
        labelsAdded: [{ message: { id: "old-1" }, labelIds: ["STARRED"] }],
        labelsRemoved: [{ message: { id: "old-2" }, labelIds: ["UNREAD"] }],
      },
      { id: "203", messagesDeleted: [{ message: { id: "gone-1" } }] },
    ],
    nextPageToken: "next",
    historyId: "999",
  };

  it("asks for all four event types from the given cursor, 500 per page", async () => {
    const list = jest.fn<ReturnType<HistoryFn>, Parameters<HistoryFn>>(async () => ({ data: history }));
    const provider = new GmailMailProvider(api({ history: list }), noopPersistence);

    await provider.listChanges({ since: "100", pageToken: "p1" });

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      startHistoryId: "100",
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      pageToken: "p1",
      maxResults: 500,
    });
  });

  it("flattens history records to message-level changes, in history order", async () => {
    const provider = new GmailMailProvider(api({ history: async () => ({ data: history }) }), noopPersistence);
    expect(await provider.listChanges({ since: "100" })).toEqual({
      changes: [
        { type: "added", id: "new-1" },
        { type: "added", id: "new-2" },
        { type: "labelsChanged", id: "old-1" },
        { type: "labelsChanged", id: "old-2" },
        { type: "deleted", id: "gone-1" },
      ],
      nextPageToken: "next",
      cursor: "999",
    });
  });

  it("reports no changes and no next page when history is empty", async () => {
    const provider = new GmailMailProvider(
      api({ history: async () => ({ data: { historyId: "300" } }) }),
      noopPersistence,
    );
    expect(await provider.listChanges({ since: "100" })).toEqual({
      changes: [],
      nextPageToken: null,
      cursor: "300",
    });
  });

  it("reports an expired cursor (404) so the caller can resync in full", async () => {
    const provider = new GmailMailProvider(
      api({
        history: async () => {
          throw { response: { status: 404 } };
        },
      }),
      noopPersistence,
    );
    await expect(provider.listChanges({ since: "1" })).rejects.toThrow(CursorExpiredError);
  });

  it("does not mistake other failures for an expired cursor", async () => {
    const provider = new GmailMailProvider(
      api({
        history: async () => {
          throw { response: { status: 500 } };
        },
      }),
      noopPersistence,
    );
    await expect(provider.listChanges({ since: "1" })).rejects.toThrow(UpstreamError);
  });

  it("rejects a response without a historyId", async () => {
    const provider = new GmailMailProvider(
      api({ history: async () => ({ data: { history: [] } }) }),
      noopPersistence,
    );
    await expect(provider.listChanges({ since: "1" })).rejects.toThrow(UpstreamError);
  });
});

describe("GmailMailProvider.sendMessage", () => {
  const raw = "From: me@example.com\r\nTo: you@example.com\r\nSubject: Hi\r\n\r\nbody\r\n";
  const ok = async () => ({ data: { id: "sent-1", threadId: "thread-1" } });

  function failing(status: number, message = "Gmail error", data: unknown = {}) {
    return async () => {
      throw Object.assign(new Error(message), { response: { status, data } });
    };
  }

  it("sends the message base64url-encoded, as me, and returns the new ids", async () => {
    const send = jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(ok);
    const provider = new GmailMailProvider(api({ send }), noopPersistence);

    expect(await provider.sendMessage({ rawMime: raw })).toEqual({
      id: "sent-1",
      threadId: "thread-1",
    });

    const call = send.mock.calls[0]?.[0];
    expect(call?.userId).toBe("me");
    expect(call?.requestBody).not.toHaveProperty("threadId");
    const encoded = call?.requestBody.raw ?? "";
    expect(encoded).not.toMatch(/[+/=]/); // base64url, no padding
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(raw);
  });

  it("includes the thread id when replying", async () => {
    const send = jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(ok);
    const provider = new GmailMailProvider(api({ send }), noopPersistence);
    await provider.sendMessage({ rawMime: raw, threadId: "thread-9" });
    expect(send.mock.calls[0]?.[0].requestBody.threadId).toBe("thread-9");
  });

  it("keeps UTF-8 intact through the encoding", async () => {
    const send = jest.fn<ReturnType<SendFn>, Parameters<SendFn>>(ok);
    const provider = new GmailMailProvider(api({ send }), noopPersistence);
    const text = "Subject: caf\u00e9 \ud83d\udc4b\r\n\r\n";
    await provider.sendMessage({ rawMime: text });
    const encoded = send.mock.calls[0]?.[0].requestBody.raw ?? "";
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(text);
  });

  it("maps a missing thread (404) to ThreadNotFoundError", async () => {
    const provider = new GmailMailProvider(api({ send: failing(404) }), noopPersistence);
    await expect(provider.sendMessage({ rawMime: raw, threadId: "nope" })).rejects.toThrow(
      ThreadNotFoundError,
    );
  });

  it("maps 413 to BodyTooLargeError", async () => {
    const provider = new GmailMailProvider(api({ send: failing(413) }), noopPersistence);
    await expect(provider.sendMessage({ rawMime: raw })).rejects.toThrow(BodyTooLargeError);
  });

  it("maps a 400 to InvalidRecipientError, naming the header when Gmail does", async () => {
    const named = new GmailMailProvider(
      api({ send: failing(400, "Invalid To header") }),
      noopPersistence,
    );
    const error = await named.sendMessage({ rawMime: raw }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRecipientError);
    expect((error as InvalidRecipientError).field).toBe("to");

    const unnamed = new GmailMailProvider(api({ send: failing(400, "Bad request") }), noopPersistence);
    const other = await unnamed.sendMessage({ rawMime: raw }).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(InvalidRecipientError);
    expect((other as InvalidRecipientError).field).toBeUndefined();
  });

  it("does not mistake a revoked grant (also HTTP 400) for a bad recipient", async () => {
    const provider = new GmailMailProvider(
      api({ send: failing(400, "invalid_grant", { error: "invalid_grant" }) }),
      noopPersistence,
    );
    await expect(provider.sendMessage({ rawMime: raw })).rejects.toThrow(ReauthRequiredError);
  });

  it("keeps scope and rate-limit failures as themselves", async () => {
    const scope = new GmailMailProvider(
      api({
        send: failing(403, "forbidden", { error: { errors: [{ reason: "insufficientPermissions" }] } }),
      }),
      noopPersistence,
    );
    await expect(scope.sendMessage({ rawMime: raw })).rejects.toThrow(ScopeInsufficientError);

    const limited = new GmailMailProvider(api({ send: failing(429) }), noopPersistence);
    await expect(limited.sendMessage({ rawMime: raw })).rejects.toThrow(RateLimitedError);
  });

  it("treats other failures as UpstreamError and never retries", async () => {
    const send = jest.fn(failing(503));
    const provider = new GmailMailProvider(api({ send }), noopPersistence);
    await expect(provider.sendMessage({ rawMime: raw })).rejects.toThrow(UpstreamError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a response without ids", async () => {
    const provider = new GmailMailProvider(
      api({ send: async () => ({ data: { id: "x" } }) }),
      noopPersistence,
    );
    await expect(provider.sendMessage({ rawMime: raw })).rejects.toThrow(UpstreamError);
  });

  it("waits for a refreshed token to be persisted before returning", async () => {
    const order: string[] = [];
    const provider = new GmailMailProvider(
      api({
        send: async () => {
          order.push("send");
          return { data: { id: "a", threadId: "b" } };
        },
      }),
      { flush: async () => void order.push("flush") },
    );
    await provider.sendMessage({ rawMime: raw });
    expect(order).toEqual(["send", "flush"]);
  });
});
