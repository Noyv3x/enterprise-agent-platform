import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue, SessionEntry } from "./types.js";
import { id, nowIso, scopeOwns, stableHash } from "./utils.js";

export interface SessionIdentity {
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
}

export type LegacySessionImportResult = "created" | "replaced" | "skipped";

interface SessionApprovalEntry {
  id: string;
  type: "grant" | "clear";
  timestamp: string;
  session_id?: string;
  tool_name?: string;
}

const MAX_SESSION_JOURNAL_BYTES = 64 * 1024 * 1024;
const LEGACY_MIGRATION_OWNER = "ubitech-agent-runtime/legacy-session-import";
const LEGACY_MIGRATION_VERSION = 1;

export class SessionStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly initializeQueues = new Map<string, Promise<void>>();
  private readonly sessionQueues = new Map<string, Promise<void>>();

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

  async initialize(identity: SessionIdentity, history: AgentMessage[] = []): Promise<AgentMessage[]> {
    const file = this.path(identity);
    return await this.withQueue(this.initializeQueues, file, async () => {
      const entries = await this.readEntries(identity);
      if (entries.some((entry) => entry.type === "header")) {
        const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.payload as AgentMessage);
        if (this.isOwnedUnusedLegacyImport(entries, identity)) {
          // Consuming the imported seed is itself durable evidence of Pi use.
          // Remove the replaceable marker before model/tool execution begins,
          // so even an abrupt process exit cannot make this journal eligible
          // for a later migration refresh.
          await this.replaceRaw(file, [
            this.entry(identity, "header", {
              version: 1,
              scope_key: identity.scope_key,
              lifecycle_id: identity.lifecycle_id,
              session_id: identity.session_id,
              legacy_migration_consumed: {
                owner: LEGACY_MIGRATION_OWNER,
                version: LEGACY_MIGRATION_VERSION,
                consumed_at: nowIso(),
              },
            }),
            ...entries.slice(1),
          ]);
          await this.writeManifest(identity);
        }
        return messages;
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
      for (const message of history) await this.appendMessage(identity, message);
      return history.slice();
    });
  }

  async withSessionLock<T>(identity: SessionIdentity, task: () => Promise<T>): Promise<T> {
    return await this.withQueue(this.sessionQueues, this.path(identity), task);
  }

  async load(identity: SessionIdentity): Promise<AgentMessage[]> {
    const entries = await this.readEntries(identity);
    return entries.filter((entry) => entry.type === "message").map((entry) => entry.payload as AgentMessage);
  }

  async readEntries(identity: SessionIdentity): Promise<SessionEntry[]> {
    let text: string;
    try {
      const info = await stat(this.path(identity));
      if (!info.isFile()) throw new Error("Agent session journal is not a regular file");
      if (info.size > MAX_SESSION_JOURNAL_BYTES) {
        throw new Error(`Agent session journal exceeds ${MAX_SESSION_JOURNAL_BYTES} bytes`);
      }
      text = await readFile(this.path(identity), "utf8");
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
        if (hasLaterContent) throw new Error(`Corrupt session entry at line ${index + 1}`);
      }
    }
    return entries;
  }

  async appendMessage(identity: SessionIdentity, message: AgentMessage): Promise<void> {
    await this.append(identity, "message", message);
  }

  async appendRun(identity: SessionIdentity, payload: JsonValue): Promise<void> {
    await this.append(identity, "run", payload);
  }

  /**
   * Atomically imports visible legacy history into a journal that has never
   * been used by Pi. A prior import can be refreshed, but only while its
   * marker still exactly describes every entry in the journal. Any message,
   * run, compaction, or header written by the normal runtime makes the file
   * ineligible and therefore preserves it unchanged.
   */
  async importLegacyHistory(
    identity: SessionIdentity,
    messages: AgentMessage[],
  ): Promise<LegacySessionImportResult> {
    return await this.withSessionLock(identity, async () => {
      const file = this.path(identity);
      await this.ensureLegacyImportDirectory(identity);
      const existing = await this.readExistingImportCandidate(identity);
      if (existing.exists && !this.isOwnedUnusedLegacyImport(existing.entries, identity)) return "skipped";

      const messageDigest = stableHash(JSON.stringify(messages));
      const entries: SessionEntry[] = [
        this.entry(identity, "header", {
          version: 1,
          scope_key: identity.scope_key,
          lifecycle_id: identity.lifecycle_id,
          session_id: identity.session_id,
          legacy_migration: {
            owner: LEGACY_MIGRATION_OWNER,
            version: LEGACY_MIGRATION_VERSION,
            message_count: messages.length,
            message_digest: messageDigest,
          },
        }),
        ...messages.map((message) => this.entry(identity, "message", message)),
      ];

      await this.writeScopeManifest(identity.scope_key);
      if (existing.exists) await this.replaceRaw(file, entries);
      else await this.createRaw(file, entries);
      await this.writeManifest(identity);
      return existing.exists ? "replaced" : "created";
    });
  }

  async rewriteCompacted(
    identity: SessionIdentity,
    messages: AgentMessage[],
    payload: JsonValue,
  ): Promise<void> {
    const file = this.path(identity);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await this.writeScopeManifest(identity.scope_key);
    const entries: SessionEntry[] = [
      this.entry(identity, "header", {
        version: 1,
        scope_key: identity.scope_key,
        lifecycle_id: identity.lifecycle_id,
        session_id: identity.session_id,
      }),
      ...messages.map((message) => this.entry(identity, "message", message)),
      this.entry(identity, "compaction", payload),
    ];
    await this.replaceRaw(file, entries);
    await this.writeManifest(identity);
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

  private async append(identity: SessionIdentity, type: SessionEntry["type"], payload: JsonValue | AgentMessage): Promise<void> {
    const file = this.path(identity);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await this.appendRaw(file, this.entry(identity, type, payload));
    await this.writeManifest(identity);
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

  private async createRaw(file: string, entries: object[]): Promise<void> {
    const previous = this.writeQueues.get(file) ?? Promise.resolve();
    const next = previous.then(async () => {
      const temporary = `${file}.${id("legacy_import")}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        // link(2) fails with EEXIST instead of replacing a journal that may
        // have appeared after the eligibility check.
        await link(temporary, file);
        await chmod(file, 0o600);
        await this.syncDirectory(dirname(file));
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

  private async readExistingImportCandidate(identity: SessionIdentity): Promise<{ exists: boolean; entries: SessionEntry[] }> {
    try {
      const info = await lstat(this.path(identity));
      if (!info.isFile() || info.isSymbolicLink()) return { exists: true, entries: [] };
      if (info.size > MAX_SESSION_JOURNAL_BYTES) return { exists: true, entries: [] };
      const text = await readFile(this.path(identity), "utf8");
      // The ordinary reader intentionally tolerates a torn final write for
      // runtime recovery. Migration must be stricter: a torn tail may be the
      // first evidence that Pi already used this imported journal.
      const entries = parseStrictSessionJournal(text);
      return { exists: true, entries: entries ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, entries: [] };
      throw error;
    }
  }

  private isOwnedUnusedLegacyImport(entries: SessionEntry[], identity: SessionIdentity): boolean {
    if (entries.length === 0) return false;
    const [header, ...tail] = entries;
    if (!header || header.type !== "header" || !sameIdentity(header, identity)) return false;
    const payload = asRecord(header.payload);
    const marker = asRecord(payload?.legacy_migration);
    if (
      marker?.owner !== LEGACY_MIGRATION_OWNER
      || marker.version !== LEGACY_MIGRATION_VERSION
      || !Number.isSafeInteger(marker.message_count)
      || typeof marker.message_digest !== "string"
    ) return false;
    if (tail.length !== marker.message_count || tail.some((entry) => entry.type !== "message" || !sameIdentity(entry, identity))) {
      return false;
    }
    const messages = tail.map((entry) => entry.payload as AgentMessage);
    return stableHash(JSON.stringify(messages)) === marker.message_digest;
  }

  private async ensureLegacyImportDirectory(identity: SessionIdentity): Promise<void> {
    await ensurePrivateDirectory(this.sessionsRoot);
    const scopeDirectory = join(this.sessionsRoot, stableHash(identity.scope_key));
    await ensurePrivateDirectory(scopeDirectory);
    await ensurePrivateDirectory(join(scopeDirectory, stableHash(identity.lifecycle_id)));
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

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Legacy import directory must be a real directory");
  await chmod(path, 0o700);
}

function sameIdentity(entry: SessionEntry, identity: SessionIdentity): boolean {
  return entry.scope_key === identity.scope_key
    && entry.lifecycle_id === identity.lifecycle_id
    && entry.session_id === identity.session_id;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function parseStrictSessionJournal(text: string): SessionEntry[] | undefined {
  if (!text.endsWith("\n")) return undefined;
  const entries: SessionEntry[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") continue;
    try {
      const candidate = JSON.parse(rawLine) as unknown;
      const record = asRecord(candidate);
      if (!record || typeof record.id !== "string" || typeof record.type !== "string") return undefined;
      entries.push(candidate as SessionEntry);
    } catch {
      return undefined;
    }
  }
  return entries;
}
