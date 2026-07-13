import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { id, abortError, errorMessage, scopeOwns, throwIfAborted, truncate } from "./utils.js";

export interface ProcessSnapshot {
  id: string;
  run_id: string;
  scope_key: string;
  lifecycle_id: string;
  command: string;
  cwd: string;
  pid?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at?: string;
}

interface ManagedProcess extends ProcessSnapshot {
  child: ChildProcessWithoutNullStreams;
  outputBytes: number;
  streamedBytes: number;
  outputLimitExceeded: boolean;
  exitConfirmed: boolean;
}

export interface RunCommandOptions {
  runId: string;
  scopeKey: string;
  lifecycleId?: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  background?: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: { stdout?: string; stderr?: string }) => void;
}

export class ProcessRegistry {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly completedLru = new Map<string, true>();
  private readonly maxCapturedBytes: number;
  private readonly maxStreamedBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxRunningPerScope: number;
  private readonly maxCompletedRecords: number;
  private readonly completedRecordTtlMs: number;

  constructor(
    maxCapturedBytes = 512_000,
    maxStreamedBytes = 128_000,
    maxOutputBytes = 10_000_000,
    maxRunningPerScope = 16,
    maxCompletedRecords = 64,
    completedRecordTtlMs = 60 * 60_000,
  ) {
    if (!Number.isSafeInteger(maxCompletedRecords) || maxCompletedRecords < 0) {
      throw new Error("maxCompletedRecords must be a non-negative integer");
    }
    if (!Number.isSafeInteger(completedRecordTtlMs) || completedRecordTtlMs <= 0) {
      throw new Error("completedRecordTtlMs must be a positive integer");
    }
    this.maxCapturedBytes = maxCapturedBytes;
    this.maxStreamedBytes = maxStreamedBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.maxRunningPerScope = maxRunningPerScope;
    this.maxCompletedRecords = maxCompletedRecords;
    this.completedRecordTtlMs = completedRecordTtlMs;
  }

  async run(options: RunCommandOptions): Promise<ProcessSnapshot> {
    throwIfAborted(options.signal);
    this.pruneCompleted();
    await mkdir(options.cwd, { recursive: true });
    const runningForScope = [...this.processes.values()].filter(
      (process) => process.scope_key === options.scopeKey && process.status === "running",
    ).length;
    if (runningForScope >= this.maxRunningPerScope) {
      throw new Error(`Agent scope already owns ${this.maxRunningPerScope} running processes`);
    }
    const processId = id("process");
    const child = spawn("/bin/bash", ["-lc", options.command], {
      cwd: options.cwd,
      env: {
        ...scrubEnvironment(process.env),
        ...scrubExplicitEnvironment(options.env ?? {}),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed: ManagedProcess = {
      id: processId,
      run_id: options.runId,
      scope_key: options.scopeKey,
      lifecycle_id: options.lifecycleId ?? "",
      command: options.command,
      cwd: options.cwd,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      status: "running",
      stdout: "",
      stderr: "",
      started_at: new Date().toISOString(),
      child,
      outputBytes: 0,
      streamedBytes: 0,
      outputLimitExceeded: false,
      exitConfirmed: false,
    };
    this.processes.set(processId, managed);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.captureOutput(managed, "stdout", chunk, options.onUpdate);
    });
    child.stderr.on("data", (chunk: string) => {
      this.captureOutput(managed, "stderr", chunk, options.onUpdate);
    });
    const completion = new Promise<ProcessSnapshot>((resolve, reject) => {
      child.once("error", (error) => {
        managed.status = "failed";
        managed.stderr = truncate(`${managed.stderr}\n${errorMessage(error)}`.trim(), this.maxCapturedBytes);
        managed.finished_at = new Date().toISOString();
        reject(error);
      });
      child.once("close", (code, signal) => {
        managed.exit_code = code;
        managed.finished_at = new Date().toISOString();
        if (managed.status === "cancelled" || signal) managed.status = "cancelled";
        else managed.status = code === 0 ? "completed" : "failed";
        managed.exitConfirmed = true;
        this.rememberCompleted(managed);
        resolve(this.snapshot(managed));
      });
    });
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = (): void => this.killManaged(managed);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => this.killManaged(managed), options.timeoutMs);
      timeout.unref();
    }
    completion.finally(() => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
    if (options.background) {
      completion.catch(() => undefined);
      return this.snapshot(managed);
    }
    const result = await completion;
    if (options.signal?.aborted) throw abortError();
    return result;
  }

  list(scopeKey: string, lifecycleId?: string): ProcessSnapshot[] {
    this.pruneCompleted();
    return [...this.processes.values()]
      .filter((process) => process.scope_key === scopeKey && (!lifecycleId || process.lifecycle_id === lifecycleId))
      .map((process) => this.snapshot(process));
  }

  get(scopeKey: string, processId: string, lifecycleId?: string): ProcessSnapshot {
    const process = this.owned(scopeKey, processId, lifecycleId);
    return this.snapshot(process);
  }

  write(scopeKey: string, processId: string, input: string, lifecycleId?: string): void {
    const process = this.owned(scopeKey, processId, lifecycleId);
    if (process.status !== "running") throw new Error("Process is not running");
    process.child.stdin.write(input);
  }

  kill(scopeKey: string, processId: string, lifecycleId?: string): ProcessSnapshot {
    const process = this.owned(scopeKey, processId, lifecycleId);
    this.killManaged(process);
    return this.snapshot(process);
  }

  killRun(runId: string): void {
    for (const process of this.processes.values()) if (process.run_id === runId && process.status === "running") this.killManaged(process);
  }

  killScope(scopeKey: string, lifecycleId?: string): void {
    for (const process of this.processes.values()) {
      if (
        scopeOwns(scopeKey, process.scope_key)
        && (!lifecycleId || process.lifecycle_id === lifecycleId)
        && process.status === "running"
      ) this.killManaged(process);
    }
  }

  async waitForScopeExit(scopeKey: string, lifecycleId?: string, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const running = [...this.processes.values()].some(
        (process) => scopeOwns(scopeKey, process.scope_key)
          && (!lifecycleId || process.lifecycle_id === lifecycleId)
          && !process.exitConfirmed,
      );
      if (!running) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return ![...this.processes.values()].some(
      (process) => scopeOwns(scopeKey, process.scope_key)
        && (!lifecycleId || process.lifecycle_id === lifecycleId)
        && !process.exitConfirmed,
    );
  }

  shutdown(): void {
    for (const process of this.processes.values()) if (process.status === "running") this.killManaged(process);
  }

  private owned(scopeKey: string, processId: string, lifecycleId?: string): ManagedProcess {
    this.pruneCompleted();
    const process = this.processes.get(processId);
    if (!process || process.scope_key !== scopeKey || (lifecycleId && process.lifecycle_id !== lifecycleId)) {
      throw new Error("Process not found");
    }
    if (process.exitConfirmed) this.touchCompleted(process.id);
    return process;
  }

  private rememberCompleted(process: ManagedProcess): void {
    this.completedLru.delete(process.id);
    this.completedLru.set(process.id, true);
    this.pruneCompleted();
  }

  private touchCompleted(processId: string): void {
    if (!this.completedLru.delete(processId)) return;
    this.completedLru.set(processId, true);
  }

  private pruneCompleted(now = Date.now()): void {
    for (const processId of this.completedLru.keys()) {
      const process = this.processes.get(processId);
      const finishedAt = process?.finished_at ? Date.parse(process.finished_at) : Number.NaN;
      if (!process || (Number.isFinite(finishedAt) && now - finishedAt >= this.completedRecordTtlMs)) {
        this.completedLru.delete(processId);
        this.processes.delete(processId);
      }
    }
    while (this.completedLru.size > this.maxCompletedRecords) {
      const oldest = this.completedLru.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completedLru.delete(oldest);
      this.processes.delete(oldest);
    }
  }

  private captureOutput(
    process: ManagedProcess,
    channel: "stdout" | "stderr",
    chunk: string,
    onUpdate: RunCommandOptions["onUpdate"],
  ): void {
    const bytes = Buffer.byteLength(chunk);
    process.outputBytes += bytes;
    process[channel] = truncate(process[channel] + chunk, this.maxCapturedBytes);
    if (process.streamedBytes < this.maxStreamedBytes) {
      const remaining = this.maxStreamedBytes - process.streamedBytes;
      const selected = Buffer.from(chunk).subarray(0, remaining).toString("utf8");
      process.streamedBytes += Buffer.byteLength(selected);
      if (selected) onUpdate?.({ [channel]: selected });
    }
    if (process.outputBytes > this.maxOutputBytes && !process.outputLimitExceeded) {
      process.outputLimitExceeded = true;
      process.stderr = truncate(
        `${process.stderr}\nProcess stopped after exceeding the ${this.maxOutputBytes}-byte output limit.`.trim(),
        this.maxCapturedBytes,
      );
      this.killManaged(process);
    }
  }

  private killManaged(process: ManagedProcess): void {
    if (process.status !== "running") return;
    process.status = "cancelled";
    const pid = process.child.pid;
    try {
      if (pid && globalThis.process.platform !== "win32") globalThis.process.kill(-pid, "SIGTERM");
      else process.child.kill("SIGTERM");
    } catch {
      process.child.kill("SIGTERM");
    }
    const forceTimer = setTimeout(() => {
      if (process.child.exitCode !== null || process.child.signalCode !== null) return;
      try {
        if (pid && globalThis.process.platform !== "win32") globalThis.process.kill(-pid, "SIGKILL");
        else process.child.kill("SIGKILL");
      } catch {
        process.child.kill("SIGKILL");
      }
    }, 3_000);
    forceTimer.unref();
  }

  private snapshot(process: ManagedProcess): ProcessSnapshot {
    const {
      child: _child,
      outputBytes: _outputBytes,
      streamedBytes: _streamedBytes,
      outputLimitExceeded: _outputLimitExceeded,
      exitConfirmed: _exitConfirmed,
      ...snapshot
    } = process;
    return { ...snapshot };
  }
}

export function scrubEnvironment(source: NodeJS.ProcessEnv | Record<string, string | undefined>): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TMP", "TEMP"]);
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || (!allowed.has(name) && !name.startsWith("LC_"))) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

function scrubExplicitEnvironment(source: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  const sensitiveName = /(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION|DATABASE_URL)/i;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || sensitiveName.test(name)) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}
