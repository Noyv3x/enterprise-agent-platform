import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("max concurrency defaults to eight and accepts the inclusive 1..64 range", () => {
  assert.equal(loadConfig({}).maxConcurrency, 8);
  assert.equal(loadConfig({ AGENT_RUNTIME_MAX_CONCURRENCY: "1" }).maxConcurrency, 1);
  assert.equal(loadConfig({ AGENT_RUNTIME_MAX_CONCURRENCY: "64" }).maxConcurrency, 64);
});

test("max concurrency rejects out-of-range and partially numeric values", () => {
  for (const value of ["0", "65", "1.5", "2workers", "NaN"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_MAX_CONCURRENCY: value }),
      /Expected an integer between 1 and 64/,
    );
  }
});

test("run queue defaults to 256 and enforces a bounded positive range", () => {
  assert.equal(loadConfig({}).maxQueuedRuns, 256);
  assert.equal(loadConfig({ AGENT_RUNTIME_MAX_QUEUED_RUNS: "1" }).maxQueuedRuns, 1);
  assert.equal(loadConfig({ AGENT_RUNTIME_MAX_QUEUED_RUNS: "10000" }).maxQueuedRuns, 10_000);
  for (const value of ["0", "10001", "1.5", "many"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_MAX_QUEUED_RUNS: value }),
      /Expected an integer between 1 and 10000/,
    );
  }
});

test("request body deadline defaults to fifteen seconds and requires a positive integer", () => {
  assert.equal(loadConfig({}).requestBodyTimeoutMs, 15_000);
  assert.equal(loadConfig({ AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS: "2500" }).requestBodyTimeoutMs, 2_500);
  for (const value of ["0", "-1", "1.5", "soon"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS: value }),
      /Expected a positive integer/,
    );
  }
});

test("run cleanup grace defaults to five seconds and requires a positive integer", () => {
  assert.equal(loadConfig({}).cleanupGraceMs, 5_000);
  assert.equal(loadConfig({ AGENT_RUNTIME_CLEANUP_GRACE_MS: "250" }).cleanupGraceMs, 250);
  for (const value of ["0", "-1", "1.5", "later"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_CLEANUP_GRACE_MS: value }),
      /Expected a positive integer/,
    );
  }
});

test("run inactivity timeout defaults to thirty minutes and accepts zero to disable it", () => {
  assert.equal(loadConfig({}).runIdleTimeoutMs, 30 * 60_000);
  assert.equal(loadConfig({ AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS: "0" }).runIdleTimeoutMs, 0);
  assert.equal(loadConfig({ AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS: "2500" }).runIdleTimeoutMs, 2_500);
  for (const value of ["-1", "86400001", "1.5", "later"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS: value }),
      /Expected an integer between 0 and 86400000/,
    );
  }
});

test("model turn limit defaults to ninety and enforces a bounded positive range", () => {
  assert.equal(loadConfig({}).maxTurnsPerRun, 90);
  assert.equal(loadConfig({ AGENT_RUNTIME_MAX_TURNS: "1" }).maxTurnsPerRun, 1);
  assert.equal(loadConfig({ AGENT_RUNTIME_MAX_TURNS: "1000" }).maxTurnsPerRun, 1_000);
  for (const value of ["0", "1001", "1.5", "unlimited"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_MAX_TURNS: value }),
      /Expected an integer between 1 and 1000/,
    );
  }
});

test("foreground terminal timeout defaults to three minutes and stays within the tool schema range", () => {
  assert.equal(loadConfig({}).terminalTimeoutMs, 180_000);
  assert.equal(loadConfig({ AGENT_RUNTIME_TERMINAL_TIMEOUT_MS: "100" }).terminalTimeoutMs, 100);
  assert.equal(loadConfig({ AGENT_RUNTIME_TERMINAL_TIMEOUT_MS: "3600000" }).terminalTimeoutMs, 3_600_000);
  for (const value of ["0", "99", "3600001", "1.5", "later"]) {
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_TERMINAL_TIMEOUT_MS: value }),
      /Expected an integer between 100 and 3600000/,
    );
  }
});
