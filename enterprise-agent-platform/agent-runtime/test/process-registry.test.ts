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

async function waitUntil(read: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for process state");
}
