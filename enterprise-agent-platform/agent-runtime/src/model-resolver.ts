import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRequest, ResolvedModel, RunRequest } from "./types.js";
import { PlatformGateway } from "./platform-gateway.js";

type ProductProvider = "openai-codex" | "xai";

type ProductProviderId = "openai-codex" | "xai-oauth";

interface ProductProviderDefinition {
  runtimeProvider: ProductProvider;
  defaultModel: string;
  api: Api;
  baseUrl: string;
  excludedModelIds?: ReadonlySet<string>;
}

export interface ProductModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  context_window: number;
  max_tokens: number;
}

export interface ProductModelCatalog {
  provider: ProductProviderId;
  runtime_provider: ProductProvider;
  default_model: string;
  models: ProductModelCatalogEntry[];
}

const PRODUCT_PROVIDERS: Readonly<Record<ProductProviderId, ProductProviderDefinition>> = {
  "openai-codex": {
    runtimeProvider: "openai-codex",
    defaultModel: "gpt-5.5",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  },
  "xai-oauth": {
    runtimeProvider: "xai",
    defaultModel: "grok-4.3",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
    // xAI retired these model families on 2026-05-15. Pi keeps historical
    // metadata for compatibility, but the product catalog must not offer
    // models that the provider no longer serves.
    excludedModelIds: new Set(["grok-3", "grok-3-fast", "grok-code-fast-1"]),
  },
};

const AUXILIARY_VISION_MODEL_PREFERENCES: Readonly<Record<ProductProvider, readonly string[]>> = {
  "openai-codex": ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
  xai: ["grok-4.3", "grok-4.20-0309-non-reasoning", "grok-4.20-0309-reasoning"],
};

const PROVIDER_ALIASES: Readonly<Record<string, ProductProvider>> = {
  "openai-codex": "openai-codex",
  codex: "openai-codex",
  "xai-oauth": "xai",
  grok: "xai",
};

function definitionForRuntimeProvider(provider: ProductProvider): ProductProviderDefinition {
  return provider === "openai-codex"
    ? PRODUCT_PROVIDERS["openai-codex"]
    : PRODUCT_PROVIDERS["xai-oauth"];
}

function isTrustedProductModel(model: Model<Api>, definition: ProductProviderDefinition): boolean {
  return model.provider === definition.runtimeProvider
    && model.api === definition.api
    && model.baseUrl.replace(/\/$/, "") === definition.baseUrl
    && !definition.excludedModelIds?.has(model.id);
}

function trustedModels(provider: ProductProvider): Model<Api>[] {
  const definition = definitionForRuntimeProvider(provider);
  const lookup = getModels as unknown as (providerId: string) => readonly Model<Api>[];
  return [...lookup(provider)].filter((model) => isTrustedProductModel(model, definition));
}

/**
 * Runtime-supported model IDs, derived from Pi's locked metadata catalog.
 * This is intentionally computed rather than hand-maintained so validation,
 * catalog responses, and execution cannot drift when the dependency updates.
 */
export const PRODUCT_MODELS: Readonly<Record<ProductProvider, readonly string[]>> = Object.freeze({
  "openai-codex": Object.freeze(trustedModels("openai-codex").map((model) => model.id)),
  xai: Object.freeze(trustedModels("xai").map((model) => model.id)),
});

function productModelCatalog(
  provider: ProductProviderId,
  definition: ProductProviderDefinition,
): ProductModelCatalog {
  const models = trustedModels(definition.runtimeProvider).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      context_window: model.contextWindow,
      max_tokens: model.maxTokens,
  }));
  const defaultModel = models.some((model) => model.id === definition.defaultModel)
    ? definition.defaultModel
    : (models[0]?.id ?? "");
  return {
    provider,
    runtime_provider: definition.runtimeProvider,
    default_model: defaultModel,
    models,
  };
}

export function productModelCatalogs(): Record<ProductProviderId, ProductModelCatalog> {
  return {
    "openai-codex": productModelCatalog("openai-codex", PRODUCT_PROVIDERS["openai-codex"]),
    "xai-oauth": productModelCatalog("xai-oauth", PRODUCT_PROVIDERS["xai-oauth"]),
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
  const provider = PROVIDER_ALIASES[model.provider];
  if (!provider) {
    throw new ModelValidationError("model.provider must be openai-codex, codex, xai-oauth, or grok");
  }
  const definition = definitionForRuntimeProvider(provider);
  const lookup = getModel as unknown as (providerId: string, modelId: string) => Model<Api> | undefined;
  const resolved = lookup(provider, model.id);
  if (!resolved || !isTrustedProductModel(resolved, definition)) {
    throw new ModelValidationError(`Model ${model.id} is not allowed for provider ${model.provider}`);
  }
  return provider;
}

export function resolveModel(request: RunRequest, gateway: PlatformGateway, signal?: AbortSignal): ResolvedModel {
  const provider = validateProductModelRequest(request.model);
  const lookup = getModel as unknown as (providerId: string, modelId: string) => Model<Api> | undefined;
  const model = lookup(provider, request.model.id);
  const definition = definitionForRuntimeProvider(provider);
  if (!model || !isTrustedProductModel(model, definition)) {
    throw new Error(`Built-in product model metadata is missing for ${provider}/${request.model.id}`);
  }
  return {
    model,
    async getApiKey(requestedProvider: string): Promise<string | undefined> {
      const candidates = [requestedProvider, request.model.provider, provider];
      for (const candidate of new Set(candidates)) {
        const token = await gateway.token(request, candidate, signal);
        if (token) return token;
      }
      return undefined;
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

/**
 * Resolve an allowed image-capable companion on the same product/OAuth
 * provider. The primary model's metadata remains authoritative and unchanged.
 */
export function resolveAuxiliaryVisionModel(
  request: RunRequest,
  gateway: PlatformGateway,
  signal?: AbortSignal,
): ResolvedModel | undefined {
  const provider = validateProductModelRequest(request.model);
  const primary = resolveModel(request, gateway, signal);
  if (modelSupportsImages(primary.model)) return undefined;
  for (const id of AUXILIARY_VISION_MODEL_PREFERENCES[provider]) {
    if (!PRODUCT_MODELS[provider].includes(id)) continue;
    const candidate = resolveModel({
      ...request,
      model: { ...request.model, id },
    }, gateway, signal);
    if (modelSupportsImages(candidate.model)) return candidate;
  }
  for (const candidate of trustedModels(provider)) {
    if (candidate.id === request.model.id || !modelSupportsImages(candidate)) continue;
    return resolveModel({
      ...request,
      model: { ...request.model, id: candidate.id },
    }, gateway, signal);
  }
  return undefined;
}
