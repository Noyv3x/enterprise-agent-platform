import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue, SessionEntry } from "./types.js";
import { id, nowIso, scopeOwns, stableHash } from "./utils.js";

export interface SessionIdentity {
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
}

export interface TrackedSessionMessage {
  entry_id: string;
  message: AgentMessage;
}

export interface CompactedSessionMessage {
  entry_id?: string;
  message: AgentMessage;
}

interface SessionApprovalEntry {
  id: string;
  type: "grant" | "clear";
  timestamp: string;
  session_id?: string;
  tool_name?: string;
}

const MAX_SESSION_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ARCHIVE_BYTES = 256 * 1024 * 1024;

export class SessionStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly initializeQueues = new Map<string, Promise<void>>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly archiveQueues = new Map<string, Promise<void>>();

  constructor(home: string) {
    this.sessionsRoot = join(home, "sessions");
  }

  path(identity: SessionIdentity): string {
    const scope = stableHash(identity.scope_key);
    const lifecycle = stableHash(identity.lifecycle_id);
    const session = stableHash(identity.session_id);
    return join(this.sessionsRoot, scope, lifecycle, `${session}.jsonl`);
  }

  approvalPath(identity: Pick<SessionIdentity, "scope_key" | "lifecycle_id">): string {
    return join(this.sessionsRoot, stableHash(identity.scope_key), stableHash(identity.lifecycle_id), "approvals.jsonl");
  }

  archivePath(identity: SessionIdentity): string {
    return this.path(identity).replace(/\.jsonl$/, ".archive.jsonl");
  }

  async initialize(identity: SessionIdentity, history: AgentMessage[] = []): Promise<AgentMessage[]> {
    return (await this.initializeTracked(identity, history)).map((entry) => entry.message);
  }

  async initializeTracked(
    identity: SessionIdentity,
    history: AgentMessage[] = [],
  ): Promise<TrackedSessionMessage[]> {
    const file = this.path(identity);
    return await this.withQueue(this.initializeQueues, file, async () => {
      return await this.withQueue(this.mutationQueues, file, async () => {
        const entries = await this.readEntries(identity);
        if (entries.some((entry) => entry.type === "header")) {
          return entries
            .filter((entry) => entry.type === "message")
            .map((entry) => ({ entry_id: entry.id, message: entry.payload as AgentMessage }));
        }
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await this.writeScopeManifest(identity.scope_key);
        const header = this.entry(identity, "header", {
          version: 1,
          scope_key: identity.scope_key,
          lifecycle_id: identity.lifecycle_id,
          session_id: identity.session_id,
        });
        await this.appendRaw(file, header);
        const tracked: TrackedSessionMessage[] = [];
        for (const message of history) {
          const entry = this.entry(identity, "message", durableSessionMessage(message));
          await this.appendRaw(file, entry);
          tracked.push({ entry_id: entry.id, message });
        }
        await this.writeManifest(identity);
        return tracked;
      });
    });
  }

  async withSessionLock<T>(identity: SessionIdentity, task: () => Promise<T>): Promise<T> {
    return await this.withQueue(this.sessionQueues, this.path(identity), task);
  }

  async load(identity: SessionIdentity): Promise<AgentMessage[]> {
    const entries = await this.readEntries(identity);
    return entries.filter((entry) => entry.type === "message").map((entry) => entry.payload as AgentMessage);
  }

  async loadSearchable(identity: SessionIdentity): Promise<AgentMessage[]> {
    return await this.withQueue(this.mutationQueues, this.path(identity), async () => {
      const [archived, current] = await Promise.all([
        this.readArchiveEntries(identity),
        this.readEntries(identity),
      ]);
      const seen = new Set<string>();
      const messages: AgentMessage[] = [];
      for (const entry of [...archived, ...current]) {
        if (entry.type !== "message" || seen.has(entry.id)) continue;
        seen.add(entry.id);
        messages.push(entry.payload as AgentMessage);
      }
      return messages;
    });
  }

  async readEntries(identity: SessionIdentity): Promise<SessionEntry[]> {
    return await this.readSessionEntries(
      this.path(identity),
      "Agent session journal",
      MAX_SESSION_JOURNAL_BYTES,
    );
  }

  private async readArchiveEntries(identity: SessionIdentity): Promise<SessionEntry[]> {
    return await this.readSessionEntries(
      this.archivePath(identity),
      "Agent session archive",
      MAX_SESSION_ARCHIVE_BYTES,
    );
  }

  private async readSessionEntries(
    file: string,
    label: string,
    maximumBytes: number,
  ): Promise<SessionEntry[]> {
    let text: string;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${label} is not a regular file`);
      if (info.size > maximumBytes) {
        throw new Error(`${label} exceeds ${maximumBytes} bytes`);
      }
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: SessionEntry[] = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const candidate = JSON.parse(line) as SessionEntry;
        if (candidate && typeof candidate.id === "string" && typeof candidate.type === "string") entries.push(candidate);
      } catch {
        // A process can die between write(2) and fsync(2). Ignore only the incomplete tail.
        const hasLaterContent = lines.slice(index + 1).some((candidate) => candidate.trim() !== "");
        if (hasLaterContent) throw new Error(`Corrupt ${label.toLowerCase()} entry at line ${index + 1}`);
      }
    }
    return entries;
  }

  async appendMessage(identity: SessionIdentity, message: AgentMessage): Promise<string> {
    return (await this.append(identity, "message", durableSessionMessage(message))).id;
  }

  async appendRun(identity: SessionIdentity, payload: JsonValue): Promise<void> {
    await this.append(identity, "run", payload);
  }

  async rewriteCompacted(
    identity: SessionIdentity,
    messages: CompactedSessionMessage[],
    payload: JsonValue,
    omittedEntryIds: readonly string[] = [],
    discardedEntryIds: readonly string[] = [],
  ): Promise<string[]> {
    const file = this.path(identity);
    return await this.withQueue(this.mutationQueues, file, async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await this.writeScopeManifest(identity.scope_key);
      const current = await this.readEntries(identity);
      const currentMessages = current.filter((entry) => entry.type === "message");
      const currentById = new Map(currentMessages.map((entry) => [entry.id, entry]));
      const archivedIds = new Set((await this.readArchiveEntries(identity)).map((entry) => entry.id));
      const omittedIds = new Set(omittedEntryIds);
      const discardedIds = new Set(discardedEntryIds);
      const retainedIds = new Set<string>();
      for (const message of messages) {
        if (!message.entry_id) continue;
        if (retainedIds.has(message.entry_id)) {
          throw new Error(`Cannot compact duplicate retained session entry ${message.entry_id}`);
        }
        if (omittedIds.has(message.entry_id)) {
          throw new Error(`Session entry ${message.entry_id} cannot be both retained and omitted`);
        }
        if (!currentById.has(message.entry_id)) {
          throw new Error(`Cannot retain missing session entry ${message.entry_id}`);
        }
        retainedIds.add(message.entry_id);
      }
      for (const entryId of discardedIds) {
        if (omittedIds.has(entryId) || retainedIds.has(entryId)) {
          throw new Error(`Session entry ${entryId} cannot be discarded and retained or omitted`);
        }
        if (!currentById.has(entryId)) {
          throw new Error(`Cannot discard missing session entry ${entryId}`);
        }
      }
      for (const entryId of omittedIds) {
        if (!currentById.has(entryId) && !archivedIds.has(entryId)) {
          throw new Error(`Cannot archive missing session entry ${entryId}`);
        }
      }
      const unexpected = currentMessages.find(
        (entry) => !retainedIds.has(entry.id) && !omittedIds.has(entry.id) && !discardedIds.has(entry.id),
      );
      if (unexpected) {
        throw new Error(`Cannot compact unclassified current session entry ${unexpected.id}`);
      }
      await this.appendArchiveEntries(
        identity,
        currentMessages.filter((entry) => omittedIds.has(entry.id)),
      );
      const compactedMessages = messages.map((message): SessionEntry => {
        if (!message.entry_id) {
          return this.entry(identity, "message", durableSessionMessage(message.message));
        }
        const currentEntry = currentById.get(message.entry_id)!;
        return {
          id: currentEntry.id,
          type: "message",
          timestamp: currentEntry.timestamp,
          ...identity,
          payload: durableSessionMessage(message.message),
        };
      });
      const entries: SessionEntry[] = [
        this.entry(identity, "header", {
          version: 1,
          scope_key: identity.scope_key,
          lifecycle_id: identity.lifecycle_id,
          session_id: identity.session_id,
        }),
        ...compactedMessages,
        this.entry(identity, "compaction", payload),
      ];
      await this.replaceRaw(file, entries);
      await this.writeManifest(identity);
      return compactedMessages.map((entry) => entry.id);
    });
  }

  private async appendArchiveEntries(identity: SessionIdentity, entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const file = this.archivePath(identity);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await this.withQueue(this.archiveQueues, file, async () => {
      await this.repairJsonlTail(file, "Agent session archive", MAX_SESSION_ARCHIVE_BYTES);
      const known = new Set((await this.readArchiveEntries(identity)).map((entry) => entry.id));
      for (const entry of entries) {
        if (known.has(entry.id)) continue;
        await this.appendRaw(file, entry);
        known.add(entry.id);
      }
    });
  }

  async deleteScope(scopeKey: string, lifecycleId?: string): Promise<void> {
    const scopeDir = join(this.sessionsRoot, stableHash(scopeKey));
    const target = lifecycleId ? join(scopeDir, stableHash(lifecycleId)) : scopeDir;
    await rm(target, { recursive: true, force: true });
  }

  async deleteScopeFamily(scopeKey: string, lifecycleId?: string): Promise<void> {
    const directories = await readdir(this.sessionsRoot, { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => join(this.sessionsRoot, entry.name)),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error),
    );
    for (const directory of directories) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, "scope.json"), "utf8")) as { scope_key?: string };
        const candidate = String(manifest.scope_key || "");
        if (!scopeOwns(scopeKey, candidate)) continue;
        await rm(lifecycleId ? join(directory, stableHash(lifecycleId)) : directory, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async hasSessionApproval(identity: SessionIdentity, toolName: string): Promise<boolean> {
    const entries = await this.readApprovalEntries(identity);
    const grants = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "clear") grants.clear();
      else if (entry.session_id && entry.tool_name) grants.add(`${entry.session_id}\0${entry.tool_name}`);
    }
    return grants.has(`${identity.session_id}\0${toolName}`);
  }

  async appendSessionApproval(identity: SessionIdentity, toolName: string): Promise<void> {
    const file = this.approvalPath(identity);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await this.appendRaw(file, {
      id: id("approval_grant"),
      type: "grant",
      timestamp: nowIso(),
      session_id: identity.session_id,
      tool_name: toolName,
    } satisfies SessionApprovalEntry);
  }

  async clearSessionApprovals(scopeKey: string, lifecycleId?: string): Promise<void> {
    const scopeDir = join(this.sessionsRoot, stableHash(scopeKey));
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
  }

  async writeManifest(identity: SessionIdentity): Promise<void> {
    const manifest = this.path(identity).replace(/\.jsonl$/, ".manifest.json");
    await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
    await this.replaceText(manifest, `${JSON.stringify({ ...identity, updated_at: nowIso() }, null, 2)}\n`);
  }

  private async append(
    identity: SessionIdentity,
    type: SessionEntry["type"],
    payload: JsonValue | AgentMessage,
  ): Promise<SessionEntry> {
    const file = this.path(identity);
    return await this.withQueue(this.mutationQueues, file, async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const entry = this.entry(identity, type, payload);
      await this.appendRaw(file, entry);
      await this.writeManifest(identity);
      return entry;
    });
  }

  private entry(identity: SessionIdentity, type: SessionEntry["type"], payload: JsonValue | AgentMessage): SessionEntry {
    return { id: id("entry"), type, timestamp: nowIso(), ...identity, payload };
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
    const previous = this.writeQueues.get(file) ?? Promise.resolve();
    const next = previous.then(async () => {
      const handle = await open(file, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    const tracked = next.catch(() => undefined);
    this.writeQueues.set(file, tracked);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(file) === tracked) this.writeQueues.delete(file);
    }
  }

  private async repairJsonlTail(file: string, label: string, maximumBytes: number): Promise<void> {
    let bytes: Buffer;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${label} is not a regular file`);
      if (info.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
      if (info.size === 0) return;
      bytes = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (bytes[bytes.length - 1] === 0x0a) return;
    const previousLineEnd = bytes.lastIndexOf(0x0a);
    const tailStart = previousLineEnd + 1;
    const tail = bytes.subarray(tailStart).toString("utf8").trim();
    let preserveTail = false;
    if (tail) {
      try {
        const candidate = JSON.parse(tail) as { id?: unknown; type?: unknown };
        preserveTail = Boolean(
          candidate
          && typeof candidate === "object"
          && typeof candidate.id === "string"
          && typeof candidate.type === "string",
        );
      } catch {
        preserveTail = false;
      }
    }
    const handle = await open(file, "r+");
    try {
      if (preserveTail) {
        await handle.write("\n", bytes.length, "utf8");
      } else {
        await handle.truncate(tailStart);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async replaceRaw(file: string, entries: object[]): Promise<void> {
    const previous = this.writeQueues.get(file) ?? Promise.resolve();
    const next = previous.then(async () => {
      const temporary = `${file}.${id("compact")}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, file);
        await chmod(file, 0o600);
        const directory = await open(dirname(file), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    const tracked = next.catch(() => undefined);
    this.writeQueues.set(file, tracked);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(file) === tracked) this.writeQueues.delete(file);
    }
  }

  private async replaceText(file: string, text: string): Promise<void> {
    const temporary = `${file}.${id("manifest")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      await chmod(file, 0o600);
      await this.syncDirectory(dirname(file));
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async writeScopeManifest(scopeKey: string): Promise<void> {
    const directory = join(this.sessionsRoot, stableHash(scopeKey));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.replaceText(join(directory, "scope.json"), `${JSON.stringify({ scope_key: scopeKey }, null, 2)}\n`);
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async withQueue<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(async () => await gate);
    queues.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (queues.get(key) === current) queues.delete(key);
    }
  }
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
  if (message.role !== "toolResult") return message;
  return {
    ...message,
    content: message.content.map((block) => block.type === "image"
      ? {
          type: "text" as const,
          text: `[Tool result image (${block.mimeType}) was available to the live Agent and omitted from durable session history.]`,
        }
      : block),
    details: durableToolDetails(message.details),
  };
}

function durableToolDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => durableToolDetails(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const imageLike = (typeof source.type === "string" && source.type.toLowerCase() === "image")
    || (typeof source.mimeType === "string" && source.mimeType.toLowerCase().startsWith("image/"));
  const hasData = imageLike && Object.hasOwn(source, "data");
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (hasData && key === "data") continue;
    sanitized[key] = durableToolDetails(item);
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
