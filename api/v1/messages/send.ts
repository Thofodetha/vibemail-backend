import { defineRoute } from "../../../src/app/route";
import { readJsonBody } from "../../../src/middleware/body";
import { jsonResponse } from "../../../src/middleware/errors";
import { parseSendRequest, sendMail } from "../../../src/send";

// POST /api/v1/messages/send (CONTRACT 3.3): JWT required. Not idempotent: a retry can send twice.
export default defineRoute({
  methods: ["POST"],
  auth: true,
  cors: true,
  async handle({ request, container, user }) {
    const send = parseSendRequest(await readJsonBody(request));
    const provider = await container.providerFor(user.accountId);
    const message = await sendMail(
      { provider, messages: container.messages },
      { userId: user.userId, accountId: user.accountId, fromEmail: user.email },
      send,
    );
    return jsonResponse(201, { message });
  },
});
