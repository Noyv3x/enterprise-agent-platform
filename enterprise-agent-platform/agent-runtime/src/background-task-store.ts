import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { EXECUTION_TARGETS, type ExecutionTarget } from "./container-contract.generated.js";
import type { SessionIdentity } from "./session-store.js";
import { id, nowIso } from "./utils.js";

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

type BackgroundTaskStateDocument = BackgroundTaskStateSnapshot;

/**
 * Atomic, owner-only storage for finite background-process obligations. The
 * identity and execution target are captured outside model-visible state.
 */
export class BackgroundTaskStore {
  private readonly queues = new Map<string, Promise<void>>();
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
    return cloneState(await this.read(identity)).obligations.filter((item) => item.state === "active");
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
        return cloneState(current);
      }
      if (current.obligations.length >= MAX_BACKGROUND_TASK_OBLIGATIONS) {
        throw new Error(`Background task obligations exceed the ${MAX_BACKGROUND_TASK_OBLIGATIONS}-item limit`);
      }
      const timestamp = nowIso();
      const next = document(identity, [
        ...current.obligations,
        { process_id: processId, target, state: "active", created_at: timestamp, updated_at: timestamp },
      ], timestamp);
      await this.writeUnlocked(file, next);
      return cloneState(next);
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
      if (!existing) return cloneState(current);
      if (existing.target !== target) {
        throw new Error("Background task target does not match its registered obligation");
      }
      const timestamp = nowIso();
      const next = document(identity, current.obligations.map((item) => item.process_id === processId
        ? { ...item, state: "resolved" as const, updated_at: timestamp }
        : item), timestamp);
      await this.writeUnlocked(file, next);
      return cloneState(next);
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
      if (!existing) return cloneState(current);
      if (existing.target !== target || existing.state !== "resolved") {
        throw new Error("Background task is not a matching resolved acknowledgement tombstone");
      }
      const timestamp = nowIso();
      const next = document(identity, current.obligations.filter((item) => item.process_id !== processId), timestamp);
      await this.writeUnlocked(file, next);
      return cloneState(next);
    });
  }

  async deleteSession(identity: SessionIdentity): Promise<void> {
    const file = this.pathForIdentity(identity);
    await this.deletePath(file);
  }

  /** Delete one already-scoped responsibility file through its mutation queue. */
  async deletePath(file: string): Promise<void> {
    await this.withQueue(file, async () => {
      await rm(file, { force: true });
      try {
        await syncDirectory(dirname(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  private async readUnlocked(
    file: string,
    identity: SessionIdentity,
  ): Promise<BackgroundTaskStateDocument> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Background task state is not a regular file");
      if (info.nlink !== 1) throw new Error("Background task state must have exactly one link");
      if (this.runtimeUid !== undefined && info.uid !== this.runtimeUid) {
        throw new Error("Background task state is not owned by the Runtime user");
      }
      if ((info.mode & 0o077) !== 0) throw new Error("Background task state is not owner-only");
      if (info.size > MAX_BACKGROUND_TASK_STATE_BYTES) {
        throw new Error(`Background task state exceeds ${MAX_BACKGROUND_TASK_STATE_BYTES} bytes`);
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(raw, "utf8") > MAX_BACKGROUND_TASK_STATE_BYTES) {
        throw new Error(`Background task state exceeds ${MAX_BACKGROUND_TASK_STATE_BYTES} bytes`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Background task state contains invalid JSON");
      }
      return validateDocument(parsed, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return document(identity, [], nowIso());
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("Background task state must not be a symbolic link");
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeUnlocked(file: string, state: BackgroundTaskStateDocument): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${id("background")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      await syncDirectory(dirname(file));
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async withQueue<T>(file: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(async () => await gate);
    this.queues.set(file, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(file) === current) this.queues.delete(file);
    }
  }
}

function document(
  identity: SessionIdentity,
  obligations: BackgroundTaskObligation[],
  updatedAt: string,
): BackgroundTaskStateDocument {
  return {
    schema_version: BACKGROUND_TASK_STATE_SCHEMA_VERSION,
    ...identity,
    obligations: obligations.map((item) => ({ ...item })),
    updated_at: updatedAt,
  };
}

function cloneState(state: BackgroundTaskStateDocument): BackgroundTaskStateSnapshot {
  return document(state, state.obligations, state.updated_at);
}

function validateDocument(value: unknown, identity: SessionIdentity): BackgroundTaskStateDocument {
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

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
