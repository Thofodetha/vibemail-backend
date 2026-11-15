import { BodyTooLargeError, ValidationError } from "../types/errors";

/** The cap on a JSON request body (CONTRACT 3.3): 1 MiB. */
export const MAX_REQUEST_BYTES = 1_048_576;

/**
 * Reads a JSON request body.
 *
 * @throws BodyTooLargeError over 1 MiB, by the declared length or by the actual text
 * @throws ValidationError when the content type is not JSON or the body is not valid JSON
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    throw new ValidationError({ body: "Content-Type must be application/json" });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new BodyTooLargeError("the request body is too large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new BodyTooLargeError("the request body is too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError({ body: "must be valid JSON" });
  }
}
