import { defineRoute } from "../../../../src/app/route";
import { startSignIn } from "../../../../src/middleware/oauth";

// GET /api/v1/auth/google (CONTRACT 3.1, start): no JWT. Sets the state cookie and redirects to Google.
export default defineRoute({
  methods: ["GET"],
  auth: false,
  cors: true,
  handle: ({ container }) => startSignIn({ auth: container.auth }),
});
