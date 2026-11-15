import type { MessageContext, MessageStore, StoredMessage } from "../types/message";
import type { MailProvider, ProviderMessage } from "../types/provider";
import { ValidationError } from "../types/errors";
import { FETCH_CONCURRENCY, mapWithConcurrency } from "./index";

// The message list (CONTRACT 3.2): Gmail is asked live, every message on the page is stored, and the
// stored rows are returned. It never reads or changes the sync cursor.

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_QUERY_LENGTH = 500;
export const MAX_LABELS = 10;
const LABEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ListQuery {
  labelIds: string[];
  query?: string;
  maxResults: number;
  pageToken?: string;
}

export interface ListPage {
  messages: StoredMessage[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

/**
 * Validates the query string of `GET /api/v1/messages`. `maxResults` is never clamped: out of range
 * is an error. Multiple labels are AND-ed by Gmail.
 *
 * @throws ValidationError listing every problem, keyed by parameter
 */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const errors: Record<string, string> = {};

  let maxResults = DEFAULT_PAGE_SIZE;
  const rawMax = params.get("maxResults");
  if (rawMax !== null) {
    const parsed = /^\d+$/.test(rawMax) ? Number(rawMax) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      errors.maxResults = `must be an integer from 1 to ${MAX_PAGE_SIZE}`;
    } else {
      maxResults = parsed;
    }
  }

  let labelIds = ["INBOX"];
  const rawLabels = params.get("labelIds");
  if (rawLabels !== null) {
    const labels = rawLabels.split(",");
    if (rawLabels === "" || labels.some((label) => !LABEL_ID.test(label))) {
      errors.labelIds = "must be a comma-separated list of label ids";
    } else if (labels.length > MAX_LABELS) {
      errors.labelIds = `must hold at most ${MAX_LABELS} label ids`;
    } else {
      labelIds = labels;
    }
  }

  const rawQuery = params.get("q");
  if (rawQuery !== null && rawQuery.length > MAX_QUERY_LENGTH) {
    errors.q = `must be at most ${MAX_QUERY_LENGTH} characters`;
  }

  const rawToken = params.get("pageToken");
  if (rawToken !== null && rawToken === "") {
    errors.pageToken = "must not be empty";
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  return {
    labelIds,
    ...(rawQuery ? { query: rawQuery } : {}),
    maxResults,
    ...(rawToken ? { pageToken: rawToken } : {}),
  };
}

export interface ListDeps {
  provider: Pick<MailProvider, "listMessages" | "getMessage">;
  messages: MessageStore;
}

/**
 * Lists one page: ask Gmail for ids, fetch each message in full (concurrency 10), store them all in
 * one atomic upsert, and return the stored rows in the order Gmail listed them. A message that
 * disappears in between is skipped, so a page can hold fewer than `maxResults` while
 * `nextPageToken` is still set. Any other failure fails the whole request: no partial pages.
 */
export async function listStoredMessages(
  deps: ListDeps,
  ctx: MessageContext,
  query: ListQuery,
): Promise<ListPage> {
  const page = await deps.provider.listMessages({
    labelIds: query.labelIds,
    query: query.query,
    maxResults: query.maxResults,
    pageToken: query.pageToken,
  });

  const fetched = await mapWithConcurrency(page.ids, FETCH_CONCURRENCY, (id) =>
    deps.provider.getMessage(id),
  );
  const found = fetched.filter((m): m is ProviderMessage => m !== null);
  const messages = found.length > 0 ? await deps.messages.upsertMessages(ctx, found) : [];

  return {
    messages,
    nextPageToken: page.nextPageToken,
    resultSizeEstimate: page.resultSizeEstimate,
  };
}
