import type { ExecutorTransport, GatewayResult, GatewayTransport, ProcessRead, ProcessStartOptions, ProcessView, Sandbox, ToolContext } from "../src/transport.js";

/** Stubs for executors that only exercise foreground commands and files. */
export const noProcesses = {
  async processStart(): Promise<ProcessView> { throw new Error("unused"); },
  async processRead(): Promise<ProcessRead> { throw new Error("unused"); },
  async processDetach(): Promise<void> { throw new Error("unused"); },
  async processKill(): Promise<ProcessView> { throw new Error("unused"); },
} satisfies Pick<ExecutorTransport, "processStart" | "processRead" | "processDetach" | "processKill">;

export const personal: Sandbox = { scope_key: "private:1", workspace_id: "user-1", sandbox_id: "sandbox-1", lifecycle_id: "life-1", profile: "agent", cwd: "/workspace" };

/** A fake Manager process table whose processes are driven by the test. */
export class FakeProcesses {
  views = new Map<string, ProcessView>();
  logs = new Map<string, string>();
  starts: { context: ToolContext; options: ProcessStartOptions }[] = [];
  reads: { id: string; offset: number; waitMs: number | undefined }[] = [];
  detached: string[] = [];
  kills: string[] = [];
  terminals: string[] = [];
  /** Probe results in order; defaults to "port closed". */
  probes: number[] = [];
  private wakeups = new Set<() => void>();
  private sequence = 0;

  executor(): ExecutorTransport {
    return {
      terminal: async (_sandbox, _context, command) => { this.terminals.push(command); return { stdout: "", stderr: "", exit_code: this.probes.shift() ?? 1, status: "completed" }; },
      file: async () => { throw new Error("unused"); },
      cancelRun: async () => true,
      processStart: async (_sandbox, context, options) => {
        const id = `proc_${(++this.sequence).toString().padStart(4, "0")}`;
        const view: ProcessView = { id, owner: "private:1", scope_id: "private:1", sandbox_id: "sandbox-1", name: options.name ?? null, command: options.command, cwd: options.cwd, state: "running",
          exit_code: null, reason: "", attached: true, stdin_open: options.stdin, started_at: new Date(0).toISOString(), ended_at: null, log_bytes: 0, seq: this.sequence };
        this.views.set(id, view); this.logs.set(id, ""); this.starts.push({ context, options });
        return { ...view };
      },
      processRead: async (_sandbox, id, options, signal) => {
        this.reads.push({ id, offset: options.offset, waitMs: options.waitMs });
        const view = this.views.get(id)!;
        const available = () => Buffer.byteLength(this.logs.get(id)!) > options.offset || view.state !== "running";
        if (!available()) {
          await new Promise<void>((resolve, reject) => {
            const wake = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.wakeups.delete(wake); resolve(); };
            const abort = () => { clearTimeout(timer); this.wakeups.delete(wake); reject(signal!.reason ?? new Error("aborted")); };
            const timer = setTimeout(wake, options.waitMs ?? 0);
            this.wakeups.add(wake);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        const bytes = Buffer.from(this.logs.get(id)!).subarray(options.offset, options.offset + (options.maxBytes ?? 65536));
        const next = options.offset + bytes.length;
        return { data: bytes.toString(), offset_start: options.offset, next_offset: next, retained_from: 0, eof: view.state !== "running" && next === Buffer.byteLength(this.logs.get(id)!), process: { ...view } };
      },
      processDetach: async (_sandbox, id) => { this.detached.push(id); this.views.get(id)!.attached = false; },
      processKill: async (_sandbox, _context, id) => {
        this.kills.push(id);
        this.end(id, "killed", null, "user");
        return { ...this.views.get(id)! };
      },
    };
  }
  write(id: string, data: string): void {
    this.logs.set(id, this.logs.get(id)! + data);
    this.views.get(id)!.log_bytes = Buffer.byteLength(this.logs.get(id)!);
    this.wake();
  }
  end(id: string, state: ProcessView["state"], exitCode: number | null, reason = ""): void {
    const view = this.views.get(id)!;
    if (view.state !== "running") return;
    Object.assign(view, { state, exit_code: exitCode, reason, ended_at: new Date(0).toISOString(), stdin_open: false });
    this.wake();
  }
  private wake(): void { for (const wake of [...this.wakeups]) wake(); }
}

export function fakeGateway(handler: (tool: string, action: string, args: Record<string, unknown>, context: ToolContext, timeoutMs: number | undefined) => GatewayResult | Promise<GatewayResult>): GatewayTransport & { calls: { tool: string; action: string; args: Record<string, unknown>; context: ToolContext; timeoutMs: number | undefined }[] } {
  const calls: { tool: string; action: string; args: Record<string, unknown>; context: ToolContext; timeoutMs: number | undefined }[] = [];
  return { calls, async call(tool, action, args, context, _signal, timeoutMs) { calls.push({ tool, action, args, context, timeoutMs }); return handler(tool, action, args, context, timeoutMs); } };
}
