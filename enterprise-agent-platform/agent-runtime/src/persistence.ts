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

interface AlwaysGrantFile {
  version: 1;
  grants: Array<{ scope_key: string; tool_name: string; created_at: string }>;
}

export class AlwaysApprovalStore {
  private readonly file: string;
  private readonly grants = new Map<string, { scope_key: string; tool_name: string; created_at: string }>();

  constructor(home: string) {
    this.file = join(home, "approvals", "always.json");
    const stored = readJsonFile<AlwaysGrantFile>(this.file, { version: 1, grants: [] });
    for (const grant of stored.grants) {
      if (grant.scope_key && grant.tool_name) this.grants.set(this.key(grant.scope_key, grant.tool_name), grant);
    }
  }

  has(scopeKey: string, toolName: string): boolean {
    return this.grants.has(this.key(scopeKey, toolName));
  }

  grant(scopeKey: string, toolName: string): void {
    const key = this.key(scopeKey, toolName);
    if (this.grants.has(key)) return;
    this.grants.set(key, { scope_key: scopeKey, tool_name: toolName, created_at: nowIso() });
    this.flush();
  }

  private flush(): void {
    writeJsonAtomic(this.file, { version: 1, grants: [...this.grants.values()] } satisfies AlwaysGrantFile);
  }

  private key(scopeKey: string, toolName: string): string {
    return `${scopeKey}\0${toolName}`;
  }
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
  private readonly records = new Map<string, PersistentIdempotencyRecord>();

  constructor(home: string) {
    this.file = join(home, "idempotency", "index.json");
    const stored = readJsonFile<IdempotencyFile>(this.file, { version: 1, records: [] });
    const now = Date.now();
    for (const record of stored.records) {
      if (record.lookup_hash && record.run_id && record.expires_at > now) this.records.set(record.lookup_hash, record);
    }
    if (this.records.size !== stored.records.length) this.flush();
  }

  find(scopeKey: string, idempotencyKey: string): PersistentIdempotencyRecord | undefined {
    const hash = this.hash(scopeKey, idempotencyKey);
    const record = this.records.get(hash);
    if (!record) return undefined;
    if (record.expires_at <= Date.now()) {
      this.records.delete(hash);
      this.flush();
      return undefined;
    }
    return structuredClone(record);
  }

  create(scopeKey: string, idempotencyKey: string, runId: string, sessionId: string, retentionMs: number): PersistentIdempotencyRecord {
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
    this.records.set(record.lookup_hash, record);
    this.flush();
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
      next.result = {
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
      };
    }
    if (patch.inputs) next.inputs = structuredClone(patch.inputs);
    if (patch.error) next.error = patch.error;
    this.records.set(hash, next);
    this.flush();
  }

  delete(scopeKey: string, idempotencyKey: string, runId: string): void {
    const hash = this.hash(scopeKey, idempotencyKey);
    if (this.records.get(hash)?.run_id !== runId) return;
    this.records.delete(hash);
    this.flush();
  }

  private hash(scopeKey: string, idempotencyKey: string): string {
    return stableHash(`${scopeKey}\0${idempotencyKey}`);
  }

  private flush(): void {
    writeJsonAtomic(this.file, { version: 1, records: [...this.records.values()] } satisfies IdempotencyFile);
  }
}

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
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
