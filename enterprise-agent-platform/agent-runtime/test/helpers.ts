import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  MAX_TURNS_PER_RUN_DEFAULT,
  RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
  TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
} from "../src/design-contract.generated.js";
import type { ExecutionManager } from "../src/executor.js";
import { RunCoordinator as ProductionRunCoordinator } from "../src/run-coordinator.js";
import type { RunRequest, RuntimeConfig } from "../src/types.js";

export const TEST_RUNTIME_BEARER_TOKEN = "test-runtime-token";

export async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export function testConfig(home: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    home,
    host: "127.0.0.1",
    port: 0,
    bearerToken: TEST_RUNTIME_BEARER_TOKEN,
    approvalTimeoutMs: 1_000,
    runRetentionMs: 60_000,
    maxDelegationDepth: 2,
    maxDelegatesPerRun: 4,
    maxBodyBytes: 1_000_000,
    requestBodyTimeoutMs: 15_000,
    compactionThreshold: 0.8,
    runIdleTimeoutMs: RUN_IDLE_TIMEOUT_DEFAULT_SECONDS * 1_000,
    maxTurnsPerRun: MAX_TURNS_PER_RUN_DEFAULT,
    terminalTimeoutMs: TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
    cleanupGraceMs: 500,
    maxConcurrency: 8,
    maxQueuedRuns: 256,
    managerSocketPath: "/tmp/test-manager-executor.sock",
    managerToken: "test-manager-executor-token",
    managerRequestTimeoutMs: 3_630_000,
    ...overrides,
  };
}

export function fakeExecutionManager(overrides: Partial<ExecutionManager> = {}): ExecutionManager {
  let processSequence = 0;
  const processes = new Map<string, number>();
  const snapshot = (id: string, status: "running" | "completed" | "failed") => ({
    id,
    run_id: "run_test",
    scope_key: "private:1",
    lifecycle_id: "life",
    command: "test command",
    cwd: "/workspace",
    status,
    stdout: "",
    stderr: "",
    started_at: new Date(0).toISOString(),
    ...(status === "running" ? {} : {
      exit_code: status === "completed" ? 0 : 1,
      finished_at: new Date(0).toISOString(),
    }),
    background: status === "running",
  });
  return {
    async audit(request) {
      return { audit_id: request.audit_id, executor_id: "executor_test", target: request.target };
    },
    async terminal(_context, arguments_, signal) {
      const id = `process_${(++processSequence).toString(36)}`;
      const command = String(arguments_.command || "");
      const duration = commandDuration(command);
      if (arguments_.background === true) {
        processes.set(id, Date.now() + duration);
        return { result: snapshot(id, "running") };
      }
      const timeout = Number(arguments_.timeout_ms ?? Number.MAX_SAFE_INTEGER);
      await waitFor(Math.min(duration, timeout), signal);
      return { result: snapshot(id, duration > timeout || /(?:^|[;&|]\s*)false(?:\s|$)/.test(command) ? "failed" : "completed") };
    },
    async process(_context, action, arguments_) {
      if (action === "list") return { result: [] };
      const id = String(arguments_.process_id || "process_test");
      if (action === "wait") {
        const remaining = Math.max(0, (processes.get(id) ?? 0) - Date.now());
        const timeout = Number(arguments_.timeout_ms ?? 0);
        const waitTimedOut = remaining > timeout;
        await waitFor(Math.min(remaining, timeout));
        if (!waitTimedOut) processes.delete(id);
        return { result: { ...snapshot(id, waitTimedOut ? "running" : "completed"), wait_timed_out: waitTimedOut } };
      }
      return { result: snapshot(id, processes.has(id) ? "running" : "completed") };
    },
    async file(context, action, arguments_) {
      const path = fakeWorkspacePath(context.execution_context.workspace_id, String(arguments_.path || ""));
      if (action === "read") return { content: await readFile(path, "utf8").catch(() => "") };
      if (action === "write") {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, String(arguments_.content || ""), "utf8");
        return { content: `Wrote ${Buffer.byteLength(String(arguments_.content || ""))} bytes to ${path}` };
      }
      if (action === "patch") {
        const content = await readFile(path, "utf8");
        const oldText = String(arguments_.old_text || "");
        const replacementCount = content.split(oldText).length - 1;
        const expected = Number(arguments_.expected_replacements ?? 1);
        if (replacementCount !== expected) throw new Error(`Expected ${expected} replacements, found ${replacementCount}`);
        await writeFile(path, content.split(oldText).join(String(arguments_.new_text || "")), "utf8");
        return { content: `Patched ${path}` };
      }
      return { content: "No matches", details: { count: 0 } };
    },
    async cancelRun() { return true; },
    async cleanupScope() { return { confirmed: true, completion_tasks: [] }; },
    async preview() { return { processes: [], revision: "preview_test:0" }; },
    async previewSummary() { return { running_terminal_count: 0 }; },
    ...overrides,
  };
}

function commandDuration(command: string): number {
  return [...command.matchAll(/\bsleep\s+([0-9]+(?:\.[0-9]+)?)/g)]
    .reduce((maximum, match) => Math.max(maximum, Number(match[1]) * 1_000), 0);
}

async function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}

export class TestRunCoordinator extends ProductionRunCoordinator {
  constructor(options: {
    config: RuntimeConfig;
    executor?: ExecutionManager;
    streamFn?: StreamFn;
    visionStreamFn?: StreamFn;
    visionTimeoutMs?: number;
  }) {
    super({ ...options, executor: options.executor ?? fakeExecutionManager() });
  }

  override createRun(request: RunRequest, childRun = false) {
    const workspace = request.workspace;
    if (typeof workspace !== "string") return super.createRun(request, childRun);
    return super.createRun({
      ...request,
      workspace: "/workspace",
      execution_context: workspace === "/workspace" && request.execution_context
        ? request.execution_context
        : {
            sandbox_id: request.execution_context?.sandbox_id ?? "sandbox_test",
            workspace_id: `test_${Buffer.from(workspace).toString("base64url")}`,
          },
      ...(request.attachments ? {
        attachments: request.attachments.map((attachment) => ({
          ...attachment,
          ...(attachment.path && !attachment.path.startsWith("/")
            ? { path: resolve(workspace, attachment.path) }
            : {}),
        })),
      } : {}),
    }, childRun);
  }
}

function fakeWorkspacePath(workspaceId: string, path: string): string {
  if (!workspaceId.startsWith("test_") || (path !== "/workspace" && !path.startsWith("/workspace/"))) return path;
  const workspace = Buffer.from(workspaceId.slice(5), "base64url").toString("utf8");
  return resolve(workspace, relative("/workspace", path));
}
