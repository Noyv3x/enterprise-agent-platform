import { keyedQueue, readPrivateText, removeDurableFile, writeState } from "./durable-store.js";
import { EXECUTION_TARGETS, type ExecutionTarget } from "./container-contract.generated.js";
import type { SessionIdentity } from "./session-store.js";
import { nowIso } from "./utils.js";

export const BACKGROUND_TASK_STATE_SCHEMA_VERSION = 2;
export const MAX_BACKGROUND_TASK_OBLIGATIONS = 256;

const MAX_BACKGROUND_TASK_STATE_BYTES = 1024 * 1024;
const PROCESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ALLOWED_EXECUTION_TARGETS = new Set<ExecutionTarget>(EXECUTION_TARGETS);

export interface BackgroundTaskObligation {
  process_id: string;
  target: ExecutionTarget;
  state: "active" | "resolved";
  created_at: string;
  updated_at: string;
}

export interface BackgroundTaskStateSnapshot extends SessionIdentity {
  schema_version: typeof BACKGROUND_TASK_STATE_SCHEMA_VERSION;
  obligations: BackgroundTaskObligation[];
  updated_at: string;
}

export interface BackgroundTaskSessionState {
  read(): Promise<BackgroundTaskStateSnapshot>;
  active(): Promise<BackgroundTaskObligation[]>;
  register(processId: string, target: ExecutionTarget): Promise<BackgroundTaskStateSnapshot>;
  resolve(processId: string, target: ExecutionTarget): Promise<BackgroundTaskStateSnapshot>;
  acknowledge(processId: string, target: ExecutionTarget): Promise<BackgroundTaskStateSnapshot>;
}

/**
 * Atomic, owner-only storage for finite background-process obligations. The
 * identity and execution target are captured outside model-visible state.
 */
export class BackgroundTaskStore {
  private readonly withQueue = keyedQueue();
  private readonly runtimeUid: number | undefined;

  constructor(
    private readonly pathForIdentity: (identity: SessionIdentity) => string,
    runtimeUid = typeof process.getuid === "function" ? process.getuid() : undefined,
  ) {
    this.runtimeUid = runtimeUid;
  }

  session(identity: SessionIdentity): BackgroundTaskSessionState {
    const captured = { ...identity };
    return {
      read: async () => await this.read(captured),
      active: async () => await this.active(captured),
      register: async (processId, target) => await this.register(captured, processId, target),
      resolve: async (processId, target) => await this.resolve(captured, processId, target),
      acknowledge: async (processId, target) => await this.acknowledge(captured, processId, target),
    };
  }

  async read(identity: SessionIdentity): Promise<BackgroundTaskStateSnapshot> {
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => await this.readUnlocked(file, identity));
  }

  async active(identity: SessionIdentity): Promise<BackgroundTaskObligation[]> {
    return (await this.read(identity)).obligations.filter((item) => item.state === "active");
  }

  async register(
    identity: SessionIdentity,
    processId: string,
    target: ExecutionTarget,
  ): Promise<BackgroundTaskStateSnapshot> {
    validateProcessId(processId);
    validateTarget(target);
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => {
      const current = await this.readUnlocked(file, identity);
      const existing = current.obligations.find((item) => item.process_id === processId);
      if (existing) {
        if (existing.target !== target) {
          throw new Error("Background task target does not match its registered obligation");
        }
        return current;
      }
      if (current.obligations.length >= MAX_BACKGROUND_TASK_OBLIGATIONS) {
        throw new Error(`Background task obligations exceed the ${MAX_BACKGROUND_TASK_OBLIGATIONS}-item limit`);
      }
      const timestamp = nowIso();
      const next = document(identity, [
        ...current.obligations,
        { process_id: processId, target, state: "active", created_at: timestamp, updated_at: timestamp },
      ], timestamp);
      await writeState(file, next, false);
      return next;
    });
  }

  async resolve(
    identity: SessionIdentity,
    processId: string,
    target: ExecutionTarget,
  ): Promise<BackgroundTaskStateSnapshot> {
    validateProcessId(processId);
    validateTarget(target);
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => {
      const current = await this.readUnlocked(file, identity);
      const existing = current.obligations.find((item) => item.process_id === processId);
      if (!existing) return current;
      if (existing.target !== target) {
        throw new Error("Background task target does not match its registered obligation");
      }
      const timestamp = nowIso();
      const next = document(identity, current.obligations.map((item) => item.process_id === processId
        ? { ...item, state: "resolved" as const, updated_at: timestamp }
        : item), timestamp);
      await writeState(file, next, false);
      return next;
    });
  }

  async acknowledge(
    identity: SessionIdentity,
    processId: string,
    target: ExecutionTarget,
  ): Promise<BackgroundTaskStateSnapshot> {
    validateProcessId(processId);
    validateTarget(target);
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => {
      const current = await this.readUnlocked(file, identity);
      const existing = current.obligations.find((item) => item.process_id === processId);
      if (!existing) return current;
      if (existing.target !== target || existing.state !== "resolved") {
        throw new Error("Background task is not a matching resolved acknowledgement tombstone");
      }
      const timestamp = nowIso();
      const next = document(identity, current.obligations.filter((item) => item.process_id !== processId), timestamp);
      await writeState(file, next, false);
      return next;
    });
  }

  async deleteSession(identity: SessionIdentity): Promise<void> {
    const file = this.pathForIdentity(identity);
    await this.deletePath(file);
  }

  /** Delete one already-scoped responsibility file through its mutation queue. */
  async deletePath(file: string): Promise<void> {
    await this.withQueue(file, () => removeDurableFile(file));
  }

  private async readUnlocked(
    file: string,
    identity: SessionIdentity,
  ): Promise<BackgroundTaskStateSnapshot> {
    const raw = await readPrivateText(
      file, "Background task state", MAX_BACKGROUND_TASK_STATE_BYTES, this.runtimeUid, true,
    );
    if (raw === undefined) return document(identity, [], nowIso());
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Background task state contains invalid JSON");
    }
    return validateDocument(parsed, identity);
  }
}

function document(
  identity: SessionIdentity,
  obligations: BackgroundTaskObligation[],
  updatedAt: string,
): BackgroundTaskStateSnapshot {
  return {
    schema_version: BACKGROUND_TASK_STATE_SCHEMA_VERSION,
    ...identity,
    obligations,
    updated_at: updatedAt,
  };
}

function validateDocument(value: unknown, identity: SessionIdentity): BackgroundTaskStateSnapshot {
  const source = exactObject(value, [
    "schema_version",
    "scope_key",
    "lifecycle_id",
    "session_id",
    "obligations",
    "updated_at",
  ], "Background task state");
  if (source.schema_version !== BACKGROUND_TASK_STATE_SCHEMA_VERSION) {
    throw new Error("Background task state schema version is unsupported");
  }
  for (const key of ["scope_key", "lifecycle_id", "session_id"] as const) {
    if (source[key] !== identity[key]) {
      throw new Error(`Background task state ${key} does not match its session`);
    }
  }
  validateTimestamp(source.updated_at, "Background task state updated_at");
  if (!Array.isArray(source.obligations)) {
    throw new Error("Background task state obligations must be an array");
  }
  if (source.obligations.length > MAX_BACKGROUND_TASK_OBLIGATIONS) {
    throw new Error(`Background task obligations exceed the ${MAX_BACKGROUND_TASK_OBLIGATIONS}-item limit`);
  }
  const seen = new Set<string>();
  const obligations = source.obligations.map((value, index): BackgroundTaskObligation => {
    const item = exactObject(
      value,
      ["process_id", "target", "state", "created_at", "updated_at"],
      `Background task state item ${index}`,
    );
    validateProcessId(item.process_id);
    validateTarget(item.target);
    if (item.state !== "active" && item.state !== "resolved") {
      throw new Error(`Background task state item ${index} state is invalid`);
    }
    validateTimestamp(item.created_at, `Background task state item ${index} created_at`);
    validateTimestamp(item.updated_at, `Background task state item ${index} updated_at`);
    if (seen.has(item.process_id)) throw new Error(`Duplicate background process id: ${item.process_id}`);
    seen.add(item.process_id);
    return {
      process_id: item.process_id,
      target: item.target,
      state: item.state,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  });
  return document(identity, obligations, source.updated_at);
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const source = value as Record<string, unknown>;
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return source;
}

function validateProcessId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PROCESS_ID_PATTERN.test(value)) {
    throw new Error("Background process id is not a Runtime-issued safe id");
  }
}

function validateTarget(value: unknown): asserts value is ExecutionTarget {
  if (typeof value !== "string" || !ALLOWED_EXECUTION_TARGETS.has(value as ExecutionTarget)) {
    throw new Error("Background task target must be sandbox or host");
  }
}

function validateTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
}

