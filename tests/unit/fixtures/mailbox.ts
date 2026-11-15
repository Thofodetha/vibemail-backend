import type { SyncMailProvider } from "../../../src/providers/gmail/provider";
import { CursorExpiredError } from "../../../src/types/errors";
import type { ProviderMessage } from "../../../src/types/provider";

/** A small normalised message whose id is `m0000`, `m0001`, ... so tests can name messages by number. */
export function makeMessage(index: number): ProviderMessage {
  return {
    id: id(index),
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

export function id(index: number): string {
  return `m${String(index).padStart(4, "0")}`;
}

export type Change = { type: "added" | "deleted" | "labelsChanged"; id: string };

/**
 * A scripted mailbox: `pages` are the pages `listChanges` serves (the next page token is derived),
 * `inbox` is what a full resync lists. Records every call so tests can assert on them.
 */
export class FakeMailbox implements SyncMailProvider {
  pages: { changes: Change[]; cursor: string }[] = [];
  inbox: ProviderMessage[] = [];
  expired = false;
  missing = new Set<string>();
  failFetch = new Set<string>();
  watchResult = { cursor: "9001", expiresAt: new Date("2026-11-21T00:00:00.000Z") };
  /** If set, `getMessage` waits for it before answering. */
  gate: Promise<void> | null = null;

  readonly changeCalls: { since: string; pageToken?: string }[] = [];
  readonly fetchCalls: string[] = [];
  readonly watchCalls: string[] = [];

  async listChanges(p: { since: string; pageToken?: string }) {
    this.changeCalls.push({ ...p });
    if (this.expired) throw new CursorExpiredError("cursor expired");
    const index = p.pageToken === undefined ? 0 : Number(p.pageToken.slice(1));
    const page = this.pages[index];
    if (!page) throw new Error(`no scripted page ${index}`);
    return {
      changes: page.changes,
      nextPageToken: index + 1 < this.pages.length ? `p${index + 1}` : null,
      cursor: page.cursor,
    };
  }

  async getMessage(messageId: string): Promise<ProviderMessage | null> {
    this.fetchCalls.push(messageId);
    if (this.gate) await this.gate;
    if (this.failFetch.has(messageId)) throw new Error(`Gmail failed on ${messageId}`);
    if (this.missing.has(messageId)) return null;
    return makeMessage(Number(messageId.slice(1)));
  }

  async listMessages(p: { labelIds: string[]; maxResults: number; pageToken?: string }) {
    return {
      ids: this.inbox.slice(0, p.maxResults).map((m) => m.id),
      nextPageToken: null,
      resultSizeEstimate: this.inbox.length,
    };
  }

  async watchChanges(p: { destination: string }) {
    this.watchCalls.push(p.destination);
    return this.watchResult;
  }
}
