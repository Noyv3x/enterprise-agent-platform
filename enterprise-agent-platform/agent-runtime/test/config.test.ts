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
