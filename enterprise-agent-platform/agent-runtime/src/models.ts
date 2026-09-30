import type { Api, Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface ModelSelection {
  id: string;
  thinking?: ThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
}

// Platform authorizes model IDs when resolving credentials. Its live Codex
// catalog can lead the SDK's bundled catalog; retain the native wire protocol.
export async function resolveModel(runtime: ModelRuntime, selection: ModelSelection, signal?: AbortSignal): Promise<Model<Api>> {
  const injected = runtime.getModels().find(model => model.id === selection.id &&
    model.provider !== 'openai-codex' && runtime.getRegisteredNativeProvider(model.provider));
  const provider = injected?.provider ?? 'openai-codex';
  const available = await runtime.getAvailable(provider, signal ? { signal } : undefined);
  const known = available.find(model => model.id === selection.id);
  const template = known ?? available.find(model => model.provider === 'openai-codex' && model.id === 'gpt-5.5')
    ?? available.find(model => model.provider === 'openai-codex' && model.input.includes('image'))
    ?? available.find(model => model.provider === 'openai-codex');
  if (!template) throw Object.assign(new Error(`Unknown model: ${selection.id}`), { status: 400 });
  return {
    ...template,
    id: selection.id,
    name: known?.name ?? selection.id,
    contextWindow: selection.contextWindow ?? template.contextWindow,
    maxTokens: selection.maxTokens ?? template.maxTokens,
  };
}

const bindings = new WeakMap<ModelRuntime, { sid: string; beforeRequest: (() => void) | undefined }>();
// Pi's summary/retry machinery stays untouched. Apply conversation routing at
// the final runtime boundary, after summarization chooses a random ID/no cache.
export function bindModelSession(runtime: ModelRuntime, sid: string, beforeRequest?: () => void): void {
  const existing = bindings.get(runtime);
  if (existing) {
    existing.sid = sid;
    existing.beforeRequest = beforeRequest;
    return;
  }
  const binding = { sid, beforeRequest };
  bindings.set(runtime, binding);
  let delegating = false;
  const wrap = <K extends 'stream' | 'streamSimple' | 'complete' | 'completeSimple'>(method: K) => {
    const original = runtime[method].bind(runtime);
    runtime[method] = ((model: Model<Api>, context: Parameters<ModelRuntime['streamSimple']>[1], options?: Parameters<ModelRuntime['streamSimple']>[2]) => {
      if (!delegating) binding.beforeRequest?.();
      const previous = delegating;
      delegating = true;
      try {
        return original(model, context, { ...options, sessionId: binding.sid, cacheRetention: 'short' });
      } finally {
        delegating = previous;
      }
    }) as typeof runtime[typeof method];
  };
  wrap('stream');
  wrap('streamSimple');
  wrap('complete');
  wrap('completeSimple');
}
