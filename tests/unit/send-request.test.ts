import {
  isValidEmail,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  normalizeMessageId,
  parseSendRequest,
} from "../../src/send/request";
import { ValidationError } from "../../src/types/errors";

const valid = () => ({
  to: [{ email: "you@example.com" }],
  subject: "Hello",
  bodyText: "Hi",
});

function fieldsOf(input: unknown): Record<string, string> {
  try {
    parseSendRequest(input);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("expected a ValidationError");
}

describe("parseSendRequest: valid requests", () => {
  it("accepts the minimal request and fills in the defaults", () => {
    expect(parseSendRequest(valid())).toEqual({
      to: [{ name: null, email: "you@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      bodyText: "Hi",
      bodyHtml: undefined,
      threadId: undefined,
      inReplyTo: undefined,
      references: undefined,
    });
  });

  it("accepts cc, bcc, both bodies, names and an empty subject", () => {
    const parsed = parseSendRequest({
      to: [{ name: "Ann", email: "ann@example.com" }],
      cc: [{ email: "cara@example.com" }],
      bcc: [{ email: "dan@example.com" }],
      subject: "",
      bodyText: "t",
      bodyHtml: "<p>h</p>",
    });
    expect(parsed.to[0]).toEqual({ name: "Ann", email: "ann@example.com" });
    expect(parsed.cc).toHaveLength(1);
    expect(parsed.bcc).toHaveLength(1);
    expect(parsed.subject).toBe("");
  });

  it("accepts a body that is only HTML, or only an empty string", () => {
    expect(() => parseSendRequest({ ...valid(), bodyText: undefined, bodyHtml: "<p>x</p>" })).not.toThrow();
    expect(() => parseSendRequest({ ...valid(), bodyText: "" })).not.toThrow();
  });

  it("accepts a reply, normalising Message-IDs and defaulting references", () => {
    const parsed = parseSendRequest({
      ...valid(),
      threadId: "18f0a1b2c3d4e5f6",
      inReplyTo: "CAF1abc@mail.example.com",
    });
    expect(parsed.inReplyTo).toBe("<CAF1abc@mail.example.com>");
    expect(parsed.references).toEqual(["<CAF1abc@mail.example.com>"]);

    const explicit = parseSendRequest({
      ...valid(),
      threadId: "t1",
      inReplyTo: "<b@x.com>",
      references: ["a@x.com", "<b@x.com>"],
    });
    expect(explicit.references).toEqual(["<a@x.com>", "<b@x.com>"]);
  });

  it("accepts exactly the maximum recipients and the maximum subject", () => {
    const to = Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({ email: `u${i}@example.com` }));
    expect(() => parseSendRequest({ ...valid(), to })).not.toThrow();
    expect(() => parseSendRequest({ ...valid(), subject: "s".repeat(MAX_SUBJECT_LENGTH) })).not.toThrow();
  });
});

describe("parseSendRequest: recipients", () => {
  it.each([
    ["no to", { subject: "s", bodyText: "b" }, "to"],
    ["an empty to", { ...valid(), to: [] }, "to"],
    ["to that is not an array", { ...valid(), to: "you@example.com" }, "to"],
    ["an entry that is not an object", { ...valid(), to: ["you@example.com"] }, "to[0]"],
    ["an invalid address", { ...valid(), to: [{ email: "nope" }] }, "to[0].email"],
    ["a missing address", { ...valid(), to: [{ name: "Ann" }] }, "to[0].email"],
    ["an invalid cc address", { ...valid(), cc: [{ email: "a@b" }] }, "cc[0].email"],
    ["an invalid bcc address", { ...valid(), bcc: [{ email: "@b.com" }] }, "bcc[0].email"],
    ["a name with a line break", { ...valid(), to: [{ name: "A\nB", email: "a@example.com" }] }, "to[0].name"],
    ["a non-string name", { ...valid(), to: [{ name: 5, email: "a@example.com" }] }, "to[0].name"],
  ])("rejects %s", (_label, input, field) => {
    expect(fieldsOf(input)).toHaveProperty([field]);
  });

  it("rejects more than the allowed recipients across to, cc and bcc together", () => {
    const some = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@example.com` }));
    const fields = fieldsOf({ ...valid(), to: some(50, "t"), cc: some(40, "c"), bcc: some(11, "b") });
    expect(fields.to).toContain("at most 100");
  });
});

describe("parseSendRequest: subject, body and replies", () => {
  it.each([
    ["no subject", { to: valid().to, bodyText: "b" }, "subject"],
    ["a non-string subject", { ...valid(), subject: 5 }, "subject"],
    ["a subject over the limit", { ...valid(), subject: "s".repeat(MAX_SUBJECT_LENGTH + 1) }, "subject"],
    ["a subject with CR", { ...valid(), subject: "a\rb" }, "subject"],
    ["a subject with LF", { ...valid(), subject: "a\nb" }, "subject"],
    ["no body", { to: valid().to, subject: "s" }, "body"],
    ["a non-string bodyText", { ...valid(), bodyText: 5 }, "bodyText"],
    ["a non-string bodyHtml", { ...valid(), bodyHtml: {} }, "bodyHtml"],
    ["a threadId without inReplyTo", { ...valid(), threadId: "t1" }, "threadId"],
    ["an inReplyTo without threadId", { ...valid(), inReplyTo: "<a@x.com>" }, "threadId"],
    ["an invalid threadId", { ...valid(), threadId: "bad id!", inReplyTo: "<a@x.com>" }, "threadId"],
    ["an invalid inReplyTo", { ...valid(), threadId: "t1", inReplyTo: "<a b@x.com>" }, "inReplyTo"],
    ["references without inReplyTo", { ...valid(), references: ["<a@x.com>"] }, "references"],
    [
      "references that are not an array",
      { ...valid(), threadId: "t1", inReplyTo: "<a@x.com>", references: "<a@x.com>" },
      "references",
    ],
    [
      "an invalid reference",
      { ...valid(), threadId: "t1", inReplyTo: "<a@x.com>", references: ["<a@x.com>", "<bad id>"] },
      "references",
    ],
  ])("rejects %s", (_label, input, field) => {
    expect(fieldsOf(input)).toHaveProperty([field]);
  });

  it.each([null, undefined, "text", 42, []])("rejects a body that is %p", (input) => {
    expect(fieldsOf(input)).toHaveProperty("body");
  });

  it("reports every problem at once, not just the first", () => {
    const fields = fieldsOf({ to: [], subject: 5 });
    expect(Object.keys(fields).sort()).toEqual(["body", "subject", "to"]);
  });
});

describe("isValidEmail and normalizeMessageId", () => {
  it.each(["a@b.co", "first.last@example.com", "a+tag@sub.example.org", "o'brien@example.ie"])(
    "accepts %s",
    (email) => expect(isValidEmail(email)).toBe(true),
  );

  it.each([
    "",
    "plain",
    "@example.com",
    "a@",
    "a@b",
    "a b@example.com",
    "a@exa mple.com",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    "a@-example.com",
    "a@example..com",
    "a@exam\nple.com",
    "é@example.com",
    `${"a".repeat(65)}@example.com`,
  ])("rejects %p", (email) => expect(isValidEmail(email)).toBe(false));

  it("normalises Message-IDs to angle-bracket form and rejects unusable ones", () => {
    expect(normalizeMessageId("abc@x.com")).toBe("<abc@x.com>");
    expect(normalizeMessageId("  <abc@x.com>  ")).toBe("<abc@x.com>");
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
    expect(normalizeMessageId("a b")).toBeNull();
    expect(normalizeMessageId("a<b>c")).toBeNull();
    expect(normalizeMessageId("a\r\nb")).toBeNull();
  });
});
