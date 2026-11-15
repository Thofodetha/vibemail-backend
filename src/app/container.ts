import { randomBytes } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { loadEncryptionKey } from "../db/crypto";
import {
  InMemoryAccountStore,
  InMemoryMessageStore,
  InMemorySyncStateStore,
  InMemoryTokenRowStore,
} from "../db/in-memory";
import {
  createServiceClient,
  SupabaseAccountStore,
  SupabaseMessageStore,
  SupabaseSyncStateStore,
  SupabaseTokenRowStore,
} from "../db/supabase";
import { EncryptedTokenStore } from "../db/token-store";
import { describeForLog } from "../middleware/errors";
import { allowedOrigin } from "../middleware/cors";
import { GmailAuth, gmailAuthConfigFromEnv } from "../providers/gmail/auth";
import { createGmailMailProvider } from "../providers/gmail/provider";
import { completeSignIn, type SignInResult } from "../providers/gmail/signin";
import { gmailStartWatch, pubsubTopicFromEnv } from "../providers/gmail/watch";
import { FakeMailProvider } from "../providers/fake";
import { runInitialSync } from "../sync";
import type { MessageStore } from "../types/message";
import type { MailProvider, ProviderAuth } from "../types/provider";
import type { AccountStore, SyncStateStore, TokenStore } from "../types/stores";
import { verificationTokenFromEnv } from "../webhook/gmail";

// The composition root (CONTRACT 6.3): the one module that wires the app's dependencies. Without
// `VIBEMAIL_FAKES` it wires the real Gmail provider and the Supabase-backed stores. With
// `VIBEMAIL_FAKES=1` it wires the fake provider and in-memory stores, so every route can run in a
// local preview without Google or a database. Production refuses to start with it set.

type Env = Record<string, string | undefined>;

export interface Container {
  fakes: boolean;
  frontendUrl: string;
  jwtSecret: string;
  pubsubTopic: string;
  /** `GOOGLE_PUBSUB_VERIFICATION_TOKEN`: the secret in the webhook's `?token=`. */
  verificationToken: string;
  accounts: AccountStore;
  tokens: TokenStore;
  syncState: SyncStateStore;
  messages: MessageStore;
  auth: ProviderAuth;
  /** The mail provider for one account, using that account's stored tokens. */
  providerFor: (accountId: string) => Promise<MailProvider>;
  /** The server side of the OAuth callback: exchange, store, start the watch. */
  signIn: (code: string) => Promise<SignInResult>;
  /**
   * After a sign-in: schedule the initial sync unless the account has already completed one.
   * Reports which, so the decision can be tested.
   */
  afterSignIn: (result: SignInResult) => Promise<"scheduled" | "skipped">;
  /** Keeps a promise alive past the response (`waitUntil` on Vercel). Its failure is logged, never thrown. */
  schedule: (task: Promise<unknown>) => void;
  /** Logs a failure without the underlying error object, which can hold tokens in its request headers. */
  logError: (context: string, error: unknown) => void;
  /** Resolves when everything scheduled so far has finished. For tests. */
  idle: () => Promise<void>;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function isProduction(env: Env): boolean {
  return env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
}

export function buildContainer(env: Env = process.env): Container {
  const fakes = env.VIBEMAIL_FAKES === "1";
  if (fakes && isProduction(env)) {
    throw new Error("VIBEMAIL_FAKES must not be set in production");
  }

  const jwtSecret = required(env, "JWT_SECRET");
  const frontendUrl = required(env, "FRONTEND_URL");
  allowedOrigin(frontendUrl); // throws if it is not a URL

  const pending = new Set<Promise<unknown>>();
  const logError = (context: string, error: unknown) => {
    console.error(`[vibemail] ${context}: ${describeForLog(error)}`);
  };

  const base = {
    fakes,
    frontendUrl,
    jwtSecret,
    logError,
    idle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };

  let accounts: AccountStore;
  let tokens: TokenStore;
  let syncState: SyncStateStore;
  let messages: MessageStore;
  let auth: ProviderAuth;
  let providerFor: Container["providerFor"];
  let startWatch: (accountId: string) => Promise<{ cursor: string; expiresAt: Date }>;
  let pubsubTopic: string;
  let verificationToken: string;
  let schedule: Container["schedule"];

  if (fakes) {
    const redirectUri =
      env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/api/v1/auth/google/callback";
    const fake = new FakeMailProvider({ redirectUri });
    accounts = new InMemoryAccountStore();
    syncState = new InMemorySyncStateStore();
    messages = new InMemoryMessageStore();
    tokens = new EncryptedTokenStore(new InMemoryTokenRowStore(), randomBytes(32));
    auth = fake;
    providerFor = async () => fake;
    pubsubTopic = env.GOOGLE_PUBSUB_TOPIC ?? "projects/fake/topics/fake";
    // Not a built-in secret: unset, nobody can call the webhook in a preview.
    verificationToken = env.GOOGLE_PUBSUB_VERIFICATION_TOKEN || randomBytes(16).toString("hex");
    startWatch = () => fake.watchChanges();
    schedule = (task) => {
      pending.add(task);
      task
        .catch((error: unknown) => logError("scheduled task", error))
        .finally(() => pending.delete(task));
    };
  } else {
    const config = gmailAuthConfigFromEnv(env);
    pubsubTopic = pubsubTopicFromEnv(env);
    verificationToken = verificationTokenFromEnv(env);
    const client = createServiceClient(env);
    accounts = new SupabaseAccountStore(client);
    syncState = new SupabaseSyncStateStore(client);
    messages = new SupabaseMessageStore(client);
    tokens = new EncryptedTokenStore(new SupabaseTokenRowStore(client), loadEncryptionKey(env));
    auth = new GmailAuth(config);
    providerFor = (accountId) => createGmailMailProvider({ config, tokens }, accountId);
    startWatch = gmailStartWatch({ config, tokens, topicName: pubsubTopic });
    schedule = (task) => {
      waitUntil(task.catch((error: unknown) => logError("scheduled task", error)));
    };
  }

  const signIn: Container["signIn"] = (code) =>
    completeSignIn(
      {
        auth,
        accounts,
        tokens,
        syncState,
        startWatch,
        onWatchError: (error) => logError("starting the mailbox watch", error),
      },
      { code },
    );

  const afterSignIn: Container["afterSignIn"] = async (result) => {
    const state = await syncState.get(result.accountId);
    if (state?.initialSyncCompletedAt) return "skipped";
    // The provider is built inside the task so the redirect is not held up by it.
    schedule(
      (async () => {
        const provider = await providerFor(result.accountId);
        await runInitialSync(
          { provider, messages, syncState },
          { userId: result.userId, accountId: result.accountId, pubsubTopic },
        );
      })().catch((error: unknown) => {
        logError("initial sync", error);
      }),
    );
    return "scheduled";
  };

  return {
    ...base,
    pubsubTopic,
    verificationToken,
    accounts,
    tokens,
    syncState,
    messages,
    auth,
    providerFor,
    signIn,
    afterSignIn,
    schedule,
  };
}

let cached: Container | undefined;

/** The container for this function instance, built on first use from the environment. */
export function getContainer(): Container {
  cached ??= buildContainer();
  return cached;
}

/** Drops the cached container so the next `getContainer()` rebuilds it. For tests. */
export function resetContainer(): void {
  cached = undefined;
}
