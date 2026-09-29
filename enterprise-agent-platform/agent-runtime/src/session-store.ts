import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { BACKGROUND_CONTEXT as context, JsonlSessionRepo, branchTip, setValue, value, type AgentMessage, type Session, type JsonlSessionMetadata, type Write } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { JsonValue as PiJsonValue } from "@earendil-works/pi-ai";
import { redactCommandForApproval } from "./approval-policy.js";
import { replaceText, syncDirectory, withQueue } from "./durable-store.js";
import { BackgroundTaskStore, type BackgroundTaskObligation, type BackgroundTaskSessionState } from "./background-task-store.js";
import { redactToolArgumentsForModelHistory } from "./model-history.js";
import { TodoStore, type TodoItem, type TodoSessionState } from "./todo-store.js";
import type { JsonValue } from "./types.js";
import { id, nowIso, scopeOwns, stableHash } from "./utils.js";

export interface SessionIdentity { scope_key: string; lifecycle_id: string; session_id: string }
export interface TrackedSessionMessage {
  entry_id: string;
  message: AgentMessage;
  model_content_security_version?: number;
  synthetic_kind?: "context_compaction_notice";
}
export interface CompactedSessionMessage extends Omit<TrackedSessionMessage, "entry_id"> { entry_id?: string }
interface SessionApprovalEntry {
  id: string; type: "grant" | "clear"; timestamp: string;
  session_id?: string; tool_name?: string; approval_key?: string;
}
interface LegacyEntry extends SessionIdentity {
  id: string; type: string; payload: AgentMessage;
  model_content_security_version?: number;
  synthetic_kind?: "context_compaction_notice";
}
export const CURRENT_MODEL_CONTENT_SECURITY_VERSION = 1;
const identityAddress = value<SessionIdentity>("platform", "identity");
const trackedAddress = (entryId: string) => value<Omit<TrackedSessionMessage, "message" | "entry_id">>("platform.message", entryId);

/** Native Pi journals own transcript durability; application sidecars own approvals and tasks. */
export class SessionStore {
  private readonly sessionsRoot: string;
  private readonly repo: JsonlSessionRepo;
  private readonly sessions = new Map<string, Session<JsonlSessionMetadata>>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly approvalQueues = new Map<string, Promise<void>>();
  private readonly todos: TodoStore;
  private readonly backgroundTasks: BackgroundTaskStore;
  private startup?: Promise<void>;

  constructor(private readonly home: string) {
    this.sessionsRoot = join(home, "sessions");
    this.repo = new JsonlSessionRepo({ sessionsRoot: join(this.sessionsRoot, "journals"), fileSystem: new NodeExecutionEnv({ cwd: home }) });
    this.todos = new TodoStore((identity) => this.todoPath(identity));
    this.backgroundTasks = new BackgroundTaskStore((identity) => this.backgroundTaskPath(identity));
  }

  /** Stable sidecar basename, not the native repository's timestamped journal filename. */
  path(identity: SessionIdentity): string {
    return join(this.sessionsRoot, "sidecars", `scope-${encodeURIComponent(identity.scope_key)}`, stableHash(identity.lifecycle_id), `${stableHash(identity.session_id)}.jsonl`);
  }
  approvalPath(identity: Pick<SessionIdentity, "scope_key" | "lifecycle_id">): string {
    return join(dirname(this.path({ ...identity, session_id: "" })), "approvals.jsonl");
  }
  todoPath(identity: SessionIdentity): string { return this.path(identity).replace(/\.jsonl$/, ".state.json"); }
  backgroundTaskPath(identity: SessionIdentity): string { return this.path(identity).replace(/\.jsonl$/, ".background-tasks.json"); }
  todoState(identity: SessionIdentity): TodoSessionState {
    const state = this.todos.session(identity);
    return {
      read: async () => { await this.initialize(); return state.read(); },
      active: async () => { await this.initialize(); return state.active(); },
      replace: async (todos) => { await this.initialize(); return state.replace(todos); },
    };
  }
  backgroundTaskState(identity: SessionIdentity): BackgroundTaskSessionState {
    const state = this.backgroundTasks.session(identity);
    return {
      read: async () => { await this.initialize(); return state.read(); },
      active: async () => { await this.initialize(); return state.active(); },
      register: async (processId, target) => { await this.initialize(); return state.register(processId, target); },
      resolve: async (processId, target) => { await this.initialize(); return state.resolve(processId, target); },
      acknowledge: async (processId, target) => { await this.initialize(); return state.acknowledge(processId, target); },
    };
  }
  async loadActiveTodos(identity: SessionIdentity): Promise<TodoItem[]> { await this.initialize(); return this.todos.active(identity); }
  async loadActiveBackgroundTasks(identity: SessionIdentity): Promise<BackgroundTaskObligation[]> { await this.initialize(); return this.backgroundTasks.active(identity); }

  initialize(): Promise<void>;
  initialize(identity: SessionIdentity, history?: AgentMessage[]): Promise<AgentMessage[]>;
  async initialize(identity?: SessionIdentity, history: AgentMessage[] = []): Promise<void | AgentMessage[]> {
    if (identity) return (await this.initializeTracked(identity, history)).map((entry) => entry.message);
    this.startup ??= this.migrate();
    await this.startup;
  }

  async initializeTracked(identity: SessionIdentity, history: AgentMessage[] = []): Promise<TrackedSessionMessage[]> {
    await this.initialize();
    return withQueue(this.mutationQueues, this.path(identity), async () => {
      if (!(await this.session(identity))) {
        const session = await this.create(identity);
        for (const message of history) await this.appendNative(session, message);
      }
      return this.loadTracked(identity);
    });
  }

  private key(identity: SessionIdentity): string { return stableHash(JSON.stringify([identity.scope_key, identity.lifecycle_id, identity.session_id])); }
  private async create(identity: SessionIdentity): Promise<Session<JsonlSessionMetadata>> {
    const session = await this.repo.create({ id: this.key(identity), cwd: "/platform" }, context);
    await session.setValue(identityAddress, identity, context);
    await session.createBranch("main", null, context);
    this.sessions.set(session.metadata.id, session);
    return session;
  }
  private async session(identity: SessionIdentity): Promise<Session<JsonlSessionMetadata> | undefined> {
    const key = this.key(identity);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const metadata = (await this.repo.list(undefined, context)).find((item) => item.id === key);
    if (!metadata) return undefined;
    const session = await this.repo.open(metadata, context);
    this.sessions.set(key, session);
    return session;
  }

  async loadTracked(identity: SessionIdentity): Promise<TrackedSessionMessage[]> {
    await this.initialize();
    const session = await this.session(identity);
    if (!session) return [];
    const branch = await session.branch("main", context);
    const entries = await branch!.findEntries({ order: "newestFirst", stopAtType: "compaction" }, context);
    entries.reverse();
    let messages: TrackedSessionMessage[] = [];
    for (const entry of entries) {
      if (entry.type === "compaction") {
        // Pi's context builder is not a public export. Retain the platform's exact
        // summary/notice representation while using native compaction + tail storage.
        const details = entry.details;
        const summaryTimestamp = details && typeof details === "object" && !Array.isArray(details) ? details.summaryTimestamp : undefined;
        if (summaryTimestamp !== undefined && typeof summaryTimestamp !== "number") throw new Error("Invalid native summary timestamp");
        const projected: AgentMessage[] = summaryTimestamp === undefined ? entry.retainedTail : [
          { role: "user", content: entry.summary, timestamp: summaryTimestamp }, ...entry.retainedTail,
        ];
        const metadata = compactionMetadata(details, projected.length);
        messages = projected.map((message, index) => ({ ...metadata[index]!, message }));
      } else if (entry.type === "message") {
        messages.push({ entry_id: entry.id, message: entry.message, ...(await session.getValue(trackedAddress(entry.id), context))?.value });
      }
    }
    return messages;
  }
  async load(identity: SessionIdentity): Promise<AgentMessage[]> { return (await this.loadTracked(identity)).map((entry) => entry.message); }
  async loadSearchable(identity: SessionIdentity): Promise<AgentMessage[]> {
    await this.initialize();
    const session = await this.session(identity);
    if (!session) return [];
    const entries = await session.findEntries({ type: "message", order: "asc" }, context);
    return entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  }
  async withSessionLock<T>(identity: SessionIdentity, task: () => Promise<T>): Promise<T> { return withQueue(this.sessionQueues, this.path(identity), task); }

  private async appendNative(session: Session<JsonlSessionMetadata>, message: AgentMessage, version?: number, entryId = id("entry")): Promise<string> {
    const parentId = await (await session.branch("main", context))!.getTipId(context);
    await session.mutate(async (mutation) => {
      await mutation.commit([
        { kind: "entry", entry: { id: entryId, parentId, type: "message", message: durableSessionMessage(message) } },
        setValue(branchTip("main"), entryId),
        ...(version === undefined ? [] : [setValue(trackedAddress(entryId), { model_content_security_version: version })]),
      ], context);
    }, context);
    return entryId;
  }
  async appendMessage(identity: SessionIdentity, message: AgentMessage, version?: number): Promise<string> {
    await this.initialize();
    return withQueue(this.mutationQueues, this.path(identity), async () => this.appendNative(await this.session(identity) ?? await this.create(identity), message, version));
  }

  async rewriteCompacted(identity: SessionIdentity, messages: CompactedSessionMessage[], payload: JsonValue, omittedEntryIds: readonly string[] = [], discardedEntryIds: readonly string[] = []): Promise<string[]> {
    await this.initialize();
    return withQueue(this.mutationQueues, this.path(identity), async () => {
      const session = await this.session(identity);
      if (!session) throw new Error("Cannot compact a missing session");
      const current = await this.loadTracked(identity);
      const currentIds = new Set(current.map((entry) => entry.entry_id));
      const retainedIds = messages.flatMap((entry) => entry.entry_id ? [entry.entry_id] : []);
      const omitted = new Set(omittedEntryIds);
      const discarded = new Set(discardedEntryIds);
      if (new Set(retainedIds).size !== retainedIds.length) throw new Error("Cannot compact duplicate retained session entry");
      for (const entryId of [...retainedIds, ...omitted, ...discarded]) {
        if (!currentIds.has(entryId)) throw new Error(`Cannot compact missing session entry ${entryId}`);
      }
      for (const entryId of retainedIds) if (omitted.has(entryId) || discarded.has(entryId)) throw new Error("Cannot retain an omitted or discarded entry");
      for (const entry of current) if (!retainedIds.includes(entry.entry_id) && !omitted.has(entry.entry_id) && !discarded.has(entry.entry_id)) throw new Error(`Cannot compact unclassified current session entry ${entry.entry_id}`);
      const tracked = messages.map((entry) => ({ ...entry, entry_id: entry.entry_id ?? id("entry"), message: durableSessionMessage(entry.message) }));
      await this.compactNative(session, tracked, payload);
      return tracked.map((entry) => entry.entry_id);
    });
  }
  private async compactNative(session: Session<JsonlSessionMetadata>, tracked: TrackedSessionMessage[], payload: JsonValue): Promise<void> {
    const entryId = id("compaction");
    const parentId = await (await session.branch("main", context))!.getTipId(context);
    const notice = tracked[0]?.synthetic_kind ? tracked[0].message : undefined;
    const summaryNotice = notice?.role === "user" && typeof notice.content === "string" ? notice : undefined;
    const writes: Write[] = [{ kind: "entry", entry: {
      id: entryId, parentId, type: "compaction", summary: summaryNotice ? String(summaryNotice.content) : "",
      retainedTail: tracked.slice(summaryNotice ? 1 : 0).map((entry) => entry.message), tokensBefore: 0, fromHook: true,
      details: {
        tracked: tracked.map(({ message: _message, ...metadata }) => metadata), payload,
        ...(summaryNotice ? { summaryTimestamp: summaryNotice.timestamp } : {}),
      },
    } }, setValue(branchTip("main"), entryId)];
    await session.mutate(async (mutation) => { await mutation.commit(writes, context); }, context);
  }

  async deleteSession(identity: SessionIdentity): Promise<void> {
    await this.initialize();
    await withQueue(this.mutationQueues, this.path(identity), async () => {
      const session = await this.session(identity);
      if (session) { await session.close(context); await this.repo.delete(session.metadata, context); this.sessions.delete(session.metadata.id); }
      await this.todos.deleteSession(identity);
      await this.backgroundTasks.deleteSession(identity);
    });
  }
  async deleteScope(scopeKey: string, lifecycleId?: string): Promise<void> { await this.deleteMatching(scopeKey, lifecycleId, false); }
  async deleteScopeFamily(scopeKey: string, lifecycleId?: string): Promise<void> { await this.deleteMatching(scopeKey, lifecycleId, true); }
  private async deleteMatching(scopeKey: string, lifecycleId: string | undefined, family: boolean): Promise<void> {
    await this.initialize();
    for (const metadata of await this.repo.list(undefined, context)) {
      const session = this.sessions.get(metadata.id) ?? await this.repo.open(metadata, context);
      this.sessions.set(metadata.id, session);
      const identity = (await session.getValue(identityAddress, context))?.value;
      if (identity && (family ? scopeOwns(scopeKey, identity.scope_key) : scopeKey === identity.scope_key) && (!lifecycleId || identity.lifecycle_id === lifecycleId)) await this.deleteSession(identity);
    }
    for (const directory of await this.scopeDirectories(scopeKey, family)) await rm(lifecycleId ? join(directory, stableHash(lifecycleId)) : directory, { recursive: true, force: true });
  }
  private async scopeDirectories(scopeKey: string, family = true): Promise<string[]> {
    const root = join(this.sessionsRoot, "sidecars");
    return (await directories(root)).filter((directory) => {
      const candidate = decodeURIComponent(relative(root, directory).slice("scope-".length));
      return family ? scopeOwns(scopeKey, candidate) : scopeKey === candidate;
    });
  }
  async deleteBackgroundTaskScopeFamily(scopeKey: string, lifecycleId?: string): Promise<void> {
    await this.initialize();
    for (const scope of await this.scopeDirectories(scopeKey)) {
      for (const lifecycle of lifecycleId ? [join(scope, stableHash(lifecycleId))] : await directories(scope)) {
        for (const file of await files(lifecycle)) if (file.endsWith(".background-tasks.json")) await this.backgroundTasks.deletePath(file);
      }
    }
  }

  private async migrate(): Promise<void> {
    const marker = join(this.sessionsRoot, ".pi-native");
    if (await exists(marker)) {
      await rm(join(this.home, "sessions.pi-staging"), { recursive: true, force: true });
      return;
    }
    const backup = join(this.home, "sessions.pre-pi");
    const stagingHome = join(this.home, "sessions.pi-staging");
    if (!(await exists(backup)) && await exists(this.sessionsRoot)) {
      await rename(this.sessionsRoot, backup);
      await syncDirectory(this.home);
    }
    await rm(stagingHome, { recursive: true, force: true });
    const staged = new SessionStore(stagingHome);
    await mkdir(staged.sessionsRoot, { recursive: true, mode: 0o700 });
    await replaceText(join(staged.sessionsRoot, ".pi-native"), "4\n");
    for (const scope of await directories(backup)) {
      const scopeManifest = join(scope, "scope.json");
      let scopeKey: string | undefined;
      if (await exists(scopeManifest)) {
        const manifest: unknown = JSON.parse(await readFile(scopeManifest, "utf8"));
        if (!manifest || typeof manifest !== "object" || !("scope_key" in manifest) || typeof manifest.scope_key !== "string") throw new Error(`Invalid legacy scope identity: ${scope}`);
        scopeKey = manifest.scope_key;
      }
      for (const lifecycle of await directories(scope)) {
        const paths = await files(lifecycle);
        for (const archive of paths.filter((path) => path.endsWith(".archive.jsonl"))) {
          if (!paths.includes(archive.replace(/\.archive\.jsonl$/, ".jsonl"))) throw new Error(`Legacy history has no model journal: ${archive}`);
        }
        for (const file of paths.filter((path) => path.endsWith(".jsonl") && !path.endsWith(".archive.jsonl") && !path.endsWith("approvals.jsonl"))) {
          const entries = parseJsonLines<LegacyEntry>(await readFile(file, "utf8"), "legacy session");
          const header = entries.find((entry) => entry.type === "header");
          if (!header) throw new Error(`Missing legacy session identity: ${file}`);
          const identity = { scope_key: header.scope_key, lifecycle_id: header.lifecycle_id, session_id: header.session_id };
          if (typeof identity.scope_key !== "string" || typeof identity.lifecycle_id !== "string" || typeof identity.session_id !== "string"
            || relative(backup, scope) !== stableHash(identity.scope_key)
            || relative(scope, lifecycle) !== stableHash(identity.lifecycle_id)
            || relative(lifecycle, file) !== `${stableHash(identity.session_id)}.jsonl`
            || (scopeKey !== undefined && scopeKey !== identity.scope_key)) throw new Error(`Invalid legacy session identity: ${file}`);
          scopeKey ??= identity.scope_key;
          const archive = file.replace(/\.jsonl$/, ".archive.jsonl");
          const history = await exists(archive) ? parseJsonLines<LegacyEntry>(await readFile(archive, "utf8"), "legacy history") : [];
          const session = await staged.create(identity);
          const seen = new Set<string>();
          for (const entry of [...history, ...entries]) {
            if (entry.type !== "message" || entry.synthetic_kind || seen.has(entry.id)) continue;
            seen.add(entry.id);
            await staged.appendNative(session, entry.payload, entry.model_content_security_version, entry.id);
          }
          const current = entries.filter((entry) => entry.type === "message").map((entry) => ({ entry_id: entry.id, message: durableSessionMessage(entry.payload), ...(entry.model_content_security_version === undefined ? {} : { model_content_security_version: entry.model_content_security_version }), ...(entry.synthetic_kind ? { synthetic_kind: entry.synthetic_kind } : {}) }));
          if (history.length || entries.some((entry) => entry.type === "compaction" || entry.synthetic_kind)) await staged.compactNative(session, current, { migrated: true });
        }
        const sidecars = paths.filter((file) => file.endsWith("approvals.jsonl") || file.endsWith(".state.json") || file.endsWith(".background-tasks.json"));
        if (sidecars.length && !scopeKey) throw new Error(`Missing legacy scope identity: ${scope}`);
        for (const file of sidecars) {
          const destination = join(staged.sessionsRoot, "sidecars", `scope-${encodeURIComponent(scopeKey!)}`, relative(scope, file));
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await copyFile(file, destination);
        }
      }
    }
    await staged.repo.close(context);
    await syncTree(staged.sessionsRoot);
    if (await exists(this.sessionsRoot)) throw new Error("Ambiguous session migration: active tree exists without native marker");
    await rename(staged.sessionsRoot, this.sessionsRoot);
    await syncDirectory(this.home);
    await rm(stagingHome, { recursive: true, force: true });
  }

  async hasSessionApproval(identity: SessionIdentity, approvalKey: string): Promise<boolean> {
    await this.initialize();
    return await withQueue(this.approvalQueues, "session-approvals", async () => {
      const entries = await this.readApprovalEntries(identity);
      const grants = new Set<string>();
      for (const entry of entries) {
        if (entry.type === "clear") grants.clear();
        // Unscoped entries contain only tool_name and are intentionally ignored:
        // those grants are too broad to map safely to a concrete current object.
        else if (entry.session_id && entry.approval_key?.startsWith("v2:")) {
          grants.add(`${entry.session_id}\0${entry.approval_key}`);
        }
      }
      return grants.has(`${identity.session_id}\0${approvalKey}`);
    });
  }

  async appendSessionApproval(identity: SessionIdentity, approvalKey: string, toolName: string): Promise<void> {
    await this.initialize();
    await withQueue(this.approvalQueues, "session-approvals", async () => {
      const file = this.approvalPath(identity);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await this.appendRaw(file, {
        id: id("approval_grant"),
        type: "grant",
        timestamp: nowIso(),
        session_id: identity.session_id,
        tool_name: toolName,
        approval_key: approvalKey,
      } satisfies SessionApprovalEntry);
    });
  }

  async clearSessionApprovals(scopeKey: string, lifecycleId?: string): Promise<void> {
    await this.initialize();
    await withQueue(this.approvalQueues, "session-approvals", async () => {
      const scopeDir = join(this.sessionsRoot, "sidecars", `scope-${encodeURIComponent(scopeKey)}`);
      const lifecycleDirectories = lifecycleId
        ? [join(scopeDir, stableHash(lifecycleId))]
        : await readdir(scopeDir, { withFileTypes: true }).then(
          (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => join(scopeDir, entry.name)),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error),
        );
      for (const directory of lifecycleDirectories) {
        const file = join(directory, "approvals.jsonl");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await this.replaceRaw(file, [
          { id: id("approval_clear"), type: "clear", timestamp: nowIso() } satisfies SessionApprovalEntry,
        ]);
      }
    });
  }
  private async readApprovalEntries(identity: Pick<SessionIdentity, "scope_key" | "lifecycle_id">): Promise<SessionApprovalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.approvalPath(identity), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseJsonLines<SessionApprovalEntry>(text, "approval journal");
  }

  private async appendRaw(file: string, entry: object): Promise<void> {
    const handle = await open(file, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async replaceRaw(file: string, entries: object[]): Promise<void> {
    await replaceText(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function files(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(path, entry.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function syncTree(path: string): Promise<void> {
  for (const directory of await directories(path)) await syncTree(directory);
  for (const file of await files(path)) {
    const handle = await open(file, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(path);
}

function durableSessionMessage(message: AgentMessage): AgentMessage {
  if (message.role === "user") {
    if (typeof message.content === "string" || !message.content.some((block) => block.type === "image")) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((block) => block.type === "image"
        ? {
            type: "text" as const,
            text: `[User image (${block.mimeType}) was available to the live Agent and omitted from durable session history.]`,
          }
        : block),
    };
  }
  if (message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((block) => block.type === "toolCall"
        ? {
            ...block,
            arguments: redactToolArgumentsForModelHistory(
              block.name,
              objectValue(durableToolDetails(block.arguments)),
            ),
          }
        : block),
    };
  }
  if (message.role !== "toolResult") return message;
  return {
    ...message,
    content: message.content.map((block) => block.type === "image"
      ? {
          type: "text" as const,
          text: `[Tool result image (${block.mimeType}) was available to the live Agent and omitted from durable session history.]`,
        }
      : block),
    ...(message.details === undefined ? {} : { details: durableToolDetails(message.details) }),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// Same JSON-preserving projection as the journal sanitizer: Pi details in, JSON out.
function durableToolDetails(value: PiJsonValue, fieldName?: string): PiJsonValue;
function durableToolDetails(value: unknown, fieldName?: string): unknown;
function durableToolDetails(value: unknown, fieldName?: string): unknown {
  if (fieldName === "command") {
    return typeof value === "string" ? redactCommandForApproval(value) : "[redacted]";
  }
  if (/token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|authorization/i.test(fieldName ?? "")) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => durableToolDetails(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const imageLike = (typeof source.type === "string" && source.type.toLowerCase() === "image")
    || (typeof source.mimeType === "string" && source.mimeType.toLowerCase().startsWith("image/"));
  const hasData = imageLike && Object.hasOwn(source, "data");
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (hasData && key === "data") continue;
    sanitized[key] = durableToolDetails(item, key);
  }
  if (hasData) {
    if (!(typeof sanitized.bytes === "number" && Number.isFinite(sanitized.bytes))) {
      sanitized.bytes = typeof source.data === "string"
        ? Buffer.byteLength(source.data, "base64")
        : 0;
    }
    sanitized.omitted = true;
  }
  return sanitized;
}

function parseJsonLines<T>(text: string, label: string): T[] {
  const entries: T[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      const hasLaterContent = lines.slice(index + 1).some((candidate) => candidate.trim() !== "");
      if (hasLaterContent) throw new Error(`Corrupt ${label} entry at line ${index + 1}`);
    }
  }
  return entries;
}

function compactionMetadata(details: JsonValue | undefined, count: number): Omit<TrackedSessionMessage, "message">[] {
  if (!details || typeof details !== "object" || Array.isArray(details) || !Array.isArray(details.tracked) || details.tracked.length !== count) throw new Error("Invalid native compaction tracking metadata");
  return details.tracked.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.entry_id !== "string"
      || (entry.model_content_security_version !== undefined && typeof entry.model_content_security_version !== "number")
      || (entry.synthetic_kind !== undefined && entry.synthetic_kind !== "context_compaction_notice")) throw new Error("Invalid native compaction tracking entry");
    return {
      entry_id: entry.entry_id,
      ...(entry.model_content_security_version === undefined ? {} : { model_content_security_version: entry.model_content_security_version }),
      ...(entry.synthetic_kind === "context_compaction_notice" ? { synthetic_kind: entry.synthetic_kind } : {}),
    };
  });
}
