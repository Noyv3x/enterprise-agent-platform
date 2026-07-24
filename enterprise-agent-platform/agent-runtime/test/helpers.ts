import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TURNS_PER_RUN_DEFAULT,
  RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
  TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
} from "../src/design-contract.generated.js";
import type { RuntimeConfig } from "../src/types.js";

export const TEST_RUNTIME_BEARER_TOKEN = "test-runtime-token";

export async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export function testConfig(home: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    home,
    host: "127.0.0.1",
    port: 0,
    bearerToken: TEST_RUNTIME_BEARER_TOKEN,
    approvalTimeoutMs: 1_000,
    runRetentionMs: 60_000,
    maxDelegationDepth: 2,
    maxDelegatesPerRun: 4,
    maxBodyBytes: 1_000_000,
    requestBodyTimeoutMs: 15_000,
    compactionThreshold: 0.8,
    runIdleTimeoutMs: RUN_IDLE_TIMEOUT_DEFAULT_SECONDS * 1_000,
    maxTurnsPerRun: MAX_TURNS_PER_RUN_DEFAULT,
    terminalTimeoutMs: TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS,
    cleanupGraceMs: 500,
    maxConcurrency: 8,
    maxQueuedRuns: 256,
    executionMode: "local",
    managerRequestTimeoutMs: 3_630_000,
    ...overrides,
  };
}
