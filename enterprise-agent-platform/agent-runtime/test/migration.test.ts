import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { migrateSessions, sessionPath } from "../src/migration.js";

const time = 1_750_000_000_000;
const identity = { scope_key: "private:1", lifecycle_id: "life-1", session_id: "session-1" };
const sid = "agent-private-1";
const user = (content: string, offset: number): UserMessage => ({ role: "user", content, timestamp: time + offset });
const assistant: AgentMessage = {
  role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/workspace/report.txt" } }],
  api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.4", stopReason: "toolUse", timestamp: time + 2,
  usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const result: AgentMessage = { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false,
  content: [{ type: "text", text: "Full original report" }], details: { path: "/workspace/report.txt" }, timestamp: time + 3 };

async function fixture(home: string, retained: AgentMessage[]) {
  const directory = join(home, "sessions", "journals", "--platform--");
  await mkdir(directory, { recursive: true });
  await mkdir(join(home, "sessions.pre-pi"));
  await mkdir(join(home, "migration"));
  await writeFile(join(home, "sessions", ".pi-native"), "4\n");
  await writeFile(join(home, "sessions.pre-pi", "original.jsonl"), "legacy bytes\n");
  await writeFile(join(home, "migration", "active-sessions.json"), JSON.stringify([{ sid, ...identity }]));
  const hash = createHash("sha256").update(JSON.stringify(Object.values(identity))).digest("hex");
  const originalMessages = [user("Remember the full old question", 1), assistant, result, user("Keep this question", 4)];
  let seq = 0;
  let parentId: string | null = null;
  const lines: unknown[] = [{ v: 4, kind: "header", id: hash, storageVersion: 1, createdAt: time, cwd: "/platform" },
    { kind: "value", op: "set", seq: ++seq, namespace: "platform", key: "identity", value: identity },
    { kind: "value", op: "set", seq: ++seq, namespace: "pi.branch.tip", key: "main", value: null }];
  for (const [index, message] of originalMessages.entries()) {
    const id = `entry-${index}`;
    lines.push([{ kind: "entry", type: "message", id, parentId, seq: ++seq, timestamp: message.timestamp, message },
      { kind: "value", op: "set", seq: ++seq, namespace: "pi.branch.tip", key: "main", value: id },
      { kind: "value", op: "set", seq: ++seq, namespace: "platform.message", key: id, value: { model_content_security_version: 1 } }]);
    parentId = id;
    if (index === 2) {
      lines.push([{ kind: "entry", type: "compaction", id: "older-compaction", parentId, seq: ++seq,
        timestamp: time + 3, summary: "Superseded summary", retainedTail: [], tokensBefore: 0,
        fromHook: true, details: { summaryTimestamp: time + 3, tracked: [{ entry_id: "older-summary", synthetic_kind: "compaction_summary" }], payload: {} } },
      { kind: "value", op: "set", seq: ++seq, namespace: "pi.branch.tip", key: "main", value: "older-compaction" }]);
      parentId = "older-compaction";
    }
  }
  lines.push([{ kind: "entry", type: "compaction", id: "compaction-1", parentId, seq: ++seq, timestamp: time + 5,
    summary: "Earlier work summary", retainedTail: retained, tokensBefore: 0, fromHook: true,
    details: { summaryTimestamp: time + 5, payload: { reason: "threshold" }, tracked: [
      { entry_id: "summary-1", synthetic_kind: "compaction_summary" },
      ...retained.map((_, index) => ({ entry_id: `entry-${index + 3}`, model_content_security_version: 1 })),
    ] } }, { kind: "value", op: "set", seq: ++seq, namespace: "pi.branch.tip", key: "main", value: "compaction-1" }]);
  const after = user("The next turn after compaction", 6);
  lines.push([{ kind: "entry", type: "message", id: "entry-after", parentId: "compaction-1", seq: ++seq, timestamp: time + 6, message: after },
    { kind: "value", op: "set", seq: ++seq, namespace: "pi.branch.tip", key: "main", value: "entry-after" }]);
  const path = join(directory, `2025-06-15T00-00-00-000Z_${hash}.jsonl`);
  const bytes = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(path, bytes);
  const inactive = join(directory, "inactive.jsonl");
  await writeFile(inactive, bytes.replace('"lifecycle_id":"life-1"', '"lifecycle_id":"previous-life"'));
  return { path, bytes, inactive, originalMessages: [...originalMessages, after], visible: [...retained, after] };
}

for (const rewritten of [false, true]) {
  test(`migrates full v4 transactions and ${rewritten ? "rewritten" : "unchanged"} compacted context losslessly`, async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      const retained = rewritten ? [user("Redacted retained question", 4)] : [user("Keep this question", 4)];
      const source = await fixture(home, retained);
      const inactiveBytes = await readFile(source.inactive, "utf8");
      await migrateSessions(home);
      const path = sessionPath(home, sid);
      const manager = SessionManager.open(path);
      assert.equal(manager.getSessionId(), sid);
      const entries = manager.getEntries();
      assert.deepEqual(entries.filter((entry) => entry.type === "message").slice(0, source.originalMessages.length)
        .map((entry) => entry.type === "message" ? entry.message : null), source.originalMessages);
      // Pi-native summary role replaces the old synthetic user summary; the
      // summary text/timestamp and every model-visible tail message stay exact.
      const context = manager.buildSessionContext().messages;
      assert.deepEqual(context[0], { role: "compactionSummary", summary: "Earlier work summary", tokensBefore: 0, timestamp: time + 5 });
      assert.deepEqual(context.slice(1), source.visible);
      assert.equal(await readFile(source.path, "utf8"), source.bytes);
      assert.equal(await readFile(source.inactive, "utf8"), inactiveBytes);
      assert.equal(await readFile(join(home, "sessions", ".pi-native"), "utf8"), "4\n");
      assert.equal(await readFile(join(home, "sessions.pre-pi", "original.jsonl"), "utf8"), "legacy bytes\n");
      const published = await readFile(path, "utf8");
      await migrateSessions(home);
      assert.equal(await readFile(path, "utf8"), published);
      assert.deepEqual((await readdir(join(home, "sessions-v3"))).sort(), [".migrated-from-v4", path.split("/").at(-1)!].sort());
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("resumes partial migration without overwriting published sessions and publishes marker last", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-migrate-"));
  try {
    const source = await fixture(home, []);
    await writeFile(source.path, source.bytes + "{broken-json\n");
    await assert.rejects(migrateSessions(home), SyntaxError);
    await assert.rejects(readFile(join(home, "sessions-v3", ".migrated-from-v4")), { code: "ENOENT" });
    await assert.rejects(readFile(sessionPath(home, sid)), { code: "ENOENT" });
    await writeFile(source.path, source.bytes);
    await migrateSessions(home);
    const destination = sessionPath(home, sid);
    const published = await readFile(destination, "utf8");
    await rm(join(home, "sessions-v3", ".migrated-from-v4"));
    const manager = SessionManager.open(destination);
    manager.appendMessage(user("New runtime turn must survive recovery", 7));
    const continued = await readFile(destination, "utf8");
    assert.notEqual(continued, published);
    await migrateSessions(home);
    assert.equal(await readFile(destination, "utf8"), continued);
    assert.deepEqual((await readdir(join(home, "sessions-v3"))).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

function nextTransaction() {
  return JSON.stringify([
    { kind: "entry", type: "message", id: "rollback-turn", parentId: "entry-after", seq: 100,
      timestamp: time + 8, message: user("Written during rollback", 8) },
    { kind: "value", op: "set", seq: 101, namespace: "pi.branch.tip", key: "main", value: "rollback-turn" },
  ]);
}

for (const suffix of ['{"torn":', nextTransaction()]) {
  test(`ignores uncommitted suffix ${suffix.startsWith("[") ? "even when valid JSON" : "with torn JSON"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      const source = await fixture(home, []);
      await writeFile(source.path, source.bytes + suffix);
      await migrateSessions(home);
      const manager = SessionManager.open(sessionPath(home, sid));
      assert.deepEqual(manager.buildSessionContext().messages.slice(1), source.visible);
      assert.equal(await readFile(source.path, "utf8"), source.bytes + suffix);
      const published = await readFile(sessionPath(home, sid), "utf8");
      await migrateSessions(home);
      assert.equal(await readFile(sessionPath(home, sid), "utf8"), published);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

for (const change of ["grown", "lifecycle_id", "session_id", "rewritten", "empty reset"]) {
  test(`reconciles ${change} source after rollback despite completion marker`, async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      const source = await fixture(home, []);
      await migrateSessions(home);
      const path = sessionPath(home, sid);
      const imported = await readFile(path, "utf8");
      let bytes = source.bytes;
      if (change === "grown") bytes += nextTransaction() + "\n";
      else if (change === "rewritten") bytes = bytes.replace("Earlier work summary", "Revised rollback summary");
      else {
        const changed = { ...identity, [change === "session_id" ? "session_id" : "lifecycle_id"]: "new-identity" };
        await writeFile(join(home, "migration", "active-sessions.json"), JSON.stringify([{ sid, ...changed }]));
        if (change !== "empty reset") bytes = bytes.replace(JSON.stringify(identity), JSON.stringify(changed));
      }
      await writeFile(source.path, bytes);
      await migrateSessions(home);
      const current = await readFile(path, "utf8");
      assert.notEqual(current, imported);
      const archive = (await readdir(join(home, "sessions-v3"))).find((name) => name.includes(".superseded-"));
      assert.ok(archive);
      assert.equal(await readFile(join(home, "sessions-v3", archive), "utf8"), imported);
      const manager = SessionManager.open(path);
      if (change === "grown") assert.deepEqual(manager.buildSessionContext().messages.at(-1), user("Written during rollback", 8));
      if (change === "rewritten") {
        const summary = manager.buildSessionContext().messages[0]!;
        assert.ok("summary" in summary);
        assert.equal(summary.summary, "Revised rollback summary");
      }
      if (change === "empty reset") assert.deepEqual(manager.buildSessionContext().messages, []);
      const metadata = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "platform.v4-import");
      assert.ok(metadata?.type === "custom");
      assert.ok(metadata.data && typeof metadata.data === "object" && "lastSeq" in metadata.data);
      assert.equal(metadata.data.lastSeq, change === "grown" ? 101 : change === "empty reset" ? 0 : 20);
      await migrateSessions(home);
      assert.equal(await readFile(path, "utf8"), current);
      assert.equal((await readdir(join(home, "sessions-v3"))).filter((name) => name.includes(".superseded-")).length, 1);
      assert.equal(await readFile(source.path, "utf8"), bytes);
      assert.equal(await readFile(join(home, "sessions.pre-pi", "original.jsonl"), "utf8"), "legacy bytes\n");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

for (const legacy of [false, true]) {
  test(`retains ${legacy ? "pre-metadata import" : "Pi-written entries"} when rollback source grows`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      const warnings = t.mock.method(console, "warn", () => {});
      const source = await fixture(home, []);
      await migrateSessions(home);
      const path = sessionPath(home, sid);
      if (legacy) {
        const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
        await writeFile(path, lines.slice(0, -1).join("\n") + "\n");
      } else {
        SessionManager.open(path).appendMessage(user("Pi turn wins", 7));
      }
      const preserved = await readFile(path, "utf8");
      await writeFile(source.path, source.bytes + nextTransaction() + "\n");
      await migrateSessions(home);
      assert.equal(await readFile(path, "utf8"), preserved);
      assert.equal(warnings.mock.callCount(), 1);
      assert.equal((await readdir(join(home, "sessions-v3"))).some((name) => name.includes(".superseded-")), false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("adopts an unchanged pre-metadata import without changing its context", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-migrate-"));
  try {
    await fixture(home, []);
    await migrateSessions(home);
    const path = sessionPath(home, sid);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, lines.slice(0, -1).join("\n") + "\n");
    const context = SessionManager.open(path).buildSessionContext().messages;
    await migrateSessions(home);
    assert.deepEqual(SessionManager.open(path).buildSessionContext().messages, context);
    const adopted = await readFile(path, "utf8");
    await migrateSessions(home);
    assert.equal(await readFile(path, "utf8"), adopted);
  } finally { await rm(home, { recursive: true, force: true }); }
});
