import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { FileDraftProjector, FILE_DRAFT_MAX_BYTES } from "../src/file-draft-projector.js";

type Update = Extract<AssistantMessageEvent, { type: "toolcall_delta" | "toolcall_end" }>;
function update(args: ToolCall["arguments"], end = false, name = "write_file", id = "call-1"): Update {
  const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
  const partial: AssistantMessage = {
    role: "assistant", content: [toolCall], api: "openai-completions", provider: "xai", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 0,
  };
  return end ? { type: "toolcall_end", contentIndex: 0, toolCall, partial }
    : { type: "toolcall_delta", contentIndex: 0, partial, delta: "RAW_SECRET_FRAGMENT" };
}
const content = "const value = true;\n".repeat(100);

test("native partial arguments stream by elapsed time and finish only on execution end", () => {
  let now = 0;
  const projector = new FileDraftProjector(() => now);
  const args = { target: "sandbox", path: "/workspace/file.ts", content };
  const first = projector.project(update(args))!;
  assert.equal(first.file_draft.content, content.slice(0, -512));
  assert.equal(first.file_draft.done, false);
  assert.equal(projector.project(update({ ...args, content: content + "latest" })), undefined);
  now = 100;
  const latest = projector.project(update({ ...args, content: content + "latest" }))!;
  assert.equal(latest.file_draft.content, (content + "latest").slice(0, -512));
  const final = projector.project(update(args, true))!;
  assert.deepEqual(final.file_draft, { workspace_path: "file.ts", kind: "file", content, done: false, truncated: false });
  assert.deepEqual(projector.finish("call-1")?.file_draft, { ...final.file_draft, done: true });
  assert.equal(projector.finish("call-1"), undefined);
});

test("patch previews contain replacements, not search fragments, and calls remain independent", () => {
  const projector = new FileDraftProjector();
  projector.project(update({ path: "one", content: "one" }, true));
  const patch = projector.project(update({ path: "two", old_text: "private search", new_text: "replacement" }, true, "patch_file", "call-2"))!;
  assert.deepEqual(patch.file_draft, { workspace_path: "two", kind: "replacement", content: "replacement", done: false, truncated: false });
  assert.equal(projector.finish("call-1")?.file_draft.content, "one");
  assert.equal(projector.finish("call-2")?.file_draft.content, "replacement");
});

test("host and escaping paths never publish and missing target waits for full arguments", () => {
  for (const path of ["../secret", "/etc/passwd", "/workspace/../secret", "bad\\path", "bad\u0000path", "."]) {
    assert.equal(new FileDraftProjector().project(update({ target: "sandbox", path, content }, true)), undefined);
  }
  const projector = new FileDraftProjector();
  assert.equal(projector.project(update({ path: "file", content })), undefined);
  assert.equal(projector.project(update({ target: "host", path: "file", content }, true)), undefined);
  assert.equal(projector.finish("call-1"), undefined);
  const defaultTarget = { path: "file", content: "small" };
  assert.equal(projector.project(update(defaultTarget, true))?.file_draft.content, "small");
  assert.equal("target" in defaultTarget, false);
});

test("credential fragments stay private and final drafts redact credentials", () => {
  const projector = new FileDraftProjector(() => 0);
  const prefix = "ordinary text\n".repeat(60);
  const partial = projector.project(update({ target: "sandbox", path: "file", content: prefix + "api_key=sk-" }))!;
  assert.doesNotMatch(partial.file_draft.content, /api_key|sk-/);
  const secret = "CorrectHorseBattery";
  const raw = `${prefix}https://alice:${secret}@internal.example/path\n-----BEGIN PRIVATE KEY-----\n${"AbCd1234+/".repeat(100)}`;
  const final = projector.project(update({ path: "file", content: raw }, true))!;
  assert.match(final.file_draft.content, /alice:\[redacted\]@/);
  assert.match(final.file_draft.content, /\[redacted-private-key\]/);
  assert.doesNotMatch(final.file_draft.content, /CorrectHorseBattery|AbCd1234/);
  const long = new FileDraftProjector().project(update({ path: "file", content: "https://alice:" + secret.repeat(100) }, true))!;
  assert.equal(long.file_draft.content, "https://alice:[redacted]");
});

test("drafts remain UTF-8 safe and bounded to 16 KiB", () => {
  const draft = new FileDraftProjector().project(update({ path: "unicode", content: "🙂\n".repeat(6000) }, true))!.file_draft;
  assert.equal(draft.truncated, true);
  assert.ok(Buffer.byteLength(draft.content) <= FILE_DRAFT_MAX_BYTES);
  assert.equal(draft.content, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(draft.content)));
  assert.doesNotMatch(draft.content, /\uFFFD/);
});
