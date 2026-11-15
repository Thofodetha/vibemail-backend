import { defineRoute } from "../../src/app/route";
import { jsonResponse } from "../../src/middleware/errors";
import { handleGmailWebhook } from "../../src/webhook/gmail";

// POST /webhook/gmail, reached through the rewrite in vercel.json (CONTRACT 3.5). Not under /api/v1:
// Pub/Sub calls it, not a browser, and it cannot send a user's JWT. It is verified with the shared
// `?token=` secret instead, and answers 200 only after the delta is stored.
export default defineRoute({
  methods: ["POST"],
  auth: false,
  cors: false,
  async handle({ request, url, container }) {
    let body: unknown;
    try {
      body = (await request.json()) as unknown;
    } catch {
      body = undefined; // reported as WEBHOOK_PAYLOAD_INVALID, after the token check
    }
    const result = await handleGmailWebhook(
      {
        verificationToken: container.verificationToken,
        pubsubTopic: container.pubsubTopic,
        accounts: container.accounts,
        syncState: container.syncState,
        messages: container.messages,
        providerFor: container.providerFor,
        onError: (error) => container.logError("webhook", error),
      },
      { token: url.searchParams.get("token") ?? undefined, body },
    );
    return jsonResponse(result.status, result.body);
  },
});
