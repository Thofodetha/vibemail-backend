import {
  GmailMailProvider,
  type GmailApi,
} from "../../src/providers/gmail/provider";
import type { TokenPersistence } from "../../src/providers/gmail/auth";
import {
  CursorExpiredError,
  ReauthRequiredError,
  UpstreamError,
} from "../../src/types/errors";
import { alternative, plain } from "./fixtures/gmail";

type ListFn = GmailApi["users"]["messages"]["list"];
type GetFn = GmailApi["users"]["messages"]["get"];
type HistoryFn = GmailApi["users"]["history"]["list"];

function api(parts: { list?: ListFn; get?: GetFn; history?: HistoryFn }): GmailApi {
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
