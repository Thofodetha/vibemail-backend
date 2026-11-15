import { google, type gmail_v1 } from "googleapis";
import { ProviderError } from "../../types/errors";
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
    };
  };
};

/** The methods of `MailProvider` the sync and read layer needs. The rest arrive with the send and delta-sync units. */
export type ReadableMailProvider = Pick<
  MailProvider,
  "listMessages" | "getMessage" | "watchChanges"
>;

/**
 * Gmail implementation of the read side of `MailProvider`, bound to one account's authorized client.
 * Every call waits for any token refresh it triggered to be written to the store before returning,
 * so a request never finishes with a refreshed token that was not persisted.
 */
export class GmailMailProvider implements ReadableMailProvider {
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
