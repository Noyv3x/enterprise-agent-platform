import assert from "node:assert/strict";
import { appendFile, readFile, rm } from "node:fs/promises";
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
