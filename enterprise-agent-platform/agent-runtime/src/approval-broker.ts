import type { ApprovalDecision, ApprovalRequest } from "./types.js";
import { abortError, id, nowIso, scopeOwns } from "./utils.js";
import { AlwaysApprovalStore } from "./persistence.js";
import type { SessionStore } from "./session-store.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ApprovalContext {
  runId: string;
  scopeKey: string;
  lifecycleId?: string;
  sessionId: string;
  toolName: string;
  arguments: unknown;
  reason: string;
  signal?: AbortSignal;
}

export interface ApprovalPersistence {
  always: AlwaysApprovalStore;
  sessions: SessionStore;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionGrants = new Set<string>();
  private readonly alwaysGrants = new Set<string>();
  private readonly timeoutMs: number;
  private readonly onRequest: (request: ApprovalRequest) => void;
  private readonly onResolved: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  private readonly persistence: ApprovalPersistence | undefined;

  constructor(
    timeoutMs: number,
    onRequest: (request: ApprovalRequest) => void,
    onResolved: (request: ApprovalRequest, decision: ApprovalDecision) => void,
    persistence?: ApprovalPersistence,
  ) {
    this.timeoutMs = timeoutMs;
    this.onRequest = onRequest;
    this.onResolved = onResolved;
    this.persistence = persistence;
  }

  async request(context: ApprovalContext): Promise<boolean> {
    if (context.signal?.aborted) throw abortError();
    if (this.alwaysGrants.has(this.alwaysKey(context)) || this.persistence?.always.has(context.scopeKey, context.toolName)) return true;
    if (this.sessionGrants.has(this.sessionKey(context))) return true;
    if (this.persistence && context.lifecycleId && await this.persistence.sessions.hasSessionApproval({
      scope_key: context.scopeKey,
      lifecycle_id: context.lifecycleId,
      session_id: context.sessionId,
    }, context.toolName)) {
      this.sessionGrants.add(this.sessionKey(context));
      return true;
    }
    const request: ApprovalRequest = {
      id: id("approval"),
      run_id: context.runId,
      scope_key: context.scopeKey,
      lifecycle_id: context.lifecycleId ?? "",
      session_id: context.sessionId,
      tool_name: context.toolName,
      arguments: context.arguments,
      reason: context.reason,
      created_at: nowIso(),
    };
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
        reject(new Error("Approval request timed out"));
      }, this.timeoutMs);
      timer.unref();
      const item: PendingApproval = { request, resolve, timer };
      if (context.signal) {
        const onAbort = (): void => {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(abortError());
        };
        item.signal = context.signal;
        item.onAbort = onAbort;
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(request.id, item);
      this.onRequest(request);
    });
  }

  async respond(runId: string, approvalId: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const item = this.pending.get(approvalId);
    if (!item || item.request.run_id !== runId) throw new Error("Approval request not found");
    if (decision === "session" && this.persistence && item.request.lifecycle_id) {
      await this.persistence.sessions.appendSessionApproval({
        scope_key: item.request.scope_key,
        lifecycle_id: item.request.lifecycle_id,
        session_id: item.request.session_id,
      }, item.request.tool_name);
    }
    if (decision === "always") this.persistence?.always.grant(item.request.scope_key, item.request.tool_name);
    this.pending.delete(approvalId);
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
    if (decision === "session") this.sessionGrants.add(this.sessionKeyFromRequest(item.request));
    if (decision === "always") this.alwaysGrants.add(this.alwaysKeyFromRequest(item.request));
    this.onResolved(item.request, decision);
    item.resolve(decision !== "deny");
    return item.request;
  }

  latestForRun(runId: string): ApprovalRequest | undefined {
    return [...this.pending.values()].map((item) => item.request).filter((request) => request.run_id === runId).at(-1);
  }

  hasPersistentAlways(scopeKey: string, toolName: string): boolean {
    return this.persistence?.always.has(scopeKey, toolName) === true;
  }

  cancelRun(runId: string): void {
    for (const [approvalId, item] of this.pending) {
      if (item.request.run_id !== runId) continue;
      this.pending.delete(approvalId);
      clearTimeout(item.timer);
      if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
      item.resolve(false);
    }
  }

  async clearScope(scopeKey: string, lifecycleId?: string): Promise<void> {
    for (const grant of this.sessionGrants) {
      const [grantScope = "", grantLifecycle = ""] = grant.split("\0", 3);
      if (scopeOwns(scopeKey, grantScope) && (!lifecycleId || grantLifecycle === lifecycleId)) {
        this.sessionGrants.delete(grant);
      }
    }
    for (const [approvalId, item] of this.pending) {
      if (
        !scopeOwns(scopeKey, item.request.scope_key)
        || (lifecycleId && item.request.lifecycle_id !== lifecycleId)
      ) continue;
      this.pending.delete(approvalId);
      clearTimeout(item.timer);
      if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
      item.resolve(false);
    }
    await this.persistence?.sessions.clearSessionApprovals(scopeKey, lifecycleId);
  }

  private sessionKey(context: ApprovalContext): string {
    return `${context.scopeKey}\0${context.lifecycleId ?? ""}\0${context.sessionId}\0${context.toolName}`;
  }

  private sessionKeyFromRequest(request: ApprovalRequest): string {
    return `${request.scope_key}\0${request.lifecycle_id}\0${request.session_id}\0${request.tool_name}`;
  }

  private alwaysKey(context: ApprovalContext): string {
    return `${context.scopeKey}\0${context.toolName}`;
  }

  private alwaysKeyFromRequest(request: ApprovalRequest): string {
    return `${request.scope_key}\0${request.tool_name}`;
  }
}
