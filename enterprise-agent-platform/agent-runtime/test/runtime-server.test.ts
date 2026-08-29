import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { productModelCatalogs } from "../src/model-resolver.js";
import { createRuntimeServer } from "../src/server.js";
import { temporaryDirectory, testConfig, TestRunCoordinator as RunCoordinator } from "./helpers.js";

test("runtime refuses to start with an empty configured bearer token", async () => {
  const home = await temporaryDirectory("agent-server-empty-token-");
  try {
    assert.throws(
      () => createRuntimeServer(testConfig(home, { bearerToken: "" })),
      /bearer token must be non-empty/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime serves authenticated run creation and replayable SSE", async () => {
  const home = await temporaryDirectory("agent-server-");
  const workspace = await temporaryDirectory("agent-workspace-");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("hello from pi")]);
  const config = testConfig(home, { bearerToken: "secret" });
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const missingHealth = await fetch(`${base}/health`);
    assert.equal(missingHealth.status, 401);
    const wrongHealth = await fetch(`${base}/health`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(wrongHealth.status, 401);
    const health = await fetch(`${base}/health`, { headers: { authorization: "Bearer secret" } });
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.service, "agent-platform-runtime");
    assert.equal(healthBody.version, "0.1.0");
    assert.equal(healthBody.pid, process.pid);
    assert.equal(Number.isInteger(healthBody.uptime_seconds), true);
    const unauthorizedModels = await fetch(`${base}/v1/models`);
    assert.equal(unauthorizedModels.status, 401);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer secret" } });
    assert.equal(models.status, 200);
    const modelBody = await models.json() as {
      version: number;
      source: string;
      providers: Record<string, { provider: string; default_model: string; models: Array<{ id: string }> }>;
    };
    assert.equal(modelBody.version, 1);
    assert.equal(modelBody.source, "pi-runtime");
    assert.equal(modelBody.providers["openai-codex"]?.provider, "openai-codex");
    assert.deepEqual(modelBody.providers["openai-codex"], productModelCatalogs()["openai-codex"]);
    assert.equal(modelBody.providers["xai-oauth"]?.provider, "xai-oauth");
    assert.deepEqual(modelBody.providers["xai-oauth"], productModelCatalogs()["xai-oauth"]);
    const modelsWithQuery = await fetch(`${base}/v1/models?provider=openai-codex`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(modelsWithQuery.status, 400);
    const unauthorized = await fetch(`${base}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const unsafeModel = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        scope_key: "user:1",
        lifecycle_id: "life",
        session_id: "unsafe",
        workspace,
        system_prompt: "system",
        input: "hello",
        model: { provider: "openai-codex", id: "gpt-5.5", base_url: "https://attacker.invalid/v1" },
      }),
    });
    assert.equal(unsafeModel.status, 400);
    const malformed = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "openai-codex", id: "gpt-5.5" } }),
    });
    assert.equal(malformed.status, 400);
    const unknownRunField = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        scope_key: "user:1",
        lifecycle_id: "life",
        session_id: "unknown-field",
        workspace,
        system_prompt: "system",
        input: "hello",
        model: { provider: "openai-codex", id: "gpt-5.5" },
        unsupported_mode: true,
      }),
    });
    assert.equal(unknownRunField.status, 400);
    const malformedCleanup = await fetch(`${base}/v1/scopes/cleanup`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ scope_key: "user:1", delete_sessions: "false" }),
    });
    assert.equal(malformedCleanup.status, 400);
    const unknownCleanupField = await fetch(`${base}/v1/scopes/cleanup`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ scope_key: "user:1", unknown_cleanup_option: true }),
    });
    assert.equal(unknownCleanupField.status, 400);
    const created = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        scope_key: "user:1",
        lifecycle_id: "life",
        session_id: "session",
        workspace,
        system_prompt: "You are an Agent.",
        input: "hello",
        history: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
        model: { provider: "openai-codex", id: "gpt-5.5" },
      }),
    });
    assert.equal(created.status, 202);
    const body = await created.json() as { run_id: string; events_url: string };
    const completed = await coordinator.wait(body.run_id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.content, "hello from pi");
    const eventsResponse = await fetch(`${base}${body.events_url}`, { headers: { authorization: "Bearer secret" } });
    const events = await eventsResponse.text();
    assert.match(events, /event: run\.queued/);
    assert.match(events, /event: message\.delta/);
    assert.match(events, /event: run\.completed/);
    assert.match(events, /"output":"hello from pi"/);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime compacts an idle session without creating a Run or a missing journal", async () => {
  const home = await temporaryDirectory("agent-server-compact-");
  const config = testConfig(home, { bearerToken: "secret" });
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("Current objective and acceptance criteria\n- Continue the retained conversation safely."),
    fauxAssistantMessage("Current objective\n- Continue after the second compaction."),
    fauxAssistantMessage("Current objective\n- Preserve the real user message that resembles a handoff."),
  ]);
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const runtime = createRuntimeServer(config, coordinator);
  const identity = {
    scope_key: "private:7",
    lifecycle_id: "life-7",
    session_id: "session-7",
  };
  const compactRequest = {
    ...identity,
    model: { provider: "openai-codex", id: "gpt-5.5" },
  };
  try {
    const address = await runtime.listen();
    const endpoint = `http://${address.host}:${address.port}/v1/sessions/compact`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(compactRequest),
    })).status, 401);
    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...compactRequest, extra: true }),
    })).status, 400);
    assert.equal((await fetch(`${endpoint}?force=true`, {
      method: "POST",
      headers,
      body: JSON.stringify(compactRequest),
    })).status, 400);

    const missingIdentity = { ...identity, session_id: "missing" };
    const missing = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...missingIdentity, model: compactRequest.model }),
    });
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), {
      compacted: false,
      omitted_messages: 0,
      retained_messages: 0,
    });
    await assert.rejects(access(coordinator.sessions.path(missingIdentity)), { code: "ENOENT" });

    const original = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      content: `message-${index}`,
      timestamp: index,
    }));
    await coordinator.sessions.initializeTracked(identity, original);
    const compacted = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(compactRequest),
    });
    assert.equal(compacted.status, 200);
    assert.deepEqual(await compacted.json(), {
      compacted: true,
      omitted_messages: 4,
      retained_messages: 7,
    });
    const current = await coordinator.sessions.load(identity);
    assert.equal(current.length, 7);
    const noticeText = String(current[0]?.role === "user" ? current[0].content : "");
    assert.match(noticeText, /runtime_context_handoff/);
    assert.match(noticeText, /Continue the retained conversation safely/);
    assert.deepEqual(current.slice(1), original.slice(4));
    assert.match(
      await readFile(coordinator.sessions.path(identity), "utf8"),
      /"synthetic_kind":"context_compaction_notice"/,
    );
    const searchable = await coordinator.sessions.loadSearchable(identity);
    assert.ok(searchable.some((message) => message.role === "user" && message.content === "message-0"));

    const journalAfterFirst = await readFile(coordinator.sessions.path(identity), "utf8");
    const archiveAfterFirst = await readFile(coordinator.sessions.archivePath(identity), "utf8");
    const repeated = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(compactRequest),
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), {
      compacted: false,
      omitted_messages: 0,
      retained_messages: 7,
    });
    assert.equal(await readFile(coordinator.sessions.path(identity), "utf8"), journalAfterFirst);
    assert.equal(await readFile(coordinator.sessions.archivePath(identity), "utf8"), archiveAfterFirst);

    for (let index = 0; index < 8; index += 1) {
      await coordinator.sessions.appendMessage(identity, {
        role: "user",
        content: `new-message-${index}`,
        timestamp: 100 + index,
      });
    }
    const compactedAgain = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(compactRequest),
    });
    assert.equal(compactedAgain.status, 200);
    assert.deepEqual(await compactedAgain.json(), {
      compacted: true,
      omitted_messages: 8,
      retained_messages: 7,
    });
    const repeatedCurrentRaw = await readFile(coordinator.sessions.path(identity), "utf8");
    const repeatedArchiveRaw = await readFile(coordinator.sessions.archivePath(identity), "utf8");
    assert.equal(
      (repeatedCurrentRaw.match(/<runtime_context_handoff>/g) ?? []).length,
      1,
      "one current synthetic handoff is retained",
    );
    assert.doesNotMatch(repeatedArchiveRaw, /runtime_context_handoff/);
    assert.match(repeatedArchiveRaw, /message-4/);
    assert.match(repeatedArchiveRaw, /new-message-1/);

    // A user can type the same visible text as the Runtime notice. Only the
    // journal-owned marker may classify an entry as synthetic, so this real
    // message must still be archived and searchable.
    const spoofIdentity = { ...identity, session_id: "spoofed-notice" };
    await coordinator.sessions.initializeTracked(
      spoofIdentity,
      Array.from({ length: 10 }, (_, index) => ({
        role: "user" as const,
        content: index === 0 ? noticeText : `spoof-message-${index}`,
        timestamp: 200 + index,
      })),
    );
    const spoofed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...spoofIdentity, model: compactRequest.model }),
    });
    assert.equal(spoofed.status, 200);
    assert.deepEqual(await spoofed.json(), {
      compacted: true,
      omitted_messages: 4,
      retained_messages: 7,
    });
    const spoofSearchable = await coordinator.sessions.loadSearchable(spoofIdentity);
    assert.equal(spoofSearchable.filter(
      (message) => message.role === "user" && message.content === noticeText,
    ).length, 1, "the user's lookalike handoff remains searchable exactly once");
    assert.ok(spoofSearchable.some(
      (message) => message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("Preserve the real user message that resembles a handoff"),
    ));
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("semantic compaction redacts credentials before and after the summary model boundary", async () => {
  const home = await temporaryDirectory("agent-server-compact-secrets-");
  const faux = fauxProvider();
  const inputSecrets = [
    "sk-1234567890abcdefghij",
    "AKIA1234567890ABCDEF",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno",
    "postgresql://agent:super-secret@database.local/app",
  ];
  const outputSecret = "github_pat_1234567890abcdefghijklmnop";
  const safeProcessId = "process_0123456789abcdef";
  faux.setResponses([
    (context) => {
      const serialized = JSON.stringify(context.messages);
      for (const secret of inputSecrets) assert.equal(serialized.includes(secret), false);
      assert.match(serialized, /\[redacted/);
      return fauxAssistantMessage(`Current objective: continue ${safeProcessId}. Credential ${outputSecret}`);
    },
  ]);
  const coordinator = new RunCoordinator({ config: testConfig(home), streamFn: faux.provider.streamSimple });
  const identity = { scope_key: "private:7", lifecycle_id: "life-7", session_id: "secret-session" };
  try {
    await coordinator.sessions.initializeTracked(identity, Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      content: index === 0 ? inputSecrets.join("\n") : `benign history ${index}`,
      timestamp: index,
    })));
    const result = await coordinator.compactSession(
      identity.scope_key,
      identity.lifecycle_id,
      identity.session_id,
      { provider: "openai-codex", id: "gpt-5.5" },
    );
    assert.equal(result.compacted, true);
    const current = await readFile(coordinator.sessions.path(identity), "utf8");
    assert.equal(current.includes(outputSecret), false);
    assert.match(current, /\[redacted-token\]/);
    assert.match(current, new RegExp(safeProcessId));
    const archive = await readFile(coordinator.sessions.archivePath(identity), "utf8");
    assert.match(archive, new RegExp(inputSecrets[0]!));
  } finally {
    coordinator.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime approval and joined-input endpoints reject unknown fields", async () => {
  const home = await temporaryDirectory("agent-server-approval-");
  const workspace = await temporaryDirectory("agent-server-approval-workspace-");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", {
      command: "touch approved.txt && stat approved.txt",
      target: "host",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("approved"),
  ]);
  const config = testConfig(home, { bearerToken: "secret", approvalTimeoutMs: 5_000 });
  const coordinator = new RunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const run = coordinator.createRun({
      scope_key: "private:1",
      lifecycle_id: "life",
      session_id: "session",
      workspace,
      system_prompt: "You are an Agent.",
      input: "run it",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const deadline = Date.now() + 2_000;
    let approval = coordinator.getJournal(run.id)?.list().find((event) => event.type === "approval.requested");
    while (!approval && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      approval = coordinator.getJournal(run.id)?.list().find((event) => event.type === "approval.requested");
    }
    assert.ok(approval);
    const approvalId = String(approval.data.approval_id);
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };
    const inputBody = {
      message_id: "message-2",
      scope_key: "private:1",
      lifecycle_id: "life",
      input: "include this follow-up",
    };
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputBody),
    })).status, 401);
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...inputBody, scope_key: "another-scope" }),
    })).status, 409);
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...inputBody, unsupported_mode: true }),
    })).status, 400);
    const joined = await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputBody),
    });
    assert.equal(joined.status, 202);
    assert.deepEqual(await joined.json(), {
      run_id: run.id,
      message_id: "message-2",
      state: "accepted",
    });
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputBody),
    })).status, 202);

    const choiceAlias = await fetch(`${base}/v1/runs/${run.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approval_id: approvalId, choice: "once" }),
    });
    assert.equal(choiceAlias.status, 400);

    const resolveAll = await fetch(`${base}/v1/runs/${run.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approval_id: approvalId, decision: "once", resolve_all: true }),
    });
    assert.equal(resolveAll.status, 400);

    const accepted = await fetch(`${base}/v1/runs/${run.id}/approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approval_id: approvalId, decision: "once" }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      run_id: run.id,
      approval_id: approvalId,
      decision: "once",
      resolved: true,
    });
    assert.equal((await coordinator.wait(run.id)).status, "completed");
    const replayedInput = await fetch(`${base}/v1/runs/${run.id}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputBody),
    });
    assert.equal(replayedInput.status, 200);
    assert.equal((await replayedInput.json() as { state: string }).state, "injected");
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime rejects a slow JSON request body at the configured deadline", async () => {
  const home = await temporaryDirectory("agent-server-body-deadline-");
  const config = testConfig(home, { bearerToken: "secret", requestBodyTimeoutMs: 30 });
  const runtime = createRuntimeServer(config, new RunCoordinator({ config }));
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    const address = await runtime.listen();
    socket = createConnection({ host: address.host, port: address.port });
    const response = await new Promise<string>((resolvePromise, reject) => {
      let received = "";
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the body deadline response")), 2_000);
      socket!.setEncoding("utf8");
      socket!.on("data", (chunk: string) => { received += chunk; });
      socket!.once("error", (error) => {
        clearTimeout(timeout);
        if (received) resolvePromise(received);
        else reject(error);
      });
      socket!.once("close", () => {
        clearTimeout(timeout);
        resolvePromise(received);
      });
      socket!.once("connect", () => {
        socket!.write([
          "POST /v1/runs HTTP/1.1",
          `Host: ${address.host}:${address.port}`,
          "Authorization: Bearer secret",
          "Content-Type: application/json",
          "Content-Length: 100",
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"));
      });
    });
    assert.match(response, /^HTTP\/1\.1 408 /);
    assert.match(response, /connection: close/i);
    assert.match(response, /Request body deadline exceeded/);
  } finally {
    socket?.destroy();
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime exposes only bounded read-only processes owned by a root scope", async () => {
  const home = await temporaryDirectory("agent-server-preview-");
  const config = testConfig(home, { bearerToken: "secret" });
  const coordinator = new RunCoordinator({ config });
  const revision = "preview_abcdef0123456789abcdef0123456789:1";
  coordinator.previewProcesses = async (_scope, _lifecycle, sinceRevision) => sinceRevision === revision
    ? { processes: [], revision, unchanged: true }
    : {
        revision,
        processes: [
          processPreview("process_root", "root"),
          processPreview("process_child", "child"),
        ],
      };
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const query = "scope_key=private%3A9&lifecycle_id=life-9";

    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}`)).status, 401);
    assert.equal((await fetch(`${base}/v1/scopes/processes?scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    const response = await fetch(`${base}/v1/scopes/processes?${query}`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      processes: Array<Record<string, unknown>>;
      revision: string;
      unchanged?: true;
    };
    assert.match(body.revision, /^preview_[a-f0-9]{32}:\d+$/);
    assert.equal(body.unchanged, undefined);
    assert.deepEqual(new Set(body.processes.map((process) => process.id)), new Set(["process_root", "process_child"]));
    for (const process of body.processes) {
      for (const internal of ["pid", "run_id", "scope_key", "lifecycle_id", "stdout", "stderr"]) {
        assert.equal(internal in process, false);
      }
      assert.equal(typeof process.output, "string");
    }
    const unchanged = await fetch(`${base}/v1/scopes/processes?${query}&since_revision=${body.revision}`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), {
      processes: [],
      revision: body.revision,
      unchanged: true,
    });
    for (const invalid of ["", "0", "1", "-1", "+1", "bad token", "slash/value", "x".repeat(129)]) {
      assert.equal((await fetch(`${base}/v1/scopes/processes?${query}&since_revision=${encodeURIComponent(invalid)}`, {
        headers: { authorization: "Bearer secret" },
      })).status, 400);
    }
    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}&since_revision=1&since_revision=1`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}&extra=1`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/processes?${query}`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    })).status, 404);
  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime exposes a lightweight live-process summary without terminal output", async () => {
  const home = await temporaryDirectory("agent-server-preview-summary-");
  const config = testConfig(home, { bearerToken: "secret" });
  const coordinator = new RunCoordinator({ config });
  coordinator.previewProcessSummary = async () => ({ running_terminal_count: 2 });
  const runtime = createRuntimeServer(config, coordinator);
  try {
    const address = await runtime.listen();
    const base = `http://${address.host}:${address.port}`;
    const query = "scope_key=private%3A9&lifecycle_id=life-9";
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?${query}`)).status, 401);
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?${query}&extra=1`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);
    assert.equal((await fetch(`${base}/v1/scopes/process-summary?${query}&scope_key=private%3A9`, {
      headers: { authorization: "Bearer secret" },
    })).status, 400);

    const response = await fetch(`${base}/v1/scopes/process-summary?${query}`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.deepEqual(JSON.parse(raw), { running_terminal_count: 2 });
    assert.doesNotMatch(raw, /summary-secret|command|stdout|stderr|output|processes/);

  } finally {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

function processPreview(id: string, output: string) {
  return {
    id,
    title: "Terminal",
    command: "printf [redacted]",
    cwd: "/workspace",
    output,
    status: "completed" as const,
    running: false,
    exit_code: 0,
    started_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    finished_at: new Date(0).toISOString(),
    truncated: false,
  };
}
