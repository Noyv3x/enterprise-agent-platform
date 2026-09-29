import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { SessionStore } from "../src/session-store.js";
import { stableHash } from "../src/utils.js";
import { temporaryDirectory } from "./helpers.js";

const identity = { scope_key: "private:1", lifecycle_id: "life", session_id: "session" };
const message = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });

async function legacyFixture(home: string): Promise<{ journal: string; archive: string; path: string }> {
  const scope = join(home, "sessions", stableHash(identity.scope_key));
  const path = join(scope, stableHash(identity.lifecycle_id), `${stableHash(identity.session_id)}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  const entry = (id: string, type: string, payload: unknown) => ({ id, type, ...identity, timestamp: "2026-01-01T00:00:00.000Z", payload });
  const recent = entry("recent", "message", message("retained fact"));
  const journal = [entry("header", "header", { version: 1, ...identity }), { ...entry("notice", "message", message("compaction summary")), synthetic_kind: "context_compaction_notice" }, recent, entry("compaction", "compaction", { reason: "threshold" })].map((row) => JSON.stringify(row)).join("\n") + "\n";
  // A retained entry also in the archive models archive-first interruption.
  const archive = [entry("old", "message", message("searchable compacted fact")), recent].map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(join(scope, "scope.json"), JSON.stringify({ scope_key: identity.scope_key }));
  await writeFile(path, journal);
  await writeFile(path.replace(/\.jsonl$/, ".archive.jsonl"), archive);
  await writeFile(join(dirname(path), "approvals.jsonl"), JSON.stringify({ id: "grant", type: "grant", timestamp: "2026-01-01", session_id: identity.session_id, approval_key: "v2:migrated", tool_name: "skill" }) + "\n");
  return { journal, archive, path };
}

async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (item.isFile()) {
      const path = join(item.parentPath, item.name);
      result[path.slice(root.length)] = await readFile(path, "utf8");
    }
  }
  return result;
}

test("startup converts legacy model and search history, preserves backup bytes, and reruns without writes", async () => {
  const home = await temporaryDirectory("native-migration-");
  try {
    const fixture = await legacyFixture(home);
    const before = await tree(join(home, "sessions"));
    const store = new SessionStore(home);
    await store.initialize();
    assert.deepEqual(await store.load(identity), [message("compaction summary"), message("retained fact")]);
    assert.deepEqual(await store.loadSearchable(identity), [message("searchable compacted fact"), message("retained fact")]);
    assert.equal(await store.hasSessionApproval(identity, "v2:migrated"), true);
    assert.deepEqual(await tree(join(home, "sessions.pre-pi")), before);
    assert.equal(await readFile(fixture.path.replace("/sessions/", "/sessions.pre-pi/"), "utf8"), fixture.journal);
    await store.appendMessage(identity, message("after migration"));
    const active = await tree(join(home, "sessions"));
    const restarted = new SessionStore(home);
    await restarted.initialize();
    assert.deepEqual(await tree(join(home, "sessions")), active);
    assert.deepEqual(await restarted.load(identity), [message("compaction summary"), message("retained fact"), message("after migration")]);
    assert.deepEqual(await tree(join(home, "sessions.pre-pi")), before);
    await restarted.deleteScopeFamily(identity.scope_key);
    assert.deepEqual(await restarted.loadSearchable(identity), []);
    assert.deepEqual(await tree(join(home, "sessions.pre-pi")), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const partialStage of [false, true]) {
  test(`startup resumes after backup rename${partialStage ? " and incomplete staging" : ""}`, async () => {
    const home = await temporaryDirectory("native-resume-");
    try {
      await legacyFixture(home);
      const before = await tree(join(home, "sessions"));
      await rename(join(home, "sessions"), join(home, "sessions.pre-pi"));
      if (partialStage) {
        const stage = join(home, "sessions.pi-staging", "sessions");
        await mkdir(stage, { recursive: true });
        await writeFile(join(stage, ".pi-native"), "4\n");
        await writeFile(join(stage, "partial.jsonl"), '{"incomplete":');
      }
      const store = new SessionStore(home);
      await store.initialize();
      assert.deepEqual(await store.load(identity), [message("compaction summary"), message("retained fact")]);
      assert.deepEqual(await store.loadSearchable(identity), [message("searchable compacted fact"), message("retained fact")]);
      assert.deepEqual(await tree(join(home, "sessions.pre-pi")), before);
      assert.equal((await readdir(home)).includes("sessions.pi-staging"), false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("invalid legacy interior records fail startup without publishing a partial native tree", async () => {
  const home = await temporaryDirectory("native-invalid-");
  try {
    const fixture = await legacyFixture(home);
    await writeFile(fixture.path, `not json\n${fixture.journal}`);
    const before = await tree(join(home, "sessions"));
    await assert.rejects(new SessionStore(home).initialize(), /Corrupt legacy session/);
    assert.equal((await readdir(home)).includes("sessions"), false);
    assert.deepEqual(await tree(join(home, "sessions.pre-pi")), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});
