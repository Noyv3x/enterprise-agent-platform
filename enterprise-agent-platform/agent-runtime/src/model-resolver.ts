import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRequest, ResolvedModel, RunRequest } from "./types.js";
import { PlatformGateway } from "./platform-gateway.js";

// Codex (ChatGPT OAuth) is the only product model provider.
type ProductProvider = "openai-codex";

export interface ProductModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  context_window: number;
  max_tokens: number;
}

export interface ProductModelCatalog {
  provider: ProductProvider;
  runtime_provider: ProductProvider;
  default_model: string;
  models: ProductModelCatalogEntry[];
}

function isTrustedProductModel(model: Model<Api>): boolean {
  return model.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && model.baseUrl.replace(/\/$/, "") === "https://chatgpt.com/backend-api";
}

function trustedModels(): Model<Api>[] {
  return getModels("openai-codex").filter(isTrustedProductModel);
}

/**
 * Runtime-supported model IDs, derived from Pi's locked metadata catalog.
 * This is intentionally computed rather than hand-maintained so validation,
 * catalog responses, and execution cannot drift when the dependency updates.
 */
export const PRODUCT_MODELS: Readonly<Record<ProductProvider, readonly string[]>> = Object.freeze({
  "openai-codex": Object.freeze(trustedModels().map((model) => model.id)),
});

export function productModelCatalogs(): Record<ProductProvider, ProductModelCatalog> {
  return {
    "openai-codex": {
      provider: "openai-codex",
      runtime_provider: "openai-codex",
      default_model: "",
      models: trustedModels().map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: [...model.input],
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      })),
    },
  };
}

export class ModelValidationError extends Error {
  readonly statusCode = 400;
}

export function validateProductModelRequest(model: ModelRequest): ProductProvider {
  if (!model || typeof model !== "object") throw new ModelValidationError("model is required");
  const raw = model as unknown as Record<string, unknown>;
  if (Object.hasOwn(raw, "base_url") || Object.hasOwn(raw, "baseUrl")) {
    throw new ModelValidationError("model.base_url is controlled by the Agent runtime and must not be supplied");
  }
  if (Object.hasOwn(raw, "api")) {
    throw new ModelValidationError("model.api is controlled by the Agent runtime and must not be supplied");
  }
  const allowed = new Set(["provider", "id", "reasoning"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ModelValidationError(`model accepts only provider, id, and reasoning; received ${unknown.join(", ")}`);
  }
  if (model.provider !== "openai-codex") {
    throw new ModelValidationError("model.provider must be openai-codex");
  }
  const provider: ProductProvider = model.provider;
  const lookup = getModel as unknown as (providerId: string, modelId: string) => Model<Api> | undefined;
  const resolved = lookup(provider, model.id);
  if (!resolved || !isTrustedProductModel(resolved)) {
    throw new ModelValidationError(`Model ${model.id} is not allowed for provider ${model.provider}`);
  }
  return provider;
}

export function resolveModel(request: RunRequest, gateway: PlatformGateway, signal?: AbortSignal): ResolvedModel {
  const provider = validateProductModelRequest(request.model);
  const lookup = getModel as unknown as (providerId: string, modelId: string) => Model<Api> | undefined;
  const model = lookup(provider, request.model.id);
  if (!model || !isTrustedProductModel(model)) {
    throw new Error(`Built-in product model metadata is missing for ${provider}/${request.model.id}`);
  }
  return {
    model,
    async getApiKey(_requestedProvider: string): Promise<string | undefined> {
      return await gateway.token(request, request.model.provider, signal);
    },
  };
}

/**
 * Treat the locked Pi model catalog as the capability boundary. In particular,
 * do not infer image support from a model name or provider: some Codex models
 * share an OAuth endpoint while advertising different input modalities.
 */
export function modelSupportsImages(model: Model<Api>): boolean {
  return model.input.includes("image");
}

export interface AuthorizedAuxiliaryModel {
  model: Model<Api>;
  apiKey: string;
}

/**
 * Resolve the first image-capable Pi model on the same product/OAuth provider
 * that the current account authorizes. Each candidate is checked with its own
 * model ID; authorization for the primary model is never reused.
 */
export async function resolveAuxiliaryVisionModel(
  request: RunRequest,
  gateway: PlatformGateway,
  signal?: AbortSignal,
): Promise<AuthorizedAuxiliaryModel | undefined> {
  const primary = resolveModel(request, gateway, signal);
  if (modelSupportsImages(primary.model)) return undefined;
  for (const candidate of trustedModels()) {
    if (candidate.id === request.model.id || !modelSupportsImages(candidate)) continue;
    const candidateRequest: RunRequest = {
      ...request,
      model: { ...request.model, id: candidate.id },
    };
    const resolved = resolveModel(candidateRequest, gateway, signal);
    const apiKey = await resolved.getApiKey(candidateRequest.model.provider);
    if (apiKey) return { model: resolved.model, apiKey };
  }
  return undefined;
}
