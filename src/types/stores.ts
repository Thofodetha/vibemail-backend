// Persistence interfaces (CONTRACT 5.2). Application code reaches accounts, tokens and
// sync state only through these, so the server logic runs on in-memory fakes and the
// Supabase-backed implementations in src/db can be swapped in once the schema exists.

export interface AccountStore {
  /** Creates or updates the user (by email) and the mailbox account (by `googleSub`). Email is lowercased. */
  upsertGoogleAccount(p: {
    googleSub: string;
    email: string;
    scopes: string[];
  }): Promise<{ userId: string; accountId: string }>;
  getAccountForUser(
    userId: string,
  ): Promise<{ accountId: string; email: string } | null>;
  findAccountByEmail(
    email: string,
  ): Promise<{ userId: string; accountId: string } | null>;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface TokenStore {
  /** Decrypts on read (CONTRACT 1.9); callers only ever see plaintext in memory. Null when no tokens are stored. */
  getTokens(accountId: string): Promise<StoredTokens | null>;
  /**
   * Encrypts on write. An omitted `refreshToken` keeps the stored one: refresh events
   * from the provider usually do not repeat it.
   */
  saveTokens(
    accountId: string,
    tokens: { accessToken: string; refreshToken?: string; expiresAt: Date },
  ): Promise<void>;
}

/** One row per mailbox account (CONTRACT 4.4). */
export interface SyncState {
  accountId: string;
  userId: string;
  /** The cursor delta sync resumes from. Renewing a watch must never overwrite it. */
  historyId: string;
  watchExpiration: Date;
  initialSyncCompletedAt: Date | null;
  lastDeltaAt: Date | null;
}

export interface SyncStateStore {
  get(accountId: string): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
