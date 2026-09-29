import { keyedQueue, readPrivateText, removeDurableFile, writeState } from "./durable-store.js";
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

/**
 * A session-bound view of the Runtime-owned todo sidecar. The identity is
 * captured outside model-visible arguments and revalidated on every read.
 */
export interface TodoSessionState {
  read(): Promise<TodoStateSnapshot>;
  replace(todos: readonly TodoReplacement[]): Promise<TodoStateSnapshot>;
  active(): Promise<TodoItem[]>;
}

/**
 * Atomic, owner-only storage for one structured todo sidecar per Runtime
 * session. Caller history and model text never enter this class.
 */
export class TodoStore {
  private readonly withQueue = keyedQueue();

  constructor(private readonly pathForIdentity: (identity: SessionIdentity) => string) {}

  session(identity: SessionIdentity): TodoSessionState {
    const captured = { ...identity };
    return {
      read: async () => await this.read(captured),
      replace: async (todos) => await this.replace(captured, todos),
      active: async () => await this.active(captured),
    };
  }

  async read(identity: SessionIdentity): Promise<TodoStateSnapshot> {
    const file = this.pathForIdentity(identity);
    return await this.withQueue(file, async () => await this.readUnlocked(file, identity));
  }

  async active(identity: SessionIdentity): Promise<TodoItem[]> {
    const state = await this.read(identity);
    return state.todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
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
          return previous;
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
      await writeState(file, state);
      return state;
    });
  }

  async deleteSession(identity: SessionIdentity): Promise<void> {
    const file = this.pathForIdentity(identity);
    await this.withQueue(file, () => removeDurableFile(file));
  }

  private async readUnlocked(file: string, identity: SessionIdentity): Promise<TodoStateSnapshot> {
    const raw = await readPrivateText(file, "Agent todo state", MAX_TODO_STATE_BYTES);
    let parsed: unknown;
    try {
      parsed = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      return document(identity, [], nowIso());
    }
    if (parsed && typeof parsed === "object") {
      for (const key of ["scope_key", "lifecycle_id", "session_id"] as const) {
        if (key in parsed && (parsed as Record<string, unknown>)[key] !== identity[key]) {
          throw new Error(`Agent todo state ${key} does not match its session`);
        }
      }
    }
    try {
      return validateDocument(parsed, identity);
    } catch {
      // Todo data is advisory: malformed legacy state must not block a run.
      return document(identity, [], nowIso());
    }
  }

}

function document(
  identity: SessionIdentity,
  todos: TodoItem[],
  updatedAt: string,
): TodoStateSnapshot {
  return {
    schema_version: TODO_STATE_SCHEMA_VERSION,
    ...identity,
    todos,
    updated_at: updatedAt,
  };
}

function validateDocument(value: unknown, identity: SessionIdentity): TodoStateSnapshot {
  const source = object(value, "Agent todo state");
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
    const todo = object(value, `Agent todo state item ${index}`);
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

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

