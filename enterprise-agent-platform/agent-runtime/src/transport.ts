import { randomUUID } from "node:crypto";
import { request } from "node:http";

export interface Sandbox {
  scope_key: string;
  workspace_id: string;
  sandbox_id: string;
  lifecycle_id: string;
  profile: "agent" | "chat";
  cwd: string;
}
export interface ToolContext {
  sid: string;
  scope_key: string;
  run_id: string;
  owner_user_id?: number;
  channel_id?: number;
  tool_call_id?: string;
}
export interface ProcessResult { stdout: string; stderr: string; exit_code?: number; status: string }
export interface FileResult { content: string; details: { returned?: number; total?: number } }
export interface GatewayResult { content: string; data: unknown; is_error: boolean }
export interface ExecutorTransport {
  terminal(sandbox: Sandbox, context: ToolContext, command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, auditDetails?: Record<string, unknown>): Promise<ProcessResult>;
  file(sandbox: Sandbox, context: ToolContext, action: "read" | "write", args: Record<string, unknown>, signal?: AbortSignal): Promise<FileResult>;
  cancelRun(sandbox: Sandbox, runId: string): Promise<boolean>;
}
export interface GatewayTransport {
  call(tool: "web" | "browser" | "schedule", action: string, args: Record<string, unknown>, context: ToolContext, signal?: AbortSignal): Promise<GatewayResult>;
}

export function createExecutorTransport(options: { socketPath: string; token: string; timeoutMs?: number }): ExecutorTransport {
  function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
      const req = request({ socketPath: options.socketPath, path: `/v1/executor/${path}`, method: "POST", signal,
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) throw new Error(result.error ?? `Executor HTTP ${res.statusCode}`);
            resolve(result as T);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(options.timeoutMs ?? 3_630_000, () => req.destroy(new Error("Executor request timed out")));
      req.on("error", reject);
      req.end(JSON.stringify(body));
    return promise;
  }
  const identity = (sandbox: Sandbox, runId: string) => ({ run_id: runId, scope_id: sandbox.scope_key,
    lifecycle_id: sandbox.lifecycle_id, execution_context: { sandbox_id: sandbox.sandbox_id, workspace_id: sandbox.workspace_id, profile: sandbox.profile } });
  async function execute<T>(sandbox: Sandbox, context: ToolContext, endpoint: string, operation: string, action: string,
    args: Record<string, unknown>, details: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const call = { ...identity(sandbox, context.run_id), tool_call_id: context.tool_call_id ?? randomUUID(), target: "sandbox", action, arguments: args };
    const receipt = await post<{ audit_id: string; executor_id: string }>("audit", { ...call, audit_id: randomUUID(), operation, details }, signal);
    return post<T>(endpoint, { ...call, audit_id: receipt.audit_id, executor_id: receipt.executor_id }, signal);
  }
  return {
    async terminal(sandbox, context, command, cwd, timeoutMs, signal, auditDetails) {
      // Every foreground command must terminate even if Runtime disappears.
      const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 3_600_000) : 600_000;
      const response = await execute<{ result: ProcessResult }>(sandbox, context, "terminal", "terminal", "run",
        { command, cwd, timeout_ms: deadline, background: false }, auditDetails ?? { command }, signal);
      return response.result;
    },
    file: (sandbox, context, action, args, signal) => execute<FileResult>(sandbox, context, "file", action === "read" ? "read_file" : "write_file", action, args, {}, signal),
    async cancelRun(sandbox, runId) { return (await post<{ confirmed: boolean }>("runs/cancel", identity(sandbox, runId))).confirmed; },
  };
}

export function createGatewayTransport(options: { baseUrl: string; token: string }): GatewayTransport {
  return { async call(tool, action, args, context, signal) {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/internal/agent/tools/${tool}`, {
      method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, arguments: args, context }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error(`Platform tool HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as GatewayResult;
  } };
}
