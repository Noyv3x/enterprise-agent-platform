import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionIdentity } from "./session-store.js";
import { id, nowIso } from "./utils.js";

export const TODO_STATE_SCHEMA_VERSION = 1;
export const MAX_TODO_ITEMS = 256;
export const MAX_TODO_CONTENT_CHARACTERS = 4_000;

const MAX_TODO_STATE_BYTES = 8 * 1024 * 1024;
const TODO_ID_PATTERN = /^todo_[a-f0-9]{32}$/;
const TODO_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  created_at: string;
  updated_at: string;
}

export interface TodoStateSnapshot extends SessionIdentity {
  schema_version: typeof TODO_STATE_SCHEMA_VERSION;
  todos: TodoItem[];
  updated_at: string;
}

export interface TodoReplacement {
  id?: string;
  content: string;
  status?: TodoStatus;
}

export type TodoMerge =
  | { content: string; status?: TodoStatus }
  | { id: string; content?: string; status?: TodoStatus };

/**
 * A session-bound view of the Runtime-owned todo sidecar. The identity is
 * captured outside model-visible arguments and revalidated on every read.
 */
export interface TodoSessionState {
  read(): Promise<TodoStateSnapshot>;
  replace(todos: readonly TodoReplacement[]): Promise<TodoStateSnapshot>;
  merge(todos: readonly TodoMerge[]): Promise<TodoStateSnapshot>;
  active(): Promise<TodoItem[]>;
}

type TodoStateDocument = TodoStateSnapshot;

/**
 * Atomic, owner-only storage for one structured todo sidecar per Runtime
 * session. Caller history and model text never enter this class.
 */
export class TodoStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly pathForIdentity: (identity: SessionIdentity) => string) {}

  session(identity: SessionIdentity): TodoSessionState {
    const captured = { ...identity };
    return {
      read: async () => await this.read(captured),
      replace: async (todos) => await this.replace(captured, todos),
      merge: async (todos) => await this.merge(captured, todos),
      active: async () => await this.active(captured),
    };
  }

  async read(identity: SessionIdentity): Promise<TodoStateSnapshot> {
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => await this.readUnlocked(file, identity));
  }

  async active(identity: SessionIdentity): Promise<TodoItem[]> {
    const state = await this.read(identity);
    return state.todos
      .filter((todo) => todo.status === "pending" || todo.status === "in_progress")
      .map((todo) => ({ ...todo }));
  }

  async replace(
    identity: SessionIdentity,
    replacements: readonly TodoReplacement[],
  ): Promise<TodoStateSnapshot> {
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => {
      if (replacements.length > MAX_TODO_ITEMS) {
        throw new Error(`Todo list exceeds the ${MAX_TODO_ITEMS}-item limit`);
      }
      const current = await this.readUnlocked(file, identity);
      const existing = new Map(current.todos.map((todo) => [todo.id, todo]));
      const seen = new Set<string>();
      const timestamp = nowIso();
      const next = replacements.map((replacement): TodoItem => {
        validateContent(replacement.content);
        validateStatus(replacement.status ?? "pending");
        const todoId = replacement.id ?? id("todo");
        validateTodoId(todoId);
        if (seen.has(todoId)) throw new Error(`Duplicate todo id: ${todoId}`);
        seen.add(todoId);
        const previous = existing.get(todoId);
        if (replacement.id !== undefined && !previous) {
          throw new Error(`Cannot replace unknown todo id: ${todoId}`);
        }
        const status = replacement.status ?? "pending";
        if (previous && previous.content === replacement.content && previous.status === status) {
          return { ...previous };
        }
        return {
          id: todoId,
          content: replacement.content,
          status,
          created_at: previous?.created_at ?? timestamp,
          updated_at: timestamp,
        };
      });
      const state = document(identity, next, timestamp);
      await this.writeUnlocked(file, state);
      return cloneState(state);
    });
  }

  async merge(identity: SessionIdentity, patches: readonly TodoMerge[]): Promise<TodoStateSnapshot> {
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => {
      if (patches.length === 0) throw new Error("Todo merge requires at least one item");
      if (patches.length > MAX_TODO_ITEMS) {
        throw new Error(`Todo merge exceeds the ${MAX_TODO_ITEMS}-item operation limit`);
      }
      const current = await this.readUnlocked(file, identity);
      const todos = current.todos.map((todo) => ({ ...todo }));
      const indexes = new Map(todos.map((todo, index) => [todo.id, index]));
      const patched = new Set<string>();
      const timestamp = nowIso();
      for (const patch of patches) {
        if ("id" in patch) {
          validateTodoId(patch.id);
          if (patched.has(patch.id)) throw new Error(`Duplicate todo id: ${patch.id}`);
          patched.add(patch.id);
          const index = indexes.get(patch.id);
          if (index === undefined) throw new Error(`Cannot merge unknown todo id: ${patch.id}`);
          if (patch.content === undefined && patch.status === undefined) {
            throw new Error(`Todo merge ${patch.id} must change content or status`);
          }
          const previous = todos[index]!;
          const content = patch.content ?? previous.content;
          const status = patch.status ?? previous.status;
          validateContent(content);
          validateStatus(status);
          todos[index] = previous.content === content && previous.status === status
            ? previous
            : { ...previous, content, status, updated_at: timestamp };
          continue;
        }
        validateContent(patch.content);
        validateStatus(patch.status ?? "pending");
        if (todos.length >= MAX_TODO_ITEMS) {
          throw new Error(`Todo list exceeds the ${MAX_TODO_ITEMS}-item limit`);
        }
        const todoId = id("todo");
        todos.push({
          id: todoId,
          content: patch.content,
          status: patch.status ?? "pending",
          created_at: timestamp,
          updated_at: timestamp,
        });
        indexes.set(todoId, todos.length - 1);
      }
      const state = document(identity, todos, timestamp);
      await this.writeUnlocked(file, state);
      return cloneState(state);
    });
  }

  async deleteSession(identity: SessionIdentity): Promise<void> {
    const file = this.pathForIdentity(identity);
    await this.withQueue(file, async () => {
      await rm(file, { force: true });
      try {
        await syncDirectory(dirname(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  private async readUnlocked(file: string, identity: SessionIdentity): Promise<TodoStateDocument> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Agent todo state is not a regular file");
      if (info.nlink !== 1) throw new Error("Agent todo state must have exactly one link");
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("Agent todo state is not owned by the Runtime user");
      }
      if ((info.mode & 0o077) !== 0) throw new Error("Agent todo state is not owner-only");
      if (info.size > MAX_TODO_STATE_BYTES) {
        throw new Error(`Agent todo state exceeds ${MAX_TODO_STATE_BYTES} bytes`);
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Agent todo state contains invalid JSON");
      }
      return validateDocument(parsed, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return document(identity, [], nowIso());
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("Agent todo state must not be a symbolic link");
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeUnlocked(file: string, state: TodoStateDocument): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${id("state")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      await chmod(file, 0o600);
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
  todos: TodoItem[],
  updatedAt: string,
): TodoStateDocument {
  return {
    schema_version: TODO_STATE_SCHEMA_VERSION,
    ...identity,
    todos: todos.map((todo) => ({ ...todo })),
    updated_at: updatedAt,
  };
}

function cloneState(state: TodoStateDocument): TodoStateSnapshot {
  return document(state, state.todos, state.updated_at);
}

function validateDocument(value: unknown, identity: SessionIdentity): TodoStateDocument {
  const source = exactObject(value, [
    "schema_version",
    "scope_key",
    "lifecycle_id",
    "session_id",
    "todos",
    "updated_at",
  ], "Agent todo state");
  if (source.schema_version !== TODO_STATE_SCHEMA_VERSION) {
    throw new Error("Agent todo state schema version is unsupported");
  }
  for (const key of ["scope_key", "lifecycle_id", "session_id"] as const) {
    if (source[key] !== identity[key]) throw new Error(`Agent todo state ${key} does not match its session`);
  }
  validateTimestamp(source.updated_at, "Agent todo state updated_at");
  if (!Array.isArray(source.todos)) throw new Error("Agent todo state todos must be an array");
  if (source.todos.length > MAX_TODO_ITEMS) {
    throw new Error(`Todo list exceeds the ${MAX_TODO_ITEMS}-item limit`);
  }
  const seen = new Set<string>();
  const todos = source.todos.map((value, index): TodoItem => {
    const todo = exactObject(
      value,
      ["id", "content", "status", "created_at", "updated_at"],
      `Agent todo state item ${index}`,
    );
    validateTodoId(todo.id);
    validateContent(todo.content);
    validateStatus(todo.status);
    validateTimestamp(todo.created_at, `Agent todo state item ${index} created_at`);
    validateTimestamp(todo.updated_at, `Agent todo state item ${index} updated_at`);
    if (seen.has(todo.id)) throw new Error(`Duplicate todo id: ${todo.id}`);
    seen.add(todo.id);
    return {
      id: todo.id,
      content: todo.content,
      status: todo.status,
      created_at: todo.created_at,
      updated_at: todo.updated_at,
    };
  });
  return document(identity, todos, source.updated_at);
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

function validateTodoId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !TODO_ID_PATTERN.test(value)) {
    throw new Error("Todo id is not a Runtime-issued safe id");
  }
}

function validateContent(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Todo content must be a non-empty string");
  }
  if (value.length > MAX_TODO_CONTENT_CHARACTERS * 2) {
    throw new Error(`Todo content exceeds ${MAX_TODO_CONTENT_CHARACTERS} characters`);
  }
  if (Array.from(value).length > MAX_TODO_CONTENT_CHARACTERS) {
    throw new Error(`Todo content exceeds ${MAX_TODO_CONTENT_CHARACTERS} characters`);
  }
}

function validateStatus(value: unknown): asserts value is TodoStatus {
  if (typeof value !== "string" || !TODO_STATUSES.has(value as TodoStatus)) {
    throw new Error("Todo status must be pending, in_progress, completed, or cancelled");
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
