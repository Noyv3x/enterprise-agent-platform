import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { ApprovalBroker } from "../src/approval-broker.js";
import { AlwaysApprovalStore } from "../src/persistence.js";
import { SessionStore, type SessionIdentity } from "../src/session-store.js";
import type { ApprovalRequest } from "../src/types.js";
import { temporaryDirectory } from "./helpers.js";

test("ApprovalBroker resolves once and caches session grants", async () => {
  const requests: ApprovalRequest[] = [];
  const broker = new ApprovalBroker(1_000, (request) => requests.push(request), () => undefined);
  const context = {
    runId: "run-one",
    scopeKey: "scope",
    sessionId: "session",
    toolName: "terminal",
    approvalKey: "v2:terminal:date",
    displayArguments: { command: "date" },
    reason: "host command",
  };
  const first = broker.request(context);
  assert.equal(requests.length, 1);
  await broker.respond("run-one", requests[0]!.id, "session");
  assert.deepEqual(await first, { allowed: true, outcome: "approved" });
  assert.deepEqual(await broker.request({ ...context, runId: "run-two" }), { allowed: true, outcome: "approved" });
  assert.equal(requests.length, 1);
});

test("session approval does not authorize another object in the same tool", async () => {
  const requests: ApprovalRequest[] = [];
  const broker = new ApprovalBroker(1_000, (request) => requests.push(request), () => undefined);
  const firstContext = {
    runId: "run-one",
    scopeKey: "scope",
    lifecycleId: "life",
    sessionId: "session",
    toolName: "terminal",
    approvalKey: "v2:terminal:command-one",
    displayArguments: { command: "printf one" },
    reason: "host command",
  };
  const first = broker.request(firstContext);
  await broker.respond(firstContext.runId, (await waitForRequest(requests)).id, "session");
  assert.deepEqual(await first, { allowed: true, outcome: "approved" });

  const second = broker.request({
    ...firstContext,
    runId: "run-two",
    approvalKey: "v2:terminal:command-two",
    displayArguments: { command: "printf two" },
  });
  const secondRequest = await waitForRequest(requests, 1);
  broker.cancelRun("run-two");
  assert.equal(secondRequest.approval_key, "v2:terminal:command-two");
  assert.deepEqual(await second, { allowed: false, outcome: "cancelled" });
});

test("one-shot approval rejects session and always decisions and ignores cached grants", async () => {
  const home = await temporaryDirectory("agent-one-shot-approval-");
  try {
    const approvalKey = "v2:process:write-input";
    const identity = { scope_key: "scope", lifecycle_id: "life", session_id: "session" };
    const sessions = new SessionStore(home);
    await sessions.appendSessionApproval(identity, approvalKey, "process");
    const always = new AlwaysApprovalStore(home);
    always.grant(identity.scope_key, approvalKey, "process");
    const requests: ApprovalRequest[] = [];
    const broker = new ApprovalBroker(
      1_000,
      (request) => requests.push(request),
      () => undefined,
      { always, sessions },
    );
    const pending = broker.request({
      runId: "run-one-shot",
      scopeKey: identity.scope_key,
      lifecycleId: identity.lifecycle_id,
      sessionId: identity.session_id,
      toolName: "process",
      approvalKey,
      displayArguments: { action: "write", arguments: { process_id: "shell", input: "printf ok" } },
      reason: "write process input",
      allowSession: false,
      allowPermanent: false,
    });
    const request = await waitForRequest(requests);
    assert.equal(request.allow_session, false);
    assert.equal(request.allow_permanent, false);
    await assert.rejects(broker.respond(request.run_id, request.id, "session"), /Session approval is not allowed/);
    await assert.rejects(broker.respond(request.run_id, request.id, "always"), /Permanent approval is not allowed/);
    await broker.respond(request.run_id, request.id, "once");
    assert.deepEqual(await pending, { allowed: true, outcome: "approved" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("always and session approvals survive broker restart and cleanup clears session grants", async () => {
  const home = await temporaryDirectory("agent-approval-persistence-");
  try {
    const persistence = () => ({ always: new AlwaysApprovalStore(home), sessions: new SessionStore(home) });
    const context = {
      runId: "run-one",
      scopeKey: "scope",
      lifecycleId: "life",
      sessionId: "session",
      toolName: "terminal",
      approvalKey: "v2:terminal:rm-stale",
      displayArguments: { command: "rm stale.txt" },
      reason: "sensitive command",
    };

    const alwaysRequests: ApprovalRequest[] = [];
    const first = new ApprovalBroker(1_000, (request) => alwaysRequests.push(request), () => undefined, persistence());
    const alwaysPending = first.request(context);
    await first.respond("run-one", (await waitForRequest(alwaysRequests)).id, "always");
    assert.deepEqual(await alwaysPending, { allowed: true, outcome: "approved" });
    assert.equal(first.hasPersistentAlways("scope", context.approvalKey), true);
    const alwaysFile = await stat(`${home}/approvals/always.json`);
    assert.equal(alwaysFile.mode & 0o777, 0o600);

    const restartedAlwaysRequests: ApprovalRequest[] = [];
    const restartedAlways = new ApprovalBroker(1_000, (request) => restartedAlwaysRequests.push(request), () => undefined, persistence());
    assert.deepEqual(await restartedAlways.request({ ...context, runId: "run-two" }), { allowed: true, outcome: "approved" });
    assert.equal(restartedAlwaysRequests.length, 0);

    const sessionContext = {
      ...context,
      toolName: "process",
      approvalKey: "v2:process:write-one",
      displayArguments: { action: "write", resource: "process-one" },
      runId: "run-session-one",
    };
    const sessionRequests: ApprovalRequest[] = [];
    const sessionBroker = new ApprovalBroker(1_000, (request) => sessionRequests.push(request), () => undefined, persistence());
    const sessionPending = sessionBroker.request(sessionContext);
    await sessionBroker.respond(sessionContext.runId, (await waitForRequest(sessionRequests)).id, "session");
    assert.deepEqual(await sessionPending, { allowed: true, outcome: "approved" });
    assert.equal(sessionBroker.hasPersistentAlways("scope", sessionContext.approvalKey), false);
    const sessionFile = await stat(`${home}/sessions/${hash("scope")}/${hash("life")}/approvals.jsonl`);
    assert.equal(sessionFile.mode & 0o777, 0o600);

    const restartedSession = new ApprovalBroker(1_000, () => assert.fail("persisted session grant should not prompt"), () => undefined, persistence());
    assert.deepEqual(await restartedSession.request({ ...sessionContext, runId: "run-session-two" }), { allowed: true, outcome: "approved" });
    await restartedSession.clearScope("scope", "life");

    const afterCleanupRequests: ApprovalRequest[] = [];
    const afterCleanup = new ApprovalBroker(1_000, (request) => afterCleanupRequests.push(request), () => undefined, persistence());
    const afterCleanupPending = afterCleanup.request({ ...sessionContext, runId: "run-session-three" });
    await waitForRequest(afterCleanupRequests);
    afterCleanup.cancelRun("run-session-three");
    assert.deepEqual(await afterCleanupPending, { allowed: false, outcome: "cancelled" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cleanup waits for an earlier session grant commit and prevents it from reappearing", async () => {
  const home = await temporaryDirectory("agent-approval-cleanup-race-");
  try {
    let markAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    const allowAppend = new Promise<void>((resolve) => { releaseAppend = resolve; });
    class DelayedSessionStore extends SessionStore {
      override async appendSessionApproval(
        identity: SessionIdentity,
        approvalKey: string,
        toolName: string,
      ): Promise<void> {
        markAppendStarted();
        await allowAppend;
        await super.appendSessionApproval(identity, approvalKey, toolName);
      }
    }
    const sessions = new DelayedSessionStore(home);
    const requests: ApprovalRequest[] = [];
    const broker = new ApprovalBroker(
      1_000,
      (request) => requests.push(request),
      () => undefined,
      { always: new AlwaysApprovalStore(home), sessions },
    );
    const context = {
      runId: "run-racing-grant",
      scopeKey: "scope",
      lifecycleId: "life",
      sessionId: "session",
      toolName: "terminal",
      approvalKey: "v2:terminal:racing-grant",
      displayArguments: { command: "date" },
      reason: "host command",
    };
    const identity = {
      scope_key: context.scopeKey,
      lifecycle_id: context.lifecycleId,
      session_id: context.sessionId,
    };
    const pending = broker.request(context);
    const response = broker.respond(context.runId, (await waitForRequest(requests)).id, "session");
    await appendStarted;
    const cleanup = broker.clearScope(context.scopeKey, context.lifecycleId);

    releaseAppend();
    await response;
    assert.deepEqual(await pending, { allowed: true, outcome: "approved" });
    await cleanup;
    assert.equal(await sessions.hasSessionApproval(identity, context.approvalKey), false);

    const afterCleanup = broker.request({ ...context, runId: "run-after-racing-grant" });
    await waitForRequest(requests, 1);
    broker.cancelRun("run-after-racing-grant");
    assert.deepEqual(await afterCleanup, { allowed: false, outcome: "cancelled" });
    const restarted = new SessionStore(home);
    assert.equal(await restarted.hasSessionApproval(identity, context.approvalKey), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cleanup waits for an earlier durable lookup and does not allow a stale grant to reappear", async () => {
  const home = await temporaryDirectory("agent-approval-lookup-cleanup-race-");
  try {
    let markLookupStarted!: () => void;
    let releaseLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
    const allowLookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
    class DelayedLookupSessionStore extends SessionStore {
      private delayNextLookup = true;

      override async hasSessionApproval(identity: SessionIdentity, approvalKey: string): Promise<boolean> {
        const persisted = await super.hasSessionApproval(identity, approvalKey);
        if (this.delayNextLookup) {
          this.delayNextLookup = false;
          markLookupStarted();
          await allowLookup;
        }
        return persisted;
      }
    }
    const sessions = new DelayedLookupSessionStore(home);
    const identity = { scope_key: "scope", lifecycle_id: "life", session_id: "session" };
    const approvalKey = "v2:terminal:durable-lookup-race";
    await sessions.appendSessionApproval(identity, approvalKey, "terminal");
    const requests: ApprovalRequest[] = [];
    const broker = new ApprovalBroker(
      1_000,
      (request) => requests.push(request),
      () => undefined,
      { always: new AlwaysApprovalStore(home), sessions },
    );
    const context = {
      runId: "run-durable-lookup",
      scopeKey: identity.scope_key,
      lifecycleId: identity.lifecycle_id,
      sessionId: identity.session_id,
      toolName: "terminal",
      approvalKey,
      displayArguments: { command: "date" },
      reason: "host command",
    };
    const lookup = broker.request(context);
    await lookupStarted;
    const cleanup = broker.clearScope(identity.scope_key, identity.lifecycle_id);

    releaseLookup();
    assert.deepEqual(await lookup, { allowed: true, outcome: "approved" });
    await cleanup;
    assert.equal(await sessions.hasSessionApproval(identity, approvalKey), false);

    const afterCleanup = broker.request({ ...context, runId: "run-after-durable-lookup-cleanup" });
    await waitForRequest(requests);
    broker.cancelRun("run-after-durable-lookup-cleanup");
    assert.deepEqual(await afterCleanup, { allowed: false, outcome: "cancelled" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("session grant persistence failure denies and reports notification failure", async () => {
  const home = await temporaryDirectory("agent-approval-persistence-failure-");
  try {
    class FailingSessionStore extends SessionStore {
      override async appendSessionApproval(): Promise<void> {
        throw new Error("approval journal unavailable");
      }
    }
    const requests: ApprovalRequest[] = [];
    const resolutions: string[] = [];
    const broker = new ApprovalBroker(
      1_000,
      (request) => requests.push(request),
      (_request, resolution) => resolutions.push(resolution),
      { always: new AlwaysApprovalStore(home), sessions: new FailingSessionStore(home) },
    );
    const context = {
      runId: "run-persistence-failure",
      scopeKey: "scope",
      lifecycleId: "life",
      sessionId: "session",
      toolName: "terminal",
      approvalKey: "v2:terminal:persistence-failure",
      displayArguments: { command: "date" },
      reason: "host command",
    };
    const pending = broker.request(context);
    await assert.rejects(
      broker.respond(context.runId, (await waitForRequest(requests)).id, "session"),
      /approval journal unavailable/,
    );
    assert.deepEqual(await pending, { allowed: false, outcome: "notification_failed" });
    assert.deepEqual(resolutions, ["notification_failed"]);

    const retry = broker.request({ ...context, runId: "run-after-persistence-failure" });
    await waitForRequest(requests, 1);
    broker.cancelRun("run-after-persistence-failure");
    assert.deepEqual(await retry, { allowed: false, outcome: "cancelled" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function waitForRequest(requests: ApprovalRequest[], index = 0): Promise<ApprovalRequest> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (requests[index]) return requests[index];
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for approval request");
}

function hash(value: string): string {
  // Keep the test independent of SessionStore internals beyond its documented SHA-256 layout.
  return createHash("sha256").update(value).digest("hex");
}

test("ApprovalBroker cancels pending run approvals", async () => {
  const requests: ApprovalRequest[] = [];
  const broker = new ApprovalBroker(1_000, (request) => requests.push(request), () => undefined);
  const result = broker.request({
    runId: "run-one",
    scopeKey: "scope",
    sessionId: "session",
    toolName: "write_file",
    approvalKey: "v2:write_file:path",
    displayArguments: { path: "/tmp/file" },
    reason: "write",
  });
  broker.cancelRun("run-one");
  assert.deepEqual(await result, { allowed: false, outcome: "cancelled" });
});

test("ApprovalBroker timeout resolves fail-closed and emits a resolved event", async () => {
  const requests: ApprovalRequest[] = [];
  const resolutions: string[] = [];
  const broker = new ApprovalBroker(
    5,
    (request) => requests.push(request),
    (_request, resolution) => resolutions.push(resolution),
  );
  const result = await broker.request({
    runId: "run-timeout",
    scopeKey: "scope",
    sessionId: "session",
    toolName: "terminal",
    approvalKey: "v2:terminal:timeout",
    displayArguments: { command: "sleep 1" },
    reason: "host command",
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(result, { allowed: false, outcome: "timeout" });
  assert.deepEqual(resolutions, ["timeout"]);
});

test("invalid broad always grants are discarded instead of authorizing current objects", async () => {
  const home = await temporaryDirectory("agent-approval-invalid-");
  try {
    const directory = `${home}/approvals`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/always.json`, JSON.stringify({
      version: 999,
      grants: [{ scope_key: "scope", tool_name: "terminal", created_at: new Date().toISOString() }],
    }), "utf8");
    const store = new AlwaysApprovalStore(home);
    assert.equal(store.has("scope", "v2:terminal:specific"), false);
    const persisted = JSON.parse(await readFile(`${directory}/always.json`, "utf8")) as { version: number; grants: unknown[] };
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.grants, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
