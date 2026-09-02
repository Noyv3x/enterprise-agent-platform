import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { RunRequest } from "../src/types.js";
import {
  fakeExecutionManager,
  temporaryDirectory,
  testConfig,
  TestRunCoordinator as RunCoordinator,
} from "./helpers.js";

const blockedEmailCalls = [
  fauxToolCall("terminal", { command: "printf forbidden" }),
  fauxToolCall("read_file", { path: "forbidden.txt" }),
  fauxToolCall("web", { action: "search", arguments: { query: "forbidden" } }),
  fauxToolCall("browser", { action: "stats" }),
  fauxToolCall("skill", { action: "list" }),
  fauxToolCall("schedule", { action: "list" }),
  fauxToolCall("delegate_task", { prompt: "do not delegate" }),
  fauxToolCall("mcp", { action: "list" }),
  fauxToolCall("mail", {
    action: "send",
    arguments: {
      account_id: 1,
      to: ["recipient@example.com"],
      subject: "forbidden",
      text_body: "forbidden",
    },
  }),
];

const readOnlyMailCalls = [
  fauxToolCall("mail", { action: "accounts" }),
  fauxToolCall("mail", { action: "folders", arguments: { account_id: 1 } }),
  fauxToolCall("mail", {
    action: "search",
    arguments: { account_id: 1, criteria: { unread: true } },
  }),
  fauxToolCall("mail", {
    action: "read",
    arguments: { account_id: 1, folder: "INBOX", uid: 7 },
  }),
];

test("unattended email runs expose only read-only mail operations", async () => {
  const home = await temporaryDirectory("agent-email-policy-home-");
  const workspace = await temporaryDirectory("agent-email-policy-workspace-");
  const faux = fauxProvider();
  let exposedToolNames: string[] = [];
  let exposedMailSchema = "";
  faux.setResponses([
    (context) => {
      exposedToolNames = context.tools?.map((tool) => tool.name) ?? [];
      exposedMailSchema = JSON.stringify(context.tools?.find((tool) => tool.name === "mail")?.parameters);
      return fauxAssistantMessage(blockedEmailCalls, { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Blocked unsafe email-triggered actions."),
  ]);
  let gatewayCalls = 0;
  let managerCalls = 0;
  const coordinator = new RunCoordinator({
    config: testConfig(home),
    streamFn: faux.provider.streamSimple,
    executor: fakeExecutionManager({
      async audit() {
        managerCalls += 1;
        return assert.fail("blocked email tools must not reach Manager audit");
      },
      async terminal() {
        managerCalls += 1;
        return assert.fail("blocked email tools must not reach Manager terminal execution");
      },
      async file() {
        managerCalls += 1;
        return assert.fail("blocked email tools must not reach Manager file execution");
      },
    }),
  });
  coordinator.gateway.invoke = async () => {
    gatewayCalls += 1;
    return assert.fail("blocked email tools must not reach the platform gateway");
  };
  try {
    const run = coordinator.createRun(emailRequest(workspace, "blocked"));
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    assert.deepEqual(exposedToolNames, ["mail"]);
    for (const action of ["accounts", "folders", "search", "read"]) {
      assert.match(exposedMailSchema, new RegExp(`"const":"${action}"`));
    }
    for (const action of ["send", "reply", "move", "mark", "save_attachment"]) {
      assert.doesNotMatch(exposedMailSchema, new RegExp(`"const":"${action}"`));
    }
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(gatewayCalls, 0);
    assert.equal(managerCalls, 0);
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    assert.equal(events.some((event) => event.type === "tool.started"), false);
    const failures = events.filter((event) => event.type === "tool.failed");
    assert.equal(failures.length, blockedEmailCalls.length);
    assert.equal(failures.every((event) => (
      event.data.execution_started === false
      && event.data.unattended_authorization_required === true
      && /only use read-only mail/.test(String(event.data.reason))
    )), true);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unattended email runs may list accounts and folders, search, and read mail", async () => {
  const home = await temporaryDirectory("agent-email-read-home-");
  const workspace = await temporaryDirectory("agent-email-read-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(readOnlyMailCalls, { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail read complete."),
  ]);
  const actions: string[] = [];
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  coordinator.gateway.invoke = async (_request, _runId, tool, action) => {
    assert.equal(tool, "mail");
    actions.push(action);
    return { data: { ok: true } };
  };
  try {
    const run = coordinator.createRun(emailRequest(workspace, "read-only"));
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    assert.deepEqual(actions.sort(), ["accounts", "folders", "read", "search"]);
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    assert.equal(events.filter((event) => event.type === "tool.completed").length, readOnlyMailCalls.length);
    assert.equal(events.some((event) => event.type === "tool.failed"), false);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate provider tool-call ids fail the whole parallel batch before execution", async () => {
  const home = await temporaryDirectory("agent-duplicate-tool-id-home-");
  const workspace = await temporaryDirectory("agent-duplicate-tool-id-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("terminal", { command: "printf first" }, { id: "duplicate-call" }),
      fauxToolCall("read_file", { path: "second.txt" }, { id: "duplicate-call" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Duplicate calls rejected."),
  ]);
  let downstreamCalls = 0;
  const coordinator = new RunCoordinator({
    config: testConfig(home),
    streamFn: faux.provider.streamSimple,
    executor: fakeExecutionManager({
      async audit() {
        downstreamCalls += 1;
        return assert.fail("duplicate ids must not reach Manager audit");
      },
      async terminal() {
        downstreamCalls += 1;
        return assert.fail("duplicate ids must not execute terminal");
      },
      async file() {
        downstreamCalls += 1;
        return assert.fail("duplicate ids must not execute file operations");
      },
    }),
  });
  try {
    const request = emailRequest(workspace, "duplicates");
    delete request.metadata;
    const run = coordinator.createRun(request);
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    const events = coordinator.getJournal(run.id)?.list() ?? [];
    assert.equal(downstreamCalls, 0);
    assert.equal(events.some((event) => event.type === "approval.requested"), false);
    assert.equal(events.some((event) => event.type === "tool.started"), false);
    const failures = events.filter((event) => event.type === "tool.failed");
    assert.equal(failures.length, 2);
    assert.equal(failures.every((event) => /unique id/.test(JSON.stringify(event.data.result))), true);
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function emailRequest(workspace: string, suffix: string): RunRequest {
  return {
    scope_key: "private:1",
    lifecycle_id: "life",
    session_id: `email-${suffix}`,
    workspace,
    system_prompt: "You are an Agent.",
    input: "Handle the incoming email.",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    metadata: { trigger: "email", unattended: true },
  };
}
