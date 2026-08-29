import { request as httpRequest } from "node:http";
import { lstatSync } from "node:fs";
import { EXECUTION_TARGETS, type ExecutionTarget } from "./container-contract.generated.js";
import { redactCommandForApproval } from "./approval-policy.js";
import type {
  ProcessPreviewResult,
  ProcessPreviewSummary,
  ProcessSnapshot,
  ProcessWaitResult,
} from "./process-registry.js";
import type {
  ExecutionContext,
  JsonObject,
  JsonValue,
  RuntimeConfig,
} from "./types.js";
import { abortError, errorMessage, safeEqual } from "./utils.js";

const MAX_MANAGER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPE_CLEANUP_COMPLETION_EVIDENCE = 1024;
const PROCESS_PREVIEW_REVISION = /^preview_[A-Za-z0-9._-]{1,96}:\d{1,20}$/;
const MANAGED_PROCESS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMPLETION_OWNER_ID = /^[a-f0-9]{64}$/;
const PROCESS_WAIT_TRANSPORT_GRACE_MILLISECONDS = 30_000;

export interface ExecutionIdentity {
  run_id: string;
  scope_id: string;
  lifecycle_id: string;
  tool_call_id: string;
  execution_context: ExecutionContext;
}

export interface ExecutionAuditRequest extends ExecutionIdentity {
  audit_id: string;
  target: ExecutionTarget;
  operation: string;
  action: string;
  arguments: JsonObject;
  details: JsonObject;
}

export interface ExecutionAuditReceipt {
  audit_id: string;
  executor_id: string;
  target: ExecutionTarget;
  recorded_at?: string;
}

export interface ExecutionCallContext extends ExecutionIdentity {
  receipt: ExecutionAuditReceipt;
}

export interface TaskExecutionIdentity extends Required<ScopeExecutionIdentity> {
  completion_owner_id: string;
}

export interface ReconciledTaskSnapshot extends ProcessSnapshot {
  target: ExecutionTarget;
}

export interface ExecutorTerminalResponse {
  result: ProcessSnapshot;
}

export interface ExecutorProcessResponse {
  result: JsonValue;
}

export interface ExecutorFileResponse {
  content: string;
  details?: JsonValue;
}

export interface ScopeExecutionIdentity {
  scope_id: string;
  lifecycle_id?: string;
  execution_context: ExecutionContext;
}

export interface ScopeCleanupIdentity {
  scope_id: string;
  lifecycle_id?: string;
}

export interface CompletionTaskCleanupEvidence extends TaskExecutionIdentity {
  process_id: string;
  target: ExecutionTarget;
}

export interface ScopeCleanupResult {
  confirmed: true;
  completion_tasks: CompletionTaskCleanupEvidence[];
}

export interface ExecutionManager {
  audit(request: ExecutionAuditRequest, signal?: AbortSignal): Promise<ExecutionAuditReceipt>;
  terminal(
    context: ExecutionCallContext,
    arguments_: JsonObject,
    signal?: AbortSignal,
    completionOwnerId?: string,
  ): Promise<ExecutorTerminalResponse>;
  process(
    context: ExecutionCallContext,
    action: string,
    arguments_: JsonObject,
    signal?: AbortSignal,
  ): Promise<ExecutorProcessResponse>;
  file(
    context: ExecutionCallContext,
    action: string,
    arguments_: JsonObject,
    signal?: AbortSignal,
  ): Promise<ExecutorFileResponse>;
  cancelRun(
    identity: Omit<ExecutionIdentity, "tool_call_id">,
    preserveProcessIds?: readonly string[],
  ): Promise<boolean>;
  reconcileTasks?(identity: TaskExecutionIdentity): Promise<ReconciledTaskSnapshot[]>;
  acknowledgeTask?(identity: TaskExecutionIdentity, processId: string): Promise<boolean>;
  cleanupScope(identity: ScopeCleanupIdentity): Promise<ScopeCleanupResult>;
  preview(
    identity: Required<ScopeExecutionIdentity>,
    sinceRevision?: string,
  ): Promise<ProcessPreviewResult>;
  previewSummary(identity: Required<ScopeExecutionIdentity>): Promise<ProcessPreviewSummary>;
}

export class ManagerExecutorClient implements ExecutionManager {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;

  constructor(socketPath: string, token: string, requestTimeoutMs: number) {
    if (!socketPath.trim()) throw new Error("Manager executor socket path must be non-empty");
    if (!token.trim()) throw new Error("Manager executor token must be non-empty");
    let socket: ReturnType<typeof lstatSync>;
    try {
      socket = lstatSync(socketPath);
    } catch (error) {
      throw new Error(`Manager executor socket is unavailable at ${socketPath}: ${errorMessage(error)}`);
    }
    if (socket.isSymbolicLink() || !socket.isSocket()) {
      throw new Error(`Manager executor path must be a non-symlink Unix socket: ${socketPath}`);
    }
    this.socketPath = socketPath;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async audit(request: ExecutionAuditRequest, signal?: AbortSignal): Promise<ExecutionAuditReceipt> {
    const response = objectValue(await this.post("/v1/executor/audit", request, signal));
    const auditId = stringValue(response.audit_id);
    const executorId = stringValue(response.executor_id);
    const target = executionTarget(response.target);
    if (!auditId || !safeEqual(auditId, request.audit_id)) {
      throw new Error("Manager executor returned a mismatched audit id");
    }
    if (!executorId) throw new Error("Manager executor did not return an executor id");
    if (target !== request.target) throw new Error("Manager executor returned a mismatched execution target");
    const receipt: ExecutionAuditReceipt = { audit_id: auditId, executor_id: executorId, target };
    if (typeof response.recorded_at === "string" && response.recorded_at) {
      receipt.recorded_at = response.recorded_at;
    }
    return receipt;
  }

  async terminal(
    context: ExecutionCallContext,
    arguments_: JsonObject,
    signal?: AbortSignal,
    completionOwnerId?: string,
  ): Promise<ExecutorTerminalResponse> {
    const response = objectValue(await this.post(
      "/v1/executor/terminal",
      executionBody(context, {
        action: "run",
        arguments: arguments_,
        ...(completionOwnerId ? {
          completion_required: true,
          completion_owner_id: completionOwnerId,
        } : {}),
      }),
      signal,
    ));
    return { result: processSnapshot(response.result) };
  }

  async process(
    context: ExecutionCallContext,
    action: string,
    arguments_: JsonObject,
    signal?: AbortSignal,
  ): Promise<ExecutorProcessResponse> {
    const waitTimeout = action === "wait" && Number.isSafeInteger(arguments_.timeout_ms)
      && Number(arguments_.timeout_ms) > 0
      ? Number(arguments_.timeout_ms)
      : undefined;
    const response = objectValue(await this.post(
      "/v1/executor/process",
      executionBody(context, { action, arguments: arguments_ }),
      signal,
      waitTimeout === undefined
        ? undefined
        : Math.max(this.requestTimeoutMs, waitTimeout + PROCESS_WAIT_TRANSPORT_GRACE_MILLISECONDS),
    ));
    if (action === "wait") {
      return { result: processWaitResult(response.result) as unknown as JsonValue };
    }
    return { result: sanitizeExecutionResult(response.result) };
  }

  async file(
    context: ExecutionCallContext,
    action: string,
    arguments_: JsonObject,
    signal?: AbortSignal,
  ): Promise<ExecutorFileResponse> {
    const response = objectValue(await this.post(
      "/v1/executor/file",
      executionBody(context, { action, arguments: arguments_ }),
      signal,
    ));
    if (typeof response.content !== "string") {
      throw new Error("Manager executor file response is missing content");
    }
    const result: ExecutorFileResponse = { content: response.content };
    if (response.details !== undefined) result.details = sanitizeExecutionResult(response.details);
    return result;
  }

  async cancelRun(
    identity: Omit<ExecutionIdentity, "tool_call_id">,
    preserveProcessIds: readonly string[] = [],
  ): Promise<boolean> {
    const response = objectValue(await this.post("/v1/executor/runs/cancel", {
      ...identity,
      ...(preserveProcessIds.length > 0 ? { preserve_process_ids: [...preserveProcessIds] } : {}),
    }));
    return response.confirmed === true;
  }

  async reconcileTasks(identity: TaskExecutionIdentity): Promise<ReconciledTaskSnapshot[]> {
    const response = objectValue(await this.post("/v1/executor/tasks/reconcile", identity));
    if (!Array.isArray(response.processes) || response.processes.length > 256) {
      throw new Error("Manager executor returned an invalid task reconciliation set");
    }
    return response.processes.map((value) => {
      const raw = objectValue(value);
      return { ...processSnapshot(raw), target: executionTarget(raw.target) };
    });
  }

  async acknowledgeTask(identity: TaskExecutionIdentity, processId: string): Promise<boolean> {
    const response = objectValue(await this.post("/v1/executor/tasks/acknowledge", {
      ...identity,
      process_id: processId,
    }));
    return response.confirmed === true;
  }

  async cleanupScope(identity: ScopeCleanupIdentity): Promise<ScopeCleanupResult> {
    const response = objectValue(await this.post("/v1/executor/scopes/cleanup", identity));
    requireExactKeys(response, ["confirmed", "completion_tasks"], "scope cleanup response");
    if (response.confirmed !== true || !Array.isArray(response.completion_tasks)) {
      throw new Error("Manager executor returned an invalid scope cleanup response");
    }
    if (response.completion_tasks.length > MAX_SCOPE_CLEANUP_COMPLETION_EVIDENCE) {
      throw new Error("Manager executor scope cleanup evidence exceeds its safety limit");
    }
    const seen = new Set<string>();
    const completionTasks = response.completion_tasks.map((value): CompletionTaskCleanupEvidence => {
      const item = objectValue(value);
      requireExactKeys(item, [
        "scope_id", "lifecycle_id", "execution_context", "completion_owner_id", "process_id", "target",
      ], "scope cleanup completion evidence");
      const execution = objectValue(item.execution_context);
      requireExactKeys(execution, ["sandbox_id", "workspace_id"], "scope cleanup execution context");
      if (
        typeof item.scope_id !== "string" || !item.scope_id
        || typeof item.lifecycle_id !== "string" || !item.lifecycle_id
        || typeof execution.sandbox_id !== "string" || !execution.sandbox_id
        || typeof execution.workspace_id !== "string" || !execution.workspace_id
        || typeof item.completion_owner_id !== "string" || !COMPLETION_OWNER_ID.test(item.completion_owner_id)
        || typeof item.process_id !== "string" || !MANAGED_PROCESS_ID.test(item.process_id)
        || seen.has(item.process_id)
      ) {
        throw new Error("Manager executor returned invalid scope cleanup completion evidence");
      }
      seen.add(item.process_id);
      return {
        scope_id: item.scope_id,
        lifecycle_id: item.lifecycle_id,
        execution_context: {
          sandbox_id: execution.sandbox_id,
          workspace_id: execution.workspace_id,
        },
        completion_owner_id: item.completion_owner_id,
        process_id: item.process_id,
        target: executionTarget(item.target),
      };
    });
    return { confirmed: true, completion_tasks: completionTasks };
  }

  async preview(
    identity: Required<ScopeExecutionIdentity>,
    sinceRevision?: string,
  ): Promise<ProcessPreviewResult> {
    const response = objectValue(await this.post("/v1/executor/scopes/processes", {
      ...identity,
      ...(sinceRevision === undefined ? {} : { since_revision: sinceRevision }),
    }));
    if (
      !Array.isArray(response.processes)
      || typeof response.revision !== "string"
      || !PROCESS_PREVIEW_REVISION.test(response.revision)
    ) {
      throw new Error("Manager executor returned an invalid process preview");
    }
    const processes = response.processes.map((value, index) => processPreview(value, index));
    if (response.unchanged === true) {
      if (processes.length !== 0) throw new Error("Manager unchanged preview must not include processes");
      return { processes: [], revision: response.revision, unchanged: true };
    }
    return { processes, revision: response.revision };
  }

  async previewSummary(identity: Required<ScopeExecutionIdentity>): Promise<ProcessPreviewSummary> {
    const response = objectValue(await this.post("/v1/executor/scopes/process-summary", identity));
    return { running_terminal_count: boundedCount(response.running_terminal_count, "running_terminal_count") };
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    requestTimeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    return await new Promise<unknown>((resolvePromise, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      };
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "content-length": encoded.length,
        },
        signal,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_MANAGER_RESPONSE_BYTES) {
            response.destroy(new Error("Manager executor response exceeded 2 MiB"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", fail);
        response.once("end", () => {
          if (settled) return;
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            let detail = raw.trim();
            try {
              const parsed = objectValue(JSON.parse(raw));
              if (typeof parsed.error === "string") detail = parsed.error;
            } catch {
              // Preserve the bounded plain response for diagnostics.
            }
            fail(new Error(`Manager executor POST ${path} failed (${status}): ${detail || "empty response"}`));
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            settled = true;
            resolvePromise(parsed);
          } catch {
            fail(new Error(`Manager executor POST ${path} returned invalid JSON`));
          }
        });
      });
      request.setTimeout(requestTimeoutMs, () => {
        request.destroy(new Error(`Manager executor POST ${path} timed out`));
      });
      request.once("error", fail);
      request.end(encoded);
    });
  }
}

/** Constructing production mode without the Manager identity fails closed. */
export function createExecutionManager(config: RuntimeConfig): ExecutionManager {
  return new ManagerExecutorClient(
    config.managerSocketPath,
    config.managerToken,
    config.managerRequestTimeoutMs,
  );
}

export function executionContext(request: { execution_context?: ExecutionContext }): ExecutionContext {
  const context = request.execution_context;
  if (!context) throw new Error("Run is missing its trusted execution_context");
  return context;
}

function executionBody(context: ExecutionCallContext, extra: JsonObject): JsonObject {
  return {
    audit_id: context.receipt.audit_id,
    executor_id: context.receipt.executor_id,
    target: context.receipt.target,
    run_id: context.run_id,
    scope_id: context.scope_id,
    lifecycle_id: context.lifecycle_id,
    tool_call_id: context.tool_call_id,
    execution_context: context.execution_context,
    ...extra,
  };
}

function executionTarget(value: unknown): ExecutionTarget {
  if (value !== EXECUTION_TARGETS[0] && value !== EXECUTION_TARGETS[1]) {
    throw new Error("Manager executor returned an invalid execution target");
  }
  return value;
}

function processSnapshot(value: unknown): ProcessSnapshot {
  const snapshot = objectValue(value);
  for (const field of ["id", "run_id", "scope_key", "lifecycle_id", "command", "cwd", "status", "stdout", "stderr", "started_at"] as const) {
    if (typeof snapshot[field] !== "string") {
      throw new Error(`Manager executor process result is missing ${field}`);
    }
  }
  if (typeof snapshot.background !== "boolean") {
    throw new Error("Manager executor process result is missing background");
  }
  if (!["running", "completed", "failed", "cancelled", "orphaned"].includes(String(snapshot.status))) {
    throw new Error("Manager executor process result has an invalid status");
  }
  if (
    snapshot.status === "orphaned"
    && (snapshot.background !== true || snapshot.stop_confirmed !== false)
  ) {
    throw new Error("Manager orphaned process result must remain active and unconfirmed");
  }
  const result: ProcessSnapshot = {
    id: String(snapshot.id),
    run_id: String(snapshot.run_id),
    scope_key: String(snapshot.scope_key),
    lifecycle_id: String(snapshot.lifecycle_id),
    command: redactCommandForApproval(String(snapshot.command)),
    cwd: String(snapshot.cwd),
    status: snapshot.status as ProcessSnapshot["status"],
    stdout: String(snapshot.stdout),
    stderr: String(snapshot.stderr),
    started_at: String(snapshot.started_at),
    background: snapshot.background,
  };
  if (Number.isSafeInteger(snapshot.pid) && Number(snapshot.pid) > 0) result.pid = Number(snapshot.pid);
  if (snapshot.exit_code === null || Number.isSafeInteger(snapshot.exit_code)) {
    result.exit_code = snapshot.exit_code as number | null;
  }
  if (typeof snapshot.finished_at === "string") result.finished_at = snapshot.finished_at;
  if (typeof snapshot.stop_confirmed === "boolean") result.stop_confirmed = snapshot.stop_confirmed;
  return result;
}

function processWaitResult(value: unknown): ProcessWaitResult {
  const raw = objectValue(value);
  if (typeof raw.wait_timed_out !== "boolean") {
    throw new Error("Manager executor process wait result is missing wait_timed_out");
  }
  return {
    ...processSnapshot(raw),
    wait_timed_out: raw.wait_timed_out,
  };
}

function processPreview(value: unknown, index: number): import("./process-registry.js").ProcessPreview {
  const preview = objectValue(value);
  for (const field of ["id", "command", "cwd", "output", "status", "started_at", "updated_at"] as const) {
    if (typeof preview[field] !== "string") {
      throw new Error(`Manager executor process preview is missing ${field}`);
    }
  }
  if (typeof preview.running !== "boolean" || typeof preview.truncated !== "boolean") {
    throw new Error("Manager executor returned an invalid process preview state");
  }
  if (!["running", "completed", "failed", "cancelled", "orphaned"].includes(String(preview.status))) {
    throw new Error("Manager executor process preview has an invalid status");
  }
  if (preview.status === "orphaned" && preview.running !== true) {
    throw new Error("Manager orphaned process preview must remain active");
  }
  const result: import("./process-registry.js").ProcessPreview = {
    id: String(preview.id),
    title: `Terminal ${index + 1}`,
    command: redactCommandForApproval(String(preview.command)),
    cwd: String(preview.cwd).slice(0, 2_048),
    output: redactCommandForApproval(String(preview.output)),
    status: preview.status as import("./process-registry.js").ProcessPreview["status"],
    running: preview.running,
    started_at: String(preview.started_at),
    updated_at: String(preview.updated_at),
    truncated: preview.truncated,
  };
  if (preview.exit_code === null || typeof preview.exit_code === "number") result.exit_code = preview.exit_code;
  if (typeof preview.finished_at === "string") result.finished_at = preview.finished_at;
  return result;
}

function boundedCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Manager executor returned an invalid ${label}`);
  }
  return Number(value);
}

function sanitizeExecutionResult(value: unknown, fieldName = ""): JsonValue {
  if (fieldName === "command") {
    return typeof value === "string" ? redactCommandForApproval(value) : "[redacted]";
  }
  if (/token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|authorization/i.test(fieldName)) {
    return "[redacted]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeExecutionResult(item));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeExecutionResult(item, key)]),
  );
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manager executor returned an invalid object response");
  }
  return value as JsonObject;
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`Manager executor returned an invalid ${label}`);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
