// CORS for /api/v1 (CONTRACT 1.8). The frontend is one separate origin, `FRONTEND_URL`; no other
// origin is allowed, and preflights are answered without authentication.

/** `https://app.example.com/some/path` -> `https://app.example.com`. Origins have no path. */
export function allowedOrigin(frontendUrl: string): string {
  return new URL(frontendUrl).origin;
}

export function corsHeaders(frontendUrl: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(frontendUrl),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
}

/** The answer to an `OPTIONS` preflight: `204` with the CORS headers. */
export function preflightResponse(frontendUrl: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(frontendUrl) });
}

/** Adds the CORS headers to a response, keeping any it already has. */
export function withCors(response: Response, frontendUrl: string): Response {
  for (const [name, value] of Object.entries(corsHeaders(frontendUrl))) {
    response.headers.set(name, value);
  }
  return response;
}
