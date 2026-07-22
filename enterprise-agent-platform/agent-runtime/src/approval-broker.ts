import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
  ApprovalResult,
} from "./types.js";
import { abortError, id, nowIso, scopeOwns } from "./utils.js";
import { AlwaysApprovalStore } from "./persistence.js";
import type { SessionStore } from "./session-store.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
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
  approvalKey: string;
  displayArguments: unknown;
  reason: string;
  allowSession?: boolean;
  allowPermanent?: boolean;
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
  private readonly onResolved: (request: ApprovalRequest, resolution: ApprovalResolution) => void;
  private readonly persistence: ApprovalPersistence | undefined;

  constructor(
    timeoutMs: number,
    onRequest: (request: ApprovalRequest) => void,
    onResolved: (request: ApprovalRequest, resolution: ApprovalResolution) => void,
    persistence?: ApprovalPersistence,
  ) {
    this.timeoutMs = timeoutMs;
    this.onRequest = onRequest;
    this.onResolved = onResolved;
    this.persistence = persistence;
  }

  async request(context: ApprovalContext): Promise<ApprovalResult> {
    if (context.signal?.aborted) throw abortError();
    if (!context.approvalKey.startsWith("v2:")) throw new Error("approvalKey must use the v2 approval-object format");
    if (context.allowPermanent !== false
        && (this.alwaysGrants.has(this.alwaysKey(context)) || this.persistence?.always.has(context.scopeKey, context.approvalKey))) {
      return { allowed: true, outcome: "approved" };
    }
    if (context.allowSession !== false && this.sessionGrants.has(this.sessionKey(context))) {
      return { allowed: true, outcome: "approved" };
    }
    if (context.allowSession !== false && this.persistence && context.lifecycleId && await this.persistence.sessions.hasSessionApproval({
      scope_key: context.scopeKey,
      lifecycle_id: context.lifecycleId,
      session_id: context.sessionId,
    }, context.approvalKey)) {
      this.sessionGrants.add(this.sessionKey(context));
      return { allowed: true, outcome: "approved" };
    }
    const request: ApprovalRequest = {
      id: id("approval"),
      run_id: context.runId,
      scope_key: context.scopeKey,
      lifecycle_id: context.lifecycleId ?? "",
      session_id: context.sessionId,
      tool_name: context.toolName,
      approval_key: context.approvalKey,
      arguments: context.displayArguments,
      reason: context.reason,
      allow_session: context.allowSession !== false,
      allow_permanent: context.allowPermanent !== false,
      created_at: nowIso(),
    };
    return await new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(request.id, "timeout", { allowed: false, outcome: "timeout" });
      }, this.timeoutMs);
      timer.unref();
      const item: PendingApproval = { request, resolve, timer };
      if (context.signal) {
        const onAbort = (): void => {
          this.settle(request.id, "cancelled", { allowed: false, outcome: "cancelled" });
        };
        item.signal = context.signal;
        item.onAbort = onAbort;
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(request.id, item);
      try {
        this.onRequest(request);
      } catch {
        this.settle(request.id, "notification_failed", { allowed: false, outcome: "notification_failed" });
      }
    });
  }

  async respond(runId: string, approvalId: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const item = this.pending.get(approvalId);
    if (!item || item.request.run_id !== runId) throw new Error("Approval request not found");
    if (decision === "always" && !item.request.allow_permanent) {
      throw new Error("Permanent approval is not allowed for this request");
    }
    if (decision === "session" && !item.request.allow_session) {
      throw new Error("Session approval is not allowed for this request");
    }
    this.pending.delete(approvalId);
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
    try {
      if (decision === "session" && this.persistence && item.request.lifecycle_id) {
        await this.persistence.sessions.appendSessionApproval({
          scope_key: item.request.scope_key,
          lifecycle_id: item.request.lifecycle_id,
          session_id: item.request.session_id,
        }, item.request.approval_key, item.request.tool_name);
      }
      if (decision === "always") {
        this.persistence?.always.grant(
          item.request.scope_key,
          item.request.approval_key,
          item.request.tool_name,
        );
      }
    } catch (error) {
      this.publishResolved(item.request, "notification_failed");
      item.resolve({ allowed: false, outcome: "notification_failed" });
      throw error;
    }
    if (decision === "session") this.sessionGrants.add(this.sessionKeyFromRequest(item.request));
    if (decision === "always") this.alwaysGrants.add(this.alwaysKeyFromRequest(item.request));
    this.publishResolved(item.request, decision);
    item.resolve({
      allowed: decision !== "deny",
      outcome: decision === "deny" ? "denied" : "approved",
    });
    return item.request;
  }

  latestForRun(runId: string): ApprovalRequest | undefined {
    return [...this.pending.values()].map((item) => item.request).filter((request) => request.run_id === runId).at(-1);
  }

  hasPersistentAlways(scopeKey: string, approvalKey: string): boolean {
    return this.persistence?.always.has(scopeKey, approvalKey) === true;
  }

  cancelRun(runId: string): void {
    for (const [approvalId, item] of this.pending) {
      if (item.request.run_id !== runId) continue;
      this.settle(approvalId, "cancelled", { allowed: false, outcome: "cancelled" });
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
      this.settle(approvalId, "cancelled", { allowed: false, outcome: "cancelled" });
    }
    await this.persistence?.sessions.clearSessionApprovals(scopeKey, lifecycleId);
  }

  private sessionKey(context: ApprovalContext): string {
    return `${context.scopeKey}\0${context.lifecycleId ?? ""}\0${context.sessionId}\0${context.approvalKey}`;
  }

  private sessionKeyFromRequest(request: ApprovalRequest): string {
    return `${request.scope_key}\0${request.lifecycle_id}\0${request.session_id}\0${request.approval_key}`;
  }

  private alwaysKey(context: ApprovalContext): string {
    return `${context.scopeKey}\0${context.approvalKey}`;
  }

  private alwaysKeyFromRequest(request: ApprovalRequest): string {
    return `${request.scope_key}\0${request.approval_key}`;
  }

  private settle(approvalId: string, resolution: ApprovalResolution, result: ApprovalResult): void {
    const item = this.pending.get(approvalId);
    if (!item) return;
    this.pending.delete(approvalId);
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
    this.publishResolved(item.request, resolution);
    item.resolve(result);
  }

  private publishResolved(request: ApprovalRequest, resolution: ApprovalResolution): void {
    try {
      this.onResolved(request, resolution);
    } catch {
      // Resolution is already final. Observability failure must not turn a
      // denial or timeout into authorization or leave the tool call hanging.
    }
  }
}
