import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { validateProductModelRequest } from "./model-resolver.js";
import { SessionStore, type SessionIdentity } from "./session-store.js";
import type { ModelRequest } from "./types.js";

export const LEGACY_IMPORT_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024 * 1024,
  sessionBytes: 8 * 1024 * 1024,
  messageBytes: 1024 * 1024,
  totalContentBytes: 32 * 1024 * 1024,
  sessions: 10_000,
  messagesPerSession: 10_000,
  totalMessages: 100_000,
  identityBytes: 2_048,
  identityCharacters: 512,
});

export interface LegacyImportCounts {
  total: number;
  created: number;
  replaced: number;
  skipped: number;
  invalid: number;
}

interface LegacyMessageInput {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface LegacySessionInput extends SessionIdentity {
  model: ModelRequest;
  messages: LegacyMessageInput[];
}

interface LegacyImportManifest {
  version: 1;
  sessions: LegacySessionInput[];
}

const EMPTY_COUNTS: LegacyImportCounts = { total: 0, created: 0, replaced: 0, skipped: 0, invalid: 0 };
const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

/** Read and validate a private, non-symlink migration manifest. */
export async function readLegacyImportManifest(path: string): Promise<LegacyImportManifest> {
  if (!isAbsolute(path)) throw new Error("Legacy import manifest path must be absolute");
  const initialInfo = await lstat(path);
  if (initialInfo.isSymbolicLink() || !initialInfo.isFile()) {
    throw new Error("Legacy import manifest must be a non-symlink regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Legacy import manifest must be a regular file");
    if ((info.mode & 0o777) !== 0o600) throw new Error("Legacy import manifest permissions must be 0600");
    if (info.size > LEGACY_IMPORT_LIMITS.manifestBytes) throw new Error("Legacy import manifest is too large");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== info.size || bytes.byteLength > LEGACY_IMPORT_LIMITS.manifestBytes) {
      throw new Error("Legacy import manifest changed while being read");
    }
    return validateManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}

/** Import a fully validated manifest without exposing its content in results. */
export async function importLegacySessions(
  manifest: unknown,
  homeInput: string,
): Promise<LegacyImportCounts> {
  const validated = validateManifest(manifest);
  const home = await preparePrivateHome(homeInput);
  const store = new SessionStore(home);
  const counts: LegacyImportCounts = { ...EMPTY_COUNTS, total: validated.sessions.length };
  for (const session of validated.sessions) {
    const model = resolveManifestModel(session.model);
    const messages = session.messages.map((message) => normalizeMessage(message, model));
    const result = await store.importLegacyHistory(session, messages);
    counts[result] += 1;
  }
  return counts;
}

export async function importLegacyManifestFile(manifestPath: string, homeInput: string): Promise<LegacyImportCounts> {
  const manifest = await readLegacyImportManifest(manifestPath);
  return await importLegacySessions(manifest, homeInput);
}

export async function runLegacySessionImporter(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LegacyImportCounts> {
  const options = parseArguments(argv);
  const configuredHome = options.home ?? environment.AGENT_RUNTIME_HOME;
  if (!configuredHome) throw new Error("Agent runtime home is required");
  return await importLegacyManifestFile(options.manifest, configuredHome);
}

async function preparePrivateHome(homeInput: string): Promise<string> {
  const home = resolve(homeInput);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Agent runtime home must be a real directory");
  await chmod(home, 0o700);
  const sessions = join(home, "sessions");
  try {
    await mkdir(sessions, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const sessionsInfo = await lstat(sessions);
  if (sessionsInfo.isSymbolicLink() || !sessionsInfo.isDirectory()) {
    throw new Error("Agent runtime sessions directory must be a real directory");
  }
  await chmod(sessions, 0o700);
  return home;
}

function validateManifest(value: unknown): LegacyImportManifest {
  const manifest = requireRecord(value, "manifest");
  requireExactKeys(manifest, ["version", "sessions"], "manifest");
  if (manifest.version !== 1) throw new Error("Unsupported legacy import manifest version");
  if (!Array.isArray(manifest.sessions)) throw new Error("manifest.sessions must be an array");
  if (manifest.sessions.length > LEGACY_IMPORT_LIMITS.sessions) throw new Error("Legacy import contains too many sessions");

  let totalContentBytes = 0;
  let totalMessages = 0;
  const identities = new Set<string>();
  const sessions = manifest.sessions.map((candidate, sessionIndex): LegacySessionInput => {
    const session = requireRecord(candidate, `session ${sessionIndex}`);
    requireExactKeys(session, ["scope_key", "lifecycle_id", "session_id", "model", "messages"], `session ${sessionIndex}`);
    if (Buffer.byteLength(JSON.stringify(session)) > LEGACY_IMPORT_LIMITS.sessionBytes) {
      throw new Error("Legacy import session is too large");
    }
    const identity: SessionIdentity = {
      scope_key: requireIdentity(session.scope_key, "scope_key"),
      lifecycle_id: requireIdentity(session.lifecycle_id, "lifecycle_id"),
      session_id: requireIdentity(session.session_id, "session_id"),
    };
    const identityKey = `${identity.scope_key}\0${identity.lifecycle_id}\0${identity.session_id}`;
    if (identities.has(identityKey)) throw new Error("Legacy import contains a duplicate session identity");
    identities.add(identityKey);

    const modelRecord = requireRecord(session.model, "model");
    requireExactKeys(modelRecord, ["provider", "id"], "model");
    const model: ModelRequest = {
      provider: requireString(modelRecord.provider, "model.provider"),
      id: requireString(modelRecord.id, "model.id"),
    };
    // Validate against the fixed product catalog before any file is written.
    resolveManifestModel(model);

    if (!Array.isArray(session.messages)) throw new Error("session.messages must be an array");
    if (session.messages.length > LEGACY_IMPORT_LIMITS.messagesPerSession) {
      throw new Error("Legacy import session contains too many messages");
    }
    totalMessages += session.messages.length;
    if (totalMessages > LEGACY_IMPORT_LIMITS.totalMessages) throw new Error("Legacy import contains too many messages");
    const messages = session.messages.map((messageCandidate, messageIndex): LegacyMessageInput => {
      const message = requireRecord(messageCandidate, `message ${messageIndex}`);
      requireExactKeys(message, ["role", "content", "timestamp"], `message ${messageIndex}`);
      if (message.role !== "user" && message.role !== "assistant") {
        throw new Error("Legacy import message role must be user or assistant");
      }
      const content = requireString(message.content, "message.content", true);
      const contentBytes = Buffer.byteLength(content);
      if (contentBytes > LEGACY_IMPORT_LIMITS.messageBytes) throw new Error("Legacy import message is too large");
      totalContentBytes += contentBytes;
      if (totalContentBytes > LEGACY_IMPORT_LIMITS.totalContentBytes) {
        throw new Error("Legacy import message content exceeds the total limit");
      }
      if (!Number.isSafeInteger(message.timestamp) || Number(message.timestamp) < 0) {
        throw new Error("Legacy import message timestamp must be a non-negative integer");
      }
      return { role: message.role, content, timestamp: Number(message.timestamp) };
    });
    return { ...identity, model, messages };
  });
  return { version: 1, sessions };
}

function resolveManifestModel(request: ModelRequest): Model<Api> {
  const provider = validateProductModelRequest(request);
  const lookup = getModel as unknown as (providerId: string, modelId: string) => Model<Api> | undefined;
  const model = lookup(provider, request.id);
  if (!model) throw new Error("Legacy import model metadata is unavailable");
  return model;
}

function normalizeMessage(message: LegacyMessageInput, model: Model<Api>): AgentMessage {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp: message.timestamp } satisfies UserMessage;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      ...ZERO_USAGE,
      cost: { ...ZERO_USAGE.cost },
    },
    stopReason: "stop",
    timestamp: message.timestamp,
  } satisfies AssistantMessage;
}

function requireIdentity(value: unknown, name: string): string {
  const text = requireString(value, name);
  if (text.length > LEGACY_IMPORT_LIMITS.identityCharacters || Buffer.byteLength(text) > LEGACY_IMPORT_LIMITS.identityBytes) {
    throw new Error(`${name} is too long`);
  }
  return text;
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) throw new Error(`${name} must be a string`);
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${name} has an invalid shape`);
  }
}

function parseArguments(argv: string[]): { manifest: string; home?: string } {
  let manifest: string | undefined;
  let home: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if ((option !== "--manifest" && option !== "--home") || !value || value.startsWith("--")) {
      throw new Error("Invalid legacy import arguments");
    }
    if (option === "--manifest") {
      if (manifest) throw new Error("Duplicate legacy import manifest argument");
      manifest = value;
    } else {
      if (home) throw new Error("Duplicate Agent runtime home argument");
      home = value;
    }
    index += 1;
  }
  if (!manifest) throw new Error("Legacy import manifest is required");
  return home ? { manifest, home } : { manifest };
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  runLegacySessionImporter(process.argv.slice(2)).then(
    (counts) => {
      process.stdout.write(`${JSON.stringify(counts)}\n`);
    },
    () => {
      process.stdout.write(`${JSON.stringify({ ...EMPTY_COUNTS, invalid: 1 })}\n`);
      process.exitCode = 1;
    },
  );
}
