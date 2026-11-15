import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AccountStore,
  SyncState,
  SyncStateStore,
} from "../types/stores";
import type { TokenRowStore } from "./token-store";

// Supabase-backed stores (CONTRACT 4 and 5.2). Column names follow CONTRACT section 4. They are
// written before the schema exists, so they are verified live only after the schema merges
// (AC-18, AC-19). Each write is a single statement; the Supabase client has no transactions.

/** The service-role client. Server-only: it bypasses Row Level Security. */
export function createServiceClient(
  env: Record<string, string | undefined> = process.env,
): SupabaseClient {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function fail(operation: string, error: { message: string }): never {
  throw new Error(`${operation}: ${error.message}`);
}

export class SupabaseAccountStore implements AccountStore {
  constructor(private readonly client: SupabaseClient) {}

  async upsertGoogleAccount(p: {
    googleSub: string;
    email: string;
    scopes: string[];
  }): Promise<{ userId: string; accountId: string }> {
    const email = p.email.toLowerCase();
    const now = new Date().toISOString();

    const user = await this.client
      .from("users")
      .upsert({ email, updated_at: now }, { onConflict: "email" })
      .select("id")
      .single<{ id: string }>();
    if (user.error) fail("upsert user", user.error);

    const account = await this.client
      .from("gmail_accounts")
      .upsert(
        {
          user_id: user.data.id,
          google_sub: p.googleSub,
          email,
          scopes: p.scopes,
          updated_at: now,
        },
        { onConflict: "google_sub" },
      )
      .select("id")
      .single<{ id: string }>();
    if (account.error) fail("upsert gmail account", account.error);

    return { userId: user.data.id, accountId: account.data.id };
  }

  async getAccountForUser(
    userId: string,
  ): Promise<{ accountId: string; email: string } | null> {
    const { data, error } = await this.client
      .from("gmail_accounts")
      .select("id, email")
      .eq("user_id", userId)
      .maybeSingle<{ id: string; email: string }>();
    if (error) fail("get account for user", error);
    return data ? { accountId: data.id, email: data.email } : null;
  }

  async findAccountByEmail(
    email: string,
  ): Promise<{ userId: string; accountId: string } | null> {
    const { data, error } = await this.client
      .from("gmail_accounts")
      .select("id, user_id")
      .eq("email", email.toLowerCase())
      .maybeSingle<{ id: string; user_id: string }>();
    if (error) fail("find account by email", error);
    return data ? { userId: data.user_id, accountId: data.id } : null;
  }
}

interface TokenColumns {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
}

/** Ciphertext columns of `gmail_accounts`. Wrap it in `EncryptedTokenStore`; it never sees plaintext. */
export class SupabaseTokenRowStore implements TokenRowStore {
  constructor(private readonly client: SupabaseClient) {}

  async get(accountId: string): Promise<{
    accessTokenEnc: string;
    refreshTokenEnc: string;
    expiresAt: Date;
  } | null> {
    const { data, error } = await this.client
      .from("gmail_accounts")
      .select("access_token_enc, refresh_token_enc, token_expires_at")
      .eq("id", accountId)
      .maybeSingle<TokenColumns>();
    if (error) fail("get tokens", error);
    if (
      !data ||
      data.access_token_enc === null ||
      data.refresh_token_enc === null ||
      data.token_expires_at === null
    ) {
      return null;
    }
    return {
      accessTokenEnc: data.access_token_enc,
      refreshTokenEnc: data.refresh_token_enc,
      expiresAt: new Date(data.token_expires_at),
    };
  }

  async save(
    accountId: string,
    row: { accessTokenEnc: string; refreshTokenEnc?: string; expiresAt: Date },
  ): Promise<void> {
    const { data, error } = await this.client
      .from("gmail_accounts")
      .update({
        access_token_enc: row.accessTokenEnc,
        // Omitted when absent, so the stored refresh token is kept.
        ...(row.refreshTokenEnc === undefined
          ? {}
          : { refresh_token_enc: row.refreshTokenEnc }),
        token_expires_at: row.expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", accountId)
      .select("id");
    if (error) fail("save tokens", error);
    if (!data || data.length === 0) {
      throw new Error(`save tokens: no account ${accountId}`);
    }
  }
}

interface SyncStateColumns {
  account_id: string;
  user_id: string;
  history_id: string;
  watch_expiration: string;
  initial_sync_completed_at: string | null;
  last_delta_at: string | null;
}

export class SupabaseSyncStateStore implements SyncStateStore {
  constructor(private readonly client: SupabaseClient) {}

  async get(accountId: string): Promise<SyncState | null> {
    const { data, error } = await this.client
      .from("gmail_sync_state")
      .select(
        "account_id, user_id, history_id, watch_expiration, initial_sync_completed_at, last_delta_at",
      )
      .eq("account_id", accountId)
      .maybeSingle<SyncStateColumns>();
    if (error) fail("get sync state", error);
    if (!data) return null;
    return {
      accountId: data.account_id,
      userId: data.user_id,
      historyId: data.history_id,
      watchExpiration: new Date(data.watch_expiration),
      initialSyncCompletedAt: data.initial_sync_completed_at
        ? new Date(data.initial_sync_completed_at)
        : null,
      lastDeltaAt: data.last_delta_at ? new Date(data.last_delta_at) : null,
    };
  }

  async save(state: SyncState): Promise<void> {
    const { error } = await this.client.from("gmail_sync_state").upsert(
      {
        account_id: state.accountId,
        user_id: state.userId,
        history_id: state.historyId,
        watch_expiration: state.watchExpiration.toISOString(),
        initial_sync_completed_at:
          state.initialSyncCompletedAt?.toISOString() ?? null,
        last_delta_at: state.lastDeltaAt?.toISOString() ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "account_id" },
    );
    if (error) fail("save sync state", error);
  }
}
