import { decodeEncodedWords, parseAddressList } from "../gmail/address";
import { GMAIL_SCOPES } from "../gmail/auth";
import {
  CodeExchangeFailedError,
  InvalidPageTokenError,
  MessageNotFoundError,
  ThreadNotFoundError,
} from "../../types/errors";
import type {
  EmailAddress,
  MailProvider,
  ProviderAuth,
  ProviderMessage,
  ProviderTokens,
} from "../../types/provider";

// An in-memory mail provider for local preview and tests (`VIBEMAIL_FAKES=1`, CONTRACT 6.3). It
// implements both provider interfaces over a made-up mailbox, so the whole app runs without Google
// or a database. It never leaves the process, and the composition root refuses to build it in
// production.

/** The authorization code the fake consent URL hands back. It carries no authority. */
export const FAKE_AUTH_CODE = "fake-authorization-code";

export interface FakeMailProviderOptions {
  /** The OAuth callback URL the fake consent page "redirects" to. */
  redirectUri: string;
  /** The signed-in mailbox. */
  email?: string;
  /** How many demo messages the inbox starts with. */
  size?: number;
  now?: () => Date;
}

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(4, "0");

/** The one place read state is derived, so `isRead` and `labelIds` never disagree. */
function withLabels(message: ProviderMessage, labelIds: string[]): ProviderMessage {
  return { ...message, labelIds, isRead: !labelIds.includes("UNREAD") };
}

function unfoldHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

const decodeBase64Text = (content: string) =>
  Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");

/** Reads the headers and the text and HTML bodies out of a message built by the send layer. */
function readRawMessage(raw: string) {
  const split = raw.indexOf("\r\n\r\n");
  const headers = unfoldHeaders(raw.slice(0, split));
  const rest = raw.slice(split + 4);
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;

  const boundary = /boundary="?([^";]+)"?/.exec(headers.get("content-type") ?? "")?.[1];
  const parts = boundary
    ? rest
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => {
          const text = part.replace(/^\r\n/, "");
          const at = text.indexOf("\r\n\r\n");
          return { type: text.slice(0, at), content: text.slice(at + 4) };
        })
    : [{ type: headers.get("content-type") ?? "", content: rest }];
  for (const part of parts) {
    if (/text\/html/i.test(part.type)) bodyHtml = decodeBase64Text(part.content);
    else if (/text\/plain/i.test(part.type)) bodyText = decodeBase64Text(part.content);
  }
  return { headers, bodyText, bodyHtml };
}

export class FakeMailProvider implements ProviderAuth, MailProvider {
  private messages: ProviderMessage[] = [];
  private sentCount = 0;
  private cursor = 1000;
  private readonly email: string;
  private readonly now: () => Date;

  constructor(private readonly options: FakeMailProviderOptions) {
    this.email = options.email ?? "demo@vibemail.test";
    this.now = options.now ?? (() => new Date());
    const start = this.now().getTime();
    const size = options.size ?? 60;
    for (let i = 0; i < size; i += 1) {
      const labelIds = ["INBOX"];
      if (i % 3 === 0) labelIds.push("UNREAD");
      if (i % 7 === 0) labelIds.push("STARRED");
      this.messages.push(
        withLabels(
          {
            id: `fake${pad(i)}`,
            threadId: `fakethread${pad(i)}`,
            cursor: String(1000 + i),
            receivedAt: new Date(start - i * HOUR),
            labelIds,
            isRead: true,
            snippet: `This is demo message ${i + 1}.`,
            sizeEstimate: 1200 + i,
            subject: `Demo message ${i + 1}`,
            from: { name: "Ann Lee", email: "ann@example.test" },
            to: [{ name: null, email: this.email }],
            cc: [],
            bcc: [],
            rfc822MessageId: `<fake-${i}@vibemail.test>`,
            inReplyTo: null,
            references: [],
            bodyText: `Hello,\n\nThis is demo message ${i + 1}.\n`,
            bodyHtml: i % 2 === 0 ? `<p>Hello,</p><p>This is demo message ${i + 1}.</p>` : null,
            attachments: [],
          },
          labelIds,
        ),
      );
    }
  }

  // ---- ProviderAuth -------------------------------------------------------------------------

  async getAuthorizationUrl(p: { state: string }): Promise<string> {
    const url = new URL(this.options.redirectUri);
    url.searchParams.set("code", FAKE_AUTH_CODE);
    url.searchParams.set("state", p.state);
    return url.toString();
  }

  async exchangeCode(p: { code: string }): Promise<{
    tokens: ProviderTokens;
    grantedScopes: string[];
    identity: { subject: string; email: string };
  }> {
    if (p.code !== FAKE_AUTH_CODE) {
      throw new CodeExchangeFailedError("the fake provider did not issue this code");
    }
    return {
      tokens: {
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: new Date(this.now().getTime() + HOUR),
      },
      grantedScopes: [...GMAIL_SCOPES],
      identity: { subject: "fake-google-sub", email: this.email },
    };
  }

  async refreshAccessToken(): Promise<ProviderTokens> {
    return {
      accessToken: "fake-access-token",
      expiresAt: new Date(this.now().getTime() + HOUR),
    };
  }

  // ---- MailProvider -------------------------------------------------------------------------

  async listMessages(p: {
    labelIds: string[];
    query?: string;
    maxResults: number;
    pageToken?: string;
  }) {
    const offset = p.pageToken === undefined ? 0 : Number(p.pageToken);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new InvalidPageTokenError("the page token is not valid");
    }
    const needle = p.query?.toLowerCase();
    const matches = this.messages.filter(
      (m) =>
        p.labelIds.every((label) => m.labelIds.includes(label)) &&
        (needle === undefined ||
          `${m.subject ?? ""} ${m.snippet} ${m.from?.email ?? ""}`.toLowerCase().includes(needle)),
    );
    const end = Math.min(offset + p.maxResults, matches.length);
    return {
      ids: matches.slice(offset, end).map((m) => m.id),
      nextPageToken: end < matches.length ? String(end) : null,
      resultSizeEstimate: matches.length,
    };
  }

  async getMessage(id: string): Promise<ProviderMessage | null> {
    const found = this.messages.find((m) => m.id === id);
    return found ? { ...found } : null;
  }

  async sendMessage(p: { rawMime: string; threadId?: string }) {
    if (p.threadId !== undefined && !this.messages.some((m) => m.threadId === p.threadId)) {
      throw new ThreadNotFoundError("the thread does not exist");
    }
    const { headers, bodyText, bodyHtml } = readRawMessage(p.rawMime);
    this.sentCount += 1;
    this.cursor += 1;
    const addresses = (name: string): EmailAddress[] => parseAddressList(headers.get(name) ?? "");
    const references = (headers.get("references") ?? "").split(/\s+/).filter((r) => r.length > 0);
    const labelIds = ["SENT"];
    const message = withLabels(
      {
        id: `fakesent${pad(this.sentCount)}`,
        threadId: p.threadId ?? `fakesentthread${pad(this.sentCount)}`,
        cursor: String(this.cursor),
        receivedAt: this.now(),
        labelIds,
        isRead: true,
        snippet: (bodyText ?? "").slice(0, 100),
        sizeEstimate: p.rawMime.length,
        subject: decodeEncodedWords(headers.get("subject") ?? ""),
        from: { name: null, email: this.email },
        to: addresses("to"),
        cc: addresses("cc"),
        bcc: addresses("bcc"),
        rfc822MessageId: `<fakesent-${this.sentCount}@vibemail.test>`,
        inReplyTo: headers.get("in-reply-to") ?? null,
        references,
        bodyText,
        bodyHtml,
        attachments: [],
      },
      labelIds,
    );
    this.messages.unshift(message);
    return { id: message.id, threadId: message.threadId };
  }

  async setRead(id: string, isRead: boolean): Promise<void> {
    const index = this.messages.findIndex((m) => m.id === id);
    const current = this.messages[index];
    if (!current) throw new MessageNotFoundError("the message does not exist");
    const others = current.labelIds.filter((label) => label !== "UNREAD");
    this.cursor += 1;
    this.messages[index] = {
      ...withLabels(current, isRead ? others : [...others, "UNREAD"]),
      cursor: String(this.cursor),
    };
  }

  async watchChanges(): Promise<{ cursor: string; expiresAt: Date }> {
    return {
      cursor: String(this.cursor),
      expiresAt: new Date(this.now().getTime() + 7 * 24 * HOUR),
    };
  }

  async listChanges(p: { since: string }) {
    return { changes: [], nextPageToken: null, cursor: p.since };
  }
}
