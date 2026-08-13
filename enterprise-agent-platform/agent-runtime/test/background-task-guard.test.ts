import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionManager } from "../src/executor.js";
import { RunCoordinator } from "../src/run-coordinator.js";
import { classifyToolCall, createTools, managedExecutionBinding } from "../src/tools.js";
import type { RunRequest } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

const ACTIVE_TASK_REVIEW_ERROR = "Agent run stopped before observing a required background task reach a terminal state; review is required before resuming";
const BACKGROUND_STATE_REVIEW_ERROR = "Runtime could not safely verify finite background task state; review is required before resuming";

test("the default background task cannot be ignored and forces needs_review after bounded follow-ups", async () => {
  const home = await temporaryDirectory("agent-background-task-guard-");
  const workspace = await temporaryDirectory("agent-background-task-guard-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 30",
      background: true,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The background transfer was started."),
    (context) => {
      assert.match(JSON.stringify(context.messages), /finite background task owned by this session/);
      return fauxAssistantMessage("The transfer should finish later.");
    },
    fauxAssistantMessage("The transfer is still pending."),
    fauxAssistantMessage("The transfer is still pending."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun(baseRequest(workspace, "ignored-task"));
    await approveTerminal(coordinator, run.id);
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.error, ACTIVE_TASK_REVIEW_ERROR);
    assert.equal(completed.result?.content, "The transfer is still pending.");
    const terminal = coordinator.getJournal(run.id)?.list().find((event) => event.type === "run.needs_review");
    assert.equal(terminal?.data.error, ACTIVE_TASK_REVIEW_ERROR);
    assert.equal(terminal?.data.content, "The transfer is still pending.");
    assert.equal(faux.state.callCount, 5);
    assert.doesNotMatch(
      JSON.stringify(await coordinator.sessions.loadSearchable(identity("ignored-task"))),
      /finite background task owned by this session/,
      "Runtime task follow-ups must not become durable conversation content",
    );
    assert.equal((await coordinator.sessions.loadActiveBackgroundTasks(identity("ignored-task"))).length, 1);
    const preserved = coordinator.processes.list("private:1", "life");
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0]?.status, "running", "completion-guard needs_review must preserve its finite task");
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process.wait observing a completed task releases the completion guard", async () => {
  const home = await temporaryDirectory("agent-background-task-wait-");
  const workspace = await temporaryDirectory("agent-background-task-wait-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 0.03; printf done",
      background: true,
    }), { stopReason: "toolUse" }),
    (context) => fauxAssistantMessage(fauxToolCall("process", {
      action: "wait",
      process_id: processIdFrom(context.messages),
      timeout_ms: 1_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The background task reached its verified terminal state."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun(baseRequest(workspace, "waited-task"));
    await approveTerminal(coordinator, run.id);
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "The background task reached its verified terminal state.");
    assert.deepEqual(await coordinator.sessions.loadActiveBackgroundTasks(identity("waited-task")), []);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a process.wait timeout does not release the background task guard", async () => {
  const home = await temporaryDirectory("agent-background-task-timeout-");
  const workspace = await temporaryDirectory("agent-background-task-timeout-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 30",
      background: true,
    }), { stopReason: "toolUse" }),
    (context) => fauxAssistantMessage(fauxToolCall("process", {
      action: "wait",
      process_id: processIdFrom(context.messages),
      timeout_ms: 100,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The wait timed out."),
    fauxAssistantMessage("The task remains active."),
    fauxAssistantMessage("The task remains active."),
    fauxAssistantMessage("The task remains active."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun(baseRequest(workspace, "timeout-task"));
    await approveTerminal(coordinator, run.id);
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.error, ACTIVE_TASK_REVIEW_ERROR);
    assert.equal((await coordinator.sessions.loadActiveBackgroundTasks(identity("timeout-task"))).length, 1);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an orphaned Manager snapshot does not release a persisted background task", async () => {
  const home = await temporaryDirectory("agent-background-task-orphaned-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("process", {
      action: "wait",
      process_id: "process_orphaned",
      timeout_ms: 1_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The process is orphaned."),
    fauxAssistantMessage("The process is still orphaned."),
    fauxAssistantMessage("The process is still orphaned."),
    fauxAssistantMessage("The process is still orphaned."),
  ]);
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async process() {
      return {
        result: {
          ...managedSnapshot("running"),
          id: "process_orphaned",
          status: "orphaned" as const,
        },
      };
    },
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    await coordinator.sessions.backgroundTaskState(identity("orphaned-task")).register(
      "process_orphaned",
      "sandbox",
    );
    const completed = await coordinator.wait(coordinator.createRun({
      ...baseRequest("/workspace", "orphaned-task"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.error, ACTIVE_TASK_REVIEW_ERROR);
    assert.equal((await coordinator.sessions.loadActiveBackgroundTasks(identity("orphaned-task"))).length, 1);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("a corrupted obligation sidecar fails closed as needs_review before the model runs", async () => {
  const home = await temporaryDirectory("agent-background-task-corrupt-");
  const workspace = await temporaryDirectory("agent-background-task-corrupt-workspace-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("This response must never run.")]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const sessionIdentity = identity("corrupt-task");
    await coordinator.sessions.backgroundTaskState(sessionIdentity).register("process_corrupt", "sandbox");
    await writeFile(coordinator.sessions.backgroundTaskPath(sessionIdentity), "{broken", "utf8");
    const completed = await coordinator.wait(coordinator.createRun(baseRequest(workspace, "corrupt-task")).id);
    assert.equal(completed.status, "needs_review");
    assert.equal(completed.error, BACKGROUND_STATE_REVIEW_ERROR);
    assert.equal(faux.state.callCount, 0);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an explicitly declared background service does not block Run completion", async () => {
  const home = await temporaryDirectory("agent-background-service-");
  const workspace = await temporaryDirectory("agent-background-service-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 30",
      background: true,
      background_kind: "service",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The requested long-lived service was started."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  try {
    const run = coordinator.createRun(baseRequest(workspace, "service"));
    await approveTerminal(coordinator, run.id);
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "The requested long-lived service was started.");
    await assert.rejects(stat(coordinator.sessions.backgroundTaskPath(identity("service"))), { code: "ENOENT" });
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a delegated Run rejects every background process before Manager audit or execution", async () => {
  const home = await temporaryDirectory("agent-delegated-background-block-");
  const faux = fauxProvider();
  let auditCalls = 0;
  let terminalCalls = 0;
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async audit(request) {
      auditCalls += 1;
      return { audit_id: request.audit_id, executor_id: "unexpected", target: request.target };
    },
    async terminal() {
      terminalCalls += 1;
      return { result: managedSnapshot("running") };
    },
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "sleep 30",
      background: true,
      background_kind: "service",
    }), { stopReason: "toolUse" }),
    (context) => {
      assert.match(JSON.stringify(context.messages), /Delegated Agents cannot start background processes/);
      return fauxAssistantMessage("I cannot leave a background process in a temporary delegated scope.");
    },
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    const completed = await coordinator.wait(coordinator.createRun({
      ...baseRequest("/workspace", "delegated-background"),
      scope_key: "private:1/delegate/test",
      session_id: "delegated-background:child",
      metadata: { parent_run_id: "run_parent", delegation_depth: 1 },
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(auditCalls, 0);
    assert.equal(terminalCalls, 0);
    assert.equal(completed.sideEffectsStarted, false);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("terminal evidence for an unregistered managed service does not enter task acknowledgement", async () => {
  const home = await temporaryDirectory("agent-managed-service-evidence-");
  const faux = fauxProvider();
  let acknowledgeCalls = 0;
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async acknowledgeTask() {
      acknowledgeCalls += 1;
      return false;
    },
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "managed service",
      background: true,
      background_kind: "service",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("process", {
      action: "wait",
      process_id: "process_managed",
      timeout_ms: 1_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The service observation completed without creating a finite-task obligation."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    const completed = await coordinator.wait(coordinator.createRun({
      ...baseRequest("/workspace", "managed-service-evidence"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(acknowledgeCalls, 0);
    assert.deepEqual(await coordinator.sessions.loadActiveBackgroundTasks(identity("managed-service-evidence")), []);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("background_kind is closed-world, requires background=true, and never enters Manager bindings", async () => {
  const terminal = createTools({
    runId: "run",
    request: { scope_key: "private:1", lifecycle_id: "life", workspace: "/workspace" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  }).find((tool) => tool.name === "terminal");
  assert.ok(terminal);

  assert.doesNotThrow(() => validateToolArguments(terminal, fauxToolCall("terminal", {
    command: "sleep 30",
    background: true,
    background_kind: "task",
  })));
  assert.doesNotThrow(() => validateToolArguments(terminal, fauxToolCall("terminal", {
    command: "sleep 30",
    background: true,
    background_kind: "service",
  })));
  assert.throws(
    () => validateToolArguments(terminal, fauxToolCall("terminal", {
      command: "sleep 30",
      background: true,
      background_kind: "daemon",
    })),
    /must match a schema in anyOf/,
  );
  assert.throws(
    () => validateToolArguments(terminal, fauxToolCall("terminal", {
      command: "sleep 30",
      background: true,
      background_kind: "task",
      watcher: true,
    })),
    /must not have additional properties/,
  );
  await assert.rejects(
    terminal.execute("foreground-kind", { command: "true", background_kind: "task" } as never, undefined),
    /valid only when background=true/,
  );
  assert.match(
    (await classifyToolCall("terminal", { command: "true", background_kind: "task" }, "/workspace")).hardBlock || "",
    /valid only when background=true/,
  );
  const managed = managedExecutionBinding("terminal", {
    command: "sleep 30",
    cwd: "/workspace",
    background: true,
    background_kind: "service",
  }, "/workspace");
  assert.deepEqual(managed, {
    operation: "terminal",
    action: "run",
    arguments: { command: "sleep 30", cwd: "/workspace", background: true },
  });
  assert.equal(Object.hasOwn(managed.arguments, "background_kind"), false);
});

test("managed background task evidence uses Manager snapshots without forwarding background_kind", async () => {
  const home = await temporaryDirectory("agent-managed-background-task-");
  const faux = fauxProvider();
  const terminalArguments: Array<Record<string, unknown>> = [];
  const auditArguments: Array<Record<string, unknown>> = [];
  const auditDetails: Array<Record<string, unknown>> = [];
  const manager: ExecutionManager = {
    managed: true,
    async audit(request) {
      auditArguments.push(request.arguments);
      auditDetails.push(request.details);
      return { audit_id: request.audit_id, executor_id: `executor-${auditArguments.length}`, target: request.target };
    },
    async terminal(_context, arguments_) {
      terminalArguments.push(arguments_);
      return { result: managedSnapshot("running") };
    },
    async process(_context, action) {
      assert.equal(action, "wait");
      return { result: { ...managedSnapshot("completed"), wait_timed_out: false } };
    },
    async file() { throw new Error("unexpected file call"); },
    async cancelRun() { return true; },
    async cleanupScope() { return { confirmed: true, completion_tasks: [] }; },
    async preview() { return { processes: [], revision: "preview_test:1" }; },
    async previewSummary() { return { running_terminal_count: 0 }; },
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "managed batch",
      background: true,
      background_kind: "task",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("process", {
      action: "wait",
      process_id: "process_managed",
      timeout_ms: 1_000,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The managed background task completed."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    const completed = await coordinator.wait(coordinator.createRun({
      ...baseRequest("/workspace", "managed-task"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.result?.content, "The managed background task completed.");
    assert.equal(terminalArguments.length, 1);
    assert.equal(Object.hasOwn(terminalArguments[0]!, "background_kind"), false);
    assert.equal(Object.hasOwn(auditArguments[0]!, "background_kind"), false);
    assert.equal(Object.hasOwn(auditDetails[0]!, "background_kind"), false);
    assert.deepEqual(await coordinator.sessions.loadActiveBackgroundTasks(identity("managed-task")), []);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("Manager task reconciliation repairs a crash before Runtime sidecar registration and acknowledges once", async () => {
  const home = await temporaryDirectory("agent-managed-background-reconcile-");
  const faux = fauxProvider();
  const acknowledgements: string[] = [];
  let reconcileCalls = 0;
  let processCalls = 0;
  const manager: ExecutionManager = {
    managed: true,
    async audit(request) {
      return { audit_id: request.audit_id, executor_id: "executor-reconcile", target: request.target };
    },
    async terminal() { throw new Error("the recovered task must not be replayed"); },
    async process(_context, action, arguments_) {
      processCalls += 1;
      assert.equal(action, "wait");
      assert.equal(arguments_.process_id, "proc_recovered");
      return { result: {
        ...managedSnapshot("completed"),
        id: "proc_recovered",
        run_id: "run-before-crash",
        scope_key: "private:1",
        lifecycle_id: "life",
        wait_timed_out: false,
      } };
    },
    async file() { throw new Error("unexpected file call"); },
    async cancelRun() { return true; },
    async cleanupScope() { return { confirmed: true, completion_tasks: [] }; },
    async reconcileTasks() {
      reconcileCalls += 1;
      return [{
        ...managedSnapshot("running"),
        id: "proc_recovered",
        run_id: "run-before-crash",
        target: "sandbox",
      }];
    },
    async acknowledgeTask(_identity, processId) {
      acknowledgements.push(processId);
      return true;
    },
    async preview() { return { processes: [], revision: "preview_test:reconcile" }; },
    async previewSummary() { return { running_terminal_count: 0 }; },
  };
  faux.setResponses([
    (context) => {
      assert.match(context.systemPrompt || "", /proc_recovered/);
      return fauxAssistantMessage(fauxToolCall("process", {
        action: "wait",
        process_id: "proc_recovered",
        timeout_ms: 1_000,
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Recovered task verified without replay."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    const completed = await coordinator.wait(coordinator.createRun({
      ...baseRequest("/workspace", "reconcile-task"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(reconcileCalls, 1);
    assert.deepEqual(acknowledgements, ["proc_recovered"]);
    assert.equal(processCalls, 1);
    assert.deepEqual(await coordinator.sessions.loadActiveBackgroundTasks(identity("reconcile-task")), []);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("run-start reconciliation completes a resolved tombstone acknowledgement before the model runs", async () => {
  const home = await temporaryDirectory("agent-managed-background-tombstone-");
  const faux = fauxProvider();
  const acknowledgements: string[] = [];
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async reconcileTasks() {
      return [{
        ...managedSnapshot("completed"),
        id: "proc_resolved",
        run_id: "run-before-restart",
        target: "sandbox",
      }];
    },
    async acknowledgeTask(_identity, processId) {
      acknowledgements.push(processId);
      return true;
    },
  };
  faux.setResponses([
    (context) => {
      assert.doesNotMatch(context.systemPrompt || "", /proc_resolved/);
      assert.deepEqual(acknowledgements, ["proc_resolved"]);
      return fauxAssistantMessage("The prior task acknowledgement was recovered before this turn.");
    },
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    const state = coordinator.sessions.backgroundTaskState(identity("resolved-tombstone"));
    await state.register("proc_resolved", "sandbox");
    await state.resolve("proc_resolved", "sandbox");
    const completed = await coordinator.wait(coordinator.createRun({
      ...baseRequest("/workspace", "resolved-tombstone"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(completed.status, "completed", completed.error);
    assert.deepEqual(acknowledgements, ["proc_resolved"]);
    assert.deepEqual((await state.read()).obligations, []);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("needs_review obligations survive a new coordinator and terminal evidence releases them", async () => {
  const home = await temporaryDirectory("agent-background-restart-");
  const firstFaux = fauxProvider();
  const manager = managedBackgroundManager();
  firstFaux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "managed long task",
      background: true,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("It will finish later."),
    fauxAssistantMessage("Still running."),
    fauxAssistantMessage("Still running."),
    fauxAssistantMessage("Still running."),
  ]);
  const first = new RunCoordinator({ config: testConfig(home), streamFn: firstFaux.provider.streamSimple });
  Object.defineProperty(first, "executor", { value: manager });
  try {
    const result = await first.wait(first.createRun({
      ...baseRequest("/workspace", "restart-task"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(result.status, "needs_review");
    assert.equal((await first.sessions.loadActiveBackgroundTasks(identity("restart-task"))).length, 1);
  } finally {
    first.shutdown();
  }

  const secondFaux = fauxProvider();
  secondFaux.setResponses([
    (context) => {
      assert.match(context.systemPrompt || "", /<background_task_obligations>/);
      assert.match(context.systemPrompt || "", /"process_id": "process_managed"/);
      assert.match(context.systemPrompt || "", /"target": "sandbox"/);
      return fauxAssistantMessage(fauxToolCall("process", {
        action: "wait",
        process_id: "process_managed",
        timeout_ms: 1_000,
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("The recovered task reached a verified terminal state."),
  ]);
  const second = new RunCoordinator({ config: testConfig(home), streamFn: secondFaux.provider.streamSimple });
  Object.defineProperty(second, "executor", { value: manager });
  try {
    const result = await second.wait(second.createRun({
      ...baseRequest("/workspace", "restart-task"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    }).id);
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(await second.sessions.loadActiveBackgroundTasks(identity("restart-task")), []);
  } finally {
    second.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("an active task blocks schedule creation before Platform access and terminal evidence restores it", async () => {
  const home = await temporaryDirectory("agent-background-schedule-block-");
  const faux = fauxProvider();
  const manager = managedBackgroundManager();
  const scheduleArguments = {
    name: "Poll the process",
    prompt: "Report process progress",
    schedule: { type: "interval" as const, every_seconds: 300 },
    timezone: "UTC",
    delivery: "chat" as const,
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("schedule", {
      action: "create",
      arguments: scheduleArguments,
    }), { stopReason: "toolUse" }),
    (context) => {
      assert.match(JSON.stringify(context.messages), /Cannot create a schedule while this session has an active finite background task/);
      return fauxAssistantMessage(fauxToolCall("process", {
        action: "wait",
        process_id: "process_managed",
        timeout_ms: 1_000,
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("schedule", {
      action: "create",
      arguments: scheduleArguments,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The task finished and the separately requested schedule was created."),
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  let platformCalls = 0;
  coordinator.gateway.invoke = async (_request, _runId, tool, action) => {
    assert.equal(tool, "schedule");
    assert.equal(action, "create");
    platformCalls += 1;
    return { data: { schedule_id: 7 } };
  };
  try {
    await coordinator.sessions.backgroundTaskState(identity("schedule-block")).register(
      "process_managed",
      "sandbox",
    );
    const run = coordinator.createRun({
      ...baseRequest("/workspace", "schedule-block"),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    });
    const approval = await waitUntil(() => coordinator.getJournal(run.id)?.list().find(
      (event) => event.type === "approval.requested" && event.data.tool_name === "schedule",
    ));
    assert.equal(platformCalls, 0, "the blocked create must not reach Platform before terminal evidence");
    await coordinator.respondApproval(run.id, String(approval.data.approval_id), "once");
    const completed = await coordinator.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(platformCalls, 1);
    assert.deepEqual(await coordinator.sessions.loadActiveBackgroundTasks(identity("schedule-block")), []);
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.filter((event) => event.type === "approval.requested").length, 1);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("scope cleanup reaches a Manager pre-start intent without Runtime context or sidecar", async () => {
  const home = await temporaryDirectory("agent-background-cleanup-context-");
  const cleanupIdentities: unknown[] = [];
  const acknowledgements: string[] = [];
  const owner = "7".repeat(64);
  let acknowledged = false;
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async cleanupScope(cleanupIdentity) {
      cleanupIdentities.push(structuredClone(cleanupIdentity));
      return {
        confirmed: true,
        completion_tasks: acknowledged ? [] : [{
          scope_id: "private:1",
          lifecycle_id: "life",
          execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
          completion_owner_id: owner,
          process_id: "process_prestart_intent",
          target: "sandbox",
        }],
      };
    },
    async acknowledgeTask(_identity, processId) {
      acknowledgements.push(processId);
      acknowledged = true;
      return true;
    },
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: fauxProvider().provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  try {
    assert.equal(await coordinator.cleanupScope("private:1", "life"), 0);
    assert.deepEqual(cleanupIdentities, [{ scope_id: "private:1", lifecycle_id: "life" }]);
    assert.deepEqual(acknowledgements, ["process_prestart_intent"]);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("scope cleanup retries after local responsibility commit fails and retains context until acknowledgement", async () => {
  const home = await temporaryDirectory("agent-background-cleanup-local-retry-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("ready")]);
  const owner = "6".repeat(64);
  let acknowledged = false;
  let acknowledgeCalls = 0;
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async cleanupScope() {
      return { confirmed: true, completion_tasks: acknowledged ? [] : [{
        scope_id: "private:1", lifecycle_id: "life",
        execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
        completion_owner_id: owner, process_id: "process_cleanup_retry", target: "sandbox",
      }] };
    },
    async acknowledgeTask() {
      acknowledgeCalls += 1;
      acknowledged = true;
      return true;
    },
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  const taskIdentity = identity("cleanup-local-retry");
  try {
    const run = coordinator.createRun({
      ...baseRequest("/workspace", taskIdentity.session_id),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    });
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    await coordinator.sessions.backgroundTaskState(taskIdentity).register("process_cleanup_retry", "sandbox");
    const scopeManifest = dirname(dirname(coordinator.sessions.path(taskIdentity))) + "/scope.json";
    const validManifest = await readFile(scopeManifest, "utf8");
    await writeFile(scopeManifest, "{broken", "utf8");

    await assert.rejects(coordinator.cleanupScope("private:1", "life"));
    assert.equal(acknowledgeCalls, 0, "Manager evidence must stay unacknowledged before local commit");
    await coordinator.previewProcesses("private:1", "life");

    await writeFile(scopeManifest, validManifest, "utf8");
    assert.equal(await coordinator.cleanupScope("private:1", "life"), 0);
    assert.equal(acknowledgeCalls, 1);
    await assert.rejects(stat(coordinator.sessions.backgroundTaskPath(taskIdentity)), { code: "ENOENT" });
    await assert.rejects(coordinator.previewProcesses("private:1", "life"), /Trusted execution context is unavailable/);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("permanent scope cleanup retries acknowledgement after local session commit", async () => {
  const home = await temporaryDirectory("agent-background-cleanup-ack-retry-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("ready")]);
  const owner = "5".repeat(64);
  let acknowledgeCalls = 0;
  let acknowledged = false;
  const manager: ExecutionManager = {
    ...managedBackgroundManager(),
    async cleanupScope() {
      return { confirmed: true, completion_tasks: acknowledged ? [] : [{
        scope_id: "private:1", lifecycle_id: "life",
        execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
        completion_owner_id: owner, process_id: "process_cleanup_ack_retry", target: "host",
      }] };
    },
    async acknowledgeTask() {
      acknowledgeCalls += 1;
      if (acknowledgeCalls === 1) return false;
      acknowledged = true;
      return true;
    },
  };
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  Object.defineProperty(coordinator, "executor", { value: manager });
  const taskIdentity = identity("cleanup-ack-retry");
  try {
    const run = coordinator.createRun({
      ...baseRequest("/workspace", taskIdentity.session_id),
      execution_context: { sandbox_id: "agent_1", workspace_id: "workspace_1" },
    });
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    await coordinator.sessions.backgroundTaskState(taskIdentity).register("process_cleanup_ack_retry", "host");

    await assert.rejects(
      coordinator.cleanupScope("private:1", "life", true),
      /did not acknowledge/,
    );
    await assert.rejects(stat(coordinator.sessions.path(taskIdentity)), { code: "ENOENT" });
    await coordinator.previewProcesses("private:1", "life");

    assert.equal(await coordinator.cleanupScope("private:1", "life", true), 0);
    assert.equal(acknowledgeCalls, 2);
    await assert.rejects(coordinator.previewProcesses("private:1", "life"), /Trusted execution context is unavailable/);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

function baseRequest(workspace: string, sessionId: string): RunRequest {
  return {
    scope_key: "private:1",
    lifecycle_id: "life",
    session_id: sessionId,
    workspace,
    system_prompt: "You are an Agent.",
    input: "Complete the task.",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
}

function identity(sessionId: string): { scope_key: string; lifecycle_id: string; session_id: string } {
  return { scope_key: "private:1", lifecycle_id: "life", session_id: sessionId };
}

function processIdFrom(messages: unknown): string {
  const match = /Process started: (process_[a-z0-9]+)/i.exec(JSON.stringify(messages));
  assert.ok(match?.[1]);
  return match[1];
}

function managedSnapshot(status: "running" | "completed") {
  return {
    id: "process_managed",
    run_id: "run_managed",
    scope_key: "private:1",
    lifecycle_id: "life",
    command: "managed batch",
    cwd: "/workspace",
    status,
    ...(status === "completed" ? { exit_code: 0, finished_at: new Date().toISOString() } : {}),
    stdout: status === "completed" ? "done" : "",
    stderr: "",
    started_at: new Date().toISOString(),
    background: true,
  } as const;
}

function managedBackgroundManager(): ExecutionManager {
  return {
    managed: true,
    async audit(request) {
      return { audit_id: request.audit_id, executor_id: "executor-managed", target: request.target };
    },
    async terminal() { return { result: managedSnapshot("running") }; },
    async process(_context, action) {
      assert.equal(action, "wait");
      return { result: { ...managedSnapshot("completed"), wait_timed_out: false } };
    },
    async file() { throw new Error("unexpected file call"); },
    async cancelRun() { return true; },
    async cleanupScope() { return { confirmed: true, completion_tasks: [] }; },
    async preview() { return { processes: [], revision: "preview_test:restart" }; },
    async previewSummary() { return { running_terminal_count: 0 }; },
  };
}

async function approveTerminal(coordinator: RunCoordinator, runId: string): Promise<void> {
  const approval = await waitUntil(() => coordinator.getJournal(runId)?.list().find(
    (event) => event.type === "approval.requested",
  ));
  await coordinator.respondApproval(runId, String(approval.data.approval_id), "once");
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Runtime state");
}
