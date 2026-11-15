import { randomBytes } from "node:crypto";
import { EncryptionError } from "../../src/db/crypto";
import { InMemoryTokenRowStore } from "../../src/db/in-memory";
import { EncryptedTokenStore } from "../../src/db/token-store";

const ACCOUNT = "account-1";
const ACCESS = "ya29.plain-access-token";
const REFRESH = "1//plain-refresh-token";

function setup() {
  const rows = new InMemoryTokenRowStore();
  const store = new EncryptedTokenStore(rows, randomBytes(32));
  return { rows, store };
}

describe("EncryptedTokenStore", () => {
  it("stores only ciphertext: neither token appears in the stored row", async () => {
    const { rows, store } = setup();
    await store.saveTokens(ACCOUNT, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(1000),
    });
    const stored = JSON.stringify(rows.rows.get(ACCOUNT));
    expect(stored).not.toContain(ACCESS);
    expect(stored).not.toContain(REFRESH);
    expect(stored).not.toContain(Buffer.from(ACCESS).toString("base64"));
  });

  it("returns the plaintext tokens it was given", async () => {
    const { store } = setup();
    await store.saveTokens(ACCOUNT, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(1000),
    });
    expect(await store.getTokens(ACCOUNT)).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(1000),
    });
  });

  it("keeps the stored refresh token when a save omits it (a refresh event)", async () => {
    const { rows, store } = setup();
    await store.saveTokens(ACCOUNT, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(1000),
    });
    const refreshBefore = rows.rows.get(ACCOUNT)?.refreshTokenEnc;

    await store.saveTokens(ACCOUNT, {
      accessToken: "ya29.rotated",
      expiresAt: new Date(2000),
    });

    expect(rows.rows.get(ACCOUNT)?.refreshTokenEnc).toBe(refreshBefore);
    expect(await store.getTokens(ACCOUNT)).toEqual({
      accessToken: "ya29.rotated",
      refreshToken: REFRESH,
      expiresAt: new Date(2000),
    });
  });

  it("replaces the refresh token when a save provides a new one", async () => {
    const { store } = setup();
    await store.saveTokens(ACCOUNT, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(1000),
    });
    await store.saveTokens(ACCOUNT, {
      accessToken: ACCESS,
      refreshToken: "1//new-refresh",
      expiresAt: new Date(1000),
    });
    expect((await store.getTokens(ACCOUNT))?.refreshToken).toBe("1//new-refresh");
  });

  it("refuses a first save that has no refresh token", async () => {
    const { store } = setup();
    await expect(
      store.saveTokens(ACCOUNT, { accessToken: ACCESS, expiresAt: new Date(1) }),
    ).rejects.toThrow("no refresh token");
  });

  it("returns null for an account with no tokens", async () => {
    const { store } = setup();
    expect(await store.getTokens("unknown")).toBeNull();
  });

  it("fails loudly when a stored value no longer authenticates", async () => {
    const { rows, store } = setup();
    await store.saveTokens(ACCOUNT, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(1000),
    });
    const row = rows.rows.get(ACCOUNT);
    if (!row) throw new Error("row missing");
    const bytes = Buffer.from(row.accessTokenEnc, "base64");
    bytes[13] = (bytes[13] ?? 0) ^ 0xff;
    rows.rows.set(ACCOUNT, { ...row, accessTokenEnc: bytes.toString("base64") });

    await expect(store.getTokens(ACCOUNT)).rejects.toThrow(EncryptionError);
  });
});
