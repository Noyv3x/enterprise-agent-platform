import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type FileEntry, type SessionContext } from "@earendil-works/pi-coding-agent";
import type { SystemMessage, UserMessage } from "@earendil-works/pi-ai";

// Provenance: generated with the actual published 0.87.1 SessionManager, not
// hand-written JSON or the upgraded writer. create/appendMessage/model/thinking,
// branchWithSummary, appendCompaction and appendLabelChange produced the journal.
// The companion JSONL captures that same old reader's buildSessionContext() and
// getBranch() at EVERY entry, including the abandoned tool/image branch, the
// changed named system section, and the compaction boundary's prompt snapshot.
// IDs, timestamps, payloads and references are deliberately retained verbatim.
// Do not regenerate with the installed upgraded package: these are old-reader
// compatibility expectations. No old package dependency is needed to run them.
// Resolve from the runtime root, as npm test runs compiled dist/test files while
// TypeScript does not copy JSONL fixtures into dist.
const fixtureDirectory = join(process.cwd(), "test", "fixtures");
interface OldContext { leafId: string; context: SessionContext; branch: string[] }

async function fixture() {
  const bytes = await readFile(join(fixtureDirectory, "pi-0.87.1-session-v3.jsonl"));
  const entries = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as FileEntry);
  const contexts = (await readFile(join(fixtureDirectory, "pi-0.87.1-contexts.jsonl"), "utf8"))
    .trimEnd().split("\n").map((line) => JSON.parse(line) as OldContext);
  return { bytes, entries, contexts };
}

function assertOldBranches(manager: SessionManager, contexts: OldContext[]) {
  for (const expected of contexts) {
    manager.branch(expected.leafId);
    assert.deepEqual(manager.buildSessionContext(), expected.context, `context at old entry ${expected.leafId}`);
    assert.deepEqual(manager.getBranch().map((entry) => entry.id), expected.branch);
  }
}

test("opens a real 0.87.1 v3 journal without rewriting or losing any branch context", async () => {
  const original = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "pi-session-compatibility-"));
  try {
    const path = join(directory, "session.jsonl");
    await writeFile(path, original.bytes);
    const manager = SessionManager.open(path);
    assert.deepEqual(manager.getHeader(), original.entries[0]);
    assert.deepEqual(manager.getEntries(), original.entries.slice(1));
    assert.deepEqual(manager.buildSessionContext(), original.contexts.at(-1)!.context);
    assertOldBranches(manager, original.contexts);
    assert.equal(manager.getLabel(original.entries.find((entry) => entry.type === "label")!.targetId), "alternate interpretation");
    assert.deepEqual(await readFile(path), original.bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("appends to an old v3 journal and reopens with old branches and compacted prompt intact", async () => {
  const original = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "pi-session-append-"));
  try {
    const path = join(directory, "session.jsonl");
    await writeFile(path, original.bytes);
    const manager = SessionManager.open(path);
    const oldContext = original.contexts.at(-1)!.context;
    const system: SystemMessage = { role: "system", content: "Continue after upgrade.",
      sections: { policy: "<policy>Preserve history</policy>" }, timestamp: 1_750_000_000_008 };
    const user: UserMessage = { role: "user", content: "Use the retained image to answer the next question.", timestamp: 1_750_000_000_009 };
    const previousLeaf = manager.getLeafId();
    const modelId = manager.appendModelChange("anthropic", "claude-sonnet-4-5");
    manager.appendThinkingLevelChange("medium");
    manager.appendMessage(system);
    const userId = manager.appendMessage(user);
    manager.appendCustomEntry("platform.compatibility", { preserved: true, previousLeaf });
    const leaf = manager.getLeafId()!;
    const expectedEntries = manager.getEntries();
    const bytes = await readFile(path);
    assert.deepEqual(bytes.subarray(0, original.bytes.length), original.bytes);
    const reopened = SessionManager.open(path);
    assert.deepEqual(reopened.getEntries(), expectedEntries);
    assert.deepEqual(reopened.getEntries().slice(0, original.entries.length - 1), original.entries.slice(1));
    assert.equal(reopened.getEntry(modelId)!.parentId, previousLeaf);
    assert.equal(reopened.getLeafEntry()!.parentId, userId);
    assert.deepEqual(reopened.buildSessionContext(), {
      messages: [...oldContext.messages, system, user], thinkingLevel: "medium",
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
    assertOldBranches(reopened, original.contexts);
    reopened.branch(leaf);
    assert.deepEqual(reopened.getTree(), manager.getTree());
    assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
