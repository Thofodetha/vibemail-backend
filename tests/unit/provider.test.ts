import type {
  MailProvider,
  ProviderAuth,
  ProviderMessage,
  ProviderTokens,
} from "../../src/types/provider";

// Compile-time conformance: if either interface gains, loses or changes a method,
// this class stops compiling and ts-jest fails the suite.
class StubProvider implements ProviderAuth, MailProvider {
  private readonly tokens: ProviderTokens = {
    accessToken: "access",
    expiresAt: new Date(0),
  };

  async getAuthorizationUrl(p: { state: string }): Promise<string> {
    return `https://auth.example/consent?state=${p.state}`;
  }

  async exchangeCode(): Promise<{
    tokens: ProviderTokens;
    grantedScopes: string[];
    identity: { subject: string; email: string };
  }> {
    return {
      tokens: this.tokens,
      grantedScopes: [],
      identity: { subject: "sub", email: "user@example.com" },
    };
  }

  async refreshAccessToken(): Promise<ProviderTokens> {
    return this.tokens;
  }

  async listMessages(): Promise<{
    ids: string[];
    nextPageToken: string | null;
    resultSizeEstimate: number;
  }> {
    return { ids: [], nextPageToken: null, resultSizeEstimate: 0 };
  }

  async getMessage(): Promise<ProviderMessage | null> {
    return null;
  }

  async sendMessage(): Promise<{ id: string; threadId: string }> {
    return { id: "id", threadId: "thread" };
  }

  async setRead(): Promise<void> {}

  async watchChanges(): Promise<{ cursor: string; expiresAt: Date }> {
    return { cursor: "cursor", expiresAt: new Date(0) };
  }

  async listChanges(): Promise<{
    changes: { type: "added" | "deleted" | "labelsChanged"; id: string }[];
    nextPageToken: string | null;
    cursor: string;
  }> {
    return { changes: [], nextPageToken: null, cursor: "cursor" };
  }
}

// Exhaustive by construction: adding a method to either interface is a compile
// error here until this list (and the stub above) is updated.
const everyMethod: Record<keyof ProviderAuth | keyof MailProvider, true> = {
  getAuthorizationUrl: true,
  exchangeCode: true,
  refreshAccessToken: true,
  listMessages: true,
  getMessage: true,
  sendMessage: true,
  setRead: true,
  watchChanges: true,
  listChanges: true,
};

describe("provider interfaces", () => {
  it("are satisfied by one class that exposes every method", () => {
    const provider: ProviderAuth & MailProvider = new StubProvider();
    for (const name of Object.keys(everyMethod) as Array<
      keyof typeof everyMethod
    >) {
      expect(typeof provider[name]).toBe("function");
    }
  });
});
