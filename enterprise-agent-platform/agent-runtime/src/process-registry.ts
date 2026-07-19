import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { id, abortError, errorMessage, scopeOwns, throwIfAborted, truncate } from "./utils.js";

export type ProcessUpdateBehavior = "wait" | "terminate";

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
  background: boolean;
  update_behavior?: ProcessUpdateBehavior;
}

export interface ProcessPreview {
  id: string;
  title: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  output: string;
  status: ProcessSnapshot["status"];
  running: boolean;
  exit_code?: number | null;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  truncated: boolean;
}

export interface ProcessPreviewSummary {
  running_terminal_count: number;
}

export interface UpdateBlockerSummary {
  running_background_terminal_count: number;
  update_blocking_terminal_count: number;
  terminable_background_terminal_count: number;
}

interface ManagedProcess extends ProcessSnapshot {
  child: ChildProcessWithoutNullStreams;
  outputBytes: number;
  streamedBytes: number;
  outputLimitExceeded: boolean;
  exitConfirmed: boolean;
  previewStdout: string;
  previewStderr: string;
  previewStdoutTruncated: boolean;
  previewStderrTruncated: boolean;
  previewUpdatedAt: string;
}

const PREVIEW_PROCESS_LIMIT = 16;
const PREVIEW_CAPTURE_BYTES = 64 * 1024;
// stdout + stderr + the combined output field remain below roughly 1 MiB for
// the maximum 16-process response, even when JSON escaping doubles newlines.
const PREVIEW_STREAM_BYTES = 8 * 1024;
const PREVIEW_COMBINED_BYTES = 16 * 1024;
const PREVIEW_COMMAND_BYTES = 4 * 1024;
const PREVIEW_CWD_BYTES = 2 * 1024;

export interface RunCommandOptions {
  runId: string;
  scopeKey: string;
  lifecycleId?: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  background?: boolean;
  updateBehavior?: ProcessUpdateBehavior;
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
    const background = options.background ?? false;
    if (!background && options.updateBehavior !== undefined) {
      throw new Error("updateBehavior is supported only for background processes");
    }
    const updateBehavior = options.updateBehavior ?? "wait";
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
      background,
      ...(background ? { update_behavior: updateBehavior } : {}),
      child,
      outputBytes: 0,
      streamedBytes: 0,
      outputLimitExceeded: false,
      exitConfirmed: false,
      previewStdout: "",
      previewStderr: "",
      previewStdoutTruncated: false,
      previewStderrTruncated: false,
      previewUpdatedAt: new Date().toISOString(),
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
        managed.previewUpdatedAt = managed.finished_at;
        reject(error);
      });
      child.once("close", (code, signal) => {
        managed.exit_code = code;
        managed.finished_at = new Date().toISOString();
        if (managed.status === "cancelled" || signal) managed.status = "cancelled";
        else managed.status = code === 0 ? "completed" : "failed";
        managed.exitConfirmed = true;
        managed.previewUpdatedAt = managed.finished_at;
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
    if (background) {
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

  /**
   * Return a bounded, presentation-safe view of a root Agent scope and its
   * delegates. This intentionally has no companion write/kill operation.
   */
  preview(scopeKey: string, lifecycleId: string): ProcessPreview[] {
    this.pruneCompleted();
    return [...this.processes.values()]
      .filter((process) => scopeOwns(scopeKey, process.scope_key) && process.lifecycle_id === lifecycleId)
      .sort((left, right) => {
        const running = Number(right.status === "running") - Number(left.status === "running");
        if (running !== 0) return running;
        const recency = Date.parse(right.started_at) - Date.parse(left.started_at);
        return recency || right.id.localeCompare(left.id);
      })
      .slice(0, PREVIEW_PROCESS_LIMIT)
      .map((process, index) => this.previewSnapshot(process, index));
  }

  /**
   * Return only the live-process count needed by the platform's collapsed
   * preview controls.  Keeping this separate from preview() ensures a status
   * poll never serializes terminal commands or captured output.
   */
  previewSummary(scopeKey: string, lifecycleId: string): ProcessPreviewSummary {
    this.pruneCompleted();
    const runningTerminalCount = [...this.processes.values()].filter(
      (process) => scopeOwns(scopeKey, process.scope_key)
        && process.lifecycle_id === lifecycleId
        && process.status === "running",
    ).length;
    return { running_terminal_count: runningTerminalCount };
  }

  /**
   * Return aggregate process counts used to decide whether an update may
   * safely restart the runtime. No process identity, command, or output is
   * included in this global summary.
   */
  updateBlockerSummary(): UpdateBlockerSummary {
    this.pruneCompleted();
    const runningBackground = [...this.processes.values()].filter(
      (process) => process.background && process.status === "running",
    );
    const updateBlocking = runningBackground.filter(
      (process) => process.update_behavior !== "terminate",
    );
    return {
      running_background_terminal_count: runningBackground.length,
      update_blocking_terminal_count: updateBlocking.length,
      terminable_background_terminal_count: runningBackground.length - updateBlocking.length,
    };
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
    const previewKey = channel === "stdout" ? "previewStdout" : "previewStderr";
    const truncatedKey = channel === "stdout" ? "previewStdoutTruncated" : "previewStderrTruncated";
    const preview = utf8Tail(process[previewKey] + chunk, PREVIEW_CAPTURE_BYTES);
    process[previewKey] = preview.value;
    process[truncatedKey] ||= preview.truncated;
    process.previewUpdatedAt = new Date().toISOString();
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
    process.previewUpdatedAt = new Date().toISOString();
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
      previewStdout: _previewStdout,
      previewStderr: _previewStderr,
      previewStdoutTruncated: _previewStdoutTruncated,
      previewStderrTruncated: _previewStderrTruncated,
      previewUpdatedAt: _previewUpdatedAt,
      ...snapshot
    } = process;
    return { ...snapshot };
  }

  private previewSnapshot(process: ManagedProcess, index: number): ProcessPreview {
    const stdout = boundedPlainText(process.previewStdout, PREVIEW_STREAM_BYTES);
    const stderr = boundedPlainText(process.previewStderr, PREVIEW_STREAM_BYTES);
    const combined = stdout.value && stderr.value
      ? `${stdout.value}\n[stderr]\n${stderr.value}`
      : stdout.value || stderr.value;
    const output = utf8Tail(combined, PREVIEW_COMBINED_BYTES);
    const result: ProcessPreview = {
      id: process.id,
      title: `Terminal ${index + 1}`,
      command: redactPreviewCommand(process.command),
      cwd: boundedPlainText(process.cwd, PREVIEW_CWD_BYTES).value,
      stdout: stdout.value,
      stderr: stderr.value,
      output: output.value,
      status: process.status,
      running: process.status === "running",
      started_at: process.started_at,
      updated_at: process.previewUpdatedAt,
      truncated: process.previewStdoutTruncated
        || process.previewStderrTruncated
        || stdout.truncated
        || stderr.truncated
        || output.truncated,
    };
    if (process.exit_code !== undefined) result.exit_code = process.exit_code;
    if (process.finished_at !== undefined) result.finished_at = process.finished_at;
    return result;
  }
}

function redactPreviewCommand(value: string): string {
  const sensitiveName = "[A-Za-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|auth|pat|session(?:[_-]?(?:id|key|token|secret))?)[A-Za-z0-9_.-]*";
  let command = stripTerminalControls(value);
  // Header values commonly contain semicolon-separated cookies. Redact the
  // complete quoted header before token-oriented rules can expose a later
  // cookie whose name itself does not look sensitive.
  command = command.replace(
    /(["'])((?:authorization|(?:set-)?cookie)\s*:)[\s\S]*?\1/gi,
    "$1$2 [redacted]$1",
  );
  command = command.replace(
    new RegExp(`\\b(${sensitiveName})\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s;|&]+)`, "gi"),
    "$1=[redacted]",
  );
  command = command.replace(
    /(--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|credential|cookie|auth|pat|session))(?:\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/gi,
    "$1 [redacted]",
  );
  command = command.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'";|&]+/gi, "$1[redacted]");
  command = command.replace(/((?:set-)?cookie\s*:\s*)[^\s'";|&]+/gi, "$1[redacted]");
  command = command.replace(
    /((?:^|\s)(?:-u|--user)(?:\s*=\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s;|&]+)/gi,
    "$1[redacted]",
  );
  command = command.replace(
    /((?:^|\s)(?:-b|--cookie)(?:\s*=\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s;|&]+)/gi,
    "$1[redacted]",
  );
  command = command.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]@");
  command = command.replace(
    new RegExp(`([?&](?:${sensitiveName})=)[^&#\\s'";|]+`, "gi"),
    "$1[redacted]",
  );
  command = command.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, "[redacted]");
  command = command.replace(/\b(?:github_pat_|gh[pousr]_|glpat-|sk-)[A-Za-z0-9_-]{16,}\b/gi, "[redacted]");
  return utf8Tail(command, PREVIEW_COMMAND_BYTES).value;
}

function boundedPlainText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  return utf8Tail(stripTerminalControls(value), maxBytes);
}

function stripTerminalControls(value: string): string {
  return value
    // Operating-system commands (including terminal-title changes).
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // Control Sequence Introducer and remaining two-byte escape sequences.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    // Preserve ordinary terminal layout characters only.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function utf8Tail(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { value, truncated: false };
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return { value: buffer.subarray(start).toString("utf8"), truncated: true };
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
