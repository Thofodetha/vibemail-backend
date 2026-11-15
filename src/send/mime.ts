import { randomBytes } from "node:crypto";
import { ValidationError } from "../types/errors";
import type { EmailAddress } from "../types/provider";
import { hasLineBreak, isValidEmail, normalizeMessageId, type SendRequest } from "./request";

// Builds the RFC 5322 (RFC 2822) message the provider sends. Headers use CRLF, non-ASCII header
// text is RFC 2047 encoded, bodies are UTF-8 transported as base64. The result is a complete
// message; the Gmail provider base64url-encodes it for the API.

const CRLF = "\r\n";

/** Printable ASCII, no CR or LF: safe to put in a header as it is. */
function isPlainAscii(text: string): boolean {
  return /^[ -~]*$/.test(text);
}

/** At most 45 bytes per word: `=?UTF-8?B?` + 60 base64 characters + `?=` is 73, under the 75 limit. */
const ENCODED_WORD_BYTES = 45;

/**
 * RFC 2047 encodes text that is not plain ASCII, as folded `=?UTF-8?B?...?=` words. A word is
 * never split inside a character. Plain ASCII passes through.
 */
export function encodeHeaderText(text: string): string {
  if (isPlainAscii(text)) return text;
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length > 0) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = [];
    }
  };
  for (const char of text) {
    const bytes = Buffer.from(char, "utf8");
    if (chunk.length + bytes.length > ENCODED_WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(`${CRLF} `);
}

/** A display name as an RFC 5322 phrase: bare, quoted when it holds specials, encoded when non-ASCII. */
function formatPhrase(name: string): string {
  if (!isPlainAscii(name)) return encodeHeaderText(name);
  if (/[()<>[\]:;@\\,."]/.test(name)) {
    return `"${name.replace(/[\\"]/g, "\\$&")}"`;
  }
  return name;
}

export function formatAddress(address: EmailAddress): string {
  if (hasLineBreak(address.email) || !isValidEmail(address.email)) {
    throw new ValidationError({ email: "is not a valid email address" });
  }
  if (address.name === null || address.name.length === 0) return address.email;
  if (hasLineBreak(address.name)) {
    throw new ValidationError({ name: "must not contain a line break" });
  }
  return `${formatPhrase(address.name)} <${address.email}>`;
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses.map(formatAddress).join(`,${CRLF} `);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Tue, 14 Nov 2023 22:13:20 +0000` */
export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/** UTF-8 text as base64 in 76-character lines. */
function encodeBody(text: string): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return (base64.match(/.{1,76}/g) ?? []).join(CRLF);
}

interface Part {
  headers: string[];
  content: string;
}

function textPart(contentType: "text/plain" | "text/html", text: string): Part {
  return {
    headers: [
      `Content-Type: ${contentType}; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
    ],
    content: encodeBody(text),
  };
}

function messageIdHeader(value: string): string {
  const id = normalizeMessageId(value);
  if (id === null) throw new ValidationError({ messageId: "is not a valid Message-ID" });
  return id;
}

export interface BuildOptions {
  /** The `Date` header. Defaults to now. */
  date?: Date;
  /** The multipart boundary. Defaults to a random one. */
  boundary?: string;
}

/**
 * Builds the message. `from` is the signed-in account's address.
 *
 * - Both bodies present: `multipart/alternative`, plain text first and HTML last (the preferred form).
 * - A reply carries `In-Reply-To` and `References`, which is what makes other mail clients thread it.
 * - `Bcc` is included: Gmail delivers to those recipients and removes the header from other copies.
 *
 * @throws ValidationError if anything bound for a header holds a line break or is not valid.
 */
export function buildMime(
  request: SendRequest,
  from: string,
  options: BuildOptions = {},
): string {
  if (request.bodyText === undefined && request.bodyHtml === undefined) {
    throw new ValidationError({ body: "at least one of bodyText and bodyHtml is required" });
  }
  if (hasLineBreak(request.subject)) {
    throw new ValidationError({ subject: "must not contain a line break" });
  }

  const headers: string[] = [
    `From: ${formatAddress({ name: null, email: from })}`,
    `To: ${formatAddressList(request.to)}`,
  ];
  if (request.cc.length > 0) headers.push(`Cc: ${formatAddressList(request.cc)}`);
  if (request.bcc.length > 0) headers.push(`Bcc: ${formatAddressList(request.bcc)}`);
  headers.push(`Subject: ${encodeHeaderText(request.subject)}`);
  headers.push(`Date: ${formatDate(options.date ?? new Date())}`);
  headers.push("MIME-Version: 1.0");

  if (request.inReplyTo !== undefined) {
    headers.push(`In-Reply-To: ${messageIdHeader(request.inReplyTo)}`);
    const references = (request.references ?? [request.inReplyTo]).map(messageIdHeader);
    headers.push(`References: ${references.join(`${CRLF} `)}`);
  }

  let body: string;
  if (request.bodyText !== undefined && request.bodyHtml !== undefined) {
    const boundary = options.boundary ?? `vibemail_${randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const inPart = (part: Part) => [`--${boundary}`, ...part.headers, "", part.content];
    body = [
      ...inPart(textPart("text/plain", request.bodyText)),
      ...inPart(textPart("text/html", request.bodyHtml)),
      `--${boundary}--`,
    ].join(CRLF);
  } else {
    const part =
      request.bodyHtml !== undefined
        ? textPart("text/html", request.bodyHtml)
        : textPart("text/plain", request.bodyText ?? "");
    headers.push(...part.headers);
    body = part.content;
  }

  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}
