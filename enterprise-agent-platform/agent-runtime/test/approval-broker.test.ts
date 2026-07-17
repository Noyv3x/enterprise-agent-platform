import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import test from "node:test";
import { ApprovalBroker } from "../src/approval-broker.js";
import { AlwaysApprovalStore } from "../src/persistence.js";
import { SessionStore } from "../src/session-store.js";
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
    arguments: { command: "date" },
    reason: "host command",
  };
  const first = broker.request(context);
  assert.equal(requests.length, 1);
  await broker.respond("run-one", requests[0]!.id, "session");
  assert.equal(await first, true);
  assert.equal(await broker.request({ ...context, runId: "run-two" }), true);
  assert.equal(requests.length, 1);
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
      arguments: { command: "rm stale.txt" },
      reason: "sensitive command",
    };

    const alwaysRequests: ApprovalRequest[] = [];
    const first = new ApprovalBroker(1_000, (request) => alwaysRequests.push(request), () => undefined, persistence());
    const alwaysPending = first.request(context);
    await first.respond("run-one", (await waitForRequest(alwaysRequests)).id, "always");
    assert.equal(await alwaysPending, true);
    assert.equal(first.hasPersistentAlways("scope", "terminal"), true);
    const alwaysFile = await stat(`${home}/approvals/always.json`);
    assert.equal(alwaysFile.mode & 0o777, 0o600);

    const restartedAlwaysRequests: ApprovalRequest[] = [];
    const restartedAlways = new ApprovalBroker(1_000, (request) => restartedAlwaysRequests.push(request), () => undefined, persistence());
    assert.equal(await restartedAlways.request({ ...context, runId: "run-two" }), true);
    assert.equal(restartedAlwaysRequests.length, 0);

    const sessionContext = { ...context, toolName: "process", runId: "run-session-one" };
    const sessionRequests: ApprovalRequest[] = [];
    const sessionBroker = new ApprovalBroker(1_000, (request) => sessionRequests.push(request), () => undefined, persistence());
    const sessionPending = sessionBroker.request(sessionContext);
    await sessionBroker.respond(sessionContext.runId, (await waitForRequest(sessionRequests)).id, "session");
    assert.equal(await sessionPending, true);
    assert.equal(sessionBroker.hasPersistentAlways("scope", "process"), false);
    const sessionFile = await stat(`${home}/sessions/${hash("scope")}/${hash("life")}/approvals.jsonl`);
    assert.equal(sessionFile.mode & 0o777, 0o600);

    const restartedSession = new ApprovalBroker(1_000, () => assert.fail("persisted session grant should not prompt"), () => undefined, persistence());
    assert.equal(await restartedSession.request({ ...sessionContext, runId: "run-session-two" }), true);
    await restartedSession.clearScope("scope", "life");

    const afterCleanupRequests: ApprovalRequest[] = [];
    const afterCleanup = new ApprovalBroker(1_000, (request) => afterCleanupRequests.push(request), () => undefined, persistence());
    const afterCleanupPending = afterCleanup.request({ ...sessionContext, runId: "run-session-three" });
    await waitForRequest(afterCleanupRequests);
    afterCleanup.cancelRun("run-session-three");
    assert.equal(await afterCleanupPending, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function waitForRequest(requests: ApprovalRequest[]): Promise<ApprovalRequest> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (requests[0]) return requests[0];
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
    arguments: {},
    reason: "write",
  });
  broker.cancelRun("run-one");
  assert.equal(await result, false);
});
