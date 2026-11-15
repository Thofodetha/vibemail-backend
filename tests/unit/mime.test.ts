import { decodeEncodedWords, parseAddressList } from "../../src/providers/gmail/address";
import { buildMime, encodeHeaderText, formatDate } from "../../src/send/mime";
import { parseSendRequest, type SendRequest } from "../../src/send/request";
import { ValidationError } from "../../src/types/errors";

const FROM = "me@example.com";
const DATE = new Date("2023-11-14T22:13:20.000Z");

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    to: [{ name: null, email: "you@example.com" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    bodyText: "Hi there",
    ...overrides,
  };
}

/** Splits a message into unfolded headers (first value wins) and the body. */
function parse(message: string) {
  const split = message.indexOf("\r\n\r\n");
  const headerBlock = message.slice(0, split);
  const body = message.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of headerBlock.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body, headerBlock };
}

const decode = (base64Lines: string) =>
  Buffer.from(base64Lines.replace(/\r\n/g, ""), "base64").toString("utf8");

describe("buildMime: plain text", () => {
  const built = buildMime(request(), FROM, { date: DATE });
  const { headers, body } = parse(built);

  it("has the standard headers, with From as the signed-in account", () => {
    expect(headers.get("from")).toBe(FROM);
    expect(headers.get("to")).toBe("you@example.com");
    expect(headers.get("subject")).toBe("Hello");
    expect(headers.get("date")).toBe("Tue, 14 Nov 2023 22:13:20 +0000");
    expect(headers.get("mime-version")).toBe("1.0");
    expect(headers.get("content-type")).toBe('text/plain; charset="UTF-8"');
    expect(headers.get("content-transfer-encoding")).toBe("base64");
  });

  it("carries the UTF-8 body as base64", () => {
    expect(decode(body)).toBe("Hi there");
  });

  it("uses CRLF throughout, with no bare LF, and ends with a line break", () => {
    expect(built).not.toMatch(/(?<!\r)\n/);
    expect(built.endsWith("\r\n")).toBe(true);
  });

  it("omits Cc, Bcc and the reply headers when there are none", () => {
    expect(headers.has("cc")).toBe(false);
    expect(headers.has("bcc")).toBe(false);
    expect(headers.has("in-reply-to")).toBe(false);
    expect(headers.has("references")).toBe(false);
  });

  it("wraps long bodies at 76 characters", () => {
    const long = parse(buildMime(request({ bodyText: "x".repeat(5000) }), FROM));
    const lines = long.body.trimEnd().split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(decode(long.body)).toBe("x".repeat(5000));
  });

  it("allows an empty body", () => {
    expect(decode(parse(buildMime(request({ bodyText: "" }), FROM)).body)).toBe("");
  });
});

describe("buildMime: HTML and alternatives", () => {
  it("sends an HTML-only message as text/html", () => {
    const { headers, body } = parse(
      buildMime(request({ bodyText: undefined, bodyHtml: "<p>Hi</p>" }), FROM),
    );
    expect(headers.get("content-type")).toBe('text/html; charset="UTF-8"');
    expect(decode(body)).toBe("<p>Hi</p>");
  });

  it("sends both as multipart/alternative, plain first and HTML last", () => {
    const built = buildMime(request({ bodyHtml: "<p>Hi <b>there</b></p>" }), FROM, {
      boundary: "BOUND",
    });
    const { headers, body } = parse(built);
    expect(headers.get("content-type")).toBe('multipart/alternative; boundary="BOUND"');
    expect(headers.has("content-transfer-encoding")).toBe(false);

    const parts = body.split("--BOUND").slice(1, -1);
    expect(parts).toHaveLength(2);
    expect(body.trimEnd().endsWith("--BOUND--")).toBe(true);

    const [plain, html] = parts.map(parse2);
    expect(plain?.type).toBe('text/plain; charset="UTF-8"');
    expect(plain && decode(plain.content)).toBe("Hi there");
    expect(html?.type).toBe('text/html; charset="UTF-8"');
    expect(html && decode(html.content)).toBe("<p>Hi <b>there</b></p>");
  });

  it("uses a different random boundary each time", () => {
    const a = buildMime(request({ bodyHtml: "<p>x</p>" }), FROM);
    const b = buildMime(request({ bodyHtml: "<p>x</p>" }), FROM);
    const boundary = (m: string) => /boundary="([^"]+)"/.exec(m)?.[1];
    expect(boundary(a)).toBeDefined();
    expect(boundary(a)).not.toBe(boundary(b));
  });
});

/** Parses one multipart part: its Content-Type and the content after the blank line. */
function parse2(part: string) {
  const text = part.replace(/^\r\n/, "");
  const split = text.indexOf("\r\n\r\n");
  const type = /Content-Type: ([^\r\n]+)/.exec(text.slice(0, split))?.[1];
  return { type, content: text.slice(split + 4).replace(/\r\n$/, "") };
}

describe("buildMime: recipients", () => {
  it("round-trips names, including quoted, comma and non-ASCII ones", () => {
    const to = [
      { name: "Ann Lee", email: "ann@example.com" },
      { name: "Lee, Ann", email: "lee@example.com" },
      { name: 'Ann "AJ" Lee', email: "aj@example.com" },
      { name: "Jürgen Müller", email: "j@example.com" },
      { name: "王小明 👋", email: "w@example.com" },
      { name: null, email: "plain@example.com" },
    ];
    const { headers } = parse(buildMime(request({ to }), FROM));
    expect(parseAddressList(headers.get("to") ?? "")).toEqual(to);
  });

  it("writes Cc and Bcc", () => {
    const { headers } = parse(
      buildMime(
        request({
          cc: [{ name: "Cara", email: "cara@example.com" }],
          bcc: [{ name: null, email: "secret@example.com" }],
        }),
        FROM,
      ),
    );
    expect(parseAddressList(headers.get("cc") ?? "")).toEqual([
      { name: "Cara", email: "cara@example.com" },
    ]);
    expect(headers.get("bcc")).toBe("secret@example.com");
  });
});

describe("buildMime: subject", () => {
  it("leaves a plain ASCII subject as it is", () => {
    expect(parse(buildMime(request({ subject: "Re: Q3 plan (draft)" }), FROM)).headers.get("subject")).toBe(
      "Re: Q3 plan (draft)",
    );
  });

  it("RFC 2047 encodes a non-ASCII subject and it decodes back", () => {
    const subject = "Grüße aus München 👋";
    const encoded = parse(buildMime(request({ subject }), FROM)).headers.get("subject") ?? "";
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeEncodedWords(encoded)).toBe(subject);
  });

  it("splits a long non-ASCII subject into words of at most 75 characters, never inside a character", () => {
    const subject = "é中👋".repeat(60);
    const folded = encodeHeaderText(subject);
    const words = folded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((w) => w.length <= 75)).toBe(true);
    expect(decodeEncodedWords(folded)).toBe(subject);
    expect(decodeEncodedWords(folded)).not.toContain("�");
  });

  it.each([
    ["2-byte characters", "é"],
    ["3-byte characters", "中"],
    ["4-byte characters", "👋"],
  ])("keeps every encoded word within 75 characters for %s", (_label, char) => {
    // A pattern whose byte length does not divide 45, so the limit falls inside a character.
    const subject = char.repeat(41);
    const folded = encodeHeaderText(subject);
    expect(folded.split("\r\n ").every((word) => word.length <= 75)).toBe(true);
    expect(decodeEncodedWords(folded)).toBe(subject);
  });

  it("allows an empty subject", () => {
    expect(parse(buildMime(request({ subject: "" }), FROM)).headers.get("subject")).toBe("");
  });
});

describe("buildMime: replies", () => {
  it("sets In-Reply-To and References, defaulting References to the reply target", () => {
    const parsed = parseSendRequest({
      to: [{ email: "you@example.com" }],
      subject: "Re: Hello",
      bodyText: "ok",
      threadId: "18f0a1b2c3d4e5f6",
      inReplyTo: "CAF1abc@mail.example.com",
    });
    const { headers } = parse(buildMime(parsed, FROM));
    expect(headers.get("in-reply-to")).toBe("<CAF1abc@mail.example.com>");
    expect(headers.get("references")).toBe("<CAF1abc@mail.example.com>");
  });

  it("writes every given reference, in order", () => {
    const { headers } = parse(
      buildMime(
        request({
          inReplyTo: "<b@x.com>",
          references: ["<a@x.com>", "<b@x.com>"],
        }),
        FROM,
      ),
    );
    expect(headers.get("references")).toBe("<a@x.com> <b@x.com>");
  });
});

describe("buildMime: header injection", () => {
  const attacks: [string, Partial<SendRequest>][] = [
    ["a subject with a line break", { subject: "Hi\r\nBcc: evil@example.com" }],
    ["a subject with a bare LF", { subject: "Hi\nBcc: evil@example.com" }],
    ["a display name with a line break", { to: [{ name: "A\r\nBcc: evil@example.com", email: "a@example.com" }] }],
    ["an address with a line break", { to: [{ name: null, email: "a@example.com\r\nBcc: evil@example.com" }] }],
    ["an invalid address", { to: [{ name: null, email: "not-an-address" }] }],
    ["a Message-ID with whitespace", { inReplyTo: "<a b@x.com>" }],
    ["a Message-ID with a line break", { inReplyTo: "<a@x.com>\r\nBcc: evil@example.com" }],
  ];

  it.each(attacks)("refuses %s, even when validation was bypassed", (_label, overrides) => {
    expect(() => buildMime(request(overrides), FROM)).toThrow(ValidationError);
  });

  it("refuses a From address with a line break", () => {
    expect(() => buildMime(request(), "me@example.com\r\nBcc: evil@example.com")).toThrow(
      ValidationError,
    );
  });

  it("refuses a request with no body at all", () => {
    expect(() => buildMime(request({ bodyText: undefined }), FROM)).toThrow(ValidationError);
  });
});

describe("formatDate", () => {
  it("formats in the RFC 5322 form, zero-padded, in UTC", () => {
    expect(formatDate(new Date("2024-02-03T04:05:06.000Z"))).toBe("Sat, 03 Feb 2024 04:05:06 +0000");
  });
});
