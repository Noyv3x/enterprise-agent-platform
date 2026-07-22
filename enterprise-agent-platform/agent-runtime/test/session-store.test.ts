import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  CURRENT_MODEL_CONTENT_SECURITY_VERSION,
  SessionStore,
} from "../src/session-store.js";
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

test("SessionStore distinguishes legacy/imported messages from runtime-secured messages", async () => {
  const home = await temporaryDirectory("agent-session-content-security-version-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const legacy: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "legacy-web-call",
      toolName: "web",
      content: [{ type: "text", text: "legacy search result" }],
      details: null,
      isError: false,
      timestamp: 1,
    };
    const current: ToolResultMessage = {
      ...legacy,
      toolCallId: "current-web-call",
      content: [{ type: "text", text: "current framed search result" }],
      timestamp: 2,
    };
    const [legacyTracked] = await store.initializeTracked(identity, [legacy]);
    const currentEntryId = await store.appendMessage(
      identity,
      current,
      CURRENT_MODEL_CONTENT_SECURITY_VERSION,
    );
    const beforeReload = await readFile(store.path(identity), "utf8");

    const reloaded = await store.initializeTracked(identity);

    assert.equal(legacyTracked?.model_content_security_version, undefined);
    assert.equal(reloaded.find((entry) => entry.entry_id === legacyTracked?.entry_id)?.model_content_security_version, undefined);
    assert.equal(
      reloaded.find((entry) => entry.entry_id === currentEntryId)?.model_content_security_version,
      CURRENT_MODEL_CONTENT_SECURITY_VERSION,
    );
    assert.equal(
      await readFile(store.path(identity), "utf8"),
      beforeReload,
      "loading version metadata must not rewrite legacy JSONL",
    );
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
    const [oldEntry] = await store.initializeTracked(identity, [old]);
    const retainedEntryId = await store.appendMessage(identity, retained);
    assert.ok(oldEntry);

    await store.rewriteCompacted(identity, [{ entry_id: retainedEntryId, message: retained }], {
      omitted_messages: 1,
      retained_messages: 1,
    }, [oldEntry.entry_id]);

    assert.deepEqual(await store.load(identity), [retained]);
    assert.deepEqual(await store.loadSearchable(identity), [old, retained]);
    const raw = await readFile(store.path(identity), "utf8");
    const archive = await readFile(store.archivePath(identity), "utf8");
    assert.doesNotMatch(raw, /discard-this-old-message/);
    assert.match(raw, /retain-this-message/);
    assert.match(archive, /discard-this-old-message/);
    assert.doesNotMatch(archive, /retain-this-message/);
    assert.equal((await stat(store.archivePath(identity))).mode & 0o777, 0o600);
    assert.equal((raw.match(/"type":"header"/g) ?? []).length, 1);
    assert.equal((raw.match(/"type":"compaction"/g) ?? []).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore archive is idempotent when compaction resumes after archive fsync", async () => {
  const home = await temporaryDirectory("agent-session-archive-recovery-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "archive-exactly-once", timestamp: 1 };
    const retained: UserMessage = { role: "user", content: "still-current", timestamp: 2 };
    const [retainedEntry] = await store.initializeTracked(identity, [retained]);
    const oldEntryId = await store.appendMessage(identity, old);
    assert.ok(retainedEntry);
    const beforeCompaction = await readFile(store.path(identity), "utf8");

    const compacted = [{ entry_id: retainedEntry.entry_id, message: retained }];
    await store.rewriteCompacted(identity, compacted, { omitted_messages: 1 }, [oldEntryId]);
    await writeFile(store.path(identity), beforeCompaction, { mode: 0o600 });
    await store.rewriteCompacted(identity, compacted, { omitted_messages: 1 }, [oldEntryId]);

    const archive = await readFile(store.archivePath(identity), "utf8");
    assert.equal((archive.match(/archive-exactly-once/g) ?? []).length, 1);
    assert.doesNotMatch(archive, /still-current/);
    assert.deepEqual(await store.loadSearchable(identity), [old, retained]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore serializes a concurrent append behind the complete compaction rewrite", async () => {
  const home = await temporaryDirectory("agent-session-compaction-append-race-");
  let releaseReplace = (): void => {};
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "archive-before-race", timestamp: 1 };
    const retained: UserMessage = { role: "user", content: "retained-before-race", timestamp: 2 };
    const concurrent: UserMessage = { role: "user", content: "concurrent-append-must-survive", timestamp: 3 };
    const [oldEntry] = await store.initializeTracked(identity, [old]);
    const retainedEntryId = await store.appendMessage(identity, retained);
    assert.ok(oldEntry);

    const internals = store as unknown as {
      replaceRaw(file: string, entries: object[]): Promise<void>;
    };
    const originalReplaceRaw = internals.replaceRaw.bind(store);
    let replaceReached = (): void => {};
    const reachedReplace = new Promise<void>((resolve) => { replaceReached = resolve; });
    const replaceGate = new Promise<void>((resolve) => { releaseReplace = resolve; });
    let intercepted = false;
    internals.replaceRaw = async (file, entries) => {
      if (!intercepted && file === store.path(identity)) {
        intercepted = true;
        replaceReached();
        await replaceGate;
      }
      await originalReplaceRaw(file, entries);
    };

    const rewrite = store.rewriteCompacted(
      identity,
      [{ entry_id: retainedEntryId, message: retained }],
      { omitted_messages: 1, retained_messages: 1 },
      [oldEntry.entry_id],
    );
    await reachedReplace;
    let appendSettled = false;
    const append = store.appendMessage(identity, concurrent).finally(() => { appendSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const appendSettledBeforeRewrite = appendSettled;
    releaseReplace();
    await Promise.all([rewrite, append]);

    assert.equal(appendSettledBeforeRewrite, false, "append must wait for the logical rewrite transaction");
    assert.deepEqual(await store.load(identity), [retained, concurrent]);
    assert.deepEqual(await store.loadSearchable(identity), [old, retained, concurrent]);
  } finally {
    releaseReplace();
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore rejects a stale compaction snapshot before archiving or replacing current messages", async () => {
  const home = await temporaryDirectory("agent-session-stale-compaction-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "old-stale-snapshot-message", timestamp: 1 };
    const retained: UserMessage = { role: "user", content: "retained-stale-snapshot-message", timestamp: 2 };
    const newer: UserMessage = { role: "user", content: "newer-message-outside-stale-snapshot", timestamp: 3 };
    const [oldEntry] = await store.initializeTracked(identity, [old]);
    const retainedEntryId = await store.appendMessage(identity, retained);
    await store.appendMessage(identity, newer);
    assert.ok(oldEntry);

    await assert.rejects(
      store.rewriteCompacted(
        identity,
        [{ entry_id: retainedEntryId, message: retained }],
        { omitted_messages: 1, retained_messages: 1 },
        [oldEntry.entry_id],
      ),
      /Cannot compact unclassified current session entry/,
    );

    assert.deepEqual(await store.load(identity), [old, retained, newer]);
    await assert.rejects(readFile(store.archivePath(identity), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore explicitly discards the prior synthetic notice during repeated compaction", async () => {
  const home = await temporaryDirectory("agent-session-repeated-compaction-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "first-archived-message", timestamp: 1 };
    const middle: UserMessage = { role: "user", content: "second-archived-message", timestamp: 2 };
    const retained: UserMessage = { role: "user", content: "finally-retained-message", timestamp: 3 };
    const firstNotice: UserMessage = { role: "user", content: "first-synthetic-notice", timestamp: 4 };
    const secondNotice: UserMessage = { role: "user", content: "second-synthetic-notice", timestamp: 5 };
    const [oldEntry] = await store.initializeTracked(identity, [old]);
    const middleEntryId = await store.appendMessage(identity, middle);
    const retainedEntryId = await store.appendMessage(identity, retained);
    assert.ok(oldEntry);

    const firstRewriteIds = await store.rewriteCompacted(
      identity,
      [
        { message: firstNotice },
        { entry_id: middleEntryId, message: middle },
        { entry_id: retainedEntryId, message: retained },
      ],
      { omitted_messages: 1, retained_messages: 3 },
      [oldEntry.entry_id],
    );
    const firstNoticeEntryId = firstRewriteIds[0];
    assert.ok(firstNoticeEntryId);

    await store.rewriteCompacted(
      identity,
      [
        { message: secondNotice },
        { entry_id: retainedEntryId, message: retained },
      ],
      { omitted_messages: 1, retained_messages: 2 },
      [middleEntryId],
      [firstNoticeEntryId],
    );

    assert.deepEqual(await store.load(identity), [secondNotice, retained]);
    const archive = await readFile(store.archivePath(identity), "utf8");
    assert.match(archive, /first-archived-message/);
    assert.match(archive, /second-archived-message/);
    assert.doesNotMatch(archive, /first-synthetic-notice/);
    assert.doesNotMatch(archive, /second-synthetic-notice/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore repairs an invalid partial archive tail before retrying compaction", async () => {
  const home = await temporaryDirectory("agent-session-archive-partial-tail-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "recover-after-partial-tail", timestamp: 1 };
    const retained: UserMessage = { role: "user", content: "retained-after-partial-tail", timestamp: 2 };
    const [oldEntry] = await store.initializeTracked(identity, [old]);
    const retainedEntryId = await store.appendMessage(identity, retained);
    assert.ok(oldEntry);
    await writeFile(store.archivePath(identity), "{\"id\":\"partial", { mode: 0o600 });

    await store.rewriteCompacted(
      identity,
      [{ entry_id: retainedEntryId, message: retained }],
      { omitted_messages: 1, retained_messages: 1 },
      [oldEntry.entry_id],
    );

    const archive = await readFile(store.archivePath(identity), "utf8");
    assert.equal((archive.match(/recover-after-partial-tail/g) ?? []).length, 1);
    assert.doesNotMatch(archive, /\"id\":\"partial/);
    assert.doesNotThrow(() => archive.trimEnd().split("\n").map((line) => JSON.parse(line)));
    assert.deepEqual(await store.loadSearchable(identity), [old, retained]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore preserves a complete archive record whose trailing newline was not durable", async () => {
  const home = await temporaryDirectory("agent-session-archive-missing-newline-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const old: UserMessage = { role: "user", content: "complete-record-without-newline", timestamp: 1 };
    const retained: UserMessage = { role: "user", content: "retained-after-complete-record", timestamp: 2 };
    const [oldEntry] = await store.initializeTracked(identity, [old]);
    const retainedEntryId = await store.appendMessage(identity, retained);
    assert.ok(oldEntry);
    const oldLine = (await readFile(store.path(identity), "utf8"))
      .trimEnd()
      .split("\n")
      .find((line) => (JSON.parse(line) as { id?: string }).id === oldEntry.entry_id);
    assert.ok(oldLine);
    await writeFile(store.archivePath(identity), oldLine, { mode: 0o600 });

    await store.rewriteCompacted(
      identity,
      [{ entry_id: retainedEntryId, message: retained }],
      { omitted_messages: 1, retained_messages: 1 },
      [oldEntry.entry_id],
    );

    const archive = await readFile(store.archivePath(identity), "utf8");
    assert.equal(archive.endsWith("\n"), true);
    assert.equal((archive.match(/complete-record-without-newline/g) ?? []).length, 1);
    assert.deepEqual(await store.loadSearchable(identity), [old, retained]);
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
        process: {
          command: `API_TOKEN=ghp_${"S".repeat(36)} printf ok`,
          authorization: "Bearer secret-value",
        },
        tokens: ["array-secret-value"],
        api_key: { value: "object-secret-value" },
      },
      isError: false,
      timestamp: 1,
    };
    await store.initialize(identity);
    const resultEntryId = await store.appendMessage(identity, result);

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
          process: { command: string; authorization: string };
          tokens: string;
          api_key: string;
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
    assert.match(persistedDetails?.process.command ?? "", /API_TOKEN=\[redacted\]/);
    assert.equal(persistedDetails?.process.authorization, "[redacted]");
    assert.equal(persistedDetails?.tokens, "[redacted]");
    assert.equal(persistedDetails?.api_key, "[redacted]");
    const liveDetails = result.details as {
      screenshot: { data: string };
      nested: Array<{ data: string }>;
      tokens: string[];
      api_key: { value: string };
    };
    assert.equal(liveDetails.screenshot.data, encoded, "persistence must not mutate live details");
    assert.equal(liveDetails.nested[0]?.data, encoded, "nested live details must remain unchanged");
    assert.deepEqual(liveDetails.tokens, ["array-secret-value"]);
    assert.deepEqual(liveDetails.api_key, { value: "object-secret-value" });
    const raw = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(raw, new RegExp(encoded.slice(0, 100)));
    assert.doesNotMatch(raw, /ghp_S{20}/);
    assert.doesNotMatch(raw, /secret-value/);
    assert.doesNotMatch(raw, /array-secret-value|object-secret-value/);
    assert.ok(Buffer.byteLength(raw) < 10_000, `durable journal unexpectedly used ${Buffer.byteLength(raw)} bytes`);

    await store.rewriteCompacted(identity, [{ entry_id: resultEntryId, message: result }], {
      omitted_messages: 0,
      retained_messages: 1,
    });
    const compactedRaw = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(compactedRaw, new RegExp(encoded.slice(0, 100)));
    assert.doesNotMatch(compactedRaw, /ghp_S{20}/);
    assert.doesNotMatch(compactedRaw, /secret-value/);
    assert.doesNotMatch(compactedRaw, /array-secret-value|object-secret-value/);
    assert.ok(Buffer.byteLength(compactedRaw) < 10_000);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("SessionStore redacts assistant tool-call payloads in journals and archives", async () => {
  const home = await temporaryDirectory("agent-session-tool-arguments-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "user:1", lifecycle_id: "life", session_id: "session" };
    const token = `ghp_${"S".repeat(36)}`;
    const headerSecret = "compact-header-secret";
    const processSecret = "process-header-secret";
    const typedText = "unstructured private browser form value";
    const terminalMessage = fauxAssistantMessage(fauxToolCall("terminal", {
      command: `API_TOKEN=${token} curl -HAuthorization:${headerSecret} left\u202eright`,
      cwd: ".",
    }), { stopReason: "toolUse" });
    const processMessage = fauxAssistantMessage(fauxToolCall("process", {
      action: "write",
      process_id: "shell",
      input: `curl --header=X-API-Key:${processSecret} left\u2066right\n`,
    }), { stopReason: "toolUse" });
    const browserMessage = fauxAssistantMessage(fauxToolCall("browser", {
      action: "type",
      arguments: { tab_id: "tab", ref: "e1", text: typedText },
    }), { stopReason: "toolUse" });
    const tracked = await store.initializeTracked(identity, [terminalMessage, processMessage, browserMessage]);
    const retained: UserMessage = { role: "user", content: "retain", timestamp: 3 };
    const retainedEntryId = await store.appendMessage(identity, retained);

    const journal = await readFile(store.path(identity), "utf8");
    assert.doesNotMatch(journal, new RegExp(token));
    assert.doesNotMatch(journal, new RegExp(headerSecret));
    assert.doesNotMatch(journal, new RegExp(processSecret));
    assert.doesNotMatch(journal, /[\u202e\u2066]/u);
    assert.doesNotMatch(journal, new RegExp(typedText));
    assert.match(journal, /\[redacted\]/);
    assert.match(journal, /input omitted/);
    assert.match(
      JSON.stringify(terminalMessage),
      new RegExp(token),
      "durable redaction must not mutate the live assistant message",
    );
    assert.match(JSON.stringify(processMessage), new RegExp(processSecret));
    assert.match(JSON.stringify(browserMessage), new RegExp(typedText));

    await store.rewriteCompacted(
      identity,
      [{ entry_id: retainedEntryId, message: retained }],
      { omitted_messages: 3, retained_messages: 1 },
      tracked.map((entry) => entry.entry_id),
    );
    const archive = await readFile(store.archivePath(identity), "utf8");
    assert.doesNotMatch(archive, new RegExp(token));
    assert.doesNotMatch(archive, new RegExp(headerSecret));
    assert.doesNotMatch(archive, new RegExp(processSecret));
    assert.doesNotMatch(archive, /[\u202e\u2066]/u);
    assert.doesNotMatch(archive, new RegExp(typedText));
    assert.match(archive, /\[redacted\]/);
    assert.match(archive, /input omitted/);
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
