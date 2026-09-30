import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createAgentSession, createExtensionRuntime, SessionManager, SettingsManager,
  type AgentSession, type ModelRuntime, type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { createModelRuntime } from './credentials.js';
import { sessionPath } from './migration.js';
import { bindModelSession, resolveModel, type ModelSelection } from './models.js';

export type CompactionOutcome = {
  compacted: true;
  model: string;
  usage: { input: number; output: number; cache_read: number; cache_write: number; total: number };
} | { compacted: false; reason: 'too_small' };

export async function compactSession(session: AgentSession, signal?: AbortSignal): Promise<CompactionOutcome> {
  let abortCompletion: Promise<void> | undefined;
  const abort = () => {
    // Observe rejection immediately; cancellation remains an AbortError after cleanup.
    abortCompletion = session.abort().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await session.compact();
    signal?.throwIfAborted();
    return {
      compacted: true,
      model: session.model!.id,
      usage: {
        input: result.usage?.input ?? 0,
        output: result.usage?.output ?? 0,
        cache_read: result.usage?.cacheRead ?? 0,
        cache_write: result.usage?.cacheWrite ?? 0,
        total: result.usage?.totalTokens ?? 0,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Compaction cancelled', 'AbortError');
    // Pi 0.87.1 reports this expected no-work outcome as an untyped Error.
    if (error instanceof Error && error.message === 'Nothing to compact (session too small)') return { compacted: false, reason: 'too_small' };
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await abortCompletion;
  }
}

export async function compactStored(
  home: string,
  sid: string,
  platformUrl: string,
  token: string,
  selectedModel: ModelSelection & Required<Pick<ModelSelection, 'thinking'>>,
  modelRuntimeFactory?: (modelId: string) => Promise<ModelRuntime>,
  signal?: AbortSignal,
): Promise<CompactionOutcome> {
  signal?.throwIfAborted();
  const file = sessionPath(home, sid);
  if (!existsSync(file)) throw Object.assign(new Error('Session not found'), { status: 404 });
  const manager = SessionManager.open(file, dirname(file));
  const models = await (modelRuntimeFactory?.(selectedModel.id) ??
    createModelRuntime(platformUrl, token, () => selectedModel.id));
  // compact() awaits preflight before creating its own controller. Guard the
  // stream boundary too, so cancellation during that gap cannot start a summary.
  bindModelSession(models, sid, () => signal?.throwIfAborted());
  const model = await resolveModel(models, selectedModel, signal);
  signal?.throwIfAborted();
  const runtime = createExtensionRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
  const { session } = await createAgentSession({
    cwd: manager.getCwd(),
    agentDir: join(home, 'empty-agent'),
    modelRuntime: models,
    model,
    thinkingLevel: selectedModel.thinking,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }),
    resourceLoader,
    tools: [],
    noTools: 'all',
  });
  try {
    // compact() prepares the saved branch directly. Never prompt(): that would
    // append a replacement system message/tool loadout from this temporary session.
    return await compactSession(session, signal);
  } finally {
    session.dispose();
  }
}
