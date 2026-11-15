import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for secrets at rest (CONTRACT 1.9).
// Stored form: base64( IV (12 bytes) || ciphertext || auth tag (16 bytes) ).

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Raised for any key, format or authentication failure. Messages never contain secrets. */
export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

/**
 * Parses `ENCRYPTION_KEY` into 32 raw bytes.
 * The contract specifies base64; a 64-character hex string is also accepted.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    key = Buffer.from(value, "base64");
  } else {
    throw new EncryptionError(
      "ENCRYPTION_KEY must be 32 bytes, base64-encoded (or 64 hex characters)",
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes`,
    );
  }
  return key;
}

/** Reads and parses `ENCRYPTION_KEY` from the environment. */
export function loadEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionError("ENCRYPTION_KEY is not set");
  }
  return parseEncryptionKey(raw);
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

/** Throws `EncryptionError` if the value is malformed, tampered with, or the key is wrong. */
export function decryptSecret(stored: string, key: Buffer): string {
  const bytes = Buffer.from(stored, "base64");
  if (bytes.length < IV_BYTES + TAG_BYTES) {
    throw new EncryptionError("encrypted value is malformed");
  }
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new EncryptionError("encrypted value failed authentication");
  }
}
