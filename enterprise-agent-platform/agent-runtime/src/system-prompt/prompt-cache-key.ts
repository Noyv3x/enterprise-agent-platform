import { createHash } from "node:crypto";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const PROMPT_CACHE_KEY_VERSION = "runtime-stable-prompt-ordered-tools-and-scope/v3";
const SCOPE_PARTITION_VERSION = "runtime-prompt-cache-scope/v1";

interface ProviderIdentity {
  provider: string;
  api: string;
}

/**
 * Build a provider cache-routing key without exposing raw Run identity or
 * volatile prompt data. The stable scope source is hashed locally to partition
 * traffic before the opaque wire key is derived. Tool schemas must come from
 * the provider payload in wire order because order changes the rendered prefix.
 */
export function codexPromptCacheKey(
  stableRuntimePrompt: string,
  providerToolSchemas: readonly unknown[],
  scopePartitionSource: string,
): string {
  const tools = [...providerToolSchemas];
  const material = canonicalJson({
    scope_partition: sha256(`${SCOPE_PARTITION_VERSION}\0${scopePartitionSource}`),
    stable_runtime_prompt: stableRuntimePrompt,
    tools,
    version: PROMPT_CACHE_KEY_VERSION,
  });
  const digest = sha256(material).slice(0, 24);
  return `pck_${digest}`;
}

/**
 * Pi calls this after constructing the concrete provider request. Returning
 * undefined preserves its payload unchanged for every other provider/API or
 * for an unexpected Codex payload shape.
 */
export function withCodexPromptCacheKey(
  payload: unknown,
  model: ProviderIdentity,
  stableRuntimePrompt: string,
  scopePartitionSource: string,
): unknown | undefined {
  if (model.provider !== CODEX_PROVIDER || model.api !== CODEX_API) return undefined;
  if (!isRecord(payload)) return undefined;
  const schemas = payload.tools;
  if (schemas !== undefined && !Array.isArray(schemas)) return undefined;
  return {
    ...payload,
    prompt_cache_key: codexPromptCacheKey(stableRuntimePrompt, schemas ?? [], scopePartitionSource),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ordinalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, candidate: unknown) => {
    if (!isRecord(candidate)) return candidate;
    const ordered = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(candidate).sort(ordinalCompare)) {
      ordered[key] = candidate[key];
    }
    return ordered;
  });
  if (encoded === undefined) throw new Error("Prompt cache material must be JSON serializable");
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
