import { preflightResponse, withCors } from "../middleware/cors";
import {
  describeApiError,
  errorResponse,
  isServerFault,
} from "../middleware/errors";
import { authenticate, type AuthenticatedUser } from "../middleware/jwt";
import { getContainer, type Container } from "./container";

// The wrapper every Vercel Function in `api/` goes through, so each route behaves the same way:
// CORS and preflight, the method check, JWT authentication, and one error envelope for every
// failure (CONTRACT 1.4 and 1.8). A route supplies only what is specific to it.

export type Method = "GET" | "POST";

export interface RouteContext {
  request: Request;
  url: URL;
  container: Container;
  /** The authenticated user. Present on routes declared with `auth: true`. */
  user: AuthenticatedUser;
}

export interface RouteSpec {
  methods: readonly Method[];
  /** Require a valid Bearer JWT and a linked Gmail account. */
  auth: boolean;
  /** Apply the `/api/v1` CORS headers and answer `OPTIONS`. The webhook is not a browser endpoint. */
  cors: boolean;
  handle: (context: RouteContext) => Promise<Response>;
}

/** A Vercel Function in the Web-standard form: `export default { fetch }`. */
export interface VercelHandler {
  fetch(request: Request): Promise<Response>;
}

/** The placeholder user for routes that do not authenticate. */
const NO_USER: AuthenticatedUser = { userId: "", accountId: "", email: "" };

export function defineRoute(spec: RouteSpec): VercelHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      let container: Container;
      try {
        container = getContainer();
      } catch (error) {
        // A misconfigured deployment. There is no frontend URL to build CORS headers from.
        console.error(
          `[vibemail] configuration: ${error instanceof Error ? error.message : "invalid"}`,
        );
        return errorResponse(describeApiError(new Error("misconfigured")));
      }

      const finish = (response: Response): Response =>
        spec.cors ? withCors(response, container.frontendUrl) : response;

      try {
        if (spec.cors && request.method === "OPTIONS") {
          return preflightResponse(container.frontendUrl);
        }
        if (!(spec.methods as readonly string[]).includes(request.method)) {
          return finish(
            errorResponse(
              {
                status: 405,
                code: "METHOD_NOT_ALLOWED",
                message: `This route accepts ${spec.methods.join(", ")}.`,
              },
              { Allow: [...spec.methods, ...(spec.cors ? ["OPTIONS"] : [])].join(", ") },
            ),
          );
        }

        const user = spec.auth
          ? await authenticate(request, {
              jwtSecret: container.jwtSecret,
              accounts: container.accounts,
            })
          : NO_USER;
        return finish(
          await spec.handle({ request, url: new URL(request.url), container, user }),
        );
      } catch (error) {
        const apiError = describeApiError(error);
        if (isServerFault(apiError)) container.logError("request failed", error);
        return finish(errorResponse(apiError));
      }
    },
  };
}
