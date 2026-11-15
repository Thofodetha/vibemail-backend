import { google } from "googleapis";
import type { TokenStore } from "../../types/stores";
import { UpstreamError } from "../../types/errors";
import { createAuthorizedClient, type GmailAuthConfig } from "./auth";
import { mapGoogleError } from "./errors";

/** The slice of the Gmail API client the watch call uses. The real `google.gmail()` client satisfies it. */
export interface GmailWatchApi {
  users: {
    watch(params: {
      userId: string;
      requestBody: { topicName: string };
    }): Promise<{ data: { historyId?: string | null; expiration?: string | null } }>;
  };
}

export interface WatchResult {
  /** The mailbox's current history position when the watch started. */
  cursor: string;
  /** When Gmail stops pushing unless the watch is renewed. */
  expiresAt: Date;
}

/** Reads the Pub/Sub topic from `GOOGLE_PUBSUB_TOPIC`. */
export function pubsubTopicFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const topic = env.GOOGLE_PUBSUB_TOPIC;
  if (!topic) {
    throw new Error("GOOGLE_PUBSUB_TOPIC must be set");
  }
  return topic;
}

/** Calls `users.watch` for the signed-in mailbox, with no label filter. */
export async function watchMailbox(
  gmail: GmailWatchApi,
  topicName: string,
): Promise<WatchResult> {
  let data: { historyId?: string | null; expiration?: string | null };
  try {
    ({ data } = await gmail.users.watch({
      userId: "me",
      requestBody: { topicName },
    }));
  } catch (error) {
    throw mapGoogleError(error);
  }
  const expirationMs = Number(data.expiration);
  if (!data.historyId || !Number.isFinite(expirationMs)) {
    throw new UpstreamError("watch response lacks a historyId or an expiration");
  }
  return { cursor: data.historyId, expiresAt: new Date(expirationMs) };
}

/**
 * Builds the `startWatch` function sign-in uses: it loads the account's stored tokens, makes an
 * authorized Gmail client, calls `users.watch`, and makes sure any token refresh it triggered
 * is persisted before returning.
 */
export function gmailStartWatch(deps: {
  config: GmailAuthConfig;
  tokens: TokenStore;
  topicName: string;
}): (accountId: string) => Promise<WatchResult> {
  return async (accountId) => {
    const { client, persistence } = await createAuthorizedClient(
      { config: deps.config, tokens: deps.tokens },
      accountId,
    );
    const gmail = google.gmail({ version: "v1", auth: client });
    const result = await watchMailbox(gmail, deps.topicName);
    await persistence.flush();
    return result;
  };
}
