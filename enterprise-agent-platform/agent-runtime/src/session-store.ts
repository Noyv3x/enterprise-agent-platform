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

interface SessionApprovalEntry {
  id: string;
  type: "grant" | "clear";
  timestamp: string;
  session_id?: string;
  tool_name?: string;
}

const MAX_SESSION_JOURNAL_BYTES = 64 * 1024 * 1024;

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
        return entries.filter((entry) => entry.type === "message").map((entry) => entry.payload as AgentMessage);
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
