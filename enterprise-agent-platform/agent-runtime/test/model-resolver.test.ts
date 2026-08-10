import assert from "node:assert/strict";
import test from "node:test";
import { PlatformGateway } from "../src/platform-gateway.js";
import {
  modelSupportsImages,
  PRODUCT_MODELS,
  productModelCatalogs,
  resolveAuxiliaryVisionModel,
  resolveModel,
  validateProductModelRequest,
} from "../src/model-resolver.js";
import type { ModelRequest, RunRequest } from "../src/types.js";

test("all Runtime catalog models resolve only to fixed OAuth provider endpoints", () => {
  const gateway = new PlatformGateway();
  for (const id of PRODUCT_MODELS["openai-codex"]) {
    const resolved = resolveModel(request({ provider: "openai-codex", id }), gateway);
    assert.equal(resolved.model.provider, "openai-codex");
    assert.equal(resolved.model.api, "openai-codex-responses");
    assert.equal(resolved.model.baseUrl, "https://chatgpt.com/backend-api");
  }
  for (const id of PRODUCT_MODELS.xai) {
    const resolved = resolveModel(request({ provider: "xai-oauth", id }), gateway);
    assert.equal(resolved.model.provider, "xai");
    assert.equal(resolved.model.api, "openai-completions");
    assert.equal(resolved.model.baseUrl, "https://api.x.ai/v1");
  }
});

test("public model catalogs are generated from the same trusted Runtime models", () => {
  const catalogs = productModelCatalogs();

  assert.deepEqual(
    catalogs["openai-codex"].models.map((model) => model.id),
    PRODUCT_MODELS["openai-codex"],
  );
  assert.deepEqual(
    catalogs["xai-oauth"].models.map((model) => model.id),
    PRODUCT_MODELS.xai,
  );
  assert.equal(catalogs["openai-codex"].default_model, "");
  assert.equal(catalogs["xai-oauth"].default_model, "");
  assert.ok(catalogs["openai-codex"].models.every((model) => model.context_window > 0));
  assert.ok(catalogs["xai-oauth"].models.every((model) => model.max_tokens > 0));
});

test("only canonical product provider ids resolve", () => {
  const gateway = new PlatformGateway();
  assert.equal(
    resolveModel(request({ provider: "openai-codex", id: catalogModelId("openai-codex") }), gateway).model.provider,
    "openai-codex",
  );
  assert.equal(
    resolveModel(request({ provider: "xai-oauth", id: catalogModelId("xai-oauth") }), gateway).model.provider,
    "xai",
  );
  for (const provider of ["codex", "grok", "openai", "xai", "faux", "openrouter"]) {
    assert.throws(
      () => validateProductModelRequest({ provider, id: "catalog-model" }),
      /model\.provider must be/,
    );
  }
});

test("caller-controlled model API and base URL are rejected before token resolution", () => {
  const allowed = { provider: "openai-codex", id: catalogModelId("openai-codex") };
  assert.throws(
    () => validateProductModelRequest({ ...allowed, base_url: "https://attacker.invalid/v1" } as unknown as ModelRequest),
    /base_url is controlled/,
  );
  assert.throws(
    () => validateProductModelRequest({ ...allowed, baseUrl: "https://attacker.invalid/v1" } as unknown as ModelRequest),
    /base_url is controlled/,
  );
  assert.throws(
    () => validateProductModelRequest({ ...allowed, api: "openai-completions" } as unknown as ModelRequest),
    /model\.api is controlled/,
  );
  assert.throws(
    () => validateProductModelRequest({ provider: "openai-codex", id: "unlisted-model" }),
    /not allowed/,
  );
  assert.throws(
    () => validateProductModelRequest({ provider: "grok", id: "catalog-model" }),
    /model\.provider must be/,
  );
});

test("OAuth token lookup keeps the canonical product provider on the fixed endpoint", async () => {
  const xaiModelId = catalogModelId("xai-oauth");
  const seen: Array<{ model: string; provider: string }> = [];
  const gateway = {
    token: async (candidateRequest: RunRequest, provider: string) => {
      seen.push({ model: candidateRequest.model.id, provider });
      return "short-lived-oauth-token";
    },
  } as unknown as PlatformGateway;
  const run = request({ provider: "xai-oauth", id: xaiModelId });
  const resolved = resolveModel(run, gateway);
  assert.equal(await resolved.getApiKey(resolved.model.provider), "short-lived-oauth-token");
  assert.deepEqual(seen, [{ model: xaiModelId, provider: "xai-oauth" }]);
  assert.equal(resolved.model.baseUrl, "https://api.x.ai/v1");
});

test("image support follows locked model metadata without overriding Codex OAuth models", () => {
  const gateway = new PlatformGateway();
  const textOnly = resolveModel(request({
    provider: "openai-codex",
    id: catalogModelId("openai-codex", (model) => !model.input.includes("image")),
  }), gateway);
  const multimodalCodex = resolveModel(request({
    provider: "openai-codex",
    id: catalogModelId("openai-codex", (model) => model.input.includes("image")),
  }), gateway);

  assert.equal(modelSupportsImages(textOnly.model), false);
  assert.equal(modelSupportsImages(multimodalCodex.model), true);
  assert.equal(textOnly.model.api, "openai-codex-responses");
  assert.equal(textOnly.model.baseUrl, "https://chatgpt.com/backend-api");
});

test("text-only Codex selects the first account-authorized image companion from Pi metadata", async () => {
  const catalogs = productModelCatalogs();
  const imageModels = catalogs["openai-codex"].models.filter((model) => model.input.includes("image"));
  assert.ok(imageModels.length > 1, "the locked Pi fixture must expose multiple image-capable Codex models");
  const authorized = imageModels.at(-1);
  assert.ok(authorized);
  const attempts: string[] = [];
  const gateway = {
    token: async (candidateRequest: RunRequest) => {
      attempts.push(candidateRequest.model.id);
      return candidateRequest.model.id === authorized.id ? "authorized-model-token" : undefined;
    },
  } as unknown as PlatformGateway;
  const textOnlyRequest = request({
    provider: "openai-codex",
    id: catalogModelId("openai-codex", (model) => !model.input.includes("image")),
  });
  const companion = await resolveAuxiliaryVisionModel(textOnlyRequest, gateway);

  assert.ok(companion);
  assert.equal(companion.model.id, authorized.id);
  assert.equal(companion.apiKey, "authorized-model-token");
  assert.deepEqual(attempts, imageModels.map((model) => model.id));
  assert.equal(companion.model.provider, "openai-codex");
  assert.equal(companion.model.api, "openai-codex-responses");
  assert.equal(companion.model.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(modelSupportsImages(companion.model), true);
  assert.equal(
    await resolveAuxiliaryVisionModel(request({ provider: "openai-codex", id: imageModels[0]!.id }), gateway),
    undefined,
  );
});

test("text-only Codex has no auxiliary companion when the account authorizes no image model", async () => {
  const attempted: string[] = [];
  const gateway = {
    token: async (candidateRequest: RunRequest) => {
      attempted.push(candidateRequest.model.id);
      return undefined;
    },
  } as unknown as PlatformGateway;
  const textOnlyRequest = request({
    provider: "openai-codex",
    id: catalogModelId("openai-codex", (model) => !model.input.includes("image")),
  });

  assert.equal(await resolveAuxiliaryVisionModel(textOnlyRequest, gateway), undefined);
  assert.deepEqual(
    attempted,
    productModelCatalogs()["openai-codex"].models
      .filter((model) => model.input.includes("image"))
      .map((model) => model.id),
  );
});

test("xAI auxiliary authorization binds the product provider, candidate model, and original scope", async () => {
  const textOnlyModelId = catalogModelId("xai-oauth", (model) => !model.input.includes("image"));
  const imageModelId = catalogModelId("xai-oauth", (model) => model.input.includes("image"));
  const seen: Array<{ provider: string; requestProvider: string; model: string; scopeKey: string }> = [];
  const gateway = {
    token: async (candidateRequest: RunRequest, provider: string) => {
      seen.push({
        provider,
        requestProvider: candidateRequest.model.provider,
        model: candidateRequest.model.id,
        scopeKey: candidateRequest.scope_key,
      });
      return candidateRequest.model.id === imageModelId ? "xai-image-token" : undefined;
    },
  } as unknown as PlatformGateway;
  const candidateRequest = request({ provider: "xai-oauth", id: textOnlyModelId });
  candidateRequest.scope_key = "private:42";

  const companion = await resolveAuxiliaryVisionModel(candidateRequest, gateway);

  assert.ok(companion);
  assert.equal(companion.model.id, imageModelId);
  assert.equal(companion.apiKey, "xai-image-token");
  assert.deepEqual(seen, [{
    provider: "xai-oauth",
    requestProvider: "xai-oauth",
    model: imageModelId,
    scopeKey: "private:42",
  }]);
  assert.notEqual(seen[0]?.model, textOnlyModelId, "the primary model authorization must not be reused");
});

function catalogModelId(
  provider: "openai-codex" | "xai-oauth",
  predicate: (model: ReturnType<typeof productModelCatalogs>[typeof provider]["models"][number]) => boolean = () => true,
): string {
  const model = productModelCatalogs()[provider].models.find(predicate);
  assert.ok(model, `locked Pi catalog must include a matching ${provider} model`);
  return model.id;
}

function request(model: ModelRequest): RunRequest {
  return {
    scope_key: "scope",
    lifecycle_id: "life",
    session_id: "session",
    workspace: "/tmp/workspace",
    system_prompt: "You are an Agent.",
    input: "hello",
    model,
  };
}
