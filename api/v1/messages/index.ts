import { defineRoute } from "../../../src/app/route";
import { jsonResponse } from "../../../src/middleware/errors";
import { listStoredMessages, parseListQuery } from "../../../src/sync/read";

// GET /api/v1/messages (CONTRACT 3.2): JWT required.
export default defineRoute({
  methods: ["GET"],
  auth: true,
  cors: true,
  async handle({ url, container, user }) {
    const query = parseListQuery(url.searchParams);
    const provider = await container.providerFor(user.accountId);
    const page = await listStoredMessages(
      { provider, messages: container.messages },
      { userId: user.userId, accountId: user.accountId },
      query,
    );
    return jsonResponse(200, page);
  },
});
