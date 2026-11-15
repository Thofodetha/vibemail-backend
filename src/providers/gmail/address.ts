import type { EmailAddress } from "../../types/provider";

/** Decodes bytes with a charset label from a header or Content-Type, falling back to UTF-8 for unknown labels. */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").replace(/\*.*$/, "").trim().toLowerCase();
  try {
    return new TextDecoder(label || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQ(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const hex = text.slice(i + 1, i + 3);
    if (ch === "_") {
      out.push(0x20);
    } else if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0));
    }
  }
  return Uint8Array.from(out);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/** Decodes RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`). Plain text passes through. */
export function decodeEncodedWords(value: string): string {
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = value.replace(
    /(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g,
    "$1",
  );
  return joined.replace(ENCODED_WORD, (_match, charset: string, enc: string, text: string) => {
    const bytes =
      enc.toLowerCase() === "b"
        ? Uint8Array.from(Buffer.from(text, "base64"))
        : decodeQ(text);
    return decodeBytes(bytes, charset);
  });
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** Splits an address list on top-level commas, ignoring commas inside quotes, angle brackets and comments. */
function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (inQuotes) {
      current += ch;
      if (ch === "\\") {
        current += value.charAt(i + 1);
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (ch === "(") {
      comment += 1;
      current += ch;
    } else if (ch === ")" && comment > 0) {
      comment -= 1;
      current += ch;
    } else if (comment > 0) {
      current += ch;
    } else if (ch === "<") {
      angle += 1;
      current += ch;
    } else if (ch === ">" && angle > 0) {
      angle -= 1;
      current += ch;
    } else if (angle > 0) {
      current += ch;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else if (ch === ":" || ch === ";") {
      // Group syntax (`Team: a@x.com, b@y.com;`): drop the group label and the terminator.
      if (ch === ":") current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseOne(part: string): EmailAddress | null {
  const angle = /^(.*)<([^<>]*)>\s*(?:\(.*\))?\s*$/s.exec(part);
  if (angle) {
    const email = (angle[2] ?? "").trim();
    if (!email.includes("@")) return null;
    const name = decodeEncodedWords(unquote(angle[1] ?? ""));
    return { name: name.length > 0 ? name : null, email };
  }
  // Bare address, optionally followed by a comment holding the name: `a@b.com (Ann)`.
  const bare = /^([^\s()<>]+@[^\s()<>]+)\s*(?:\((.*)\))?\s*$/s.exec(part);
  if (bare) {
    const name = decodeEncodedWords((bare[2] ?? "").trim());
    return { name: name.length > 0 ? name : null, email: (bare[1] ?? "").trim() };
  }
  return null;
}

/**
 * Parses an RFC 5322 address list header. Display names are unquoted and RFC 2047-decoded; an
 * empty name is `null`. Entries with no address (such as `undisclosed-recipients:;`) are dropped.
 */
export function parseAddressList(value: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const part of splitAddresses(value)) {
    const parsed = parseOne(part);
    if (parsed) out.push(parsed);
  }
  return out;
}
