import assert from "node:assert/strict";
import test from "node:test";
import {
  codexPromptCacheKey,
  withCodexPromptCacheKey,
} from "../src/system-prompt/prompt-cache-key.js";
import {
  buildSystemPromptParts,
  type SystemPromptAssemblyInput,
} from "../src/system-prompt/prompt-assembly.js";

function promptInput(overrides: Partial<SystemPromptAssemblyInput> = {}): SystemPromptAssemblyInput {
  return {
    platformSystemPrompt: "Platform identity and workspace context.",
    activeTodos: [],
    activeBackgroundTasks: [],
    learningReview: false,
    canWriteMemory: false,
    scheduledRun: false,
    recurringScheduledRun: false,
    interactiveInputs: false,
    ...overrides,
  };
}

const providerTools = [
  {
    strict: null,
    parameters: {
      required: ["path"],
      properties: {
        path: { type: "string" },
        limit: { maximum: 100, type: "integer" },
      },
      type: "object",
    },
    description: "Read a file",
    name: "read_file",
    type: "function",
  },
  {
    type: "function",
    name: "terminal",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    strict: null,
  },
];

test("Codex prompt cache key ignores volatile prompt state and canonicalizes provider tool schemas", () => {
  const scopeKey = "private:prompt-cache-scope";
  const first = buildSystemPromptParts(promptInput({
    platformSystemPrompt: "Platform context. Current UTC: first.",
    recalledMemory: "First recalled fact.",
    availableSkills: [{ id: "first", name: "First skill" }],
  }));
  const second = buildSystemPromptParts(promptInput({
    platformSystemPrompt: "Platform context. Current UTC: second.",
    recalledMemory: "Second recalled fact.",
    availableSkills: [{ id: "second", name: "Second skill" }],
  }));
  const reorderedTools = [
    {
      name: "terminal",
      strict: null,
      description: "Run a command",
      type: "function",
      parameters: {
        required: ["command"],
        properties: { command: { type: "string" } },
        type: "object",
      },
    },
    {
      name: "read_file",
      description: "Read a file",
      parameters: {
        properties: {
          limit: { type: "integer", maximum: 100 },
          path: { type: "string" },
        },
        type: "object",
        required: ["path"],
      },
      type: "function",
      strict: null,
    },
  ];

  assert.equal(first.stable, second.stable);
  assert.notEqual(first.context, second.context);
  assert.notEqual(first.volatile, second.volatile);
  const firstKey = codexPromptCacheKey(first.stable, providerTools, scopeKey);
  const secondKey = codexPromptCacheKey(second.stable, reorderedTools, scopeKey);
  assert.equal(firstKey, secondKey);
  assert.match(firstKey, /^pck_[0-9a-f]{24}$/);
  assert.doesNotMatch(firstKey, /private|prompt-cache-scope/);
  assert.notEqual(
    codexPromptCacheKey(first.stable, providerTools, "private:other-scope"),
    firstKey,
    "stable scope partitions must not share one provider routing hotspot",
  );
});

test("Codex prompt cache key changes with stable policy or provider schema capabilities", () => {
  const readOnly = buildSystemPromptParts(promptInput());
  const writable = buildSystemPromptParts(promptInput({ canWriteMemory: true }));
  const changedTools = [
    {
      ...providerTools[0]!,
      parameters: {
        type: "object",
        properties: {
          path: { type: "number" },
          limit: { maximum: 100, type: "integer" },
        },
        required: ["path"],
      },
    },
    providerTools[1]!,
  ];

  const scopeKey = "private:stable-policy-scope";
  const baseline = codexPromptCacheKey(readOnly.stable, providerTools, scopeKey);
  assert.notEqual(codexPromptCacheKey(writable.stable, providerTools, scopeKey), baseline);
  assert.notEqual(codexPromptCacheKey(readOnly.stable, changedTools, scopeKey), baseline);
});

test("payload override is limited to the exact Codex OAuth provider and API", () => {
  const scopeKey = "private:raw-scope-must-not-leave-process";
  const payload = {
    instructions: "complete prompt including volatile data",
    prompt_cache_key: "session-sensitive-key",
    tools: providerTools,
  };
  const replaced = withCodexPromptCacheKey(
    payload,
    { provider: "openai-codex", api: "openai-codex-responses" },
    "stable Runtime prefix",
    scopeKey,
  );

  assert.deepEqual(replaced, {
    ...payload,
    prompt_cache_key: codexPromptCacheKey("stable Runtime prefix", providerTools, scopeKey),
  });
  const wireKey = (replaced as { prompt_cache_key: string }).prompt_cache_key;
  assert.match(wireKey, /^pck_[0-9a-f]{24}$/);
  assert.doesNotMatch(wireKey, /raw-scope|session-sensitive|account/);
  assert.equal(payload.prompt_cache_key, "session-sensitive-key", "the provider payload must not be mutated");
  assert.equal(
    withCodexPromptCacheKey(payload, { provider: "xai", api: "openai-completions" }, "stable", scopeKey),
    undefined,
  );
  assert.equal(
    withCodexPromptCacheKey(
      payload,
      { provider: "openai-codex", api: "openai-responses" },
      "stable",
      scopeKey,
    ),
    undefined,
  );
});
