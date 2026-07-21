import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
} from "./design-contract.generated.js";
import type { RuntimeConfig } from "./types.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function loadToken(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_RUNTIME_TOKEN?.trim()) return env.AGENT_RUNTIME_TOKEN.trim();
  if (env.AGENT_RUNTIME_TOKEN_FILE?.trim()) {
    const token = readFileSync(env.AGENT_RUNTIME_TOKEN_FILE.trim(), "utf8").trim();
    if (token) return token;
  }
  throw new Error(
    "Agent Runtime bearer token is required; set AGENT_RUNTIME_TOKEN or AGENT_RUNTIME_TOKEN_FILE to a non-empty value",
  );
}

function fraction(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 0.95) {
    throw new Error(`Expected a fraction between 0.5 and 0.95, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const bearerToken = loadToken(env);
  const config: RuntimeConfig = {
    home: resolve(env.AGENT_RUNTIME_HOME || "data/runtimes/agent"),
    host: env.AGENT_RUNTIME_HOST || "127.0.0.1",
    port: positiveInteger(env.AGENT_RUNTIME_PORT, 8766),
    bearerToken,
    approvalTimeoutMs: positiveInteger(env.AGENT_RUNTIME_APPROVAL_TIMEOUT_MS, 15 * 60_000),
    runRetentionMs: positiveInteger(env.AGENT_RUNTIME_RUN_RETENTION_MS, 60 * 60_000),
    maxDelegationDepth: positiveInteger(env.AGENT_RUNTIME_MAX_DELEGATION_DEPTH, 2),
    maxDelegatesPerRun: positiveInteger(env.AGENT_RUNTIME_MAX_DELEGATES, 4),
    maxBodyBytes: positiveInteger(env.AGENT_RUNTIME_MAX_BODY_BYTES, 2 * 1024 * 1024),
    requestBodyTimeoutMs: positiveInteger(env.AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS, 15_000),
    compactionThreshold: fraction(env.AGENT_RUNTIME_COMPACTION_THRESHOLD, 0.8),
    runIdleTimeoutMs: boundedInteger(
      env[RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE],
      RUN_IDLE_TIMEOUT_DEFAULT_SECONDS * 1_000,
      RUN_IDLE_TIMEOUT_MINIMUM_SECONDS * 1_000,
      RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS * 1_000,
    ),
    maxTurnsPerRun: boundedInteger(
      env[MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE],
      MAX_TURNS_PER_RUN_DEFAULT,
      MAX_TURNS_PER_RUN_MINIMUM,
      MAX_TURNS_PER_RUN_MAXIMUM,
    ),
    terminalTimeoutMs: boundedInteger(
      env[TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE],
      TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
      TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS,
      TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS,
    ),
    cleanupGraceMs: positiveInteger(env.AGENT_RUNTIME_CLEANUP_GRACE_MS, 5_000),
    maxConcurrency: boundedInteger(env.AGENT_RUNTIME_MAX_CONCURRENCY, 8, 1, 64),
    maxQueuedRuns: boundedInteger(env.AGENT_RUNTIME_MAX_QUEUED_RUNS, 256, 1, 10_000),
  };
  const platformUrl = env.AGENT_PLATFORM_INTERNAL_URL?.replace(/\/$/, "");
  const platformToken = env.AGENT_PLATFORM_INTERNAL_TOKEN?.trim();
  if (platformUrl) config.platformUrl = platformUrl;
  if (platformToken) config.platformToken = platformToken;
  return config;
}
