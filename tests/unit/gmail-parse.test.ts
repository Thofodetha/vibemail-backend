import type { gmail_v1 } from "googleapis";
import {
  decodeEncodedWords,
  parseAddressList,
} from "../../src/providers/gmail/address";
import { parseGmailMessage } from "../../src/providers/gmail/parse";
import { UpstreamError } from "../../src/types/errors";
import { allFixtures, b64url, plain } from "./fixtures/gmail";

type Raw = gmail_v1.Schema$Message;

function withPayload(payload: gmail_v1.Schema$MessagePart): Raw {
  return { ...plain.raw, payload };
}

describe("parseGmailMessage on recorded fixtures", () => {
  for (const [name, fixture] of Object.entries(allFixtures)) {
    it(`parses the ${name} message to exactly the section 4.3 model`, () => {
      expect(parseGmailMessage(fixture.raw)).toEqual(fixture.expected);
    });
  }
});

describe("parseGmailMessage rules", () => {
  it("derives isRead from the UNREAD label, in one place", () => {
    const unread = parseGmailMessage({ ...plain.raw, labelIds: ["INBOX", "UNREAD"] });
    const read = parseGmailMessage({ ...plain.raw, labelIds: ["INBOX", "STARRED"] });
    expect(unread.isRead).toBe(false);
    expect(read.isRead).toBe(true);
    // Starred is not a column: it stays visible as a label.
    expect(read.labelIds).toContain("STARRED");
  });

  it("matches header names case-insensitively and takes the first occurrence", () => {
    const message = parseGmailMessage(
      withPayload({
        mimeType: "text/plain",
        headers: [
          { name: "sUbJeCt", value: "First" },
          { name: "SUBJECT", value: "Second" },
          { name: "FROM", value: "x@example.com" },
        ],
        body: { data: b64url("x") },
      }),
    );
    expect(message.subject).toBe("First");
    expect(message.from?.email).toBe("x@example.com");
  });

  it("treats an empty header value as missing, never as an empty string", () => {
    const message = parseGmailMessage(
      withPayload({
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "   " }],
        body: { data: b64url("x") },
      }),
    );
    expect(message.subject).toBeNull();
  });

  it("reads a single-part text/html message from payload.body.data", () => {
    const message = parseGmailMessage(
      withPayload({
        mimeType: "text/html",
        headers: [],
        body: { data: b64url("<p>only html</p>") },
      }),
    );
    expect(message.bodyHtml).toBe("<p>only html</p>");
    expect(message.bodyText).toBeNull();
  });

  it("decodes base64url bodies, including characters that differ from plain base64", () => {
    const text = "?>?>?> ~~~ é中👋";
    const message = parseGmailMessage(
      withPayload({ mimeType: "text/plain", headers: [], body: { data: b64url(text) } }),
    );
    expect(message.bodyText).toBe(text);
  });

  it("decodes a body using the part's charset", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url"); // "café"
    const message = parseGmailMessage(
      withPayload({
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }],
        body: { data: latin1 },
      }),
    );
    expect(message.bodyText).toBe("café");
  });

  it("takes the first matching part depth-first, through nested multiparts", () => {
    const message = parseGmailMessage(
      withPayload({
        mimeType: "multipart/mixed",
        headers: [],
        parts: [
          {
            mimeType: "multipart/related",
            parts: [
              { mimeType: "text/html", body: { data: b64url("<i>nested</i>") } },
              { mimeType: "text/html", body: { data: b64url("<i>second</i>") } },
            ],
          },
          { mimeType: "text/plain", body: { data: b64url("after") } },
        ],
      }),
    );
    expect(message.bodyHtml).toBe("<i>nested</i>");
    expect(message.bodyText).toBe("after");
  });

  it("never uses an attachment part as the body, but lists it", () => {
    const message = parseGmailMessage(
      withPayload({
        mimeType: "multipart/mixed",
        headers: [],
        parts: [
          {
            partId: "0",
            mimeType: "text/plain",
            filename: "notes.txt",
            body: { attachmentId: "att-1", size: 10, data: b64url("secret notes") },
          },
          { partId: "1", mimeType: "text/plain", body: { data: b64url("real body") } },
        ],
      }),
    );
    expect(message.bodyText).toBe("real body");
    expect(message.attachments).toEqual([
      { partId: "0", filename: "notes.txt", mimeType: "text/plain", size: 10, attachmentId: "att-1" },
    ]);
  });

  it("decodes RFC 2047 words in the subject and in display names", () => {
    const subject = `=?UTF-8?B?${Buffer.from("Grüße 👋").toString("base64")}?=`;
    const message = parseGmailMessage(
      withPayload({
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: subject },
          { name: "From", value: "=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <j@example.com>" },
        ],
        body: { data: b64url("x") },
      }),
    );
    expect(message.subject).toBe("Grüße 👋");
    expect(message.from).toEqual({ name: "Jürgen Müller", email: "j@example.com" });
  });

  it.each(["id", "threadId", "historyId", "internalDate"] as const)(
    "rejects a response with no %s",
    (field) => {
      expect(() => parseGmailMessage({ ...plain.raw, [field]: undefined })).toThrow(
        UpstreamError,
      );
    },
  );
});

describe("parseAddressList", () => {
  it("keeps a comma inside a quoted display name", () => {
    expect(parseAddressList('"Lee, Ann" <ann@x.com>, bob@y.com')).toEqual([
      { name: "Lee, Ann", email: "ann@x.com" },
      { name: null, email: "bob@y.com" },
    ]);
  });

  it("unescapes quotes inside a quoted name", () => {
    expect(parseAddressList('"Ann \\"AJ\\" Lee" <ann@x.com>')).toEqual([
      { name: 'Ann "AJ" Lee', email: "ann@x.com" },
    ]);
  });

  it("gives an empty display name as null", () => {
    expect(parseAddressList("<ann@x.com>")).toEqual([{ name: null, email: "ann@x.com" }]);
    expect(parseAddressList('"" <ann@x.com>')).toEqual([{ name: null, email: "ann@x.com" }]);
  });

  it("reads a name given as a trailing comment", () => {
    expect(parseAddressList("ann@x.com (Ann Lee)")).toEqual([
      { name: "Ann Lee", email: "ann@x.com" },
    ]);
  });

  it("drops entries with no address, such as an empty group", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList("not an address")).toEqual([]);
  });

  it("flattens a group's members", () => {
    expect(parseAddressList("Team: a@x.com, Bee <b@x.com>;")).toEqual([
      { name: null, email: "a@x.com" },
      { name: "Bee", email: "b@x.com" },
    ]);
  });
});

describe("decodeEncodedWords", () => {
  it("joins adjacent encoded words without the whitespace between them", () => {
    const a = `=?UTF-8?B?${Buffer.from("Hel").toString("base64")}?=`;
    const b = `=?UTF-8?B?${Buffer.from("lo").toString("base64")}?=`;
    expect(decodeEncodedWords(`${a} ${b}`)).toBe("Hello");
  });

  it("leaves ordinary text alone", () => {
    expect(decodeEncodedWords("Plain subject: 1 + 1 = 2")).toBe("Plain subject: 1 + 1 = 2");
  });

  it("falls back to UTF-8 for an unknown charset instead of throwing", () => {
    expect(decodeEncodedWords("=?x-unknown?Q?abc?=")).toBe("abc");
  });
});
