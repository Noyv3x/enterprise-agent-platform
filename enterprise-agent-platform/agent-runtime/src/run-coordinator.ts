import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { ApprovalBroker } from "./approval-broker.js";
import { EventJournal } from "./event-journal.js";
import { resolveModel, validateProductModelRequest } from "./model-resolver.js";
import { PlatformGateway } from "./platform-gateway.js";
import { AlwaysApprovalStore, IdempotencyStore, type PersistentIdempotencyRecord } from "./persistence.js";
import { ProcessRegistry } from "./process-registry.js";
import { SessionStore } from "./session-store.js";
import { classifyToolCall, createTools, readRegularFileRange } from "./tools.js";
import type { ApprovalDecision, JsonObject, JsonValue, RunRecord, RunRequest, RunResult, RuntimeConfig } from "./types.js";
import { abortError, assertNonEmpty, errorMessage, id, resolveWorkspacePath, scopeOwns } from "./utils.js";

interface RunCompletion {
  promise: Promise<RunRecord>;
  resolve: (record: RunRecord) => void;
}

interface ScopeCleanupFence {
  scopeKey: string;
  lifecycleId?: string;
}

export class RunCapacityError extends Error {
  readonly statusCode = 429;
}

export class RunValidationError extends Error {
  readonly statusCode = 400;
}

export interface RunCoordinatorOptions {
  config: RuntimeConfig;
  streamFn?: StreamFn;
}

export class RunCoordinator {
  readonly sessions: SessionStore;
  readonly processes: ProcessRegistry;
  readonly gateway: PlatformGateway;
  readonly approvals: ApprovalBroker;
  readonly idempotency: IdempotencyStore;
  private readonly config: RuntimeConfig;
  private readonly streamFn: StreamFn | undefined;
  private readonly runs = new Map<string, RunRecord>();
  private readonly journals = new Map<string, EventJournal>();
  private readonly completions = new Map<string, RunCompletion>();
  private readonly agents = new Map<string, Agent>();
  private readonly delegateCounts = new Map<string, number>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly topLevelQueue: string[] = [];
  private readonly activeTopLevelRuns = new Set<string>();
  private readonly childRuns = new Set<string>();
  private readonly scopeCleanupFences = new Set<ScopeCleanupFence>();
  private readonly forcedReviewReasons = new Map<string, string>();

  constructor(options: RunCoordinatorOptions) {
    this.config = options.config;
    this.streamFn = options.streamFn;
    this.sessions = new SessionStore(options.config.home);
    this.processes = new ProcessRegistry();
    this.gateway = new PlatformGateway(options.config.platformUrl, options.config.platformToken);
    this.idempotency = new IdempotencyStore(options.config.home);
    this.approvals = new ApprovalBroker(
      options.config.approvalTimeoutMs,
      (approval) => {
        this.journals.get(approval.run_id)?.publish("approval.requested", {
          approval_id: approval.id,
          tool_name: approval.tool_name,
          arguments: approval.arguments as JsonObject,
          reason: approval.reason,
          scope_key: approval.scope_key,
          session_id: approval.session_id,
        });
      },
      (approval, decision) => {
        this.journals.get(approval.run_id)?.publish("approval.resolved", {
          approval_id: approval.id,
          decision,
          tool_name: approval.tool_name,
        });
      },
      { always: new AlwaysApprovalStore(options.config.home), sessions: this.sessions },
    );
  }

  createRun(request: RunRequest, childRun = false): RunRecord {
    try {
      validateRunRequest(request);
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "statusCode" in error
        && Number((error as { statusCode?: unknown }).statusCode) === 400
      ) {
        throw error;
      }
      throw new RunValidationError(errorMessage(error));
    }
    this.assertScopeAvailable(request);
    const idempotencyKey = runIdempotencyKey(request);
    if (idempotencyKey) {
      const existingId = this.idempotencyIndex.get(idempotencyKey);
      const existing = existingId ? this.runs.get(existingId) : undefined;
      if (existing) return existing;
      if (existingId) this.idempotencyIndex.delete(idempotencyKey);
      const persisted = this.idempotency.find(request.scope_key, idempotencyValue(request)!);
      if (persisted) return this.restorePersistentRun(request, persisted, idempotencyKey);
    }
    if (!childRun && this.topLevelQueue.length >= this.config.maxQueuedRuns) {
      throw new RunCapacityError(`Agent run queue is full (${this.config.maxQueuedRuns} waiting runs)`);
    }
    const runId = id("run");
    const now = Date.now();
    const record: RunRecord = {
      id: runId,
      request: structuredClone(request),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
      sideEffectsStarted: false,
    };
    const journal = new EventJournal(runId);
    const completion = deferred(record);
    this.runs.set(runId, record);
    this.journals.set(runId, journal);
    this.completions.set(runId, completion);
    if (childRun) this.childRuns.add(runId);
    if (idempotencyKey) {
      this.idempotencyIndex.set(idempotencyKey, runId);
      this.idempotency.create(request.scope_key, idempotencyValue(request)!, runId, request.session_id, this.config.runRetentionMs);
    }
    journal.publish("run.queued", { status: "queued" });
    if (childRun) queueMicrotask(() => void this.execute(record));
    else {
      this.topLevelQueue.push(runId);
      this.drainTopLevelQueue();
    }
    return record;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  getJournal(runId: string): EventJournal | undefined {
    return this.journals.get(runId);
  }

  async wait(runId: string): Promise<RunRecord> {
    const completion = this.completions.get(runId);
    if (!completion) throw new Error("Run not found");
    return await completion.promise;
  }

  async respondApproval(runId: string, approvalId: string | undefined, decision: ApprovalDecision): Promise<void> {
    const resolvedApprovalId = approvalId || this.approvals.latestForRun(runId)?.id;
    if (!resolvedApprovalId) throw new Error("Approval request not found");
    await this.approvals.respond(runId, resolvedApprovalId, decision);
  }

  cancel(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error("Run not found");
    if (isTerminal(record.status)) return record;
    record.controller.abort();
    this.agents.get(runId)?.abort();
    this.approvals.cancelRun(runId);
    this.processes.killRun(runId);
    if (record.status === "queued") {
      const queueIndex = this.topLevelQueue.indexOf(runId);
      if (queueIndex >= 0) this.topLevelQueue.splice(queueIndex, 1);
      this.finish(record, "cancelled", "Run cancelled");
    }
    return record;
  }

  async cleanupScope(scopeKey: string, lifecycleId?: string, deleteSessions = false): Promise<number> {
    const fence: ScopeCleanupFence = {
      scopeKey,
      ...(lifecycleId ? { lifecycleId } : {}),
    };
    // Installing the fence before the first await makes createRun() and the
    // cleanup snapshot atomic with respect to this single Node.js process.
    this.scopeCleanupFences.add(fence);
    try {
      const matching = [...this.runs.values()].filter(
        (record) => scopeOwns(scopeKey, record.request.scope_key)
          && (!lifecycleId || record.request.lifecycle_id === lifecycleId),
      );
      let cancelled = 0;
      const pending: Promise<RunRecord>[] = [];
      for (const record of matching) {
        if (isTerminal(record.status)) continue;
        pending.push(this.wait(record.id));
        this.cancel(record.id);
        cancelled += 1;
      }
      if (pending.length) {
        await Promise.race([
          Promise.all(pending),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timed out while confirming Agent run cancellation")),
              10_000,
            );
            timer.unref();
          }),
        ]);
      }
      if (matching.some((record) => !isTerminal(record.status))) {
        throw new Error("Agent run cancellation could not be confirmed");
      }
      await this.approvals.clearScope(scopeKey, lifecycleId);
      this.processes.killScope(scopeKey, lifecycleId);
      if (!await this.processes.waitForScopeExit(scopeKey, lifecycleId)) {
        throw new Error("Agent process cleanup could not be confirmed");
      }
      if (deleteSessions) await this.sessions.deleteScopeFamily(scopeKey, lifecycleId);
      return cancelled;
    } finally {
      this.scopeCleanupFences.delete(fence);
    }
  }

  private assertScopeAvailable(request: RunRequest): void {
    const fence = [...this.scopeCleanupFences].find(
      (candidate) => scopeOwns(candidate.scopeKey, request.scope_key)
        && (!candidate.lifecycleId || candidate.lifecycleId === request.lifecycle_id),
    );
    if (!fence) return;
    const lifecycle = fence.lifecycleId ? `lifecycle ${fence.lifecycleId}` : "all lifecycles";
    throw new Error(`Agent scope cleanup is in progress for ${fence.scopeKey} (${lifecycle})`);
  }

  private async execute(record: RunRecord): Promise<void> {
    await this.sessions.withSessionLock(
      sessionIdentity(record.request),
      async () => await this.executeInSession(record),
    );
  }

  private async executeInSession(record: RunRecord): Promise<void> {
    if (record.controller.signal.aborted || isTerminal(record.status)) return;
    record.status = "running";
    record.updatedAt = Date.now();
    this.persistRunStatus(record);
    const journal = this.journals.get(record.id)!;
    journal.publish("run.started", { status: "running" });
    const identity = sessionIdentity(record.request);
    let rejectTimeout!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      if (isTerminal(record.status)) return;
      record.timedOut = true;
      journal.publish("run.timeout", { timeout_ms: this.config.runTimeoutMs });
      record.controller.abort();
      this.agents.get(record.id)?.abort();
      this.approvals.cancelRun(record.id);
      this.processes.killRun(record.id);
      rejectTimeout(abortError(`Run exceeded hard timeout of ${this.config.runTimeoutMs} ms`));
    }, this.config.runTimeoutMs);
    timeout.unref();
    let rejectAbort!: (error: Error) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abortRun = (): void => rejectAbort(abortError());
    record.controller.signal.addEventListener("abort", abortRun, { once: true });
    if (record.controller.signal.aborted) abortRun();
    const executionTask = (async () => {
      const recalledMemory = await this.recallMemory(record);
      const resolved = resolveModel(record.request, this.gateway, record.controller.signal);
      const loadedHistory = await this.sessions.initialize(
        identity,
        normalizeInitialHistory(record.request.history ?? [], record.request, resolved.model.api, resolved.model.provider),
      );
      const recoveredHistory = repairInterruptedHistory(loadedHistory);
      const history = recoveredHistory.messages;
      if (recoveredHistory.repaired > 0) {
        journal.publish("session.repaired", { interrupted_tool_messages: recoveredHistory.repaired });
      }
      const tools = createTools({
        runId: record.id,
        request: record.request,
        processes: this.processes,
        gateway: this.gateway,
        querySession: async (action, arguments_, signal) => await this.querySession(
          record,
          action,
          arguments_,
          signal,
        ),
        markSideEffect: () => { record.sideEffectsStarted = true; },
        delegate: async (prompt, systemPrompt, signal) => await this.delegate(record, prompt, systemPrompt, signal),
      });
      const agentOptions: ConstructorParameters<typeof Agent>[0] = {
        initialState: {
          systemPrompt: recalledMemory
            ? `${record.request.system_prompt}\n\n<recalled_memory>\n${recalledMemory}\n</recalled_memory>`
            : record.request.system_prompt,
          model: resolved.model,
          thinkingLevel: record.request.thinking_level ?? "off",
          tools,
          messages: history,
        },
        sessionId: record.request.session_id,
        getApiKey: resolved.getApiKey,
        // The platform exposes a single explicit approval card per run. Keep
        // tool calls ordered so two sensitive calls can never create competing
        // pending approvals that the user cannot address independently.
        toolExecution: "sequential",
        transformContext: async (messages) => {
          if (estimateTokens(messages) < resolved.model.contextWindow * this.config.compactionThreshold) return messages;
          const compactedMessages = compactContext(messages);
          const omitted = Math.max(0, messages.length - compactedMessages.length);
          if (omitted > 0) {
            journal.publish("context.compacted", { omitted_messages: omitted, retained_messages: compactedMessages.length });
            await this.sessions.rewriteCompacted(identity, compactedMessages, {
              omitted_messages: omitted,
              retained_messages: compactedMessages.length,
            });
          }
          return compactedMessages;
        },
        beforeToolCall: async (toolContext, signal) => {
          if (record.controller.signal.aborted) {
            return { block: true, reason: "Agent run is no longer active" };
          }
          const policy = await classifyToolCall(
            toolContext.toolCall.name,
            toolContext.args,
            record.request.workspace,
          );
          if (policy.hardBlock) return { block: true, reason: policy.hardBlock };
          if (!policy.approvalReason) return undefined;
          const metadata = record.request.metadata as JsonObject | undefined;
          const approvalRunId = typeof metadata?.approval_owner_run_id === "string" ? metadata.approval_owner_run_id : record.id;
          const approvalScopeKey = typeof metadata?.approval_scope_key === "string" ? metadata.approval_scope_key : record.request.scope_key;
          const approvalSessionId = typeof metadata?.approval_session_id === "string"
            ? metadata.approval_session_id
            : record.request.session_id;
          const allowed = await this.approvals.request({
            runId: approvalRunId,
            scopeKey: approvalScopeKey,
            lifecycleId: record.request.lifecycle_id,
            sessionId: approvalSessionId,
            toolName: toolContext.toolCall.name,
            arguments: toolContext.args,
            reason: policy.approvalReason,
            ...(signal ? { signal } : {}),
          });
          return allowed ? undefined : { block: true, reason: "User denied the operation" };
        },
      };
      if (this.streamFn) agentOptions.streamFn = this.streamFn;
      if (record.controller.signal.aborted) throw abortError();
      const agent = new Agent(agentOptions);
      this.agents.set(record.id, agent);
      const onAbort = (): void => agent.abort();
      record.controller.signal.addEventListener("abort", onAbort, { once: true });
      agent.subscribe(async (event) => await this.handleAgentEvent(record, event));
      const prompt = await buildPrompt(record.request, record.controller.signal);
      try {
        if (record.controller.signal.aborted) throw abortError();
        await agent.prompt(prompt);
      } finally {
        record.controller.signal.removeEventListener("abort", onAbort);
      }
      if (record.controller.signal.aborted) throw abortError();
      const forcedReviewReason = this.forcedReviewReasons.get(record.id);
      if (forcedReviewReason) throw new Error(forcedReviewReason);
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      const result = resultFromMessages(agent.state.messages, resolved.model.provider, resolved.model.id);
      record.result = result;
      await this.sessions.appendRun(identity, { run_id: record.id, status: "completed" });
      this.finish(record, "completed", undefined, {
        output: result.content,
        content: result.content,
        session_id: record.request.session_id,
        model: result.model,
        usage: result.usage ?? {},
      });
    })();
    try {
      await Promise.race([executionTask, timeoutPromise, abortPromise]);
    } catch (error) {
      // The timeout branch aborts every operation but Promise.race does not
      // cancel its losing promise. Give cooperative providers and tools a
      // bounded cleanup window, then finish fail-closed instead of allowing one
      // uncooperative stream to occupy a session/concurrency slot forever.
      const cleanupConfirmed = await Promise.race([
        executionTask.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(
          () => resolve(false),
          this.config.cleanupGraceMs,
        )),
      ]);
      if (!cleanupConfirmed) {
        journal.publish("run.cleanup_timeout", { cleanup_grace_ms: this.config.cleanupGraceMs });
      }
      const aborted = record.controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const status: RunRecord["status"] = !cleanupConfirmed
        ? "needs_review"
        : (record.timedOut || aborted)
        ? record.sideEffectsStarted ? "needs_review" : "cancelled"
        : record.sideEffectsStarted ? "needs_review" : "failed";
      const baseMessage = record.timedOut
        ? `Run exceeded hard timeout of ${this.config.runTimeoutMs} ms`
        : aborted ? "Run cancelled" : errorMessage(error);
      const message = cleanupConfirmed
        ? baseMessage
        : `${baseMessage}; Agent cleanup did not settle within ${this.config.cleanupGraceMs} ms`;
      await this.sessions.appendRun(identity, { run_id: record.id, status, error: message }).catch(() => undefined);
      this.finish(record, status, message);
    } finally {
      clearTimeout(timeout);
      record.controller.signal.removeEventListener("abort", abortRun);
      this.agents.delete(record.id);
      this.forcedReviewReasons.delete(record.id);
      this.approvals.cancelRun(record.id);
      if (!record.result) this.processes.killRun(record.id);
    }
  }

  private async handleAgentEvent(record: RunRecord, event: AgentEvent): Promise<void> {
    if (isTerminal(record.status)) return;
    const journal = this.journals.get(record.id)!;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") journal.publish("message.delta", { delta: update.delta, content_index: update.contentIndex });
      else if (update.type === "thinking_delta") journal.publish("thinking.delta", { delta: update.delta, content_index: update.contentIndex });
      else if (update.type === "toolcall_delta") journal.publish("tool.arguments.delta", { delta: update.delta, content_index: update.contentIndex });
      return;
    }
    if (event.type === "message_end") {
      await this.sessions.appendMessage(sessionIdentity(record.request), event.message);
      if (event.message.role === "assistant") {
        journal.publish("message.final", {
          content: assistantText(event.message),
          stop_reason: event.message.stopReason,
          usage: event.message.usage as unknown as JsonObject,
        });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      journal.publish("tool.started", { tool_call_id: event.toolCallId, tool_name: event.toolName, arguments: event.args as JsonObject });
    } else if (event.type === "tool_execution_update") {
      journal.publish("tool.updated", { tool_call_id: event.toolCallId, tool_name: event.toolName, partial_result: event.partialResult as JsonObject });
    } else if (event.type === "tool_execution_end") {
      journal.publish(event.isError ? "tool.failed" : "tool.completed", {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        result: event.result as JsonObject,
        is_error: event.isError,
      });
    }
  }

  private async delegate(parent: RunRecord, prompt: string, systemPrompt: string | undefined, signal?: AbortSignal): Promise<string> {
    const depth = Number(parent.request.metadata?.delegation_depth ?? 0);
    if (depth >= this.config.maxDelegationDepth) throw new Error(`Delegation depth limit (${this.config.maxDelegationDepth}) reached`);
    const count = this.delegateCounts.get(parent.id) ?? 0;
    if (count >= this.config.maxDelegatesPerRun) throw new Error(`Delegation limit (${this.config.maxDelegatesPerRun}) reached`);
    this.delegateCounts.set(parent.id, count + 1);
    const childMarker = id("delegate");
    const approvalOwnerRunId = typeof parent.request.metadata?.approval_owner_run_id === "string"
      ? parent.request.metadata.approval_owner_run_id
      : parent.id;
    const approvalScopeKey = typeof parent.request.metadata?.approval_scope_key === "string"
      ? parent.request.metadata.approval_scope_key
      : parent.request.scope_key;
    const approvalSessionId = typeof parent.request.metadata?.approval_session_id === "string"
      ? parent.request.metadata.approval_session_id
      : parent.request.session_id;
    const childMetadata: JsonObject = {
      ...(parent.request.metadata ?? {}),
      parent_run_id: parent.id,
      delegation_depth: depth + 1,
      approval_owner_run_id: approvalOwnerRunId,
      approval_scope_key: approvalScopeKey,
      approval_session_id: approvalSessionId,
    };
    delete childMetadata.idempotency_key;
    const childRequest: RunRequest = {
      ...structuredClone(parent.request),
      scope_key: `${parent.request.scope_key}/delegate/${childMarker}`,
      lifecycle_id: parent.request.lifecycle_id,
      session_id: `${parent.request.session_id}:${childMarker}`,
      system_prompt: systemPrompt || parent.request.system_prompt,
      input: prompt,
      history: [],
      metadata: childMetadata,
    };
    const child = this.createRun(childRequest, true);
    const journal = this.journals.get(approvalOwnerRunId) ?? this.journals.get(parent.id)!;
    journal.publish("delegation.started", { child_run_id: child.id, depth: depth + 1 });
    const onAbort = (): void => { this.cancel(child.id); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const completed = await this.wait(child.id);
      if (completed.sideEffectsStarted) parent.sideEffectsStarted = true;
      if (completed.status !== "completed" || !completed.result) {
        if (completed.status === "needs_review") {
          this.forcedReviewReasons.set(
            parent.id,
            completed.error || "A delegated Agent stopped after starting side effects and requires review",
          );
        }
        journal.publish("delegation.failed", {
          child_run_id: child.id,
          status: completed.status,
          error: completed.error || `Child run ${completed.status}`,
          side_effects_started: completed.sideEffectsStarted,
        });
        throw new Error(completed.error || `Child run ${completed.status}`);
      }
      journal.publish("delegation.completed", { child_run_id: child.id, content: completed.result.content });
      return completed.result.content;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.processes.killScope(child.request.scope_key, child.request.lifecycle_id);
      await this.processes.waitForScopeExit(
        child.request.scope_key,
        child.request.lifecycle_id,
      ).catch(() => false);
      await this.gateway.invoke(
        child.request,
        child.id,
        "browser",
        "cleanup",
        {},
      ).catch(() => undefined);
      await this.gateway.invoke(
        child.request,
        child.id,
        "memory",
        "clear",
        { target: "memory" },
      ).catch(() => undefined);
      await this.sessions.deleteScopeFamily(
        child.request.scope_key,
      ).catch(() => undefined);
    }
  }

  private finish(record: RunRecord, status: RunRecord["status"], error?: string, data: JsonObject = {}): void {
    if (isTerminal(record.status) && record.status !== "running") return;
    record.status = status;
    record.updatedAt = Date.now();
    if (error) record.error = error;
    this.persistRunStatus(record);
    const eventType = status === "needs_review" ? "run.needs_review" : `run.${status}`;
    this.journals.get(record.id)?.publish(eventType, { status, ...(error ? { error } : {}), ...data });
    this.completions.get(record.id)?.resolve(record);
    this.scheduleRetention(record, Date.now() + this.config.runRetentionMs);
  }

  private scheduleRetention(record: RunRecord, expiresAt: number): void {
    const timer = setTimeout(() => {
      this.runs.delete(record.id);
      this.journals.delete(record.id);
      this.completions.delete(record.id);
      this.delegateCounts.delete(record.id);
      this.childRuns.delete(record.id);
      const idempotencyKey = runIdempotencyKey(record.request);
      if (idempotencyKey && this.idempotencyIndex.get(idempotencyKey) === record.id) {
        this.idempotencyIndex.delete(idempotencyKey);
        this.idempotency.delete(record.request.scope_key, idempotencyValue(record.request)!, record.id);
      }
    }, Math.max(1, expiresAt - Date.now()));
    timer.unref();
  }

  private persistRunStatus(record: RunRecord): void {
    const key = idempotencyValue(record.request);
    if (!key) return;
    this.idempotency.update(record.request.scope_key, key, {
      status: record.status,
      retentionMs: this.config.runRetentionMs,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    });
  }

  private restorePersistentRun(request: RunRequest, persisted: PersistentIdempotencyRecord, mapKey: string): RunRecord {
    let status = persisted.status;
    let error = persisted.error;
    if (status === "queued" || status === "running" || (status === "completed" && !persisted.result)) {
      status = "needs_review";
      error = "The original sidecar stopped before a replayable terminal result was persisted; the idempotent run was not executed again.";
    }
    const result: RunResult | undefined = persisted.result ? {
      content: persisted.result.content,
      messages: [],
      model: persisted.result.model,
      ...(persisted.result.usage ? { usage: persisted.result.usage } : {}),
    } : undefined;
    const record: RunRecord = {
      id: persisted.run_id,
      request: structuredClone(request),
      status,
      createdAt: persisted.created_at,
      updatedAt: Date.now(),
      controller: new AbortController(),
      sideEffectsStarted: status === "needs_review",
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
    const journal = new EventJournal(record.id);
    this.runs.set(record.id, record);
    this.journals.set(record.id, journal);
    this.completions.set(record.id, deferred(record));
    this.idempotencyIndex.set(mapKey, record.id);
    journal.publish("run.reused", { status, persisted: true });
    const terminalType = status === "needs_review" ? "run.needs_review" : `run.${status}`;
    journal.publish(terminalType, {
      status,
      reused: true,
      ...(result ? {
        output: result.content,
        content: result.content,
        session_id: persisted.session_id,
        model: result.model,
        usage: result.usage ?? {},
      } : {}),
      ...(error ? { error } : {}),
    });
    const converted = status !== persisted.status || error !== persisted.error;
    if (converted) this.persistRunStatus(record);
    this.scheduleRetention(record, converted ? Date.now() + this.config.runRetentionMs : persisted.expires_at);
    return record;
  }

  shutdown(): void {
    for (const record of this.runs.values()) if (!isTerminal(record.status)) this.cancel(record.id);
    this.processes.shutdown();
  }

  private drainTopLevelQueue(): void {
    while (this.activeTopLevelRuns.size < this.config.maxConcurrency) {
      const runId = this.topLevelQueue.shift();
      if (!runId) return;
      const record = this.runs.get(runId);
      if (!record || isTerminal(record.status)) continue;
      this.activeTopLevelRuns.add(runId);
      queueMicrotask(() => {
        void this.execute(record).finally(() => {
          this.activeTopLevelRuns.delete(runId);
          this.drainTopLevelQueue();
        });
      });
    }
  }

  private async recallMemory(record: RunRecord): Promise<string> {
    const depth = Number(record.request.metadata?.delegation_depth ?? 0);
    if (depth > 0 || (!this.gateway.configured && !record.request.gateway?.base_url)) return "";
    const query = inputText(record.request.input).trim();
    if (!query) return "";
    try {
      const result = await this.gateway.invoke(
        record.request,
        record.id,
        "memory",
        "search",
        { query: query.slice(0, 4_000), limit: 8 },
        record.controller.signal,
      );
      const recalled = String(result.content || "").replaceAll("</recalled_memory>", "&lt;/recalled_memory>");
      if (!recalled || recalled === "{}" || recalled === "null") return "";
      const bounded = recalled.slice(0, 8_000);
      this.journals.get(record.id)?.publish("memory.recalled", { characters: bounded.length });
      return bounded;
    } catch (error) {
      this.journals.get(record.id)?.publish("memory.recall.failed", { error: errorMessage(error) });
      return "";
    }
  }

  private async querySession(
    record: RunRecord,
    action: string,
    arguments_: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (!["search", "read", "list"].includes(action)) {
      throw new Error("session action must be search, read, or list");
    }
    if (signal?.aborted) throw abortError();
    const limit = boundedSessionInteger(arguments_.limit, 50, 1, 200, "session limit");
    const messages = await this.sessions.load(sessionIdentity(record.request));
    if (signal?.aborted) throw abortError();
    let summaries = messages.map((message, index) => sessionMessageSummary(message, index));
    if (action === "read" && arguments_.index !== undefined) {
      const index = boundedSessionInteger(
        arguments_.index,
        -1,
        0,
        Math.max(0, summaries.length - 1),
        "session index",
      );
      const selected = summaries[index];
      if (!selected) throw new Error(`session message ${index} was not found`);
      summaries = [selected];
    } else {
      const query = String(arguments_.query || "").trim().toLocaleLowerCase();
      if (query) {
        summaries = summaries.filter((message) => JSON.stringify(message).toLocaleLowerCase().includes(query));
      }
      summaries = summaries.slice(-limit);
    }
    const result: Record<string, JsonValue> = {
      scope_key: record.request.scope_key,
      lifecycle_id: record.request.lifecycle_id,
      session_id: record.request.session_id,
      messages: summaries,
    };
    return result;
  }
}

function boundedSessionInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function sessionMessageSummary(message: AgentMessage, index: number): Record<string, JsonValue> {
  const raw = message as unknown as Record<string, unknown>;
  const timestamp = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
    ? raw.timestamp
    : undefined;
  return {
    index,
    role: typeof raw.role === "string" ? raw.role : "unknown",
    content: sessionContentText(raw.content).slice(0, 4_000),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function sessionContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!block || typeof block !== "object") return "";
    const item = block as Record<string, unknown>;
    if (item.type === "image") return "[image omitted]";
    if (typeof item.text === "string") return item.text;
    if (item.type === "toolCall") {
      const name = typeof item.name === "string" ? item.name : "unknown";
      const arguments_ = item.arguments === undefined ? "" : JSON.stringify(item.arguments);
      return `[tool call ${name}] ${arguments_}`;
    }
    return typeof item.type === "string" ? `[${item.type}]` : "";
  }).filter(Boolean).join("\n");
}

function validateRunRequest(request: RunRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("run request must be an object");
  }
  assertNonEmpty(request.scope_key, "scope_key");
  assertNonEmpty(request.lifecycle_id, "lifecycle_id");
  assertNonEmpty(request.session_id, "session_id");
  assertNonEmpty(request.workspace, "workspace");
  assertMaximumLength(request.scope_key, 512, "scope_key");
  assertMaximumLength(request.lifecycle_id, 512, "lifecycle_id");
  assertMaximumLength(request.session_id, 512, "session_id");
  assertMaximumLength(request.workspace, 4_096, "workspace");
  if (typeof request.system_prompt !== "string") throw new Error("system_prompt must be a string");
  if (typeof request.input !== "string" && !Array.isArray(request.input)) throw new Error("input must be a string or content array");
  if (Array.isArray(request.input)) {
    for (const block of request.input as unknown[]) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        throw new Error("input content blocks must be objects");
      }
      const candidate = block as Record<string, unknown>;
      if (candidate.type === "text" && typeof candidate.text === "string") continue;
      if (
        candidate.type === "image"
        && typeof candidate.data === "string"
        && typeof candidate.mimeType === "string"
      ) continue;
      throw new Error("input content blocks must be valid text or image blocks");
    }
  }
  if (request.history !== undefined && !Array.isArray(request.history)) throw new Error("history must be an array");
  if (request.attachments !== undefined) {
    if (!Array.isArray(request.attachments) || request.attachments.length > 64) {
      throw new Error("attachments must be an array with at most 64 items");
    }
    for (const attachment of request.attachments as unknown[]) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        throw new Error("attachment entries must be objects");
      }
    }
  }
  if (
    request.metadata !== undefined
    && (!request.metadata || typeof request.metadata !== "object" || Array.isArray(request.metadata))
  ) throw new Error("metadata must be an object");
  if (request.gateway !== undefined) {
    if (!request.gateway || typeof request.gateway !== "object" || Array.isArray(request.gateway)) {
      throw new Error("gateway must be an object");
    }
    if (request.gateway.base_url !== undefined && typeof request.gateway.base_url !== "string") {
      throw new Error("gateway.base_url must be a string");
    }
    if (request.gateway.token !== undefined && typeof request.gateway.token !== "string") {
      throw new Error("gateway.token must be a string");
    }
  }
  if (request.thinking_level !== undefined && typeof request.thinking_level !== "string") {
    throw new Error("thinking_level must be a string");
  }
  if (!request.model || typeof request.model !== "object") throw new Error("model is required");
  assertNonEmpty(request.model.provider, "model.provider");
  assertNonEmpty(request.model.id, "model.id");
  if (request.model.reasoning !== undefined && typeof request.model.reasoning !== "boolean") {
    throw new Error("model.reasoning must be a boolean");
  }
  validateProductModelRequest(request.model);
}

function assertMaximumLength(value: string, maximum: number, name: string): void {
  if (value.length > maximum) throw new Error(`${name} must contain at most ${maximum} characters`);
}

const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

async function buildPrompt(request: RunRequest, signal?: AbortSignal): Promise<UserMessage> {
  let content: string | Array<TextContent | ImageContent> = request.input;
  if (request.attachments?.length) {
    const blocks: Array<TextContent | ImageContent> = typeof content === "string" ? [{ type: "text", text: content }] : content.slice();
    let imageBytes = 0;
    for (const attachment of request.attachments) {
      if (signal?.aborted) throw abortError();
      if (attachment.path && attachment.mime_type?.startsWith("image/")) {
        const path = resolveWorkspacePath(request.workspace, attachment.path);
        const selected = await readRegularFileRange(
          path,
          0,
          MAX_MODEL_IMAGE_BYTES,
          signal,
          MAX_MODEL_IMAGE_BYTES,
        );
        imageBytes += selected.buffer.length;
        if (imageBytes > MAX_MODEL_IMAGE_TOTAL_BYTES) {
          throw new Error(`Model image attachments exceed ${MAX_MODEL_IMAGE_TOTAL_BYTES} bytes in total`);
        }
        blocks.push({
          type: "image",
          data: selected.buffer.toString("base64"),
          mimeType: attachment.mime_type,
        });
      } else {
        blocks.push({ type: "text", text: `Attachment: ${attachment.name || attachment.path || attachment.url || "unnamed"}` });
      }
    }
    content = blocks;
  }
  return { role: "user", content, timestamp: Date.now() };
}

function sessionIdentity(request: RunRequest): Pick<RunRequest, "scope_key" | "lifecycle_id" | "session_id"> {
  return { scope_key: request.scope_key, lifecycle_id: request.lifecycle_id, session_id: request.session_id };
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("");
}

function normalizeInitialHistory(messages: AgentMessage[], request: RunRequest, api: string, provider: string): AgentMessage[] {
  const normalized: AgentMessage[] = [];
  for (const candidate of messages as unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as Record<string, unknown>;
    const role = message.role;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (role === "user") {
      const content = normalizeVisibleContent(message.content);
      if (content !== undefined) normalized.push({ role: "user", content, timestamp });
    } else if (role === "assistant") {
      const content = normalizeAssistantContent(message.content);
      if (content.length === 0) continue;
      normalized.push({
        role: "assistant",
        content,
        api,
        provider,
        model: request.model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp,
      });
    } else if (role === "toolResult" && typeof message.toolCallId === "string" && typeof message.toolName === "string") {
      normalized.push(candidate as AgentMessage);
    }
  }
  return normalized;
}

function repairInterruptedHistory(messages: AgentMessage[]): { messages: AgentMessage[]; repaired: number } {
  const knownToolCalls = new Set<string>();
  const completedToolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") knownToolCalls.add(block.id);
    } else if (message.role === "toolResult") {
      completedToolCalls.add(message.toolCallId);
    }
  }
  let repaired = 0;
  const recovered: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = message.content.flatMap((block): AssistantMessage["content"] => {
        if (block.type !== "toolCall" || completedToolCalls.has(block.id)) return [block];
        repaired += 1;
        return [{
          type: "text",
          text: `[Runtime recovery: tool call "${block.name}" ended before a result was durably recorded; its outcome is unknown.]`,
        }];
      });
      recovered.push({ ...message, content });
      continue;
    }
    if (message.role === "toolResult" && !knownToolCalls.has(message.toolCallId)) {
      repaired += 1;
      continue;
    }
    recovered.push(message);
  }
  return { messages: recovered, repaired };
}

function normalizeVisibleContent(value: unknown): string | Array<TextContent | ImageContent> | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const blocks: Array<TextContent | ImageContent> = [];
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") blocks.push({ type: "text", text: item.text });
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return blocks.length ? blocks : undefined;
}

function normalizeAssistantContent(value: unknown): AssistantMessage["content"] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block): AssistantMessage["content"] => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
    if (item.type === "thinking" && typeof item.thinking === "string") return [{ type: "thinking", thinking: item.thinking }];
    return [];
  });
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function resultFromMessages(messages: AgentMessage[], provider: string, model: string): RunResult {
  const assistant = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
  if (!assistant) throw new Error("Agent completed without an assistant response");
  return {
    content: assistantText(assistant),
    messages,
    model: { provider, id: model },
    usage: assistant.usage as unknown as JsonObject,
  };
}

function estimateTokens(messages: AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function inputText(input: RunRequest["input"]): string {
  if (typeof input === "string") return input;
  return input.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
}

export function compactContext(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= 6) return messages;
  const retain = Math.max(6, Math.ceil(messages.length * 0.2));
  const proposedStart = Math.max(0, messages.length - retain);
  const relativeUserStart = messages.slice(proposedStart).findIndex((message) => message.role === "user");
  let safeStart = relativeUserStart >= 0 ? proposedStart + relativeUserStart : proposedStart;
  if (relativeUserStart < 0 && messages[safeStart]?.role === "toolResult") {
    let resultBlockStart = safeStart;
    while (resultBlockStart > 0 && messages[resultBlockStart - 1]?.role === "toolResult") {
      resultBlockStart -= 1;
    }
    const preceding = messages[resultBlockStart - 1];
    const callIds = preceding?.role === "assistant"
      ? new Set(preceding.content.filter((block) => block.type === "toolCall").map((block) => block.id))
      : new Set<string>();
    let resultBlockEnd = resultBlockStart;
    while (resultBlockEnd < messages.length && messages[resultBlockEnd]?.role === "toolResult") {
      resultBlockEnd += 1;
    }
    const leadingResults = messages.slice(resultBlockStart, resultBlockEnd).filter(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
    );
    if (preceding?.role === "assistant" && leadingResults.every((message) => callIds.has(message.toolCallId))) {
      safeStart = resultBlockStart - 1;
    } else {
      while (safeStart < messages.length && messages[safeStart]?.role === "toolResult") safeStart += 1;
    }
  }
  const tail = messages.slice(safeStart);
  const notice: UserMessage = {
    role: "user",
    content: "Earlier conversation entries were compacted by the runtime. Use the retained recent context and session tools when older detail is needed.",
    timestamp: Date.now(),
  };
  return [notice, ...tail];
}

function isTerminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "needs_review";
}

function deferred(initial: RunRecord): RunCompletion {
  let resolve!: (record: RunRecord) => void;
  const promise = new Promise<RunRecord>((done) => { resolve = done; });
  if (isTerminal(initial.status)) resolve(initial);
  return { promise, resolve };
}

function runIdempotencyKey(request: RunRequest): string | undefined {
  const value = idempotencyValue(request);
  return value ? `${request.scope_key}\0${value}` : undefined;
}

function idempotencyValue(request: RunRequest): string | undefined {
  const value = request.metadata?.idempotency_key;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
