import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "./types.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function loadToken(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AGENT_RUNTIME_TOKEN?.trim()) return env.AGENT_RUNTIME_TOKEN.trim();
  if (!env.AGENT_RUNTIME_TOKEN_FILE?.trim()) return undefined;
  return readFileSync(env.AGENT_RUNTIME_TOKEN_FILE, "utf8").trim() || undefined;
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
  const config: RuntimeConfig = {
    home: resolve(env.AGENT_RUNTIME_HOME || "data/runtimes/agent"),
    host: env.AGENT_RUNTIME_HOST || "127.0.0.1",
    port: positiveInteger(env.AGENT_RUNTIME_PORT, 8766),
    approvalTimeoutMs: positiveInteger(env.AGENT_RUNTIME_APPROVAL_TIMEOUT_MS, 15 * 60_000),
    runRetentionMs: positiveInteger(env.AGENT_RUNTIME_RUN_RETENTION_MS, 60 * 60_000),
    maxDelegationDepth: positiveInteger(env.AGENT_RUNTIME_MAX_DELEGATION_DEPTH, 2),
    maxDelegatesPerRun: positiveInteger(env.AGENT_RUNTIME_MAX_DELEGATES, 4),
    maxBodyBytes: positiveInteger(env.AGENT_RUNTIME_MAX_BODY_BYTES, 2 * 1024 * 1024),
    requestBodyTimeoutMs: positiveInteger(env.AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS, 15_000),
    compactionThreshold: fraction(env.AGENT_RUNTIME_COMPACTION_THRESHOLD, 0.8),
    runTimeoutMs: positiveInteger(env.AGENT_RUNTIME_RUN_TIMEOUT_MS, 240_000),
    cleanupGraceMs: positiveInteger(env.AGENT_RUNTIME_CLEANUP_GRACE_MS, 5_000),
    maxConcurrency: boundedInteger(env.AGENT_RUNTIME_MAX_CONCURRENCY, 8, 1, 64),
    maxQueuedRuns: boundedInteger(env.AGENT_RUNTIME_MAX_QUEUED_RUNS, 256, 1, 10_000),
  };
  const bearerToken = loadToken(env);
  const platformUrl = env.AGENT_PLATFORM_INTERNAL_URL?.replace(/\/$/, "");
  const platformToken = env.AGENT_PLATFORM_INTERNAL_TOKEN?.trim();
  if (bearerToken) config.bearerToken = bearerToken;
  if (platformUrl) config.platformUrl = platformUrl;
  if (platformToken) config.platformToken = platformToken;
  return config;
}
