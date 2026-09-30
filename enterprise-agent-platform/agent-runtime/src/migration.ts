import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface Identity {
  scope_key: string;
  lifecycle_id: string;
  session_id: string;
}
interface Mapping extends Identity { sid: string }
interface OldEntry {
  kind: "entry";
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number;
  message?: AgentMessage;
  summary?: string;
  retainedTail?: AgentMessage[];
  tokensBefore?: number;
  fromHook?: boolean;
  details?: { summaryTimestamp?: number; [key: string]: unknown };
}
interface Journal {
  header: { v: number; kind: string; createdAt: number; cwd: string };
  identity?: Identity;
  tip: string | null;
  entries: OldEntry[];
  lastSeq: number;
  sourceHash: string;
}

export function sessionPath(home: string, sid: string): string {
  return join(home, "sessions-v3", `${createHash("sha256").update(sid).digest("hex")}.jsonl`);
}

async function optionalRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function* journals(directory: string): AsyncGenerator<string> {
  let children;
  try { children = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const child of children) {
    const path = join(directory, child.name);
    if (child.isDirectory()) yield* journals(path);
    else if (child.isFile() && child.name.endsWith(".jsonl")) yield path;
  }
}

function parseJournal(text: string): Journal {
  // A v4 append is committed only once its terminating newline is present.
  const committed = text.slice(0, text.lastIndexOf("\n") + 1);
  const lines = committed.split("\n").filter((line) => line.trim());
  const header = JSON.parse(lines.shift() ?? "null") as Journal["header"];
  if (!header || header.v !== 4 || header.kind !== "header") throw new Error("Expected a v4 session journal");
  const journal: Journal = { header, tip: null, entries: [], lastSeq: 0, sourceHash: digest(committed) };
  for (const line of lines) {
    const transaction = JSON.parse(line);
    for (const write of Array.isArray(transaction) ? transaction : [transaction]) {
      if (typeof write.seq === "number") journal.lastSeq = Math.max(journal.lastSeq, write.seq);
      if (write.kind === "entry") journal.entries.push(write as OldEntry);
      if (write.kind !== "value") continue;
      if (write.namespace === "platform" && write.key === "identity") {
        journal.identity = write.op === "set" ? write.value : undefined;
      }
      if (write.namespace === "pi.branch.tip" && write.key === "main") {
        journal.tip = write.op === "set" ? write.value : null;
      }
    }
  }
  return journal;
}

function convert(journal: Journal, sid: string): string {
  const timestamp = (value: number) => new Date(value).toISOString();
  const records: object[] = [{ type: "session", version: 3, id: sid,
    timestamp: timestamp(journal.header.createdAt), cwd: "/workspace" }];
  const byId = new Map(journal.entries.map((entry) => [entry.id, entry]));
  if (byId.size !== journal.entries.length) throw new Error("Duplicate v4 session entry id");
  const branch: OldEntry[] = [];
  const visited = new Set<string>();
  for (let id = journal.tip; id !== null;) {
    const entry = byId.get(id);
    if (!entry || visited.has(id)) throw new Error("Broken v4 main branch");
    visited.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();
  let parentId: string | null = null;
  const messages: { id: string; message: AgentMessage }[] = [];
  const append = (entry: OldEntry) => {
    if (!entry.message) throw new Error("Missing v4 session message");
    records.push({ type: "message", id: entry.id, parentId,
      timestamp: timestamp(entry.timestamp), message: entry.message });
    messages.push({ id: entry.id, message: entry.message });
    parentId = entry.id;
  };
  // Keep the complete searchable transcript, not merely the compacted branch.
  for (const entry of journal.entries) if (entry.type === "message") append(entry);
  const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const compaction = branch[compactionIndex];
  if (compaction) {
    if (typeof compaction.summary !== "string" || !Array.isArray(compaction.retainedTail)) {
      throw new Error("Invalid v4 compaction");
    }
    const visible = [...compaction.retainedTail, ...branch.slice(compactionIndex + 1)
      .filter((entry) => entry.type === "message").map((entry) => entry.message!)];
    const suffix = messages.slice(messages.length - visible.length);
    let firstKeptEntryId: string = compaction.id;
    if (visible.length && isDeepStrictEqual(suffix.map((entry) => entry.message), visible)) {
      firstKeptEntryId = suffix[0]!.id;
    } else if (visible.length) {
      // Old compactions may rewrite or omit individual messages. Keep originals
      // above and append the exact retained projection instead of resurrecting them.
      visible.forEach((message, index) => {
        const id = `migration-${compaction.id}-${index}`;
        if (byId.has(id)) throw new Error("Migration entry id collision");
        append({ kind: "entry", type: "message", id, parentId,
          timestamp: message.timestamp, message });
        if (index === 0) firstKeptEntryId = id;
      });
    }
    records.push({ type: "compaction", id: compaction.id, parentId,
      timestamp: timestamp(compaction.details?.summaryTimestamp ?? compaction.timestamp),
      summary: compaction.summary, firstKeptEntryId, tokensBefore: compaction.tokensBefore ?? 0,
      details: compaction.details, fromHook: compaction.fromHook });
  }
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

const importType = "platform.v4-import";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function reconcile(home: string, mapping: Mapping, journal: Journal): Promise<void> {
  const destination = sessionPath(home, mapping.sid);
  const current = await optionalRead(destination);
  const converted = convert(journal, mapping.sid);
  if (current !== undefined) {
    const lines = current.trimEnd().split("\n");
    const index = lines.findIndex((line) => {
      const entry = JSON.parse(line);
      return entry.type === "custom" && entry.customType === importType;
    });
    if (index >= 0) {
      const metadata = JSON.parse(lines[index]!).data;
      if (isDeepStrictEqual(metadata.identity, journal.identity) &&
          metadata.lastSeq === journal.lastSeq && metadata.sourceHash === journal.sourceHash) return;
      const prefix = lines.slice(0, index).join("\n") + "\n";
      if (index !== lines.length - 1 || digest(prefix) !== metadata.contentHash) {
        console.warn(`Keeping Pi session ${mapping.sid}: v4 source changed after Pi wrote session entries`);
        return;
      }
    } else if (current !== converted) {
      // Pre-metadata imports cannot be distinguished safely from Pi-written files.
      console.warn(`Keeping Pi session ${mapping.sid}: no import metadata proves it is unchanged`);
      return;
    }
    // Keep the live name until replacement, including across a crash.
    await link(destination, `${destination}.superseded-${Date.now()}-${randomUUID()}`);
    await syncDirectory(dirname(destination));
  }
  const last = JSON.parse(converted.trimEnd().split("\n").at(-1)!);
  const metadata = { type: "custom", customType: importType, id: randomUUID(),
    parentId: last.type === "session" ? null : last.id, timestamp: new Date().toISOString(),
    data: { identity: journal.identity, lastSeq: journal.lastSeq, sourceHash: journal.sourceHash,
      contentHash: digest(converted) } };
  await publish(destination, converted + JSON.stringify(metadata) + "\n");
}

async function publish(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function migrateSessions(home: string): Promise<void> {
  const directory = join(home, "sessions-v3");
  const marker = join(directory, ".migrated-from-v4");
  const mappingText = await optionalRead(join(home, "migration", "active-sessions.json"));
  if (mappingText === undefined) return;
  const mappings = JSON.parse(mappingText) as Mapping[];
  if (!Array.isArray(mappings) || mappings.some((mapping) =>
    ![mapping.sid, mapping.scope_key, mapping.lifecycle_id, mapping.session_id]
      .every((value) => typeof value === "string" && value.length > 0))) {
    throw new Error("Invalid active session migration mapping");
  }
  const sourceMarker = await optionalRead(join(home, "sessions", ".pi-native"));
  if (sourceMarker !== undefined && sourceMarker.trim() !== "4") throw new Error("Unsupported source session format");
  const key = (identity: Identity) => JSON.stringify([identity.scope_key, identity.lifecycle_id, identity.session_id]);
  const active = new Map(mappings.map((mapping) => [key(mapping), mapping]));
  const found = new Set<string>();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Persist the sessions-v3 directory itself before publishing its children.
  await syncDirectory(home);
  for await (const path of journals(join(home, "sessions", "journals"))) {
    const journal = parseJournal(await readFile(path, "utf8"));
    if (!journal.identity) continue;
    const identityKey = key(journal.identity);
    const mapping = active.get(identityKey);
    if (!mapping) continue;
    if (found.has(identityKey)) throw new Error(`Multiple journals for active session ${mapping.sid}`);
    found.add(identityKey);
    await reconcile(home, mapping, journal);
  }
  // A reset can select a new identity before the old runtime creates its journal.
  for (const mapping of mappings) {
    if (!found.has(key(mapping)) && await optionalRead(sessionPath(home, mapping.sid)) !== undefined) {
      await reconcile(home, mapping, { header: { v: 4, kind: "header", createdAt: 0, cwd: "/workspace" },
        identity: { scope_key: mapping.scope_key, lifecycle_id: mapping.lifecycle_id, session_id: mapping.session_id },
        entries: [], tip: null, lastSeq: 0, sourceHash: digest("") });
    }
  }
  await publish(marker, "4\n");
}
