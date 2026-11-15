import { defineRoute } from "../../../../src/app/route";
import { jsonResponse } from "../../../../src/middleware/errors";
import { markRead } from "../../../../src/send/mark-read";
import { ValidationError } from "../../../../src/types/errors";

/** The `{gmailId}` of `/api/v1/messages/{gmailId}/read`. */
function messageIdFrom(url: URL): string {
  const match = /\/messages\/([^/]+)\/read\/?$/.exec(url.pathname);
  try {
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {
    // a malformed percent-escape falls through to the error below
  }
  throw new ValidationError({ gmailId: "is not a valid message id" });
}

// POST /api/v1/messages/{gmailId}/read (CONTRACT 3.4): JWT required. Idempotent. There is no unread.
export default defineRoute({
  methods: ["POST"],
  auth: true,
  cors: true,
  async handle({ url, container, user }) {
    const provider = await container.providerFor(user.accountId);
    const message = await markRead(
      { provider, messages: container.messages },
      { userId: user.userId, accountId: user.accountId },
      messageIdFrom(url),
    );
    return jsonResponse(200, { message });
  },
});
