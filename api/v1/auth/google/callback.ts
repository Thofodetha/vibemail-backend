import { defineRoute } from "../../../../src/app/route";
import { handleOAuthCallback } from "../../../../src/middleware/oauth";

// GET /api/v1/auth/google/callback (CONTRACT 3.1): no JWT. Always answers with a redirect.
export default defineRoute({
  methods: ["GET"],
  auth: false,
  cors: true,
  handle: ({ request, container }) =>
    handleOAuthCallback(
      {
        signIn: container.signIn,
        afterSignIn: container.afterSignIn,
        frontendUrl: container.frontendUrl,
        jwtSecret: container.jwtSecret,
        onError: (error) => container.logError("sign-in", error),
      },
      request,
    ),
});
