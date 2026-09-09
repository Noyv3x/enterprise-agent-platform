import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject, RunResult, RunStatus } from "./types.js";
import { id, nowIso, stableHash } from "./utils.js";

interface AlwaysGrant {
  scope_key: string;
  approval_key: string;
  tool_name: string;
  created_at: string;
}

interface AlwaysGrantFile {
  version: 2;
  grants: AlwaysGrant[];
}

export class AlwaysApprovalStore {
  private readonly file: string;
  private grants = new Map<string, AlwaysGrant>();
  private commitError?: Error;

  constructor(home: string) {
    this.file = join(home, "approvals", "always.json");
    const stored = readJsonFile<unknown>(this.file, { version: 2, grants: [] });
    if (isAlwaysGrantFile(stored)) {
      for (const grant of stored.grants) {
        this.grants.set(this.key(grant.scope_key, grant.approval_key), grant);
      }
    } else if (existsSync(this.file)) {
      // Any unscoped or invalid grant could authorize unrelated commands.
      // Fail closed by replacing it with an empty current store.
      this.flush();
    }
  }

  has(scopeKey: string, approvalKey: string): boolean {
    if (this.commitError) throw this.commitError;
    return this.grants.has(this.key(scopeKey, approvalKey));
  }

  grant(scopeKey: string, approvalKey: string, toolName: string): void {
    const key = this.key(scopeKey, approvalKey);
    if (this.commitError) throw this.commitError;
    if (this.grants.has(key)) return;
    const candidate = new Map(this.grants);
    candidate.set(key, {
      scope_key: scopeKey,
      approval_key: approvalKey,
      tool_name: toolName,
      created_at: nowIso(),
    });
    this.flush(candidate);
  }

  private flush(candidate = this.grants): void {
    if (this.commitError) throw this.commitError;
    try {
      writeJsonAtomic(this.file, { version: 2, grants: [...candidate.values()] } satisfies AlwaysGrantFile);
    } catch (error) {
      if (error instanceof UncertainCommitError) this.commitError = error;
      throw error;
    }
    this.grants = candidate;
  }

  private key(scopeKey: string, approvalKey: string): string {
    return `${scopeKey}\0${approvalKey}`;
  }
}

function isAlwaysGrantFile(value: unknown): value is AlwaysGrantFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; grants?: unknown };
  return candidate.version === 2
    && Array.isArray(candidate.grants)
    && candidate.grants.every((grant) => {
      if (!grant || typeof grant !== "object" || Array.isArray(grant)) return false;
      const item = grant as Record<string, unknown>;
      return typeof item.scope_key === "string" && item.scope_key.length > 0
        && typeof item.approval_key === "string" && item.approval_key.startsWith("v2:")
        && typeof item.tool_name === "string" && item.tool_name.length > 0
        && typeof item.created_at === "string";
    });
}

export interface PersistentIdempotencyRecord {
  lookup_hash: string;
  run_id: string;
  session_id: string;
  status: RunStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
  result?: Pick<
    RunResult,
    "content" | "model" | "usage" | "context_usage" | "input_message_ids" | "unconsumed_input_message_ids"
  >;
  inputs?: Record<string, { fingerprint: string; state: "accepted" | "injected" | "unconsumed" }>;
  error?: string;
}

interface IdempotencyFile {
  version: 1;
  records: PersistentIdempotencyRecord[];
}

export class IdempotencyStore {
  private readonly file: string;
  private records = new Map<string, PersistentIdempotencyRecord>();
  private commitError?: Error;

  constructor(home: string) {
    this.file = join(home, "idempotency", "index.json");
    const stored = readJsonFile<IdempotencyFile>(this.file, { version: 1, records: [] });
    const now = Date.now();
    const candidate = new Map<string, PersistentIdempotencyRecord>();
    for (const record of stored.records) {
      if (record.lookup_hash && record.run_id && !recordExpired(record, now)) candidate.set(record.lookup_hash, record);
    }
    if (candidate.size !== stored.records.length) this.flush(candidate);
    else this.records = candidate;
  }

  find(scopeKey: string, idempotencyKey: string): PersistentIdempotencyRecord | undefined {
    if (this.commitError) throw this.commitError;
    const hash = this.hash(scopeKey, idempotencyKey);
    const record = this.records.get(hash);
    if (!record) return undefined;
    if (recordExpired(record, Date.now())) {
      const candidate = new Map(this.records);
      candidate.delete(hash);
      this.flush(candidate);
      return undefined;
    }
    return structuredClone(record);
  }

  create(scopeKey: string, idempotencyKey: string, runId: string, sessionId: string, retentionMs: number): PersistentIdempotencyRecord {
    if (this.commitError) throw this.commitError;
    const timestamp = Date.now();
    const record: PersistentIdempotencyRecord = {
      lookup_hash: this.hash(scopeKey, idempotencyKey),
      run_id: runId,
      session_id: sessionId,
      status: "queued",
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: timestamp + retentionMs,
    };
    const candidate = new Map(this.records);
    candidate.set(record.lookup_hash, record);
    this.flush(candidate);
    return structuredClone(record);
  }

  update(
    scopeKey: string,
    idempotencyKey: string,
    patch: {
      status: RunStatus;
      retentionMs: number;
      result?: RunResult;
      inputs?: PersistentIdempotencyRecord["inputs"];
      error?: string;
    },
  ): void {
    if (this.commitError) throw this.commitError;
    const hash = this.hash(scopeKey, idempotencyKey);
    const current = this.records.get(hash);
    if (!current) return;
    const timestamp = Date.now();
    const next: PersistentIdempotencyRecord = {
      ...current,
      status: patch.status,
      updated_at: timestamp,
      expires_at: timestamp + patch.retentionMs,
    };
    if (patch.result) {
      next.result = structuredClone({
        content: patch.result.content,
        model: patch.result.model,
        ...(patch.result.usage ? { usage: patch.result.usage } : {}),
        ...(patch.result.context_usage ? { context_usage: patch.result.context_usage } : {}),
        ...(patch.result.input_message_ids
          ? { input_message_ids: patch.result.input_message_ids }
          : {}),
        ...(patch.result.unconsumed_input_message_ids
          ? { unconsumed_input_message_ids: patch.result.unconsumed_input_message_ids }
          : {}),
      });
    }
    if (patch.inputs) next.inputs = structuredClone(patch.inputs);
    if (patch.error) next.error = patch.error;
    const candidate = new Map(this.records);
    candidate.set(hash, next);
    this.flush(candidate);
  }

  delete(scopeKey: string, idempotencyKey: string, runId: string): void {
    if (this.commitError) throw this.commitError;
    const hash = this.hash(scopeKey, idempotencyKey);
    if (this.records.get(hash)?.run_id !== runId) return;
    const candidate = new Map(this.records);
    candidate.delete(hash);
    this.flush(candidate);
  }

  private hash(scopeKey: string, idempotencyKey: string): string {
    return stableHash(`${scopeKey}\0${idempotencyKey}`);
  }

  private flush(candidate: Map<string, PersistentIdempotencyRecord>): void {
    if (this.commitError) throw this.commitError;
    try {
      writeJsonAtomic(this.file, { version: 1, records: [...candidate.values()] } satisfies IdempotencyFile);
    } catch (error) {
      if (error instanceof UncertainCommitError) this.commitError = error;
      throw error;
    }
    this.records = candidate;
  }
}

function recordExpired(record: PersistentIdempotencyRecord, now: number): boolean {
  return record.status !== "queued" && record.status !== "running" && record.expires_at <= now;
}

// After rename the disk may contain the candidate despite a failed directory
// sync. Fence the store until restart rather than overwrite evidence from a
// stale in-memory snapshot or authorize an unconfirmed grant.
class UncertainCommitError extends Error {}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Unable to read persistent runtime state ${file}: ${(error as Error).message}`);
  }
}

function writeJsonAtomic(file: string, value: JsonObject | AlwaysGrantFile | IdempotencyFile): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.${id("state")}.tmp`);
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    renamed = true;
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (renamed) throw new UncertainCommitError(`Persistent runtime state commit is uncertain: ${(error as Error).message}`, { cause: error });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
