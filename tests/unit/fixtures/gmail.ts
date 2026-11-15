import type { gmail_v1 } from "googleapis";
import type { ProviderMessage } from "../../../src/types/provider";

// Gmail `users.messages.get?format=full` responses, shaped like recorded ones, with the
// ProviderMessage each must parse to (CONTRACT 4.3). Bodies are base64url, as Gmail sends them.

export const b64url = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64url");

type Raw = gmail_v1.Schema$Message;

interface Fixture {
  raw: Raw;
  expected: ProviderMessage;
}

/** Single-part text/plain: the payload itself holds the body (`parts` is absent). */
export const plain: Fixture = {
  raw: {
    id: "18f0a1b2c3d4e5f6",
    threadId: "18f0a1b2c3d4e5f6",
    historyId: "100100",
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    snippet: "Hi there, are we still on for lunch?",
    sizeEstimate: 2100,
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "Delivered-To", value: "me@example.com" },
        { name: "Subject", value: "Lunch?" },
        { name: "From", value: "Ann Lee <ann@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Date", value: "Tue, 14 Nov 2023 22:13:20 +0000" },
        { name: "Message-ID", value: "<CAF1abc@mail.example.com>" },
      ],
      body: { size: 36, data: b64url("Hi there, are we still on for lunch?") },
    },
  },
  expected: {
    id: "18f0a1b2c3d4e5f6",
    threadId: "18f0a1b2c3d4e5f6",
    cursor: "100100",
    receivedAt: new Date(1_700_000_000_000),
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    isRead: false,
    snippet: "Hi there, are we still on for lunch?",
    sizeEstimate: 2100,
    subject: "Lunch?",
    from: { name: "Ann Lee", email: "ann@example.com" },
    to: [{ name: null, email: "me@example.com" }],
    cc: [],
    bcc: [],
    rfc822MessageId: "<CAF1abc@mail.example.com>",
    inReplyTo: null,
    references: [],
    bodyText: "Hi there, are we still on for lunch?",
    bodyHtml: null,
    attachments: [],
  },
};

/** multipart/alternative with both bodies. Header names arrive in mixed case. */
export const alternative: Fixture = {
  raw: {
    id: "18f0a1b2c3d4e600",
    threadId: "18f0a1b2c3d4e600",
    historyId: "100200",
    internalDate: "1700003600000",
    labelIds: ["INBOX", "STARRED"],
    snippet: "Weekly digest",
    sizeEstimate: 5400,
    payload: {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [
        { name: "SUBJECT", value: "Weekly digest" },
        { name: "from", value: '"Digest, The" <digest@news.example.com>' },
        { name: "To", value: "me@example.com, Bob <bob@example.com>" },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
          body: { size: 12, data: b64url("Plain digest") },
        },
        {
          partId: "1",
          mimeType: "text/html",
          filename: "",
          headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }],
          body: { size: 27, data: b64url("<p>Html <b>digest</b></p>\n") },
        },
      ],
    },
  },
  expected: {
    id: "18f0a1b2c3d4e600",
    threadId: "18f0a1b2c3d4e600",
    cursor: "100200",
    receivedAt: new Date(1_700_003_600_000),
    labelIds: ["INBOX", "STARRED"],
    isRead: true,
    snippet: "Weekly digest",
    sizeEstimate: 5400,
    subject: "Weekly digest",
    from: { name: "Digest, The", email: "digest@news.example.com" },
    to: [
      { name: null, email: "me@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ],
    cc: [],
    bcc: [],
    rfc822MessageId: null,
    inReplyTo: null,
    references: [],
    bodyText: "Plain digest",
    bodyHtml: "<p>Html <b>digest</b></p>\n",
    attachments: [],
  },
};

/** multipart/mixed: an alternative body plus a PDF attachment (metadata only, never the bytes). */
export const withAttachment: Fixture = {
  raw: {
    id: "18f0a1b2c3d4e700",
    threadId: "18f0a1b2c3d4e700",
    historyId: "100300",
    internalDate: "1700007200000",
    labelIds: ["INBOX"],
    snippet: "Report attached",
    sizeEstimate: 90_000,
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [
        { name: "Subject", value: "Q3 report" },
        { name: "From", value: "cfo@example.com" },
        { name: "To", value: "me@example.com" },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          filename: "",
          body: { size: 0 },
          parts: [
            {
              partId: "0.0",
              mimeType: "text/plain",
              filename: "",
              body: { size: 15, data: b64url("Report attached") },
            },
            {
              partId: "0.1",
              mimeType: "text/html",
              filename: "",
              body: { size: 24, data: b64url("<div>Report attached</div>") },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "q3-report.pdf",
          body: { attachmentId: "ANGjdJ_attachment_id", size: 88_123 },
        },
      ],
    },
  },
  expected: {
    id: "18f0a1b2c3d4e700",
    threadId: "18f0a1b2c3d4e700",
    cursor: "100300",
    receivedAt: new Date(1_700_007_200_000),
    labelIds: ["INBOX"],
    isRead: true,
    snippet: "Report attached",
    sizeEstimate: 90_000,
    subject: "Q3 report",
    from: { name: null, email: "cfo@example.com" },
    to: [{ name: null, email: "me@example.com" }],
    cc: [],
    bcc: [],
    rfc822MessageId: null,
    inReplyTo: null,
    references: [],
    bodyText: "Report attached",
    bodyHtml: "<div>Report attached</div>",
    attachments: [
      {
        partId: "1",
        filename: "q3-report.pdf",
        mimeType: "application/pdf",
        size: 88_123,
        attachmentId: "ANGjdJ_attachment_id",
      },
    ],
  },
};

/** A reply: In-Reply-To, References and Cc are present. */
export const reply: Fixture = {
  raw: {
    id: "18f0a1b2c3d4e800",
    threadId: "18f0a1b2c3d4e5f6",
    historyId: "100400",
    internalDate: "1700010800000",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Yes, noon works",
    sizeEstimate: 3300,
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "Subject", value: "Re: Lunch?" },
        { name: "From", value: "Ann Lee <ann@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "Cara <cara@example.com>, dan@example.com" },
        { name: "Message-ID", value: "<CAF2def@mail.example.com>" },
        { name: "In-Reply-To", value: "<CAF1abc@mail.example.com>" },
        {
          name: "References",
          value: "<CAF0root@mail.example.com>\r\n <CAF1abc@mail.example.com>",
        },
      ],
      body: { size: 15, data: b64url("Yes, noon works") },
    },
  },
  expected: {
    id: "18f0a1b2c3d4e800",
    threadId: "18f0a1b2c3d4e5f6",
    cursor: "100400",
    receivedAt: new Date(1_700_010_800_000),
    labelIds: ["INBOX", "UNREAD"],
    isRead: false,
    snippet: "Yes, noon works",
    sizeEstimate: 3300,
    subject: "Re: Lunch?",
    from: { name: "Ann Lee", email: "ann@example.com" },
    to: [{ name: null, email: "me@example.com" }],
    cc: [
      { name: "Cara", email: "cara@example.com" },
      { name: null, email: "dan@example.com" },
    ],
    bcc: [],
    rfc822MessageId: "<CAF2def@mail.example.com>",
    inReplyTo: "<CAF1abc@mail.example.com>",
    references: ["<CAF0root@mail.example.com>", "<CAF1abc@mail.example.com>"],
    bodyText: "Yes, noon works",
    bodyHtml: null,
    attachments: [],
  },
};

/** No Subject, To, From, Message-ID or labels, and an empty snippet: absent fields become null / [] / "". */
export const missingHeaders: Fixture = {
  raw: {
    id: "18f0a1b2c3d4e900",
    threadId: "18f0a1b2c3d4e900",
    historyId: "100500",
    internalDate: "1700014400000",
    sizeEstimate: 400,
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers: [{ name: "Date", value: "Tue, 14 Nov 2023 23:20:00 +0000" }],
      body: { size: 0 },
    },
  },
  expected: {
    id: "18f0a1b2c3d4e900",
    threadId: "18f0a1b2c3d4e900",
    cursor: "100500",
    receivedAt: new Date(1_700_014_400_000),
    labelIds: [],
    isRead: true,
    snippet: "",
    sizeEstimate: 400,
    subject: null,
    from: null,
    to: [],
    cc: [],
    bcc: [],
    rfc822MessageId: null,
    inReplyTo: null,
    references: [],
    bodyText: null,
    bodyHtml: null,
    attachments: [],
  },
};

export const allFixtures: Record<string, Fixture> = {
  plain,
  alternative,
  withAttachment,
  reply,
  missingHeaders,
};
