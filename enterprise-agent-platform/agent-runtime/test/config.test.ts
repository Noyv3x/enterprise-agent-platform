import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  MAX_TURNS_PER_RUN_DEFAULT,
  MAX_TURNS_PER_RUN_MAXIMUM,
  MAX_TURNS_PER_RUN_MINIMUM,
  MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE,
  RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
  RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS,
  RUN_IDLE_TIMEOUT_MINIMUM_SECONDS,
  RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE,
  TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
  TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS,
  TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS,
  TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE,
} from "../src/design-contract.generated.js";
import { temporaryDirectory } from "./helpers.js";

const TEST_RUNTIME_TOKEN = "config-test-token";

function runtimeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AGENT_RUNTIME_TOKEN: TEST_RUNTIME_TOKEN, ...overrides };
}

function boundedIntegerError(minimum: number, maximum: number): RegExp {
  return new RegExp(`Expected an integer between ${minimum} and ${maximum}`);
}

test("runtime bearer token is mandatory and rejects missing or blank values", () => {
  for (const env of [{}, { AGENT_RUNTIME_TOKEN: "" }, { AGENT_RUNTIME_TOKEN: " \t " }]) {
    assert.throws(
      () => loadConfig(env),
      /AGENT_RUNTIME_TOKEN or AGENT_RUNTIME_TOKEN_FILE to a non-empty value/,
    );
  }
});

test("runtime bearer token accepts trimmed direct and file-backed values but rejects an empty file", async () => {
  assert.equal(loadConfig({ AGENT_RUNTIME_TOKEN: "  direct-token \n" }).bearerToken, "direct-token");
  const home = await temporaryDirectory("agent-runtime-config-token-");
  const tokenFile = join(home, "token");
  try {
    await writeFile(tokenFile, "  file-token \n", { encoding: "utf8", mode: 0o600 });
    assert.equal(loadConfig({ AGENT_RUNTIME_TOKEN_FILE: tokenFile }).bearerToken, "file-token");
    await writeFile(tokenFile, " \n\t", "utf8");
    assert.throws(
      () => loadConfig({ AGENT_RUNTIME_TOKEN_FILE: tokenFile }),
      /AGENT_RUNTIME_TOKEN or AGENT_RUNTIME_TOKEN_FILE to a non-empty value/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("max concurrency defaults to eight and accepts the inclusive 1..64 range", () => {
  assert.equal(loadConfig(runtimeEnv()).maxConcurrency, 8);
  assert.equal(loadConfig(runtimeEnv({ AGENT_RUNTIME_MAX_CONCURRENCY: "1" })).maxConcurrency, 1);
  assert.equal(loadConfig(runtimeEnv({ AGENT_RUNTIME_MAX_CONCURRENCY: "64" })).maxConcurrency, 64);
});

test("max concurrency rejects out-of-range and partially numeric values", () => {
  for (const value of ["0", "65", "1.5", "2workers", "NaN"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ AGENT_RUNTIME_MAX_CONCURRENCY: value })),
      /Expected an integer between 1 and 64/,
    );
  }
});

test("run queue defaults to 256 and enforces a bounded positive range", () => {
  assert.equal(loadConfig(runtimeEnv()).maxQueuedRuns, 256);
  assert.equal(loadConfig(runtimeEnv({ AGENT_RUNTIME_MAX_QUEUED_RUNS: "1" })).maxQueuedRuns, 1);
  assert.equal(loadConfig(runtimeEnv({ AGENT_RUNTIME_MAX_QUEUED_RUNS: "10000" })).maxQueuedRuns, 10_000);
  for (const value of ["0", "10001", "1.5", "many"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ AGENT_RUNTIME_MAX_QUEUED_RUNS: value })),
      /Expected an integer between 1 and 10000/,
    );
  }
});

test("request body deadline defaults to fifteen seconds and requires a positive integer", () => {
  assert.equal(loadConfig(runtimeEnv()).requestBodyTimeoutMs, 15_000);
  assert.equal(loadConfig(runtimeEnv({ AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS: "2500" })).requestBodyTimeoutMs, 2_500);
  for (const value of ["0", "-1", "1.5", "soon"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS: value })),
      /Expected a positive integer/,
    );
  }
});

test("run cleanup grace defaults to five seconds and requires a positive integer", () => {
  assert.equal(loadConfig(runtimeEnv()).cleanupGraceMs, 5_000);
  assert.equal(loadConfig(runtimeEnv({ AGENT_RUNTIME_CLEANUP_GRACE_MS: "250" })).cleanupGraceMs, 250);
  for (const value of ["0", "-1", "1.5", "later"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ AGENT_RUNTIME_CLEANUP_GRACE_MS: value })),
      /Expected a positive integer/,
    );
  }
});

test("run inactivity timeout uses the generated design-contract default and inclusive bounds", () => {
  const minimum = RUN_IDLE_TIMEOUT_MINIMUM_SECONDS * 1_000;
  const maximum = RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS * 1_000;
  assert.equal(loadConfig(runtimeEnv()).runIdleTimeoutMs, RUN_IDLE_TIMEOUT_DEFAULT_SECONDS * 1_000);
  assert.equal(
    loadConfig(runtimeEnv({ [RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE]: String(minimum) })).runIdleTimeoutMs,
    minimum,
  );
  assert.equal(
    loadConfig(runtimeEnv({ [RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE]: String(maximum) })).runIdleTimeoutMs,
    maximum,
  );
  for (const value of [String(minimum - 1), String(maximum + 1), "1.5", "later"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ [RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE]: value })),
      boundedIntegerError(minimum, maximum),
    );
  }
});

test("model turn limit uses the generated design-contract default and inclusive bounds", () => {
  assert.equal(loadConfig(runtimeEnv()).maxTurnsPerRun, MAX_TURNS_PER_RUN_DEFAULT);
  assert.equal(
    loadConfig(runtimeEnv({ [MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE]: String(MAX_TURNS_PER_RUN_MINIMUM) })).maxTurnsPerRun,
    MAX_TURNS_PER_RUN_MINIMUM,
  );
  assert.equal(
    loadConfig(runtimeEnv({ [MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE]: String(MAX_TURNS_PER_RUN_MAXIMUM) })).maxTurnsPerRun,
    MAX_TURNS_PER_RUN_MAXIMUM,
  );
  for (const value of [String(MAX_TURNS_PER_RUN_MINIMUM - 1), String(MAX_TURNS_PER_RUN_MAXIMUM + 1), "1.5", "unlimited"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ [MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE]: value })),
      boundedIntegerError(MAX_TURNS_PER_RUN_MINIMUM, MAX_TURNS_PER_RUN_MAXIMUM),
    );
  }
});

test("foreground terminal timeout uses the generated design-contract default and inclusive bounds", () => {
  assert.equal(loadConfig(runtimeEnv()).terminalTimeoutMs, TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS);
  assert.equal(
    loadConfig(runtimeEnv({ [TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE]: String(TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS) })).terminalTimeoutMs,
    TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS,
  );
  assert.equal(
    loadConfig(runtimeEnv({ [TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE]: String(TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS) })).terminalTimeoutMs,
    TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS,
  );
  for (const value of [String(TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS - 1), String(TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS + 1), "1.5", "later"]) {
    assert.throws(
      () => loadConfig(runtimeEnv({ [TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE]: value })),
      boundedIntegerError(TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS, TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS),
    );
  }
});
