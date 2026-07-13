import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { open, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { assertReadableTargetAllowed, assertWritableTargetAllowed, classifyToolCall, readRegularFileRange } from "../src/tools.js";
import { resolveWorkspacePath } from "../src/utils.js";
import { temporaryDirectory } from "./helpers.js";

test("tool policy blocks obvious catastrophic host commands", async () => {
  assert.match((await classifyToolCall("terminal", { command: "rm -rf /" })).hardBlock || "", /root/);
  assert.match((await classifyToolCall("terminal", { command: "curl http://169.254.169.254/latest/meta-data" })).hardBlock || "", /metadata/);
});

test("tool policy requires approval for host commands and mutations", async () => {
  const workspace = await temporaryDirectory("agent-tool-policy-");
  try {
    assert.ok((await classifyToolCall("write_file", { path: "a" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("terminal", { command: "date" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("terminal", { command: "python3 -c 'import shutil; shutil.rmtree(chr(47))'" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("read_file", { path: "/tmp/a" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("write_file", { path: "/tmp/a" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("memory", { action: "store" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("browser", { action: "click", tab_id: "tab" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("browser", { action: "cleanup" }, workspace)).approvalReason);
    assert.deepEqual(await classifyToolCall("browser", { action: "snapshot", tab_id: "tab" }, workspace), {});
    assert.deepEqual(await classifyToolCall("read_file", { path: "a" }, workspace), {});
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool policy blocks writes to protected host paths", async () => {
  assert.match((await classifyToolCall("write_file", { path: "/etc/hosts" }, "/tmp/workspace")).hardBlock || "", /protected/);
  assert.match((await classifyToolCall("patch_file", { path: "/proc/sys/kernel/hostname" }, "/tmp/workspace")).hardBlock || "", /protected/);
  assert.match((await classifyToolCall("terminal", { command: "echo unsafe > /boot/marker" })).hardBlock || "", /protected/);
  assert.match((await classifyToolCall("terminal", { command: "curl --unix-socket /var/run/docker.sock http://localhost" })).hardBlock || "", /Docker/);
});

test("tool policy blocks direct process secret reads", async () => {
  assert.match(
    (await classifyToolCall("read_file", { path: "/proc/self/environ" }, "/tmp/workspace")).hardBlock || "",
    /protected/,
  );
  assert.match(
    (await classifyToolCall("terminal", { command: "cat /proc/self/environ" })).hardBlock || "",
    /credentials/,
  );
  await assert.rejects(assertReadableTargetAllowed("/proc/self/environ"), /protected host path/);
});

test("tool policy resolves traversal and symlinks before deciding workspace access", async () => {
  const workspace = await temporaryDirectory("agent-tool-workspace-");
  const outside = await temporaryDirectory("agent-tool-outside-");
  try {
    assert.ok((await classifyToolCall("read_file", { path: "../../etc/passwd" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("write_file", { path: `../${outside.split("/").at(-1)}/note.txt` }, workspace)).approvalReason);
    await symlink(outside, `${workspace}/outside-link`, "dir");
    assert.ok((await classifyToolCall("read_file", { path: "outside-link/note.txt" }, workspace)).approvalReason);
    assert.ok((await classifyToolCall("search_files", { path: "outside-link" }, workspace)).approvalReason);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("absolute attachment and tool paths resolve directly while relative paths default to workspace", () => {
  assert.equal(resolveWorkspacePath("/workspace/agent", "notes/a.txt"), "/workspace/agent/notes/a.txt");
  assert.equal(resolveWorkspacePath("/workspace/agent", "/data/attachments/a.png"), "/data/attachments/a.png");
});

test("resolved traversal and symlink parents cannot bypass protected write paths", async () => {
  const root = await temporaryDirectory("agent-path-policy-");
  try {
    const protectedTraversal = resolveWorkspacePath(root, "../../etc/agent-runtime-test");
    assert.equal(protectedTraversal, "/etc/agent-runtime-test");
    await assert.rejects(assertWritableTargetAllowed(protectedTraversal), /protected host path/);

    const linked = `${root}/protected-link`;
    await symlink("/etc", linked, "dir");
    await assert.rejects(assertWritableTargetAllowed(`${linked}/agent-runtime-test`), /through a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file reads are range-bounded and patch-sized reads reject sparse files", async () => {
  const root = await temporaryDirectory("agent-bounded-file-");
  const path = `${root}/large.bin`;
  try {
    const handle = await open(path, "w", 0o600);
    await handle.truncate(100 * 1024 * 1024);
    await handle.close();

    const selected = await readRegularFileRange(path, 99 * 1024 * 1024, 1024);
    assert.equal(selected.total, 100 * 1024 * 1024);
    assert.equal(selected.buffer.length, 1024);
    await assert.rejects(
      readRegularFileRange(path, 0, 10 * 1024 * 1024, undefined, 10 * 1024 * 1024),
      /exceeds/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file reads reject FIFOs without waiting for a writer", async () => {
  const root = await temporaryDirectory("agent-fifo-file-");
  const path = `${root}/pipe`;
  try {
    execFileSync("mkfifo", [path]);
    await assert.rejects(readRegularFileRange(path, 0, 1024), /regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
