import { google, type gmail_v1 } from "googleapis";
import {
  BodyTooLargeError,
  CursorExpiredError,
  InvalidRecipientError,
  ProviderError,
  ThreadNotFoundError,
  UpstreamError,
} from "../../types/errors";
import type { MailProvider, MessageId, ProviderMessage } from "../../types/provider";
import type { TokenStore } from "../../types/stores";
import {
  createAuthorizedClient,
  type GmailAuthConfig,
  type TokenPersistence,
} from "./auth";
import { httpStatus, mapGoogleError } from "./errors";
import { parseGmailMessage } from "./parse";
import { watchMailbox, type GmailWatchApi } from "./watch";

/** The slice of the Gmail API client this provider uses. The real `google.gmail()` client satisfies it. */
export type GmailApi = {
  users: GmailWatchApi["users"] & {
    history: {
      list(params: {
        userId: string;
        startHistoryId: string;
        historyTypes?: string[];
        pageToken?: string;
        maxResults?: number;
      }): Promise<{
        data: {
          history?: gmail_v1.Schema$History[];
          nextPageToken?: string | null;
          historyId?: string | null;
        };
      }>;
    };
    messages: {
      list(params: {
        userId: string;
        labelIds?: string[];
        q?: string;
        maxResults?: number;
        pageToken?: string;
      }): Promise<{
        data: {
          messages?: { id?: string | null }[];
          nextPageToken?: string | null;
          resultSizeEstimate?: number | null;
        };
      }>;
      get(params: {
        userId: string;
        id: string;
        format: "full";
      }): Promise<{ data: gmail_v1.Schema$Message }>;
      send(params: {
        userId: string;
        requestBody: { raw: string; threadId?: string };
      }): Promise<{ data: { id?: string | null; threadId?: string | null } }>;
    };
  };
};

/** The methods of `MailProvider` the sync and read layer needs. The rest arrive with the send and delta-sync units. */
export type ReadableMailProvider = Pick<
  MailProvider,
  "listMessages" | "getMessage" | "watchChanges"
>;

/** What the delta sync needs: replay changes since a cursor, and re-fetch what changed. */
export type DeltaMailProvider = Pick<MailProvider, "listChanges" | "getMessage">;

/** Everything the sync layer uses: initial sync, delta sync and full resync. */
export type SyncMailProvider = ReadableMailProvider & DeltaMailProvider;

/** What the send layer needs: send a message, then read it back. */
export type ComposeMailProvider = Pick<MailProvider, "sendMessage" | "getMessage">;

/** Gmail names the offending header in its 400 message: "Invalid To header". */
function recipientField(error: unknown): "to" | "cc" | "bcc" | undefined {
  const text = error instanceof Error ? error.message : "";
  const match = /invalid (to|cc|bcc) header/i.exec(text);
  return match ? (match[1]?.toLowerCase() as "to" | "cc" | "bcc") : undefined;
}

/** The four history event types, so label changes and deletions are reported as well as new mail. */
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];

/**
 * Gmail implementation of `MailProvider` (read and change-feed sides), bound to one account's authorized client.
 * Every call waits for any token refresh it triggered to be written to the store before returning,
 * so a request never finishes with a refreshed token that was not persisted.
 */
export class GmailMailProvider implements SyncMailProvider, ComposeMailProvider {
  constructor(
    private readonly gmail: GmailApi,
    private readonly persistence: TokenPersistence,
  ) {}

  /**
   * Runs one Gmail call. A Google failure becomes a typed provider error (the original is kept in
   * `detail`). Either way any token refresh the call triggered is persisted before this returns; a
   * failure to persist it is the database's, so it is thrown as is, not blamed on Google.
   */
  private async request<T>(call: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await call();
    } catch (error) {
      await this.persistence.flush().catch(() => undefined);
      throw mapGoogleError(error);
    }
    await this.persistence.flush();
    return result;
  }

  async listMessages(p: {
    labelIds: string[];
    query?: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{
    ids: MessageId[];
    nextPageToken: string | null;
    resultSizeEstimate: number;
  }> {
    const { data } = await this.request(() =>
      this.gmail.users.messages.list({
        userId: "me",
        labelIds: p.labelIds,
        q: p.query,
        maxResults: p.maxResults,
        pageToken: p.pageToken,
      }),
    );
    return {
      ids: (data.messages ?? []).flatMap((m) => (m.id ? [m.id] : [])),
      nextPageToken: data.nextPageToken ?? null,
      resultSizeEstimate: data.resultSizeEstimate ?? 0,
    };
  }

  /** Fetches one message in full. Resolves null when Gmail says it does not exist (404). */
  async getMessage(id: MessageId): Promise<ProviderMessage | null> {
    let data: gmail_v1.Schema$Message;
    try {
      ({ data } = await this.request(() =>
        this.gmail.users.messages.get({ userId: "me", id, format: "full" }),
      ));
    } catch (error) {
      if (error instanceof ProviderError && httpStatus(error.detail) === 404) {
        return null;
      }
      throw error;
    }
    return parseGmailMessage(data);
  }

  /**
   * One page of `history.list` from `since`, flattened to message-level changes in history order.
   * `cursor` is Gmail's current history position, to store once every page has been applied.
   *
   * @throws CursorExpiredError when Gmail answers 404: `since` is too old (usually a week or more,
   *   sometimes only hours), so the caller must resync in full.
   */
  async listChanges(p: { since: string; pageToken?: string }): Promise<{
    changes: { type: "added" | "deleted" | "labelsChanged"; id: MessageId }[];
    nextPageToken: string | null;
    cursor: string;
  }> {
    let data: Awaited<ReturnType<GmailApi["users"]["history"]["list"]>>["data"];
    try {
      ({ data } = await this.request(() =>
        this.gmail.users.history.list({
          userId: "me",
          startHistoryId: p.since,
          historyTypes: HISTORY_TYPES,
          pageToken: p.pageToken,
          maxResults: 500,
        }),
      ));
    } catch (error) {
      if (error instanceof ProviderError && httpStatus(error.detail) === 404) {
        throw new CursorExpiredError("the stored history cursor is no longer valid", error.detail);
      }
      throw error;
    }
    if (!data.historyId) {
      throw new UpstreamError("history response lacks a historyId");
    }

    const changes: { type: "added" | "deleted" | "labelsChanged"; id: MessageId }[] = [];
    const ids = (messages: { message?: { id?: string | null } }[] | undefined) =>
      (messages ?? []).flatMap((m) => (m.message?.id ? [m.message.id] : []));
    for (const record of data.history ?? []) {
      for (const id of ids(record.messagesAdded)) changes.push({ type: "added", id });
      for (const id of ids(record.messagesDeleted)) changes.push({ type: "deleted", id });
      for (const id of ids(record.labelsAdded)) changes.push({ type: "labelsChanged", id });
      for (const id of ids(record.labelsRemoved)) changes.push({ type: "labelsChanged", id });
    }
    return { changes, nextPageToken: data.nextPageToken ?? null, cursor: data.historyId };
  }

  /**
   * Sends a complete RFC 5322 message as the signed-in user. Gmail wants it base64url-encoded in
   * `raw`; that encoding is this provider's business, so callers pass the message as text.
   * Not idempotent: a retried call can send twice.
   *
   * @throws ThreadNotFoundError (404), BodyTooLargeError (413), InvalidRecipientError (400)
   */
  async sendMessage(p: { rawMime: string; threadId?: string }): Promise<{
    id: MessageId;
    threadId: string;
  }> {
    let data: { id?: string | null; threadId?: string | null };
    try {
      ({ data } = await this.request(() =>
        this.gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: Buffer.from(p.rawMime, "utf8").toString("base64url"),
            ...(p.threadId === undefined ? {} : { threadId: p.threadId }),
          },
        }),
      ));
    } catch (error) {
      // Only a plain upstream failure is reinterpreted: a revoked grant (also HTTP 400), a scope
      // problem or throttling keep their own meaning.
      if (error instanceof UpstreamError) {
        const status = httpStatus(error.detail);
        if (status === 404) {
          throw new ThreadNotFoundError("the thread does not exist", error.detail);
        }
        if (status === 413) {
          throw new BodyTooLargeError("the message is too large", error.detail);
        }
        if (status === 400) {
          throw new InvalidRecipientError(
            "Gmail rejected the message headers",
            recipientField(error.detail),
            error.detail,
          );
        }
      }
      throw error;
    }
    if (!data.id || !data.threadId) {
      throw new UpstreamError("send response lacks an id or a threadId");
    }
    return { id: data.id, threadId: data.threadId };
  }

  async watchChanges(p: { destination: string }): Promise<{
    cursor: string;
    expiresAt: Date;
  }> {
    const result = await watchMailbox(this.gmail, p.destination);
    await this.persistence.flush();
    return result;
  }
}

/** Builds the provider for one account from its stored tokens. */
export async function createGmailMailProvider(
  deps: { config: GmailAuthConfig; tokens: TokenStore },
  accountId: string,
): Promise<GmailMailProvider> {
  const { client, persistence } = await createAuthorizedClient(deps, accountId);
  return new GmailMailProvider(google.gmail({ version: "v1", auth: client }), persistence);
}
