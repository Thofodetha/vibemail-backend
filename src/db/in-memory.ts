import { randomUUID } from "node:crypto";
import type {
  AccountStore,
  SyncState,
  SyncStateStore,
} from "../types/stores";
import type { TokenRowStore } from "./token-store";

// In-memory implementations of the store interfaces. They back the unit tests and the
// fake-backed local preview (VIBEMAIL_FAKES=1). Same behaviour as the Supabase stores.

interface AccountRow {
  id: string;
  userId: string;
  googleSub: string;
  email: string;
  scopes: string[];
}

export class InMemoryAccountStore implements AccountStore {
  private readonly usersByEmail = new Map<string, string>();
  private readonly accounts = new Map<string, AccountRow>();

  async upsertGoogleAccount(p: {
    googleSub: string;
    email: string;
    scopes: string[];
  }): Promise<{ userId: string; accountId: string }> {
    const email = p.email.toLowerCase();
    let userId = this.usersByEmail.get(email);
    if (userId === undefined) {
      userId = randomUUID();
      this.usersByEmail.set(email, userId);
    }
    const existing = this.accounts.get(p.googleSub);
    const row: AccountRow = {
      id: existing?.id ?? randomUUID(),
      userId,
      googleSub: p.googleSub,
      email,
      scopes: [...p.scopes],
    };
    this.accounts.set(p.googleSub, row);
    return { userId: row.userId, accountId: row.id };
  }

  async getAccountForUser(
    userId: string,
  ): Promise<{ accountId: string; email: string } | null> {
    for (const row of this.accounts.values()) {
      if (row.userId === userId) return { accountId: row.id, email: row.email };
    }
    return null;
  }

  async findAccountByEmail(
    email: string,
  ): Promise<{ userId: string; accountId: string } | null> {
    const wanted = email.toLowerCase();
    for (const row of this.accounts.values()) {
      if (row.email === wanted) return { userId: row.userId, accountId: row.id };
    }
    return null;
  }

  /** Test helper: how many accounts exist. */
  get accountCount(): number {
    return this.accounts.size;
  }
}

interface TokenRow {
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: Date;
}

export class InMemoryTokenRowStore implements TokenRowStore {
  /** Test helper: the raw stored rows, so tests can assert nothing is plaintext. */
  readonly rows = new Map<string, TokenRow>();

  async get(accountId: string): Promise<TokenRow | null> {
    const row = this.rows.get(accountId);
    return row ? { ...row } : null;
  }

  async save(
    accountId: string,
    row: { accessTokenEnc: string; refreshTokenEnc?: string; expiresAt: Date },
  ): Promise<void> {
    const existing = this.rows.get(accountId);
    const refreshTokenEnc = row.refreshTokenEnc ?? existing?.refreshTokenEnc;
    if (refreshTokenEnc === undefined) {
      throw new Error("no refresh token stored and none provided");
    }
    this.rows.set(accountId, {
      accessTokenEnc: row.accessTokenEnc,
      refreshTokenEnc,
      expiresAt: row.expiresAt,
    });
  }
}

export class InMemorySyncStateStore implements SyncStateStore {
  private readonly states = new Map<string, SyncState>();

  async get(accountId: string): Promise<SyncState | null> {
    const state = this.states.get(accountId);
    return state ? { ...state } : null;
  }

  async save(state: SyncState): Promise<void> {
    this.states.set(state.accountId, { ...state });
  }
}
