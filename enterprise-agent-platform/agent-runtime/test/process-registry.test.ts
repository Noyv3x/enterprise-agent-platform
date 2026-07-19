import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { ProcessRegistry } from "../src/process-registry.js";
import { temporaryDirectory } from "./helpers.js";

test("ProcessRegistry captures command output and isolates ownership", async () => {
  const workspace = await temporaryDirectory("agent-process-");
  try {
    const registry = new ProcessRegistry();
    const result = await registry.run({ runId: "run", scopeKey: "scope", command: "printf hello", cwd: workspace });
    assert.equal(result.status, "completed");
    assert.equal(result.stdout, "hello");
    assert.throws(() => registry.get("other-scope", result.id), /not found/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry stops an aborted process group", async () => {
  const workspace = await temporaryDirectory("agent-process-abort-");
  try {
    const registry = new ProcessRegistry();
    const controller = new AbortController();
    const running = registry.run({ runId: "run", scopeKey: "scope", command: "sleep 30", cwd: workspace, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === "AbortError");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry does not expose runtime or conventionally named secrets", async () => {
  const workspace = await temporaryDirectory("agent-process-env-");
  try {
    const registry = new ProcessRegistry();
    const result = await registry.run({
      runId: "run",
      scopeKey: "scope",
      command: "env",
      cwd: workspace,
      env: {
        AGENT_RUNTIME_TOKEN: "runtime-secret",
        AGENT_PLATFORM_INTERNAL_TOKEN: "platform-secret",
        EXAMPLE_PASSWORD: "password-secret",
        SERVICE_API_KEY: "api-secret",
        PRIVATE_KEY_DATA: "private-secret",
        SAFE_VISIBLE_VALUE: "visible",
      },
    });
    assert.match(result.stdout, /^SAFE_VISIBLE_VALUE=visible$/m);
    for (const secret of ["runtime-secret", "platform-secret", "password-secret", "api-secret", "private-secret"]) {
      assert.doesNotMatch(result.stdout, new RegExp(secret));
    }
    assert.doesNotMatch(result.stdout, /^(?:AGENT_RUNTIME_TOKEN|AGENT_PLATFORM_INTERNAL_TOKEN|EXAMPLE_PASSWORD|SERVICE_API_KEY|PRIVATE_KEY_DATA)=/m);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry evicts the least-recently-used completed records", async () => {
  const workspace = await temporaryDirectory("agent-process-lru-");
  try {
    const registry = new ProcessRegistry(512_000, 128_000, 10_000_000, 16, 2);
    const first = await registry.run({ runId: "run-1", scopeKey: "scope", command: "printf first", cwd: workspace });
    const second = await registry.run({ runId: "run-2", scopeKey: "scope", command: "printf second", cwd: workspace });
    assert.equal(registry.get("scope", first.id).stdout, "first");
    const third = await registry.run({ runId: "run-3", scopeKey: "scope", command: "printf third", cwd: workspace });
    assert.throws(() => registry.get("scope", second.id), /not found/);
    assert.equal(registry.get("scope", first.id).stdout, "first");
    assert.equal(registry.get("scope", third.id).stdout, "third");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry confirms scope cleanup only after the child close event", async () => {
  const workspace = await temporaryDirectory("agent-process-exit-confirmation-");
  const registry = new ProcessRegistry();
  try {
    const started = await registry.run({
      runId: "run",
      scopeKey: "scope",
      lifecycleId: "life",
      command: "trap 'sleep 0.15; exit 0' TERM; printf ready; while :; do sleep 1; done",
      cwd: workspace,
      background: true,
    });
    await waitUntil(() => registry.get("scope", started.id, "life").stdout === "ready");
    registry.killScope("scope", "life");
    assert.equal(await registry.waitForScopeExit("scope", "life", 25), false);
    assert.equal(await registry.waitForScopeExit("scope", "life", 1_000), true);
  } finally {
    registry.killScope("scope", "life");
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry protects background work from updates unless explicitly terminable", async () => {
  const workspace = await temporaryDirectory("agent-process-update-blockers-");
  const registry = new ProcessRegistry();
  try {
    const protectedByDefault = await registry.run({
      runId: "default-wait",
      scopeKey: "private:1",
      command: "sleep 30",
      cwd: workspace,
      background: true,
    });
    const protectedExplicitly = await registry.run({
      runId: "explicit-wait",
      scopeKey: "private:2",
      command: "sleep 30",
      cwd: workspace,
      background: true,
      updateBehavior: "wait",
    });
    const terminable = await registry.run({
      runId: "terminable",
      scopeKey: "private:3",
      command: "sleep 30",
      cwd: workspace,
      background: true,
      updateBehavior: "terminate",
    });

    assert.equal(protectedByDefault.update_behavior, "wait");
    assert.equal(protectedExplicitly.update_behavior, "wait");
    assert.equal(terminable.update_behavior, "terminate");
    assert.deepEqual(registry.updateBlockerSummary(), {
      running_background_terminal_count: 3,
      update_blocking_terminal_count: 2,
      terminable_background_terminal_count: 1,
    });
    await assert.rejects(
      registry.run({
        runId: "foreground",
        scopeKey: "private:1",
        command: "true",
        cwd: workspace,
        updateBehavior: "terminate",
      }),
      /only for background processes/,
    );
  } finally {
    for (const scope of ["private:1", "private:2", "private:3"]) registry.killScope(scope);
    await Promise.all(
      ["private:1", "private:2", "private:3"].map((scope) => registry.waitForScopeExit(scope)),
    );
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry exposes a bounded control-free root and delegate preview without internal identifiers", async () => {
  const workspace = await temporaryDirectory("agent-process-preview-");
  const registry = new ProcessRegistry();
  try {
    const root = await registry.run({
      runId: "internal-root-run",
      scopeKey: "private:7",
      lifecycleId: "life-7",
      command: "TOKEN=root-secret printf '\\033]0;host-title\\007\\033[31mroot-output\\033[0m\\001' # https://example.test/?token=url-secret&api_key=query-secret&session_id=session-url-secret&auth_token=auth-url-secret&cookie=cookie-url-secret curl -u user:pass --cookie session=cookie-secret -H 'Authorization: Bearer bearer-secret' -H 'Cookie: sid=first-cookie-secret; theme=second-cookie-secret' github_pat_abcdefghijklmnopqrstuvwxyz glpat-abcdefghijklmnopqrstuvwxyz",
      cwd: workspace,
    });
    const delegate = await registry.run({
      runId: "internal-child-run",
      scopeKey: "private:7/delegate/child-1",
      lifecycleId: "life-7",
      command: "SESSION_TOKEN=delegate-secret printf delegate-output",
      cwd: workspace,
    });
    await registry.run({
      runId: "internal-sibling-run",
      scopeKey: "private:70",
      lifecycleId: "life-7",
      command: "printf sibling-output",
      cwd: workspace,
    });
    const running = await registry.run({
      runId: "internal-running-run",
      scopeKey: "private:7",
      lifecycleId: "life-7",
      command: "printf running-output; sleep 30",
      cwd: workspace,
      background: true,
    });
    await waitUntil(() => registry.get("private:7", running.id, "life-7").stdout.includes("running-output"));

    const preview = registry.preview("private:7", "life-7");
    assert.equal(preview.length, 3);
    assert.deepEqual(registry.previewSummary("private:7", "life-7"), {
      running_terminal_count: 1,
    });
    assert.equal(preview[0]?.id, running.id);
    assert.deepEqual(new Set(preview.map((process) => process.id)), new Set([root.id, delegate.id, running.id]));
    for (const process of preview) {
      assert.equal(process.running, process.status === "running");
      for (const internal of ["pid", "run_id", "scope_key", "lifecycle_id"]) {
        assert.equal(internal in process, false);
      }
    }
    const rootPreview = preview.find((process) => process.id === root.id)!;
    assert.equal(rootPreview.stdout, "root-output");
    assert.equal(rootPreview.output, "root-output");
    assert.doesNotMatch(rootPreview.stdout, /\u001b|\u0001|host-title/);
    for (const secret of [
      "root-secret",
      "url-secret",
      "query-secret",
      "session-url-secret",
      "auth-url-secret",
      "cookie-url-secret",
      "user:pass",
      "cookie-secret",
      "bearer-secret",
      "first-cookie-secret",
      "second-cookie-secret",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "glpat-abcdefghijklmnopqrstuvwxyz",
    ]) {
      assert.doesNotMatch(rootPreview.command, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(rootPreview.command, /\[redacted\]/);
    assert.doesNotMatch(preview.find((process) => process.id === delegate.id)!.command, /delegate-secret/);
  } finally {
    registry.killScope("private:7", "life-7");
    registry.killScope("private:70", "life-7");
    await registry.waitForScopeExit("private:7", "life-7", 5_000);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProcessRegistry caps preview process count and returns only a bounded output tail", async () => {
  const workspace = await temporaryDirectory("agent-process-preview-bounds-");
  const registry = new ProcessRegistry();
  try {
    for (let index = 0; index < 18; index += 1) {
      await registry.run({
        runId: `run-${index}`,
        scopeKey: "scope",
        lifecycleId: "life",
        command: `printf process-${index}`,
        cwd: workspace,
      });
    }
    const large = await registry.run({
      runId: "large-run",
      scopeKey: "scope",
      lifecycleId: "life",
      command: "printf '%020000d' 7",
      cwd: workspace,
    });

    const preview = registry.preview("scope", "life");
    assert.equal(preview.length, 16);
    const largePreview = preview.find((process) => process.id === large.id)!;
    assert.ok(largePreview);
    assert.ok(Buffer.byteLength(largePreview.stdout, "utf8") <= 8 * 1024);
    assert.ok(Buffer.byteLength(largePreview.output, "utf8") <= 16 * 1024);
    assert.equal(largePreview.stdout.endsWith("7"), true);
    assert.equal(largePreview.truncated, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function waitUntil(read: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for process state");
}
