import type { gmail_v1 } from "googleapis";
import { UpstreamError } from "../../types/errors";
import type {
  AttachmentMeta,
  EmailAddress,
  ProviderMessage,
} from "../../types/provider";
import {
  decodeBytes,
  decodeEncodedWords,
  parseAddressList,
} from "./address";

// Gmail `users.messages.get` (format=full) response -> ProviderMessage, following the parsing
// rules of CONTRACT 4.3. Gmail-specific payload shapes stop here; nothing above this file sees them.

type Part = gmail_v1.Schema$MessagePart;

/** Case-insensitive header lookup. The first occurrence wins; an empty value counts as missing. */
function headerValue(part: Part | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const header of part?.headers ?? []) {
    if (header.name?.toLowerCase() === wanted) {
      const value = (header.value ?? "").trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function charsetOf(part: Part): string | undefined {
  const contentType = headerValue(part, "Content-Type");
  const match = contentType ? /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType) : null;
  return match?.[1];
}

/** Decodes `body.data` (base64url) using the part's charset, UTF-8 by default. */
function decodeBody(part: Part): string | null {
  const data = part.body?.data;
  if (!data) return null;
  return decodeBytes(Uint8Array.from(Buffer.from(data, "base64url")), charsetOf(part));
}

function isAttachment(part: Part): boolean {
  return (part.filename ?? "").length > 0;
}

/**
 * First non-attachment part with the given MIME type, depth first. A single-part message has no
 * `parts`, so the payload itself is the candidate.
 */
function findBody(part: Part, mimeType: string): string | null {
  if (!isAttachment(part) && part.mimeType?.toLowerCase() === mimeType) {
    const body = decodeBody(part);
    if (body !== null) return body;
  }
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function collectAttachments(part: Part, out: AttachmentMeta[]): void {
  if (isAttachment(part)) {
    out.push({
      partId: part.partId ?? "",
      filename: part.filename ?? "",
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      attachmentId: part.body?.attachmentId ?? null,
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
}

function addresses(payload: Part | undefined, name: string): EmailAddress[] {
  const value = headerValue(payload, name);
  return value === null ? [] : parseAddressList(value);
}

/** Subject and display names may carry RFC 2047 encoded words; plain text passes through unchanged. */
function decodedHeader(payload: Part | undefined, name: string): string | null {
  const value = headerValue(payload, name);
  return value === null ? null : decodeEncodedWords(value);
}

/**
 * @throws UpstreamError when the response lacks the fields every message has (`id`, `threadId`,
 *   `historyId`, `internalDate`), which means it is not a usable message.
 */
export function parseGmailMessage(raw: gmail_v1.Schema$Message): ProviderMessage {
  const { id, threadId, historyId, internalDate } = raw;
  const internalMs = Number(internalDate);
  if (!id || !threadId || !historyId || !Number.isFinite(internalMs)) {
    throw new UpstreamError("Gmail message is missing id, threadId, historyId or internalDate");
  }

  const payload = raw.payload ?? undefined;
  const labelIds = raw.labelIds ?? [];
  const references = headerValue(payload, "References");
  const attachments: AttachmentMeta[] = [];
  if (payload) collectAttachments(payload, attachments);

  return {
    id,
    threadId,
    cursor: historyId,
    receivedAt: new Date(internalMs),
    labelIds,
    // The one place `isRead` is derived, so it can never disagree with `labelIds`.
    isRead: !labelIds.includes("UNREAD"),
    snippet: raw.snippet ?? "",
    sizeEstimate: raw.sizeEstimate ?? 0,
    subject: decodedHeader(payload, "Subject"),
    from: addresses(payload, "From")[0] ?? null,
    to: addresses(payload, "To"),
    cc: addresses(payload, "Cc"),
    bcc: addresses(payload, "Bcc"),
    rfc822MessageId: headerValue(payload, "Message-ID"),
    inReplyTo: headerValue(payload, "In-Reply-To"),
    references: references === null ? [] : references.split(/\s+/),
    bodyText: payload ? findBody(payload, "text/plain") : null,
    bodyHtml: payload ? findBody(payload, "text/html") : null,
    attachments,
  };
}
