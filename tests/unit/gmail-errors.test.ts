import { httpStatus, isInvalidGrant, mapGoogleError } from "../../src/providers/gmail/errors";
import {
  RateLimitedError,
  ReauthRequiredError,
  ScopeInsufficientError,
  UpstreamError,
} from "../../src/types/errors";

function gmailError(status: number, reason?: string) {
  return {
    response: {
      status,
      data: { error: { code: status, errors: reason ? [{ reason }] : [] } },
    },
  };
}

describe("mapGoogleError", () => {
  it("maps invalid_grant to ReauthRequiredError", () => {
    expect(mapGoogleError({ message: "invalid_grant" })).toBeInstanceOf(ReauthRequiredError);
    expect(
      mapGoogleError({ response: { status: 400, data: { error: "invalid_grant" } } }),
    ).toBeInstanceOf(ReauthRequiredError);
  });

  it("maps 403 insufficientPermissions to ScopeInsufficientError", () => {
    expect(mapGoogleError(gmailError(403, "insufficientPermissions"))).toBeInstanceOf(
      ScopeInsufficientError,
    );
  });

  it("maps 429 and the 403 rate-limit reasons to RateLimitedError", () => {
    expect(mapGoogleError(gmailError(429))).toBeInstanceOf(RateLimitedError);
    expect(mapGoogleError(gmailError(403, "rateLimitExceeded"))).toBeInstanceOf(RateLimitedError);
    expect(mapGoogleError(gmailError(403, "userRateLimitExceeded"))).toBeInstanceOf(RateLimitedError);
  });

  it("maps a 403 with an unrelated reason, 5xx and plain errors to UpstreamError", () => {
    expect(mapGoogleError(gmailError(403, "forbidden"))).toBeInstanceOf(UpstreamError);
    expect(mapGoogleError(gmailError(503))).toBeInstanceOf(UpstreamError);
    expect(mapGoogleError(new Error("socket hang up"))).toBeInstanceOf(UpstreamError);
    expect(mapGoogleError("a string")).toBeInstanceOf(UpstreamError);
  });

  it("keeps the original failure in `detail` and returns provider errors unchanged", () => {
    const original = gmailError(503);
    expect(mapGoogleError(original).detail).toBe(original);
    const typed = new ReauthRequiredError("x");
    expect(mapGoogleError(typed)).toBe(typed);
  });
});

describe("httpStatus and isInvalidGrant", () => {
  it("reads the status from response.status, status or a numeric code", () => {
    expect(httpStatus({ response: { status: 404 } })).toBe(404);
    expect(httpStatus({ status: 500 })).toBe(500);
    expect(httpStatus({ code: 429 })).toBe(429);
    expect(httpStatus({ code: "403" })).toBe(403);
  });

  it("ignores values that are not HTTP statuses", () => {
    expect(httpStatus({ code: "ECONNRESET" })).toBeUndefined();
    expect(httpStatus({ code: 42 })).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus("404")).toBeUndefined();
  });

  it("recognises invalid_grant only when Google says so", () => {
    expect(isInvalidGrant({ message: "invalid_grant" })).toBe(true);
    expect(isInvalidGrant({ message: "invalid_client" })).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
  });
});
