import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionStore, CURRENT_MODEL_CONTENT_SECURITY_VERSION } from "../src/session-store.js";
import { temporaryDirectory } from "./helpers.js";

const identity = { scope_key: "private:1", lifecycle_id: "life", session_id: "session" };
const message = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });

test("native initialization is serialized, preserves identity fences and never reseeds", async () => {
  const home = await temporaryDirectory("native-session-");
  try {
    const store = new SessionStore(home);
    const [first, second] = await Promise.all([
      store.initializeTracked(identity, [message("first")]),
      store.initializeTracked(identity, [message("must not replay")]),
    ]);
    assert.deepEqual(second, first);
    const other = { ...identity, lifecycle_id: "other" };
    await store.initialize(other, [message("isolated")]);
    const restarted = new SessionStore(home);
    assert.deepEqual(await restarted.loadTracked(identity), first);
    assert.deepEqual(await restarted.load(other), [message("isolated")]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native compaction keeps exact tracked projection and searchable history without duplicate replay", async () => {
  const home = await temporaryDirectory("native-compaction-");
  try {
    const store = new SessionStore(home);
    const original = await store.initializeTracked(identity, [message("old searchable fact"), message("recent")]);
    const summary = { message: message("summary of old fact"), synthetic_kind: "context_compaction_notice" as const };
    const ids = await store.rewriteCompacted(identity, [summary, original[1]!], { reason: "manual" }, [original[0]!.entry_id]);
    await store.appendMessage(identity, message("next"), CURRENT_MODEL_CONTENT_SECURITY_VERSION);
    const restarted = new SessionStore(home);
    const current = await restarted.loadTracked(identity);
    assert.deepEqual(current.map((entry) => entry.message), [summary.message, message("recent"), message("next")]);
    assert.deepEqual(current.slice(0, 2).map((entry) => entry.entry_id), ids);
    assert.equal(current[0]!.synthetic_kind, "context_compaction_notice");
    assert.equal(current[2]!.model_content_security_version, CURRENT_MODEL_CONTENT_SECURITY_VERSION);
    assert.deepEqual(await restarted.loadSearchable(identity), [message("old searchable fact"), message("recent"), message("next")]);
    await restarted.rewriteCompacted(identity, [current[2]!], {}, [current[1]!.entry_id], [current[0]!.entry_id]);
    assert.deepEqual(await restarted.load(identity), [message("next")]);
    assert.deepEqual(await restarted.loadSearchable(identity), [message("old searchable fact"), message("recent"), message("next")]);
    await assert.rejects(restarted.rewriteCompacted(identity, [current[2]!, current[2]!], {}), /duplicate/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("family deletion fences lifecycle and scope and includes sidecar-only sessions", async () => {
  const home = await temporaryDirectory("native-delete-");
  try {
    const store = new SessionStore(home);
    const child = { ...identity, scope_key: "private:1/delegate/one" };
    const otherLife = { ...child, lifecycle_id: "other" };
    const neighbor = { ...identity, scope_key: "private:10" };
    for (const candidate of [identity, child, otherLife, neighbor]) await store.initialize(candidate, [message(candidate.scope_key)]);
    await store.appendSessionApproval(identity, "v2:key", "skill");
    await store.todoState(child).replace([{ content: "child task" }]);
    await store.todoState(otherLife).replace([{ content: "preserved task" }]);
    await store.deleteScopeFamily(identity.scope_key, identity.lifecycle_id);
    assert.deepEqual(await store.load(identity), []);
    assert.deepEqual(await store.load(child), []);
    assert.deepEqual(await store.load(otherLife), [message(child.scope_key)]);
    assert.deepEqual(await store.load(neighbor), [message(neighbor.scope_key)]);
    assert.equal(await store.hasSessionApproval(identity, "v2:key"), false);
    assert.deepEqual(await store.loadActiveTodos(child), []);
    assert.equal((await store.loadActiveTodos(otherLife))[0]!.content, "preserved task");
    const sidecarOnly = { ...identity, scope_key: "private:1/delegate/sidecar" };
    await store.todoState(sidecarOnly).replace([{ content: "sidecar-only" }]);
    await store.deleteScopeFamily(identity.scope_key);
    assert.deepEqual(await store.loadActiveTodos(sidecarOnly), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("deleting a single native session preserves sibling history and lifecycle approvals", async () => {
  const home = await temporaryDirectory("native-single-delete-");
  try {
    const store = new SessionStore(home);
    const sibling = { ...identity, session_id: "sibling" };
    await store.initialize(identity, [message("discard")]);
    await store.initialize(sibling, [message("keep")]);
    await store.appendSessionApproval(sibling, "v2:keep", "skill");
    await store.deleteSession(identity);
    await store.deleteSession(identity);
    assert.deepEqual(await store.load(identity), []);
    assert.deepEqual(await store.load(sibling), [message("keep")]);
    assert.equal(await store.hasSessionApproval(sibling, "v2:keep"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native messages redact tool secrets and omit image bytes across restart", async () => {
  const home = await temporaryDirectory("native-redaction-");
  try {
    const store = new SessionStore(home);
    await store.initialize(identity);
    await store.appendMessage(identity, { role: "user", timestamp: 1, content: [{ type: "image", data: "c2VjcmV0", mimeType: "image/png" }] });
    await store.appendMessage(identity, fauxAssistantMessage(fauxToolCall("skill", { password: "secret-value", name: "safe" })));
    const durable = JSON.stringify(await new SessionStore(home).loadSearchable(identity));
    assert.equal(durable.includes("c2VjcmV0"), false);
    assert.equal(durable.includes("secret-value"), false);
    assert.match(durable, /omitted/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("sidecar scope names cannot traverse sibling scope directories", async () => {
  const home = await temporaryDirectory("native-scope-path-");
  try {
    const store = new SessionStore(home);
    const dotScope = { ...identity, scope_key: ".." };
    await store.todoState(dotScope).replace([{ content: "dot scope task" }]);
    await store.todoState(identity).replace([{ content: "ordinary task" }]);
    await store.deleteScopeFamily(dotScope.scope_key);
    assert.deepEqual(await store.loadActiveTodos(dotScope), []);
    assert.equal((await store.loadActiveTodos(identity))[0]!.content, "ordinary task");
  } finally { await rm(home, { recursive: true, force: true }); }
});
