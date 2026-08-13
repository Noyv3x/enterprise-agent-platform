import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import { dirname } from "node:path";
import { BackgroundTaskStore } from "../src/background-task-store.js";
import { SessionStore } from "../src/session-store.js";
import { temporaryDirectory } from "./helpers.js";

test("background task obligations persist by exact session identity and resolve only by matching target", async () => {
  const home = await temporaryDirectory("agent-background-state-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:1", lifecycle_id: "life-a", session_id: "session-a" };
    const sibling = { ...identity, session_id: "session-b" };
    const state = store.backgroundTaskState(identity);

    assert.deepEqual(await state.active(), []);
    await assert.rejects(stat(store.backgroundTaskPath(identity)), { code: "ENOENT" });

    await state.register("process_one", "sandbox");
    await state.register("process_one", "sandbox");
    await state.register("process_two", "host");
    assert.equal((await stat(store.backgroundTaskPath(identity))).mode & 0o777, 0o600);
    assert.deepEqual(
      (await new SessionStore(home).loadActiveBackgroundTasks(identity)).map(
        ({ process_id, target }) => ({ process_id, target }),
      ),
      [
        { process_id: "process_one", target: "sandbox" },
        { process_id: "process_two", target: "host" },
      ],
    );
    assert.deepEqual(await store.loadActiveBackgroundTasks(sibling), []);

    const beforeMismatch = await readFile(store.backgroundTaskPath(identity), "utf8");
    await assert.rejects(state.resolve("process_one", "host"), /target does not match/);
    assert.equal(await readFile(store.backgroundTaskPath(identity), "utf8"), beforeMismatch);

    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      const directory = dirname(store.backgroundTaskPath(identity));
      await chmod(directory, 0o500);
      try {
        await assert.rejects(state.register("process_write_failure", "sandbox"), { code: "EACCES" });
      } finally {
        await chmod(directory, 0o700);
      }
      assert.equal(
        await readFile(store.backgroundTaskPath(identity), "utf8"),
        beforeMismatch,
        "a failed atomic replacement must preserve the last valid obligation state",
      );
    }

    await state.resolve("process_one", "sandbox");
    assert.equal((await state.read()).obligations.find((item) => item.process_id === "process_one")?.state, "resolved");
    assert.deepEqual(
      (await state.active()).map(({ process_id, target }) => ({ process_id, target })),
      [{ process_id: "process_two", target: "host" }],
    );
    await state.acknowledge("process_one", "sandbox");
    assert.equal((await state.read()).obligations.some((item) => item.process_id === "process_one"), false);
    await state.resolve("process_unknown", "sandbox");
    assert.equal((await state.active()).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("background task sidecar fails closed on corruption, identity drift, links, owner, type, and permissions", async () => {
  const home = await temporaryDirectory("agent-background-integrity-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:2", lifecycle_id: "life", session_id: "session" };
    await store.backgroundTaskState(identity).register("process_protected", "sandbox");
    const path = store.backgroundTaskPath(identity);
    const valid = await readFile(path, "utf8");
    const restore = async (): Promise<void> => {
      await rm(path, { recursive: true, force: true });
      await writeFile(path, valid, { mode: 0o600 });
      await chmod(path, 0o600);
    };

    await writeFile(path, "{broken", "utf8");
    await assert.rejects(store.backgroundTaskState(identity).read(), /invalid JSON/);

    await restore();
    const drifted = JSON.parse(valid) as Record<string, unknown>;
    drifted.scope_key = "private:other";
    await writeFile(path, `${JSON.stringify(drifted)}\n`, "utf8");
    await assert.rejects(store.backgroundTaskState(identity).read(), /scope_key does not match/);

    await restore();
    const unknown = JSON.parse(valid) as Record<string, unknown>;
    unknown.extra = true;
    await writeFile(path, `${JSON.stringify(unknown)}\n`, "utf8");
    await assert.rejects(store.backgroundTaskState(identity).read(), /unknown or missing fields/);

    await restore();
    await chmod(path, 0o640);
    await assert.rejects(store.backgroundTaskState(identity).read(), /not owner-only/);

    await restore();
    const info = await stat(path);
    const wrongOwnerView = new BackgroundTaskStore(() => path, info.uid + 1);
    await assert.rejects(wrongOwnerView.read(identity), /not owned by the Runtime user/);

    await restore();
    const hardlink = `${path}.hard`;
    await link(path, hardlink);
    await assert.rejects(store.backgroundTaskState(identity).read(), /exactly one link/);
    await rm(hardlink);

    await restore();
    const external = `${path}.external`;
    await copyFile(path, external);
    await rm(path);
    await symlink(external, path);
    await assert.rejects(store.backgroundTaskState(identity).read(), /symbolic link/);

    await rm(path);
    await mkdir(path);
    await assert.rejects(store.backgroundTaskState(identity).read(), /not a regular file/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("session and scope cleanup delete background task obligations without touching siblings prematurely", async () => {
  const home = await temporaryDirectory("agent-background-cleanup-");
  try {
    const store = new SessionStore(home);
    const identity = { scope_key: "private:3", lifecycle_id: "life", session_id: "one" };
    const sibling = { ...identity, session_id: "two" };
    await store.initialize(identity);
    await store.initialize(sibling);
    await store.backgroundTaskState(identity).register("process_one", "sandbox");
    await store.backgroundTaskState(sibling).register("process_two", "sandbox");

    await store.deleteSession(identity);
    await assert.rejects(stat(store.backgroundTaskPath(identity)), { code: "ENOENT" });
    assert.equal((await store.loadActiveBackgroundTasks(sibling)).length, 1);

    await store.deleteScope(identity.scope_key, identity.lifecycle_id);
    await assert.rejects(stat(store.backgroundTaskPath(sibling)), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("transient scope-family cleanup removes only task responsibility sidecars", async () => {
  const home = await temporaryDirectory("agent-background-scope-family-cleanup-");
  try {
    const store = new SessionStore(home);
    const root = { scope_key: "private:4", lifecycle_id: "life-a", session_id: "root" };
    const delegated = { scope_key: "private:4/delegate/child", lifecycle_id: "life-a", session_id: "child" };
    const otherLifecycle = { ...root, lifecycle_id: "life-b", session_id: "other-life" };
    const unrelated = { scope_key: "private:40", lifecycle_id: "life-a", session_id: "other-scope" };
    for (const identity of [root, delegated, otherLifecycle, unrelated]) {
      await store.initialize(identity);
      await store.backgroundTaskState(identity).register(`process_${identity.session_id}`, "sandbox");
    }

    await store.deleteBackgroundTaskScopeFamily(root.scope_key, root.lifecycle_id);

    await assert.rejects(stat(store.backgroundTaskPath(root)), { code: "ENOENT" });
    await assert.rejects(stat(store.backgroundTaskPath(delegated)), { code: "ENOENT" });
    await stat(store.path(root));
    await stat(store.path(delegated));
    assert.equal((await store.loadActiveBackgroundTasks(otherLifecycle)).length, 1);
    assert.equal((await store.loadActiveBackgroundTasks(unrelated)).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
