import {
  pubsubTopicFromEnv,
  watchMailbox,
  type GmailWatchApi,
} from "../../src/providers/gmail/watch";
import { ReauthRequiredError, UpstreamError } from "../../src/types/errors";

const TOPIC = "projects/my-project/topics/vibemail-gmail-notifications";

function api(
  watch: GmailWatchApi["users"]["watch"],
): GmailWatchApi {
  return { users: { watch } };
}

describe("watchMailbox", () => {
  it("watches the signed-in mailbox on the topic, with no label filter", async () => {
    const watch = jest.fn(async (_params: { userId: string; requestBody: { topicName: string } }) => ({
      data: { historyId: "12345", expiration: "1800000000000" },
    }));
    const result = await watchMailbox(api(watch), TOPIC);
    expect(watch).toHaveBeenCalledWith({ userId: "me", requestBody: { topicName: TOPIC } });
    expect(result).toEqual({ cursor: "12345", expiresAt: new Date(1_800_000_000_000) });
  });

  it("fails when the response has no historyId", async () => {
    const watch = async () => ({ data: { expiration: "1800000000000" } });
    await expect(watchMailbox(api(watch), TOPIC)).rejects.toThrow(UpstreamError);
  });

  it("fails when the expiration is missing or not a number", async () => {
    await expect(
      watchMailbox(api(async () => ({ data: { historyId: "1" } })), TOPIC),
    ).rejects.toThrow(UpstreamError);
    await expect(
      watchMailbox(api(async () => ({ data: { historyId: "1", expiration: "soon" } })), TOPIC),
    ).rejects.toThrow(UpstreamError);
  });

  it("maps a revoked grant to ReauthRequiredError", async () => {
    const watch = async () => {
      throw { message: "invalid_grant" };
    };
    await expect(watchMailbox(api(watch), TOPIC)).rejects.toThrow(ReauthRequiredError);
  });

  it("maps any other Gmail failure to UpstreamError", async () => {
    const watch = async () => {
      throw new Error("Invalid topicName does not match projects/my-project/topics/*");
    };
    await expect(watchMailbox(api(watch), TOPIC)).rejects.toThrow(UpstreamError);
  });
});

describe("pubsubTopicFromEnv", () => {
  it("reads GOOGLE_PUBSUB_TOPIC", () => {
    expect(pubsubTopicFromEnv({ GOOGLE_PUBSUB_TOPIC: TOPIC })).toBe(TOPIC);
  });

  it("fails when it is not set", () => {
    expect(() => pubsubTopicFromEnv({})).toThrow("GOOGLE_PUBSUB_TOPIC");
  });
});
