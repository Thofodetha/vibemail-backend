import { createHash, timingSafeEqual } from "node:crypto";
import type { SyncMailProvider } from "../providers/gmail/provider";
import { runDeltaSync } from "../sync/delta";
import {
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  UpstreamError,
} from "../types/errors";
import type { MessageStore } from "../types/message";
import type { AccountStore, SyncStateStore } from "../types/stores";

// The Pub/Sub push receiver for Gmail notifications (CONTRACT 3.5). This is the framework-free
// handler: build unit 6 wires it to `POST /webhook/gmail` and a Vercel rewrite.
//
// Pub/Sub treats any 2xx as an acknowledgement and retries everything else. So this answers 200
// only once the delta is stored, 200 "ignored" when a retry could not help, and 429/502/500 when
// it could, in which case the cursor has not moved and the next delivery starts from the same place.

export interface WebhookDeps {
  /** `GOOGLE_PUBSUB_VERIFICATION_TOKEN`: the shared secret in the push endpoint's `?token=`. */
  verificationToken: string;
  /** `GOOGLE_PUBSUB_TOPIC`, used if the delta needs a full resync and a fresh watch. */
  pubsubTopic: string;
  accounts: AccountStore;
  syncState: SyncStateStore;
  messages: MessageStore;
  /** The provider for one account's stored tokens. May throw `ReauthRequiredError` when it has none. */
  providerFor: (accountId: string) => Promise<SyncMailProvider>;
  now?: () => Date;
  /** Called with every failure that is not a plain "ignored" outcome. For logging; never sent to Pub/Sub. */
  onError?: (error: unknown) => void;
}

export interface WebhookRequest {
  /** The `token` query parameter, if present. */
  token: string | undefined;
  /** The parsed JSON body. */
  body: unknown;
}

export type IgnoreReason =
  | "UNKNOWN_ACCOUNT"
  | "NOT_SYNCED"
  | "REAUTH_REQUIRED"
  | "SCOPE_INSUFFICIENT";

export type WebhookResponse =
  | { status: 200; body: { status: "processed"; upserted: number; deleted: number } }
  | { status: 200; body: { status: "ignored"; reason: IgnoreReason } }
  | { status: 400 | 401 | 429 | 500 | 502; body: { error: { code: string; message: string } } };

/** Reads `GOOGLE_PUBSUB_VERIFICATION_TOKEN`. An empty secret would accept anyone, so it is refused. */
export function verificationTokenFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const token = env.GOOGLE_PUBSUB_VERIFICATION_TOKEN;
  if (!token) {
    throw new Error("GOOGLE_PUBSUB_VERIFICATION_TOKEN must be set");
  }
  return token;
}

/** Constant-time comparison. Hashing first makes the lengths equal, so length is not leaked either. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes the push envelope to the notification inside it. `message.data` is base64 JSON
 * `{ emailAddress, historyId }`; Gmail's guide says base64url while Pub/Sub's envelope is standard
 * base64, and Node's decoder accepts both. The `historyId` is validated and then ignored: the
 * delta resumes from the stored cursor, never from the notification.
 */
function decodeNotification(body: unknown): { emailAddress: string } | null {
  if (!isRecord(body) || !isRecord(body.message)) return null;
  const { data } = body.message;
  if (typeof data !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { emailAddress, historyId } = json;
  if (typeof emailAddress !== "string" || !emailAddress.includes("@")) return null;
  const historyOk =
    (typeof historyId === "string" && /^\d+$/.test(historyId)) ||
    (typeof historyId === "number" && Number.isSafeInteger(historyId) && historyId >= 0);
  if (!historyOk) return null;
  return { emailAddress };
}

function failure(
  status: 400 | 401 | 429 | 500 | 502,
  code: string,
  message: string,
): WebhookResponse {
  return { status, body: { error: { code, message } } };
}

function ignored(reason: IgnoreReason): WebhookResponse {
  return { status: 200, body: { status: "ignored", reason } };
}

export async function handleGmailWebhook(
  deps: WebhookDeps,
  req: WebhookRequest,
): Promise<WebhookResponse> {
  // Nothing else is read from a request that fails authentication.
  if (!tokenMatches(req.token, deps.verificationToken)) {
    return failure(401, "WEBHOOK_UNAUTHORIZED", "The verification token is missing or wrong.");
  }
  const notification = decodeNotification(req.body);
  if (!notification) {
    return failure(
      400,
      "WEBHOOK_PAYLOAD_INVALID",
      "The body is not a Pub/Sub push envelope carrying { emailAddress, historyId }.",
    );
  }

  try {
    const account = await deps.accounts.findAccountByEmail(
      notification.emailAddress.toLowerCase(),
    );
    if (!account) return ignored("UNKNOWN_ACCOUNT");
    if (!(await deps.syncState.get(account.accountId))) return ignored("NOT_SYNCED");

    const provider = await deps.providerFor(account.accountId);
    const result = await runDeltaSync(
      {
        provider,
        messages: deps.messages,
        syncState: deps.syncState,
        now: deps.now,
      },
      { userId: account.userId, accountId: account.accountId, pubsubTopic: deps.pubsubTopic },
    );

    switch (result.status) {
      case "processed":
        return {
          status: 200,
          body: { status: "processed", upserted: result.upserted, deleted: result.deleted },
        };
      case "resynced":
        return { status: 200, body: { status: "processed", upserted: result.stored, deleted: 0 } };
      case "not-synced":
        return ignored("NOT_SYNCED");
    }
  } catch (error) {
    // Re-authorising or granting scopes is the user's move; a retry cannot help.
    if (error instanceof ReauthRequiredError) return ignored("REAUTH_REQUIRED");
    if (error instanceof ScopeInsufficientError) return ignored("SCOPE_INSUFFICIENT");

    deps.onError?.(error);
    if (error instanceof RateLimitedError) {
      return failure(429, "GMAIL_RATE_LIMITED", "Gmail is rate limiting this mailbox. Retry later.");
    }
    if (error instanceof UpstreamError) {
      return failure(502, "GMAIL_UPSTREAM_ERROR", "Gmail failed to answer. Retry later.");
    }
    return failure(500, "INTERNAL", "The notification could not be processed.");
  }
}
