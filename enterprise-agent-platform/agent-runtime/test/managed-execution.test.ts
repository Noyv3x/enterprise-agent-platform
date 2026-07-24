import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { RunCoordinator, RunValidationError } from "../src/run-coordinator.js";
import { createTools, managedExecutionBinding } from "../src/tools.js";
import type { JsonObject, RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

const MANAGER_TOKEN = "manager-executor-test-token";

test("production configuration fails closed without Manager identity and forbids local fallback", () => {
  assert.throws(
    () => loadConfig({ AGENT_RUNTIME_TOKEN: "runtime" }),
    /Manager executor bearer token is required/,
  );
  assert.throws(
    () => loadConfig({
      AGENT_RUNTIME_TOKEN: "runtime",
      AGENT_RUNTIME_EXECUTOR_MODE: "local",
      NODE_ENV: "production",
    }),
    /local execution fallback is disabled in production/,
  );
  const configured = loadConfig({
    AGENT_RUNTIME_TOKEN: "runtime",
    AGENT_MANAGER_EXECUTOR_TOKEN: MANAGER_TOKEN,
  });
  assert.equal(configured.executionMode, "manager");
  assert.equal(configured.managerSocketPath, "/run/ubitech-agent/manager.sock");
});

test("managed execution audit bindings exactly match Manager call projections", () => {
  const workspace = "/workspace";
  assert.deepEqual(
    managedExecutionBinding(
      "terminal",
      { target: "host", command: "printf test", cwd: workspace, background: false },
      workspace,
      12_345,
    ),
    {
      operation: "terminal",
      action: "run",
      arguments: { command: "printf test", cwd: workspace, background: false, timeout_ms: 12_345 },
    },
  );
  assert.deepEqual(
    managedExecutionBinding("process", { target: "sandbox", action: "write", process_id: "process-1", input: "x" }, workspace),
    { operation: "process", action: "write", arguments: { process_id: "process-1", input: "x" } },
  );
  for (const [toolName, action, arguments_] of [
    ["read_file", "read", { path: "/workspace/a", offset: 2 }],
    ["write_file", "write", { path: "/workspace/a", content: "new" }],
    ["patch_file", "patch", { path: "/workspace/a", old_text: "a", new_text: "b" }],
    ["search_files", "search", { path: "/workspace", query: "needle" }],
  ] as const) {
    assert.deepEqual(
      managedExecutionBinding(toolName, { target: "sandbox", ...arguments_ }, workspace),
      { operation: toolName, action, arguments: arguments_ },
    );
  }
});

test("managed execution defaults to sandbox, audits before start, skips approval, and inherits identity", async () => {
  const home = await temporaryDirectory("managed-execution-");
  const socketPath = join(home, "manager.sock");
  const manager = new FakeManager(socketPath);
  await manager.listen();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "printf sandbox" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("terminal", { target: "host", command: "printf host" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "note.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("process", { action: "list" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: "child task" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("terminal", { command: "printf child" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child complete"),
    fauxAssistantMessage("parent complete"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, {
      executionMode: "manager",
      managerSocketPath: socketPath,
      managerToken: MANAGER_TOKEN,
      managerRequestTimeoutMs: 5_000,
      maxConcurrency: 1,
    }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const execution_context = { sandbox_id: "agent_42", workspace_id: "workspace_42" };
    const run = coordinator.createRun(managedRequest({ execution_context }));
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "parent complete");

    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    const auditIndexes = events.flatMap((event, index) => event.type === "execution.audit" ? [index] : []);
    const startedIndexes = events.flatMap((event, index) => event.type === "tool.started" ? [index] : []);
    assert.ok(auditIndexes.length >= 2);
    assert.ok(startedIndexes.length >= 2);
    assert.ok(auditIndexes[0]! < startedIndexes[0]!);
    assert.ok(auditIndexes[1]! < startedIndexes[1]!);

    const audits = manager.requests.filter((request) => request.path === "/v1/executor/audit");
    assert.equal(audits.length, 5);
    assert.deepEqual(
      audits.map((request) => request.body.target),
      ["sandbox", "host", "sandbox", "sandbox", "sandbox"],
    );
    for (const audit of audits) {
      assert.deepEqual(audit.body.execution_context, execution_context);
      assert.equal(audit.body.details instanceof Object, true);

      const operation = String(audit.body.operation);
      const endpoint = operation === "terminal"
        ? "/v1/executor/terminal"
        : operation === "process"
          ? "/v1/executor/process"
          : "/v1/executor/file";
      const execution = manager.requests.find((request) =>
        request.path === endpoint && request.body.audit_id === audit.body.audit_id
      );
      assert.ok(execution, `missing execution request for ${operation}`);
      assert.equal(execution.body.action, audit.body.action);
      assert.deepEqual(execution.body.arguments, audit.body.arguments);
    }
    assert.match(String((audits[0]?.body.details as JsonObject | undefined)?.command), /printf sandbox/);
    assert.equal(String((audits[0]?.body.details as JsonObject | undefined)?.cwd), "/workspace");
    assert.match(String(audits[4]?.body.scope_id), /\/delegate\//);

    const terminalCalls = manager.requests.filter((request) => request.path === "/v1/executor/terminal");
    assert.equal(terminalCalls.length, 3);
    for (const terminal of terminalCalls) {
      assert.equal(typeof terminal.body.audit_id, "string");
      assert.equal(typeof terminal.body.executor_id, "string");
      assert.deepEqual(terminal.body.execution_context, execution_context);
      assert.equal((terminal.body.arguments as JsonObject).cwd, "/workspace");
    }
    assert.equal(manager.requests.filter((request) => request.path === "/v1/executor/file").length, 1);
    assert.equal(manager.requests.filter((request) => request.path === "/v1/executor/process").length, 1);

    const preview = await coordinator.previewProcesses("private:42", "life-42");
    assert.equal(preview.revision, "preview-test:1");
    assert.equal(preview.processes[0]?.title, "Terminal 1");
    assert.match(preview.processes[0]?.command || "", /\[redacted\]/);
    assert.match(preview.processes[0]?.output || "", /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(preview), /preview-secret/);
    assert.deepEqual(await coordinator.previewProcessSummary("private:42", "life-42"), {
      running_terminal_count: 0,
    });
    assert.deepEqual(await coordinator.updateBlockerSummary(), {
      running_background_terminal_count: 0,
      update_blocking_terminal_count: 0,
      terminable_background_terminal_count: 0,
    });
    assert.equal(await coordinator.cleanupScope("private:42", "life-42"), 0);
    assert.equal(
      manager.requests.filter((request) => request.path === "/v1/executor/scopes/cleanup").length,
      1,
    );
  } finally {
    coordinator.shutdown();
    await manager.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("execution identity cannot be injected through a tool call or malformed run context", async () => {
  const tools = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  });
  for (const toolName of ["terminal", "process", "read_file", "write_file", "patch_file", "search_files"]) {
    const schema = tools.find((tool) => tool.name === toolName)?.parameters as JsonObject | undefined;
    assert.equal(schema?.additionalProperties, false);
    const properties = schema?.properties as JsonObject | undefined;
    assert.equal(properties?.sandbox_id, undefined);
    assert.equal(properties?.workspace_id, undefined);
  }

  const home = await temporaryDirectory("managed-identity-");
  const coordinator = new RunCoordinator({
    config: testConfig(home, {
      executionMode: "manager",
      managerSocketPath: join(home, "missing.sock"),
      managerToken: MANAGER_TOKEN,
    }),
  });
  try {
    const missingContext = managedRequest();
    delete missingContext.execution_context;
    assert.throws(
      () => coordinator.createRun(missingContext),
      (error: unknown) => error instanceof RunValidationError && /execution_context is required/.test(error.message),
    );
    assert.throws(
      () => coordinator.createRun(managedRequest({
        execution_context: {
          sandbox_id: "agent_1",
          workspace_id: "workspace_1",
          attacker_selected_container: "root",
        } as never,
      })),
      /accepts only sandbox_id and workspace_id/,
    );
    assert.throws(
      () => coordinator.createRun({ ...managedRequest(), workspace: "/tmp/injected" }),
      /fixed \/workspace container path/,
    );
    const established = managedRequest({ session_id: "established" });
    coordinator.createRun(established);
    assert.throws(
      () => coordinator.createRun(managedRequest({
        session_id: "conflict",
        execution_context: { sandbox_id: "attacker", workspace_id: "workspace_1" },
      })),
      /conflicts with the established scope identity/,
    );
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("Manager audit errors fail the tool before tool.started without requesting approval", async () => {
  const home = await temporaryDirectory("managed-error-");
  const socketPath = join(home, "manager.sock");
  const manager = new FakeManager(socketPath, true);
  await manager.listen();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { command: "printf blocked" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("reported failure"),
  ]);
  const coordinator = new RunCoordinator({
    config: testConfig(home, {
      executionMode: "manager",
      managerSocketPath: socketPath,
      managerToken: MANAGER_TOKEN,
      managerRequestTimeoutMs: 5_000,
    }),
    streamFn: faux.provider.streamSimple,
  });
  try {
    const run = coordinator.createRun(managedRequest());
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "execution.audit"), true);
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    assert.equal(events.some((event) => event.type === "tool.started"), false);
    const failed = events.find((event) => event.type === "tool.failed");
    assert.equal(failed?.data.execution_started, false);
    assert.equal(manager.requests.some((request) => request.path === "/v1/executor/terminal"), false);
  } finally {
    coordinator.shutdown();
    await manager.close();
    await rm(home, { recursive: true, force: true });
  }
});

function managedRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    scope_key: "private:42",
    lifecycle_id: "life-42",
    session_id: "session-42",
    workspace: "/workspace",
    execution_context: { sandbox_id: "agent_42", workspace_id: "workspace_42" },
    system_prompt: "You are ubitech agent.",
    input: "work",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    ...overrides,
  };
}

interface CapturedRequest {
  path: string;
  body: JsonObject;
}

class FakeManager {
  readonly requests: CapturedRequest[] = [];
  private readonly server = createServer((request, response) => void this.route(request, response));

  constructor(
    private readonly socketPath: string,
    private readonly rejectAudit = false,
  ) {}

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => this.server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    }));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      assert.equal(request.headers.authorization, `Bearer ${MANAGER_TOKEN}`);
      const body = await readBody(request);
      const path = request.url || "";
      this.requests.push({ path, body });
      if (path === "/v1/executor/audit") {
        if (this.rejectAudit) {
          send(response, 503, { error: "executor unavailable" });
          return;
        }
        send(response, 200, {
          audit_id: body.audit_id,
          executor_id: `executor-${this.requests.length}`,
          target: body.target,
          recorded_at: new Date().toISOString(),
        });
        return;
      }
      if (path === "/v1/executor/terminal") {
        const arguments_ = body.arguments as JsonObject;
        send(response, 200, {
          result: {
            id: `process-${this.requests.length}`,
            run_id: body.run_id,
            scope_key: body.scope_id,
            lifecycle_id: body.lifecycle_id,
            command: arguments_.command,
            cwd: arguments_.cwd,
            status: "completed",
            exit_code: 0,
            stdout: `${String(arguments_.command)}\n`,
            stderr: "",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            background: false,
          },
        });
        return;
      }
      if (path === "/v1/executor/file") {
        const arguments_ = body.arguments as JsonObject;
        send(response, 200, {
          content: "managed file content",
          details: { path: arguments_.path, returned: 20, total: 20 },
        });
        return;
      }
      if (path === "/v1/executor/process") {
        send(response, 200, { result: [] });
        return;
      }
      if (path === "/v1/executor/runs/cancel" || path === "/v1/executor/scopes/cleanup") {
        send(response, 200, { confirmed: true });
        return;
      }
      if (path === "/v1/executor/scopes/processes") {
        const now = new Date().toISOString();
        send(response, 200, {
          processes: [{
            id: "preview-1",
            title: "untrusted title",
            command: "curl -H 'Authorization: Bearer preview-secret' https://example.test",
            cwd: "/workspace",
            output: "Authorization: Bearer preview-secret",
            status: "running",
            running: true,
            started_at: now,
            updated_at: now,
            truncated: false,
          }],
          revision: "preview-test:1",
        });
        return;
      }
      if (path === "/v1/executor/scopes/process-summary") {
        send(response, 200, { running_terminal_count: 0 });
        return;
      }
      if (path === "/v1/executor/processes/update-blockers") {
        send(response, 200, {
          running_background_terminal_count: 0,
          update_blocking_terminal_count: 0,
          terminable_background_terminal_count: 0,
        });
        return;
      }
      send(response, 404, { error: "unsupported test endpoint" });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function readBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
