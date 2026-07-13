import assert from "node:assert/strict";
import test from "node:test";
import { PlatformGateway } from "../src/platform-gateway.js";
import { PRODUCT_MODELS, resolveModel, validateProductModelRequest } from "../src/model-resolver.js";
import type { ModelRequest, RunRequest } from "../src/types.js";

test("all seven product models resolve only to fixed OAuth provider endpoints", () => {
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

test("codex and grok aliases resolve while canonical non-product aliases are rejected", () => {
  const gateway = new PlatformGateway();
  assert.equal(resolveModel(request({ provider: "codex", id: "gpt-5.5" }), gateway).model.provider, "openai-codex");
  assert.equal(resolveModel(request({ provider: "xai-oauth", id: "grok-4.3" }), gateway).model.provider, "xai");
  assert.equal(resolveModel(request({ provider: "grok", id: "grok-4.20-0309-reasoning" }), gateway).model.provider, "xai");
  for (const provider of ["openai", "xai", "faux", "openrouter"]) {
    assert.throws(
      () => validateProductModelRequest({ provider, id: "gpt-5.5" }),
      /model\.provider must be/,
    );
  }
});

test("caller-controlled model API and base URL are rejected before token resolution", () => {
  const allowed = { provider: "openai-codex", id: "gpt-5.5" };
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
    () => validateProductModelRequest({ provider: "grok", id: "gpt-5.5" }),
    /not allowed/,
  );
  assert.throws(
    () => validateProductModelRequest({ provider: "grok", id: "grok-4.20-multi-agent-0309" }),
    /not allowed/,
  );
});

test("OAuth token lookup accepts the product alias without changing the fixed endpoint", async () => {
  const gateway = {
    token: async () => "short-lived-oauth-token",
  } as unknown as PlatformGateway;
  const run = request({ provider: "grok", id: "grok-4.3" });
  const resolved = resolveModel(run, gateway);
  assert.equal(await resolved.getApiKey(resolved.model.provider), "short-lived-oauth-token");
  assert.equal(resolved.model.baseUrl, "https://api.x.ai/v1");
});

function request(model: ModelRequest): RunRequest {
  return {
    scope_key: "scope",
    lifecycle_id: "life",
    session_id: "session",
    workspace: "/tmp/workspace",
    system_prompt: "You are ubitech agent.",
    input: "hello",
    model,
  };
}
