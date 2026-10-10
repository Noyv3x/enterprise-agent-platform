import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
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
/** Live sanitized terminal output as Manager commits it; never authoritative (the result is). */
export type OutputListener = (stream: "stdout" | "stderr", data: string) => void;
/** Manager's view of a supervised background process (`process/*` routes). */
export interface ProcessView {
  id: string; owner: string; scope_id: string; sandbox_id: string; name: string | null; command: string; cwd: string;
  state: "running" | "exited" | "killed" | "failed" | "interrupted"; exit_code: number | null; reason: string;
  attached: boolean; stdin_open: boolean; started_at: string; ended_at: string | null; log_bytes: number; seq: number; unconfirmed?: true;
}
export interface ProcessStartOptions { command: string; cwd: string; timeoutMs: number; name?: string; stdin: boolean }
export interface ProcessReadOptions { offset: number; maxBytes?: number; waitMs?: number }
export interface ProcessRead { data: string; offset_start: number; next_offset: number; retained_from: number; eof: boolean; process: ProcessView }
// One NDJSON line carries at most the result frame (two bounded streams plus
// JSON escaping), so a line beyond this is a protocol violation, not data.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export interface ExecutorTransport {
  terminal(sandbox: Sandbox, context: ToolContext, command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, auditDetails?: Record<string, unknown>, onOutput?: OutputListener): Promise<ProcessResult>;
  file(sandbox: Sandbox, context: ToolContext, action: "read" | "write", args: Record<string, unknown>, signal?: AbortSignal): Promise<FileResult>;
  cancelRun(sandbox: Sandbox, runId: string): Promise<boolean>;
  /** Starts an attached process owned by the calling run until `processDetach`. */
  processStart(sandbox: Sandbox, context: ToolContext, options: ProcessStartOptions, signal?: AbortSignal): Promise<ProcessView>;
  processRead(sandbox: Sandbox, processId: string, options: ProcessReadOptions, signal?: AbortSignal): Promise<ProcessRead>;
  processDetach(sandbox: Sandbox, processId: string, signal?: AbortSignal): Promise<void>;
  processKill(sandbox: Sandbox, context: ToolContext, processId: string, signal?: AbortSignal): Promise<ProcessView>;
}
export interface GatewayTransport {
  call(tool: "web" | "browser" | "schedule" | "tasks", action: string, args: Record<string, unknown>, context: ToolContext, signal?: AbortSignal, timeoutMs?: number): Promise<GatewayResult>;
}

export function createExecutorTransport(options: { socketPath: string; token: string; timeoutMs?: number }): ExecutorTransport {
  function post<T>(path: string, body: unknown, signal?: AbortSignal, onOutput?: OutputListener): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
      const req = request({ socketPath: options.socketPath, path: `/v1/executor/${path}`, method: "POST", signal,
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json", ...(onOutput ? { accept: "application/x-ndjson" } : {}) } }, res => {
        const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        if (onOutput && ok && String(res.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-ndjson")) {
          // Frames are processed as they arrive; only the partial last line is buffered.
          const decoder = new StringDecoder("utf8");
          let pending = "";
          let final: { result: unknown } | undefined;
          const frame = (line: string) => {
            if (!line) return;
            const value = JSON.parse(line) as { type?: string; stream?: string; data?: unknown; result?: unknown; error?: unknown; status?: unknown };
            if (value.type === "output") {
              if ((value.stream === "stdout" || value.stream === "stderr") && typeof value.data === "string") {
                try { onOutput(value.stream, value.data); } catch { /* live display must not affect the execution */ }
              }
            } else if (value.type === "result") final = { result: value.result };
            else if (value.type === "error") throw new Error(typeof value.error === "string" ? value.error : `Executor HTTP ${value.status ?? 500}`);
          };
          const feed = (text: string) => {
            pending += text;
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); frame(line); }
            if (pending.length > MAX_FRAME_BYTES) throw new Error("Executor stream frame too large");
          };
          res.on("data", (chunk: Buffer) => { try { feed(decoder.write(chunk)); } catch (error) { reject(error); req.destroy(); } });
          res.on("error", reject);
          res.on("end", () => {
            try {
              feed(decoder.end());
              if (pending) { frame(pending); pending = ""; }
              if (!final) throw new Error("Executor stream ended without a result");
              resolve(final as T);
            } catch (error) { reject(error); }
          });
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!ok) throw new Error(result.error ?? `Executor HTTP ${res.statusCode}`);
            resolve(result as T);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(options.timeoutMs ?? 3_630_000, () => req.destroy(new Error("Executor request timed out")));
      req.on("error", reject);
      req.end(JSON.stringify(body));
    return promise;
  }
  const processOwner = (sandbox: Sandbox) => sandbox.scope_key.replace(/\/delegate\/.*$/, "");
  const identity = (sandbox: Sandbox, runId: string) => ({ run_id: runId, scope_id: sandbox.scope_key,
    lifecycle_id: sandbox.lifecycle_id, execution_context: { sandbox_id: sandbox.sandbox_id, workspace_id: sandbox.workspace_id, profile: sandbox.profile } });
  async function execute<T>(sandbox: Sandbox, context: ToolContext, endpoint: string, operation: string, action: string,
    args: Record<string, unknown>, details: Record<string, unknown>, signal?: AbortSignal, onOutput?: OutputListener): Promise<T> {
    const call = { ...identity(sandbox, context.run_id), tool_call_id: context.tool_call_id ?? randomUUID(), target: "sandbox", action, arguments: args };
    const receipt = await post<{ audit_id: string; executor_id: string }>("audit", { ...call, audit_id: randomUUID(), operation, details }, signal);
    return post<T>(endpoint, { ...call, audit_id: receipt.audit_id, executor_id: receipt.executor_id }, signal, onOutput);
  }
  return {
    async terminal(sandbox, context, command, cwd, timeoutMs, signal, auditDetails, onOutput) {
      // Every foreground command must terminate even if Runtime disappears.
      const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 3_600_000) : 600_000;
      const response = await execute<{ result: ProcessResult }>(sandbox, context, "terminal", "terminal", "run",
        { command, cwd, timeout_ms: deadline, background: false }, auditDetails ?? { command }, signal, onOutput);
      return response.result;
    },
    file: (sandbox, context, action, args, signal) => execute<FileResult>(sandbox, context, "file", action === "read" ? "read_file" : "write_file", action, args, {}, signal),
    async cancelRun(sandbox, runId) { return (await post<{ confirmed: boolean }>("runs/cancel", identity(sandbox, runId))).confirmed; },
    async processStart(sandbox, context, options, signal) {
      const args = { command: options.command, cwd: options.cwd, timeout_ms: options.timeoutMs, ...(options.name === undefined ? {} : { name: options.name }), stdin: options.stdin, attached: true };
      return (await execute<{ process: ProcessView }>(sandbox, context, "process/start", "process", "start", args, { command: options.command, cwd: options.cwd }, signal)).process;
    },
    processRead(sandbox, processId, options, signal) {
      return post<ProcessRead>("process/read", { process_id: processId, owner: processOwner(sandbox), offset: options.offset,
        ...(options.maxBytes === undefined ? {} : { max_bytes: options.maxBytes }), ...(options.waitMs === undefined ? {} : { wait_ms: options.waitMs }) }, signal);
    },
    async processDetach(sandbox, processId, signal) { await post("process/detach", { process_id: processId, owner: processOwner(sandbox) }, signal); },
    async processKill(sandbox, context, processId, signal) {
      return (await execute<{ process: ProcessView }>(sandbox, context, "process/kill", "process", "kill", { process_id: processId }, { process_id: processId }, signal)).process;
    },
  };
}

export function createGatewayTransport(options: { baseUrl: string; token: string }): GatewayTransport {
  return { async call(tool, action, args, context, signal, timeoutMs = 120_000) {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/internal/agent/tools/${tool}`, {
      method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, arguments: args, context }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error(`Platform tool HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as GatewayResult;
  } };
}
