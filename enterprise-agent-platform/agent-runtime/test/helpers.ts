import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../src/types.js";

export async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export function testConfig(home: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    home,
    host: "127.0.0.1",
    port: 0,
    approvalTimeoutMs: 1_000,
    runRetentionMs: 60_000,
    maxDelegationDepth: 2,
    maxDelegatesPerRun: 4,
    maxBodyBytes: 1_000_000,
    requestBodyTimeoutMs: 15_000,
    compactionThreshold: 0.8,
    runIdleTimeoutMs: 30 * 60_000,
    maxTurnsPerRun: 90,
    terminalTimeoutMs: 180_000,
    cleanupGraceMs: 500,
    maxConcurrency: 8,
    maxQueuedRuns: 256,
    ...overrides,
  };
}
