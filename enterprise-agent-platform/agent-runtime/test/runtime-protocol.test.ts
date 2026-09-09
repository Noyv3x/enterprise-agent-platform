import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRuntimeServer, type RuntimeServer } from "../src/server.js";
import type { SessionIdentity } from "../src/session-store.js";
import { fakeExecutionManager, temporaryDirectory, testConfig, TestRunCoordinator } from "./helpers.js";

function event() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function deadline<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  // Real socket/model deadlines must remain live; fake time cannot drive TCP I/O.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture() {
  const home = await temporaryDirectory("runtime-protocol-");
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("controlled response")));
  const config = testConfig(home);
  const coordinator = new TestRunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const runtime = createRuntimeServer(config, coordinator);
  const address = await runtime.listen();
  const base = `http://${address.host}:${address.port}`;
  const headers = { authorization: `Bearer ${config.bearerToken}`, "content-type": "application/json" };
  const body = (session = "session") => ({
    scope_key: "private:protocol", lifecycle_id: "life", session_id: session,
    workspace: home, system_prompt: "Answer directly.", input: "hello",
    model: { provider: "openai-codex", id: "gpt-5.5" },
  });
  async function close() {
    runtime.server.closeAllConnections();
    await deadline(runtime.close(), "server close");
    await rm(home, { recursive: true, force: true });
  }
  async function request(path: string, method = "GET", value?: unknown, extraHeaders = {}) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...headers, ...extraHeaders },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return { status: response.status, text };
  }
  return { home, faux, config, coordinator, runtime, address, base, headers, body, request, close };
}

test("closed-world HTTP contracts reject before run/cancel/subscription effects", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  try {
    const positive = await f.request("/v1/runs", "POST", f.body());
    assert.equal(positive.status, 202);
    const created: unknown = JSON.parse(positive.text);
    assert.ok(created && typeof created === "object" && "run_id" in created && typeof created.run_id === "string");
    const id = created.run_id;
    assert.equal((await deadline(f.coordinator.wait(id), "positive run")).status, "completed");
    assert.equal((await f.request(`/v1/runs/${id}`)).status, 200);
    const replay = await f.request(`/v1/runs/${id}/events?after=0`);
    assert.equal(replay.status, 200);
    assert.match(replay.text, /event: run.completed/);

    let creates = 0;
    let cancels = 0;
    let subscriptions = 0;
    const create = f.coordinator.createRun.bind(f.coordinator);
    const cancel = f.coordinator.cancel.bind(f.coordinator);
    f.coordinator.createRun = (...args) => { creates++; return create(...args); };
    f.coordinator.cancel = (...args) => { cancels++; return cancel(...args); };
    const journal = f.coordinator.getJournal(id)!;
    const subscribe = journal.subscribe.bind(journal);
    journal.subscribe = (...args) => { subscriptions++; return subscribe(...args); };
    const cases: Array<{ name: string; path: string; method?: string; body?: unknown; headers?: Record<string, string>; status: number }> = [
      { name: "POST run unknown query", path: "/v1/runs?unknown=1", method: "POST", body: f.body("unknown-query"), status: 400 },
      { name: "cancel unknown body", path: `/v1/runs/${id}/cancel`, method: "POST", body: { unknown: true }, status: 400 },
      { name: "GET run unknown query", path: `/v1/runs/${id}?unknown=1`, status: 400 },
      { name: "events unknown query", path: `/v1/runs/${id}/events?unknown=1`, status: 400 },
      { name: "events malformed query cursor", path: `/v1/runs/${id}/events?after=12garbage`, status: 400 },
      { name: "events malformed header cursor", path: `/v1/runs/${id}/events`, headers: { "last-event-id": "12garbage" }, status: 400 },
      ...["-1", "9007199254740992", "", "1&after=2"].map((cursor) => ({ name: `invalid cursor ${cursor}`, path: `/v1/runs/${id}/events?after=${cursor}`, status: 400 })),
      { name: "unsupported run method", path: `/v1/runs/${id}`, method: "PUT", status: 404 },
      { name: "unsupported events method", path: `/v1/runs/${id}/events`, method: "POST", status: 404 },
    ];
    for (const c of cases) await t.test(c.name, async () => {
      const before = { creates, cancels, subscriptions };
      const result = await f.request(c.path, c.method, c.body, c.headers);
      t.diagnostic(JSON.stringify({ case: c.name, status: result.status, effects: { creates: creates - before.creates, cancels: cancels - before.cancels, subscriptions: subscriptions - before.subscriptions } }));
      assert.deepEqual({ creates, cancels, subscriptions }, before, "invalid request must not dispatch side effects");
      assert.equal(result.status, c.status);
    });
    assert.equal((await f.request(`/v1/runs/${id}/cancel`, "POST", {})).status, 202);
    assert.equal((await f.request(`/v1/runs/${id}/cancel`, "POST")).status, 202);
    const events = journal.list();
    const last = events.at(-1)!.sequence;
    for (const [query, header] of [[last - 1, 0], [0, last - 1]]) {
      const resumed = await f.request(`/v1/runs/${id}/events?after=${query}`, "GET", undefined, { "last-event-id": String(header) });
      assert.equal(resumed.status, 200);
      assert.deepEqual([...resumed.text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])), [last]);
    }
    const exhausted = await f.request(`/v1/runs/${id}/events?after=${last}`);
    assert.equal(exhausted.status, 200);
    assert.doesNotMatch(exhausted.text, /^data:/m);
  } finally { await f.close(); }
});

test("large retained SSE frames replay completely before terminal close", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const entered = event();
  const release = event();
  let runId: string | undefined;
  try {
    f.faux.setResponses([async () => {
      entered.release();
      await release.promise;
      return fauxAssistantMessage("complete");
    }]);
    const run = f.coordinator.createRun(f.body("large-replay"));
    runId = run.id;
    await deadline(entered.promise, "model entered");
    const text = "large-frame-".repeat(48 * 1024);
    const large = f.coordinator.getJournal(run.id)!.publish("message.delta", { text });
    release.release();
    assert.equal((await deadline(f.coordinator.wait(run.id), "run completed")).status, "completed");
    const replay = await f.request(`/v1/runs/${run.id}/events?after=${large.sequence - 1}`);
    assert.equal(replay.status, 200);
    const frames = [...replay.text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!));
    assert.equal(frames[0].sequence, large.sequence);
    assert.equal(frames[0].data.text, text);
    assert.equal(frames.at(-1).type, "run.completed");
  } finally {
    release.release();
    if (runId) await deadline(f.coordinator.wait(runId), "released model settled");
    await f.close();
  }
});

test("paused SSE reader has a bounded network queue while another client and Agent progress", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  const gate = event();
  const entered = event();
  const sockets: Socket[] = [];
  let slowResponse: ServerResponse | undefined;
  let fastRequest: ClientRequest | undefined;
  let slowRunId: string | undefined;
  try {
    f.faux.setResponses([
      async () => { entered.release(); await gate.promise; return fauxAssistantMessage("released"); },
      fauxAssistantMessage("independent Agent completed"),
    ]);
    const run = f.coordinator.createRun(f.body("slow-stream"));
    slowRunId = run.id;
    await deadline(entered.promise, "model start");
    const path = `/v1/runs/${run.id}/events`;
    f.runtime.server.prependListener("request", (request, response) => {
      if (request.headers["x-test-reader"] === "slow") slowResponse = response;
    });
    const slow = createConnection(f.address.port, f.address.host);
    sockets.push(slow);
    slow.on("error", () => undefined);
    slow.setTimeout(20_000, () => slow.destroy());
    await deadline(new Promise<void>((resolve, reject) => { slow.once("connect", resolve); slow.once("error", reject); }), "slow connect");
    slow.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.config.bearerToken}\r\nX-Test-Reader: slow\r\n\r\n`);
    await deadline(new Promise<void>((resolve) => slow.once("data", () => { slow.pause(); resolve(); })), "SSE headers");
    assert.ok(slowResponse);
    const fastReady = event();
    const markerSeen = event();
    let suffix = "";
    fastRequest = httpRequest(`${f.base}${path}`, { headers: f.headers }, (response) => {
      fastReady.release();
      response.on("data", (chunk: Buffer) => {
        suffix = (suffix + chunk.toString("utf8")).slice(-512);
        if (suffix.includes("reader.progress.marker")) markerSeen.release();
      });
      response.on("error", () => undefined);
    });
    fastRequest.on("error", () => undefined);
    fastRequest.setTimeout(20_000, () => fastRequest?.destroy());
    fastRequest.end();
    await deadline(fastReady.promise, "fast reader ready");
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeap = heapBefore;
    let peakWritableLength = 0;
    let publishedBytes = 0;
    const journal = f.coordinator.getJournal(run.id)!;
    const payload = "x".repeat(64 * 1024);
    // 384 events ~= 24 MiB: fixed finite load, comfortably below 32 MiB.
    for (let index = 0; index < 384; index++) {
      const published = journal.publish("message.delta", { text: payload, index });
      publishedBytes += Buffer.byteLength(JSON.stringify(published)) + 100;
      peakWritableLength = Math.max(peakWritableLength, slowResponse.writableLength);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      // Let the healthy reader and kernel drain each batch, unlike the paused reader.
      await delay(2);
    }
    journal.publish("reader.progress.marker", {});
    await deadline(markerSeen.promise, "healthy SSE reader progress");
    const independent = f.coordinator.createRun(f.body("independent"));
    assert.equal((await deadline(f.coordinator.wait(independent.id), "independent Agent progress")).status, "completed");
    const retainedBytes = journal.list().reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    t.diagnostic(JSON.stringify({ publishedBytes, retainedBytes, peakWritableLength, heapBefore, peakHeap, heapGrowth: peakHeap - heapBefore, disconnected: slowResponse.destroyed }));
    assert.ok(publishedBytes <= 32 * 1024 * 1024);
    assert.ok(retainedBytes <= 2 * 1024 * 1024, "journal control remains bounded");
    assert.ok(peakWritableLength <= 4 * 1024 * 1024,
      `slow reader queued ${peakWritableLength} bytes without disconnecting (4 MiB safety envelope)`);
  } finally {
    gate.release();
    for (const socket of sockets) socket.destroy();
    fastRequest?.destroy();
    if (slowRunId) await deadline(f.coordinator.wait(slowRunId), "released slow Agent settle");
    await f.close();
  }
});

for (const pauseAt of ["model-response", "commit-snapshot"] as const) {
  test(`manual compact versus lifecycle cleanup at ${pauseAt}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture();
    const entered = event();
    const release = event();
    const identity = { scope_key: "private:protocol", lifecycle_id: "life", session_id: "compact" };
    let pending: Promise<unknown> | undefined;
    let cleanup: Promise<unknown> | undefined;
    const controller = new AbortController();
    try {
      await f.coordinator.sessions.initializeTracked(identity, Array.from({ length: 10 }, (_, index) => ({ role: "user" as const, content: `retained user message ${index}`, timestamp: index })));
      f.faux.setResponses([async () => {
        if (pauseAt === "model-response") { entered.release(); await release.promise; }
        return fauxAssistantMessage("Current objective\n- Preserve the conversation.");
      }]);
      if (pauseAt === "commit-snapshot") {
        // Delay completion of the actual archive snapshot read, inside the real
        // mutation queue, after currentById was captured. No fabricated entries.
        const store = f.coordinator.sessions as unknown as { readArchiveEntries(identity: SessionIdentity): Promise<unknown[]> };
        const readArchive = store.readArchiveEntries.bind(store);
        let once = true;
        store.readArchiveEntries = async (...args) => {
          const entries = await readArchive(...args);
          if (once) { once = false; entered.release(); await release.promise; }
          return entries;
        };
      }
      pending = f.coordinator.compactSession(identity.scope_key, identity.lifecycle_id, identity.session_id,
        { provider: "openai-codex", id: "gpt-5.5" }, undefined, controller.signal)
        .then((result) => ({ result }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      await deadline(entered.promise, "compaction pause");
      let cleanupFinished = false;
      cleanup = f.coordinator.cleanupScope(identity.scope_key, identity.lifecycle_id, true).then((result) => { cleanupFinished = true; return result; });
      // A correct shared lifecycle lock may serialize cleanup behind compact.
      // Real bounded observation distinguishes shared-lock blocking from completed
      // filesystem deletion; virtual timers cannot advance the filesystem queue.
      await Promise.race([cleanup, delay(250)]);
      const cleanedWhilePaused = cleanupFinished;
      assert.equal(cleanedWhilePaused, false, "cleanup must wait for the admitted compaction");
      await assert.rejects(f.coordinator.compactSession(identity.scope_key, identity.lifecycle_id, "new-session",
        { provider: "openai-codex", id: "gpt-5.5" }), /cleanup is in progress/);
      const independent = await f.coordinator.compactSession("private:independent", identity.lifecycle_id, "independent",
        { provider: "openai-codex", id: "gpt-5.5" });
      assert.equal(independent.compacted, false);
      release.release();
      const outcome = await deadline(pending, "compaction settle");
      await deadline(cleanup, "cleanup settle");
      t.diagnostic(JSON.stringify({ pauseAt, cleanedWhilePaused, outcome }));
      await assert.rejects(access(f.coordinator.sessions.path(identity)), { code: "ENOENT" }, "cleanup must not be followed by a resurrected session journal");
      await assert.rejects(access(f.coordinator.sessions.archivePath(identity)), { code: "ENOENT" }, "cleanup must not be followed by resurrected archived messages");
    } finally {
      release.release();
      controller.abort();
      await deadline(Promise.allSettled([pending, cleanup]), "pending compaction cleanup");
      await f.close();
    }
  });
}

test("restarted idempotent run restores trusted context for process preview endpoints", { timeout: 20_000 }, async () => {
  const home = await temporaryDirectory("runtime-restarted-preview-");
  const config = testConfig(home);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("persisted completion")]);
  const initial = new TestRunCoordinator({ config, streamFn: faux.provider.streamSimple });
  const executionContext = { sandbox_id: "sandbox_restored", workspace_id: "workspace_restored" };
  const request = {
    scope_key: "private:restored", lifecycle_id: "life", session_id: "session",
    workspace: "/workspace", execution_context: executionContext,
    system_prompt: "Answer directly.", input: "hello",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    metadata: { idempotency_key: "restored-preview" },
  };
  const previewCalls: string[] = [];
  const manager = fakeExecutionManager({
    async preview(identity) {
      assert.deepEqual(identity, { scope_id: request.scope_key, lifecycle_id: request.lifecycle_id, execution_context: executionContext });
      previewCalls.push("processes");
      return { processes: [], revision: "preview_restored:1" };
    },
    async previewSummary(identity) {
      assert.deepEqual(identity, { scope_id: request.scope_key, lifecycle_id: request.lifecycle_id, execution_context: executionContext });
      previewCalls.push("process-summary");
      return { running_terminal_count: 2 };
    },
  });
  let runtime: RuntimeServer | undefined;
  try {
    const first = initial.createRun(request);
    assert.equal((await initial.wait(first.id)).status, "completed");
    initial.shutdown();
    const restarted = new TestRunCoordinator({ config, executor: manager, streamFn: faux.provider.streamSimple });
    runtime = createRuntimeServer(config, restarted);
    const reused = restarted.createRun(structuredClone(request));
    assert.equal(reused.id, first.id);
    assert.equal(reused.status, "completed");
    assert.equal(faux.state.callCount, 1, "replaying a completed run must not call the model again");
    const address = await runtime.listen();
    const query = new URLSearchParams({ scope_key: request.scope_key, lifecycle_id: request.lifecycle_id });
    for (const endpoint of ["processes", "process-summary"]) {
      const response = await fetch(`http://${address.host}:${address.port}/v1/scopes/${endpoint}?${query}`, {
        headers: { authorization: `Bearer ${config.bearerToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200, `${endpoint}: ${await response.clone().text()}`);
      const body = await response.json();
      assert.deepEqual(body, endpoint === "processes"
        ? { processes: [], revision: "preview_restored:1" }
        : { running_terminal_count: 2 });
    }
    assert.deepEqual(previewCalls, ["processes", "process-summary"]);
  } finally {
    initial.shutdown();
    runtime?.server.closeAllConnections();
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("healthy SSE reader drains a near-budget many-frame journal and resumes by cursor", { timeout: 20_000 }, async (t) => {
  const f = await fixture();
  const entered = event();
  const release = event();
  let runId: string | undefined;
  try {
    f.faux.setResponses([async () => {
      entered.release();
      await release.promise;
      return fauxAssistantMessage("completed after retained burst");
    }]);
    const run = f.coordinator.createRun(f.body("many-frame-replay"));
    runId = run.id;
    await deadline(entered.promise, "model entered");
    const journal = f.coordinator.getJournal(run.id)!;
    for (let index = 0; index < 2048; index++) {
      journal.publish("message.delta", { text: "x".repeat(880), index });
    }
    release.release();
    assert.equal((await deadline(f.coordinator.wait(run.id), "terminal commit")).status, "completed");
    const retained = journal.list();
    const retainedBytes = retained.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    assert.ok(retainedBytes > 1.9 * 1024 * 1024 && retainedBytes <= 2 * 1024 * 1024);
    t.diagnostic(JSON.stringify({ retainedBytes, retainedEvents: retained.length }));
    const first = retained[0]!.sequence;
    for (const after of [first - 1, retained.at(-11)!.sequence]) {
      const replay = await f.request(`/v1/runs/${run.id}/events?after=${after}`);
      assert.equal(replay.status, 200);
      const frames = [...replay.text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!));
      assert.deepEqual(frames, retained.filter((item) => item.sequence > after));
      const terminal = frames.at(-1);
      assert.ok(terminal);
      assert.equal(terminal.type, "run.completed");
    }
  } finally {
    release.release();
    if (runId) await deadline(f.coordinator.wait(runId), "released model settled");
    await f.close();
  }
});
