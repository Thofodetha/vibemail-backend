import type { StoredTokens, TokenStore } from "../types/stores";
import { decryptSecret, encryptSecret } from "./crypto";

/** What the database holds: ciphertext only. Implemented by Supabase and by an in-memory fake. */
export interface TokenRowStore {
  get(accountId: string): Promise<{
    accessTokenEnc: string;
    refreshTokenEnc: string;
    expiresAt: Date;
  } | null>;
  /**
   * Writes the access token and expiry. `refreshTokenEnc` is written only when given;
   * otherwise the stored one is kept. Throws if the account has no row to update,
   * or if there is no stored refresh token and none is given.
   */
  save(
    accountId: string,
    row: { accessTokenEnc: string; refreshTokenEnc?: string; expiresAt: Date },
  ): Promise<void>;
}

/**
 * The `TokenStore` of CONTRACT 1.9: encrypts before writing, decrypts after reading.
 * Plaintext tokens exist only in memory; the row store never sees them.
 */
export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly rows: TokenRowStore,
    private readonly key: Buffer,
  ) {}

  async getTokens(accountId: string): Promise<StoredTokens | null> {
    const row = await this.rows.get(accountId);
    if (!row) return null;
    return {
      accessToken: decryptSecret(row.accessTokenEnc, this.key),
      refreshToken: decryptSecret(row.refreshTokenEnc, this.key),
      expiresAt: row.expiresAt,
    };
  }

  async saveTokens(
    accountId: string,
    tokens: { accessToken: string; refreshToken?: string; expiresAt: Date },
  ): Promise<void> {
    await this.rows.save(accountId, {
      accessTokenEnc: encryptSecret(tokens.accessToken, this.key),
      refreshTokenEnc:
        tokens.refreshToken === undefined
          ? undefined
          : encryptSecret(tokens.refreshToken, this.key),
      expiresAt: tokens.expiresAt,
    });
  }
}
