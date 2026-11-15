import { ValidationError } from "../types/errors";
import type { EmailAddress } from "../types/provider";

// The send request of CONTRACT 3.3, validated. Everything that ends up in a message header is
// checked for line breaks here and again in the MIME builder, because a CR or LF in a header value
// lets a caller inject headers (extra recipients, a forged From).

export const MAX_RECIPIENTS = 100;
export const MAX_SUBJECT_LENGTH = 998;
/** The most body text (plain plus HTML, UTF-8 bytes) one message may carry. */
export const MAX_BODY_BYTES = 1_048_576;

/** A validated send request. `cc` and `bcc` default to empty; `references` is set whenever `inReplyTo` is. */
export interface SendRequest {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
  /** The RFC 822 Message-ID being replied to, in `<id>` form. */
  inReplyTo?: string;
  /** In `<id>` form. Defaults to `[inReplyTo]`. */
  references?: string[];
}

const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const LOCAL_PART = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Plain ASCII addresses only: `local@domain.tld`. Internationalised addresses are not supported. */
export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split(".");
  return (
    local.length <= 64 &&
    LOCAL_PART.test(local) &&
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label))
  );
}

export function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/** `abc@x.com` or `<abc@x.com>` -> `<abc@x.com>`. Null when it cannot be a Message-ID. */
export function normalizeMessageId(value: string): string | null {
  let id = value.trim();
  if (id.startsWith("<") && id.endsWith(">")) id = id.slice(1, -1);
  if (id.length === 0 || id.length > 998) return null;
  if (/[\s<>]/.test(id) || CONTROL_CHARS.test(id)) return null;
  return `<${id}>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAddresses(
  value: unknown,
  field: "to" | "cc" | "bcc",
  required: boolean,
  errors: Record<string, string>,
): EmailAddress[] {
  if (value === undefined) {
    if (required) errors[field] = "is required";
    return [];
  }
  if (!Array.isArray(value)) {
    errors[field] = "must be an array of { name?, email }";
    return [];
  }
  if (required && value.length === 0) errors[field] = "needs at least one recipient";
  const out: EmailAddress[] = [];
  value.forEach((entry: unknown, index) => {
    const path = `${field}[${index}]`;
    if (!isRecord(entry)) {
      errors[path] = "must be { name?, email }";
      return;
    }
    const { email, name } = entry;
    if (typeof email !== "string" || !isValidEmail(email)) {
      errors[`${path}.email`] = "is not a valid email address";
      return;
    }
    if (name !== undefined && name !== null) {
      if (typeof name !== "string") {
        errors[`${path}.name`] = "must be a string";
        return;
      }
      if (hasLineBreak(name)) {
        errors[`${path}.name`] = "must not contain a line break";
        return;
      }
    }
    out.push({ name: typeof name === "string" && name.length > 0 ? name : null, email });
  });
  return out;
}

/**
 * Validates a send request body (CONTRACT 3.3).
 *
 * @throws ValidationError listing every problem found, keyed by field.
 */
export function parseSendRequest(input: unknown): SendRequest {
  if (!isRecord(input)) {
    throw new ValidationError({ body: "must be a JSON object" });
  }
  const errors: Record<string, string> = {};

  const to = parseAddresses(input.to, "to", true, errors);
  const cc = parseAddresses(input.cc, "cc", false, errors);
  const bcc = parseAddresses(input.bcc, "bcc", false, errors);
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    errors.to = `to, cc and bcc together may hold at most ${MAX_RECIPIENTS} recipients`;
  }

  const { subject } = input;
  if (typeof subject !== "string") {
    errors.subject = "is required and must be a string";
  } else if (subject.length > MAX_SUBJECT_LENGTH) {
    errors.subject = `must be at most ${MAX_SUBJECT_LENGTH} characters`;
  } else if (hasLineBreak(subject)) {
    errors.subject = "must not contain a line break";
  }

  const { bodyText, bodyHtml } = input;
  if (bodyText !== undefined && typeof bodyText !== "string") {
    errors.bodyText = "must be a string";
  }
  if (bodyHtml !== undefined && typeof bodyHtml !== "string") {
    errors.bodyHtml = "must be a string";
  }
  if (bodyText === undefined && bodyHtml === undefined) {
    errors.body = "at least one of bodyText and bodyHtml is required";
  }

  const { threadId, inReplyTo, references } = input;
  if (threadId !== undefined && (typeof threadId !== "string" || !THREAD_ID.test(threadId))) {
    errors.threadId = "is not a valid thread id";
  }
  let replyId: string | undefined;
  if (inReplyTo !== undefined) {
    const normalized = typeof inReplyTo === "string" ? normalizeMessageId(inReplyTo) : null;
    if (normalized === null) errors.inReplyTo = "is not a valid Message-ID";
    else replyId = normalized;
  }
  if ((threadId === undefined) !== (inReplyTo === undefined)) {
    errors.threadId = "threadId and inReplyTo must be given together";
  }

  let referenceIds: string[] | undefined;
  if (references !== undefined) {
    if (inReplyTo === undefined) {
      errors.references = "needs inReplyTo";
    } else if (!Array.isArray(references)) {
      errors.references = "must be an array of Message-IDs";
    } else {
      const normalized = references.map((r: unknown) =>
        typeof r === "string" ? normalizeMessageId(r) : null,
      );
      if (normalized.some((r) => r === null)) {
        errors.references = "contains an invalid Message-ID";
      } else {
        referenceIds = normalized.filter((r): r is string => r !== null);
      }
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  return {
    to,
    cc,
    bcc,
    subject: subject as string,
    bodyText: bodyText as string | undefined,
    bodyHtml: bodyHtml as string | undefined,
    threadId: threadId as string | undefined,
    inReplyTo: replyId,
    references: replyId === undefined ? undefined : (referenceIds ?? [replyId]),
  };
}
