import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
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

test("SessionStore keeps live tool images out of durable journals", async () => {
  const home = await temporaryDirectory("agent-session-tool-image-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const encoded = Buffer.alloc(2 * 1024 * 1024, 0x5a).toString("base64");
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "browser-call",
      toolName: "browser",
      content: [
        { type: "text", text: "Captured browser screenshot" },
        { type: "image", data: encoded, mimeType: "image/png" },
      ],
      details: {
        screenshot: { data: encoded, mimeType: "image/png" },
        nested: [{ type: "image", data: encoded, mimeType: "image/webp", bytes: 2 * 1024 * 1024 }],
        safe: { data: "ordinary structured data", mimeType: "text/plain" },
      },
      isError: false,
      timestamp: 1,
    };
    await store.initialize(identity);
    await store.appendMessage(identity, result);

    assert.equal(result.content[1]?.type, "image", "persistence must not mutate the live tool result");
    const loaded = await store.load(identity);
    assert.equal(loaded.length, 1);
    const persisted = loaded[0];
    assert.equal(persisted?.role, "toolResult");
    assert.equal(persisted?.role === "toolResult" ? persisted.content.some((block) => block.type === "image") : true, false);
    assert.match(
      persisted?.role === "toolResult" ? persisted.content.map((block) => block.type === "text" ? block.text : "").join("\n") : "",
      /omitted from durable session history/,
    );
    const persistedDetails = persisted?.role === "toolResult"
      ? persisted.details as {
          screenshot: { data?: string; mimeType: string; bytes: number; omitted: boolean };
          nested: Array<{ data?: string; type: string; mimeType: string; bytes: number; omitted: boolean }>;
          safe: { data: string; mimeType: string };
        }
      : undefined;
    assert.equal(persistedDetails?.screenshot.data, undefined);
    assert.equal(persistedDetails?.screenshot.mimeType, "image/png");
    assert.equal(persistedDetails?.screenshot.bytes, 2 * 1024 * 1024);
    assert.equal(persistedDetails?.screenshot.omitted, true);
    assert.equal(persistedDetails?.nested[0]?.data, undefined);
    assert.equal(persistedDetails?.nested[0]?.type, "image");
    assert.equal(persistedDetails?.nested[0]?.mimeType, "image/webp");
    assert.equal(persistedDetails?.nested[0]?.bytes, 2 * 1024 * 1024);
    assert.equal(persistedDetails?.nested[0]?.omitted, true);
    assert.equal(persistedDetails?.safe.data, "ordinary structured data");
    const liveDetails = result.details as {
      screenshot: { data: string };
      nested: Array<{ data: string }>;
    };
    assert.equal(liveDetails.screenshot.data, encoded, "persistence must not mutate live details");
    assert.equal(liveDetails.nested[0]?.data, encoded, "nested live details must remain unchanged");
    const raw = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(raw, new RegExp(encoded.slice(0, 100)));
    assert.ok(Buffer.byteLength(raw) < 10_000, `durable journal unexpectedly used ${Buffer.byteLength(raw)} bytes`);

    await store.rewriteCompacted(identity, [result], {
      omitted_messages: 0,
      retained_messages: 1,
    });
    const compactedRaw = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(compactedRaw, new RegExp(encoded.slice(0, 100)));
    assert.ok(Buffer.byteLength(compactedRaw) < 10_000);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore replaces user images without mutating the live user message", async () => {
  const home = await temporaryDirectory("agent-session-user-image-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const encoded = Buffer.alloc(512 * 1024, 0x31).toString("base64");
    const message: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "Please inspect this image" },
        { type: "image", data: encoded, mimeType: "image/png" },
      ],
      timestamp: 1,
    };

    await store.initialize(identity);
    await store.appendMessage(identity, message);

    assert.equal(Array.isArray(message.content) ? message.content[1]?.type : undefined, "image");
    assert.equal(
      Array.isArray(message.content) && message.content[1]?.type === "image" ? message.content[1].data : undefined,
      encoded,
      "persistence must not mutate the live user image",
    );
    const loaded = await store.load(identity);
    const persisted = loaded[0];
    assert.equal(persisted?.role, "user");
    assert.equal(
      persisted?.role === "user" && Array.isArray(persisted.content)
        ? persisted.content.some((block) => block.type === "image")
        : true,
      false,
    );
    assert.match(JSON.stringify(persisted), /User image \(image\/png\).*omitted from durable session history/);
    const raw = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(raw, new RegExp(encoded.slice(0, 100)));
    assert.ok(Buffer.byteLength(raw) < 10_000);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
