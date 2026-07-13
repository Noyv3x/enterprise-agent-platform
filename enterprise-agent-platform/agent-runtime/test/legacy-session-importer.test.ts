import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  importLegacySessions,
  LEGACY_IMPORT_LIMITS,
  readLegacyImportManifest,
} from "../src/legacy-session-importer.js";
import { SessionStore } from "../src/session-store.js";
import { stableHash } from "../src/utils.js";
import { temporaryDirectory } from "./helpers.js";

const identity = { scope_key: "user:42", lifecycle_id: "legacy-life", session_id: "private" };

test("legacy importer normalizes visible history with Pi model metadata and hashed paths", async () => {
  const home = await temporaryDirectory("agent-legacy-import-");
  try {
    const counts = await importLegacySessions(manifest([
      { role: "user", content: "question", timestamp: 1 },
      { role: "assistant", content: "answer", timestamp: 2 },
    ]), home);
    assert.deepEqual(counts, { total: 1, created: 1, replaced: 0, skipped: 0, invalid: 0 });

    const store = new SessionStore(home);
    const messages = await store.load(identity);
    assert.deepEqual(messages[0], { role: "user", content: "question", timestamp: 1 });
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    assert.equal(store.path(identity), join(
      home,
      "sessions",
      stableHash(identity.scope_key),
      stableHash(identity.lifecycle_id),
      `${stableHash(identity.session_id)}.jsonl`,
    ));
    assert.equal((await stat(store.path(identity))).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy importer refreshes only its own unchanged unused journal", async () => {
  const home = await temporaryDirectory("agent-legacy-refresh-");
  try {
    const first = manifest([{ role: "user", content: "old", timestamp: 1 }]);
    const updated = manifest([{ role: "user", content: "new", timestamp: 2 }]);
    await importLegacySessions(first, home);
    assert.deepEqual(await importLegacySessions(updated, home), {
      total: 1,
      created: 0,
      replaced: 1,
      skipped: 0,
      invalid: 0,
    });
    assert.equal(messageText((await new SessionStore(home).load(identity))[0]), "new");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy importer never overwrites a journal after Pi appends a message or run", async () => {
  const home = await temporaryDirectory("agent-legacy-used-");
  try {
    const store = new SessionStore(home);
    await importLegacySessions(manifest([{ role: "user", content: "imported", timestamp: 1 }]), home);
    await store.appendMessage(identity, { role: "user", content: "live", timestamp: 2 });
    assert.deepEqual(await importLegacySessions(manifest([{ role: "user", content: "replacement", timestamp: 3 }]), home), {
      total: 1,
      created: 0,
      replaced: 0,
      skipped: 1,
      invalid: 0,
    });
    assert.deepEqual((await store.load(identity)).map(messageText), ["imported", "live"]);

    const runIdentity = { ...identity, session_id: "with-run" };
    const runManifest = manifest([{ role: "user", content: "before", timestamp: 1 }], runIdentity);
    await importLegacySessions(runManifest, home);
    await store.appendRun(runIdentity, { run_id: "real-run", status: "completed" });
    const replacement = manifest([{ role: "user", content: "after", timestamp: 2 }], runIdentity);
    assert.equal((await importLegacySessions(replacement, home)).skipped, 1);
    assert.equal(messageText((await store.load(runIdentity))[0]), "before");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi initialization consumes the replaceable migration marker before a run writes messages", async () => {
  const home = await temporaryDirectory("agent-legacy-consume-");
  try {
    const store = new SessionStore(home);
    await importLegacySessions(manifest([{ role: "user", content: "imported", timestamp: 1 }]), home);
    assert.equal(messageText((await store.initialize(identity))[0]), "imported");
    const counts = await importLegacySessions(manifest([{ role: "user", content: "replacement", timestamp: 2 }]), home);
    assert.equal(counts.skipped, 1);
    assert.equal(messageText((await store.load(identity))[0]), "imported");
    assert.match(await readFile(store.path(identity), "utf8"), /legacy_migration_consumed/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy importer treats a torn journal tail as evidence of runtime use", async () => {
  const home = await temporaryDirectory("agent-legacy-torn-");
  try {
    const store = new SessionStore(home);
    await importLegacySessions(manifest([{ role: "user", content: "imported", timestamp: 1 }]), home);
    const original = await readFile(store.path(identity), "utf8");
    await writeFile(store.path(identity), `${original}{"id":"entry_live"`, { mode: 0o600 });
    const counts = await importLegacySessions(manifest([{ role: "user", content: "replacement", timestamp: 2 }]), home);
    assert.equal(counts.skipped, 1);
    assert.equal(await readFile(store.path(identity), "utf8"), `${original}{"id":"entry_live"`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy importer skips an ordinary Pi journal with no migration marker", async () => {
  const home = await temporaryDirectory("agent-legacy-existing-");
  try {
    const store = new SessionStore(home);
    await store.initialize(identity, [{ role: "user", content: "Pi data", timestamp: 1 }]);
    const rawBefore = await readFile(store.path(identity), "utf8");
    const counts = await importLegacySessions(manifest([{ role: "user", content: "legacy", timestamp: 2 }]), home);
    assert.equal(counts.skipped, 1);
    assert.equal(await readFile(store.path(identity), "utf8"), rawBefore);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("manifest reader requires an absolute 0600 regular file and rejects symlinks", async () => {
  const root = await temporaryDirectory("agent-legacy-manifest-");
  try {
    const path = join(root, "manifest.json");
    await writeFile(path, JSON.stringify(manifest([])), { mode: 0o600 });
    assert.equal((await readLegacyImportManifest(path)).sessions.length, 1);

    await chmod(path, 0o640);
    await assert.rejects(readLegacyImportManifest(path), /permissions must be 0600/);
    await chmod(path, 0o600);
    const alias = join(root, "manifest-link.json");
    await symlink(path, alias);
    await assert.rejects(readLegacyImportManifest(alias));
    await assert.rejects(readLegacyImportManifest("manifest.json"), /must be absolute/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest reader rejects a FIFO without waiting for a writer", async () => {
  const root = await temporaryDirectory("agent-legacy-fifo-");
  try {
    const path = join(root, "manifest.pipe");
    execFileSync("mkfifo", [path]);
    await assert.rejects(readLegacyImportManifest(path), /regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest reader rejects a sparse file over the manifest byte limit before reading", async () => {
  const root = await temporaryDirectory("agent-legacy-large-manifest-");
  try {
    const path = join(root, "manifest.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await truncate(path, LEGACY_IMPORT_LIMITS.manifestBytes + 1);
    await assert.rejects(readLegacyImportManifest(path), /too large/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy importer enforces individual, session, and total content bounds before writing", async () => {
  const home = await temporaryDirectory("agent-legacy-limits-");
  try {
    await assert.rejects(
      importLegacySessions(manifest([{
        role: "user",
        content: "x".repeat(LEGACY_IMPORT_LIMITS.messageBytes + 1),
        timestamp: 1,
      }]), home),
      /message is too large/,
    );

    const oneMegabyte = "x".repeat(LEGACY_IMPORT_LIMITS.messageBytes);
    const sessions = Array.from({ length: 33 }, (_, index) => ({
      ...identity,
      session_id: `total-${index}`,
      model: { provider: "codex", id: "gpt-5.4" },
      messages: [{ role: "user", content: oneMegabyte, timestamp: index }],
    }));
    await assert.rejects(
      importLegacySessions({ version: 1, sessions }, home),
      /total limit/,
    );

    const tooLargeSession = {
      version: 1,
      sessions: [{
        ...identity,
        model: { provider: "codex", id: "gpt-5.4" },
        messages: Array.from({ length: 8 }, (_, index) => ({
          role: "user",
          content: oneMegabyte,
          timestamp: index,
        })),
      }],
    };
    await assert.rejects(importLegacySessions(tooLargeSession, home), /session is too large/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("manifest cannot control paths and home/session symlinks are rejected", async () => {
  const root = await temporaryDirectory("agent-legacy-paths-");
  try {
    const controlled = manifest([]) as Record<string, unknown>;
    await assert.rejects(
      importLegacySessions({ ...controlled, home: "/tmp/escape" }, join(root, "home")),
      /invalid shape/,
    );
    const realHome = join(root, "real-home");
    const linkedHome = join(root, "linked-home");
    await mkdir(realHome, { mode: 0o700 });
    await symlink(realHome, linkedHome);
    await assert.rejects(importLegacySessions(manifest([]), linkedHome), /real directory/);

    const home = join(root, "runtime-home");
    const escape = join(root, "escape");
    await mkdir(home, { mode: 0o700 });
    await mkdir(escape, { mode: 0o700 });
    await symlink(escape, join(home, "sessions"));
    await assert.rejects(importLegacySessions(manifest([]), home), /sessions directory must be a real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI contract reads a private manifest and returns content-free JSON counts", async () => {
  const root = await temporaryDirectory("agent-legacy-cli-");
  try {
    const manifestPath = join(root, "legacy.json");
    const home = join(root, "home");
    await writeFile(
      manifestPath,
      JSON.stringify(manifest([{ role: "assistant", content: "sensitive-visible-content", timestamp: 1 }])),
      { mode: 0o600 },
    );
    const importer = fileURLToPath(new URL("../src/legacy-session-importer.js", import.meta.url));
    const output = execFileSync(process.execPath, [importer, "--manifest", manifestPath, "--home", home], {
      encoding: "utf8",
      env: {},
    });
    assert.equal(output, '{"total":1,"created":1,"replaced":0,"skipped":0,"invalid":0}\n');
    assert.doesNotMatch(output, /sensitive|content|gpt|codex/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function manifest(
  messages: Array<{ role: string; content: string; timestamp: number }>,
  sessionIdentity = identity,
): unknown {
  return {
    version: 1,
    sessions: [{
      ...sessionIdentity,
      model: { provider: "codex", id: "gpt-5.4" },
      messages,
    }],
  };
}

function messageText(message: unknown): string {
  const candidate = message as { content?: string | Array<{ type?: string; text?: string }> };
  if (typeof candidate.content === "string") return candidate.content;
  return candidate.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "";
}
