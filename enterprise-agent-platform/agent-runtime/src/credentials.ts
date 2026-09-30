import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const providerId = "openai-codex";

// Platform remains authoritative: no refresh token or credentials are stored on disk.
class PlatformCredentialStore implements CredentialStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly platformUrl: string,
    private readonly token: string,
    private readonly modelId: () => string,
    private readonly timeoutMs = 120_000,
  ) {}

  async resolve(forceRefresh: boolean, signal?: AbortSignal): Promise<OAuthCredential> {
    const response = await fetch(new URL("/api/agent/tools/credentials/resolve", this.platformUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId, model: this.modelId(), force_refresh: forceRefresh }),
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      // Resolver diagnostics can contain secrets; never propagate its response body.
      await response.body?.cancel();
      throw new Error(`Platform credential resolution failed (HTTP ${response.status})`);
    }
    const data = await response.json() as { access_token?: unknown; expires_at?: unknown };
    if (typeof data.access_token !== "string" || !data.access_token ||
        !(data.expires_at === null || (typeof data.expires_at === "number" && Number.isFinite(data.expires_at)))) {
      throw new Error("Platform returned invalid credentials");
    }
    return {
      type: "oauth",
      access: data.access_token,
      // Pi requires this field, but only Platform has the real refresh token.
      refresh: "",
      expires: data.expires_at === null ? 0 : data.expires_at * 1000,
    };
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return id === providerId ? this.resolve(false, options?.signal) : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    await this.read(providerId, options);
    return [{ providerId, type: "oauth" }];
  }

  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (id !== providerId) throw new Error("Credentials are managed by Platform");
    const operation = this.pending.then(async () => {
      const current = await this.read(id, options);
      // The provider's refresh callback has already persisted any change in Platform.
      return (await fn(current)) ?? current;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async delete(_id: string, _options?: AuthOperationOptions): Promise<void> {
    throw new Error("Credentials are managed by Platform");
  }
}

export async function createModelRuntime(
  platformUrl: string,
  token: string,
  modelId: () => string,
  timeoutMs = 120_000,
): Promise<ModelRuntime> {
  const credentials = new PlatformCredentialStore(platformUrl, token, modelId, timeoutMs);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const provider = openaiCodexProvider();
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      oauth: {
        ...provider.auth!.oauth!,
        login: async () => { throw new Error("OAuth login is managed by Platform"); },
        refresh: (_credential, signal) => credentials.resolve(true, signal),
      },
    },
  });
  return runtime;
}
