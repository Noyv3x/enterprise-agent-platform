import { getModel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRequest, ResolvedModel, RunRequest } from "./types.js";
import { PlatformGateway } from "./platform-gateway.js";

type ProductProvider = "openai-codex" | "xai";

const PROVIDER_ALIASES: Readonly<Record<string, ProductProvider>> = {
  "openai-codex": "openai-codex",
  codex: "openai-codex",
  "xai-oauth": "xai",
  grok: "xai",
};

export const PRODUCT_MODELS: Readonly<Record<ProductProvider, readonly string[]>> = {
  "openai-codex": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
  xai: [
    "grok-4.3",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
  ],
};

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
  if (!PRODUCT_MODELS[provider].includes(model.id)) {
    throw new ModelValidationError(`Model ${model.id} is not allowed for provider ${model.provider}`);
  }
  return provider;
}

export function resolveModel(request: RunRequest, gateway: PlatformGateway, signal?: AbortSignal): ResolvedModel {
  const provider = validateProductModelRequest(request.model);
  const lookup = getModel as unknown as (providerId: string, modelId: string) => Model<Api> | undefined;
  const model = lookup(provider, request.model.id);
  if (!model) throw new Error(`Built-in product model metadata is missing for ${provider}/${request.model.id}`);
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
