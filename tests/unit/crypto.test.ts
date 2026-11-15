import { randomBytes } from "node:crypto";
import {
  decryptSecret,
  EncryptionError,
  encryptSecret,
  loadEncryptionKey,
  parseEncryptionKey,
} from "../../src/db/crypto";

const key = randomBytes(32);

describe("AES-256-GCM secrets", () => {
  it("round-trips a value, including non-ASCII text", () => {
    const secret = "ya29.a0-token/with+odd=chars é中";
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it("uses a fresh IV every time, so equal values encrypt differently", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a).not.toBe(b);
  });

  it("stores base64 of IV (12) + ciphertext + tag (16), with no plaintext visible", () => {
    const secret = "plain-access-token";
    const stored = encryptSecret(secret, key);
    const bytes = Buffer.from(stored, "base64");
    expect(bytes.length).toBe(12 + Buffer.byteLength(secret) + 16);
    expect(stored).not.toContain(secret);
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
  });

  it("rejects a tampered value instead of returning garbage", () => {
    const bytes = Buffer.from(encryptSecret("secret", key), "base64");
    bytes[14] = (bytes[14] ?? 0) ^ 0xff;
    expect(() => decryptSecret(bytes.toString("base64"), key)).toThrow(
      EncryptionError,
    );
  });

  it("rejects a value encrypted under another key", () => {
    const stored = encryptSecret("secret", randomBytes(32));
    expect(() => decryptSecret(stored, key)).toThrow(EncryptionError);
  });

  it("rejects a value too short to hold an IV and a tag", () => {
    expect(() => decryptSecret("AAAA", key)).toThrow(EncryptionError);
  });

  it("never puts the plaintext or the stored value in an error message", () => {
    const stored = encryptSecret("super-secret", randomBytes(32));
    try {
      decryptSecret(stored, key);
      throw new Error("expected decryptSecret to throw");
    } catch (error) {
      expect(String(error)).not.toContain("super-secret");
      expect(String(error)).not.toContain(stored);
    }
  });
});

describe("ENCRYPTION_KEY parsing", () => {
  it("accepts 32 bytes as base64 (the contract format)", () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString("base64")).equals(raw)).toBe(true);
  });

  it("also accepts 64 hex characters", () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString("hex")).equals(raw)).toBe(true);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(
      EncryptionError,
    );
  });

  it("rejects text that is neither base64 nor hex", () => {
    expect(() => parseEncryptionKey("not a key!")).toThrow(EncryptionError);
  });

  it("reads the key from the environment and fails when it is missing", () => {
    const raw = randomBytes(32);
    expect(
      loadEncryptionKey({ ENCRYPTION_KEY: raw.toString("base64") }).equals(raw),
    ).toBe(true);
    expect(() => loadEncryptionKey({})).toThrow(EncryptionError);
  });
});
