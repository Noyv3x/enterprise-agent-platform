import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { SessionStore } from "../src/session-store.js";
import { temporaryDirectory } from "./helpers.js";

test("SessionStore seeds once and isolates sessions", async () => {
  const home = await temporaryDirectory("agent-session-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const seed: UserMessage = { role: "user", content: "seed", timestamp: 1 };
    assert.deepEqual(await store.initialize(identity, [seed]), [seed]);
    assert.deepEqual(await store.initialize(identity, [{ ...seed, content: "must-not-reseed" }]), [seed]);
    const other = { ...identity, session_id: "other" };
    assert.deepEqual(await store.load(other), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore ignores an incomplete final JSONL record", async () => {
  const home = await temporaryDirectory("agent-session-tail-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const message: UserMessage = { role: "user", content: "kept", timestamp: 1 };
    await store.initialize(identity, [message]);
    await appendFile(store.path(identity), "{\"incomplete\":");
    assert.deepEqual(await store.load(identity), [message]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore reads an existing journal with unknown header metadata without rewriting it", async () => {
  const home = await temporaryDirectory("agent-session-header-metadata-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const message: UserMessage = { role: "user", content: "existing history", timestamp: 1 };
    const entries = [
      {
        id: "existing-header",
        type: "header",
        timestamp: "2026-01-01T00:00:00.000Z",
        ...identity,
        payload: {
          version: 1,
          unknown_extension: {
            owner: "retired-importer",
            version: 7,
            digest: "opaque-metadata",
          },
        },
      },
      {
        id: "existing-message",
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        ...identity,
        payload: message,
      },
    ];
    const journal = store.path(identity);
    await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
    const original = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(journal, original, { mode: 0o600 });

    const replacementSeed: UserMessage = { role: "user", content: "must-not-reseed", timestamp: 2 };
    assert.deepEqual(await store.initialize(identity, [replacementSeed]), [message]);
    assert.equal(await readFile(journal, "utf8"), original);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore atomically replaces compacted history instead of growing forever", async () => {
  const home = await temporaryDirectory("agent-session-compact-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "discard-this-old-message", timestamp: 1 };
    const retained: UserMessage = { role: "user", content: "retain-this-message", timestamp: 2 };
    await store.initialize(identity, [old]);
    await store.appendMessage(identity, retained);

    await store.rewriteCompacted(identity, [retained], {
      omitted_messages: 1,
      retained_messages: 1,
    });

    assert.deepEqual(await store.load(identity), [retained]);
    const raw = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(raw, /discard-this-old-message/);
    assert.match(raw, /retain-this-message/);
    assert.equal((raw.match(/"type":"header"/g) ?? []).length, 1);
    assert.equal((raw.match(/"type":"compaction"/g) ?? []).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
