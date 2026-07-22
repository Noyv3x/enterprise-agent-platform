import assert from "node:assert/strict";
import { rm, symlink } from "node:fs/promises";
import test from "node:test";
import {
  APPROVAL_ARGUMENT_MAX_BYTES,
  hardBlockedCommand,
  normalizeCommandForApproval,
  redactCommandForApproval,
} from "../src/approval-policy.js";
import { classifyToolCall } from "../src/tools.js";
import { temporaryDirectory } from "./helpers.js";

test("terminal approval keys and displays bind the exact raw command and execution shape", async () => {
  const workspace = await temporaryDirectory("agent-approval-policy-");
  try {
    const base = await classifyToolCall("terminal", { command: "printf ok" }, workspace);
    const controlled = await classifyToolCall("terminal", {
      command: "\u001b[31mprintf ok\u001b[0m\r\n",
      cwd: ".",
      background: false,
    }, workspace);
    assert.match(controlled.hardBlock || "", /control characters/);
    const ascii = await classifyToolCall("terminal", { command: "printf K" }, workspace);
    const fullwidth = await classifyToolCall("terminal", { command: "printf Ｋ" }, workspace);
    assert.notEqual(
      ascii.approvalKey,
      fullwidth.approvalKey,
      "NFKC-equivalent display text must not share authorization for different raw bytes",
    );
    assert.equal(ascii.displayArguments?.command, "printf K");
    assert.equal(fullwidth.displayArguments?.command, "printf Ｋ");
    assert.notEqual(
      base.approvalKey,
      (await classifyToolCall("terminal", { command: "printf changed" }, workspace)).approvalKey,
    );
    assert.notEqual(
      base.approvalKey,
      (await classifyToolCall("terminal", { command: "printf ok", cwd: "/tmp" }, workspace)).approvalKey,
    );
    const configuredDefault = await classifyToolCall("terminal", { command: "printf ok" }, workspace, 12_345);
    const explicitDefault = await classifyToolCall(
      "terminal",
      { command: "printf ok", timeout_ms: 12_345 },
      workspace,
      99_999,
    );
    assert.equal(configuredDefault.approvalKey, explicitDefault.approvalKey);
    assert.equal(configuredDefault.displayArguments?.timeout_ms, 12_345);
    assert.notEqual(
      configuredDefault.approvalKey,
      (await classifyToolCall("terminal", { command: "printf ok", timeout_ms: 12_346 }, workspace, 12_345)).approvalKey,
    );
    assert.notEqual(
      base.approvalKey,
      (await classifyToolCall("terminal", { command: "printf ok", background: true }, workspace)).approvalKey,
    );
    assert.notEqual(
      (await classifyToolCall("terminal", { command: "printf ok", background: true }, workspace)).approvalKey,
      (await classifyToolCall("terminal", {
        command: "printf ok",
        background: true,
        update_behavior: "terminate",
      }, workspace)).approvalKey,
    );
    const background = await classifyToolCall("terminal", { command: "printf ok", background: true }, workspace, 12_345);
    const backgroundTimed = await classifyToolCall(
      "terminal",
      { command: "printf ok", background: true, timeout_ms: 12_345 },
      workspace,
      99_999,
    );
    assert.equal(background.displayArguments?.timeout_ms, undefined);
    assert.equal(backgroundTimed.displayArguments?.timeout_ms, 12_345);
    assert.notEqual(background.approvalKey, backgroundTimed.approvalKey);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("terminal approval rejects commands that cannot be displayed completely", async () => {
  const exact = "x".repeat(APPROVAL_ARGUMENT_MAX_BYTES);
  assert.ok((await classifyToolCall("terminal", { command: exact })).approvalKey);

  const oversized = await classifyToolCall("terminal", { command: `${exact}x` });
  assert.match(oversized.hardBlock || "", /complete approval display limit/);
  assert.equal(oversized.approvalKey, undefined);

  const multibyte = await classifyToolCall("terminal", {
    command: "界".repeat(Math.floor(APPROVAL_ARGUMENT_MAX_BYTES / 3) + 1),
  });
  assert.match(multibyte.hardBlock || "", /UTF-8 bytes/);
  assert.equal(multibyte.displayArguments, undefined);
});

test("file approval keys bind canonical target and every execution argument", async () => {
  const workspace = await temporaryDirectory("agent-file-approval-policy-");
  const outside = await temporaryDirectory("agent-file-approval-outside-");
  try {
    await symlink(outside, `${workspace}/link`);
    const direct = await classifyToolCall("write_file", {
      path: `${outside}/note.txt`,
      content: "approved content",
    }, workspace);
    const throughLink = await classifyToolCall("write_file", {
      path: "link/note.txt",
      content: "approved content",
    }, workspace);
    assert.equal(direct.approvalKey, throughLink.approvalKey);
    assert.notEqual(
      direct.approvalKey,
      (await classifyToolCall("write_file", {
        path: `${outside}/other.txt`,
        content: "approved content",
      }, workspace)).approvalKey,
    );
    const changedContent = await classifyToolCall("write_file", {
      path: `${outside}/note.txt`,
      content: "different content",
    }, workspace);
    assert.notEqual(direct.approvalKey, changedContent.approvalKey);
    assert.match(JSON.stringify(direct.displayArguments), /content omitted: 16 UTF-8 bytes/);
    assert.doesNotMatch(JSON.stringify(direct.displayArguments), /approved content/);

    const firstPatch = await classifyToolCall("patch_file", {
      path: `${outside}/note.txt`,
      old_text: "old",
      new_text: "first",
      expected_replacements: 1,
    }, workspace);
    const secondPatch = await classifyToolCall("patch_file", {
      path: `${outside}/note.txt`,
      old_text: "old",
      new_text: "second",
      expected_replacements: 1,
    }, workspace);
    assert.notEqual(firstPatch.approvalKey, secondPatch.approvalKey);
    assert.doesNotMatch(JSON.stringify(firstPatch.displayArguments), /"first"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("action approval keys bind action and resource", async () => {
  const writeOne = await classifyToolCall("process", { action: "write", process_id: "one", input: "printf one\n" });
  const writeTwo = await classifyToolCall("process", { action: "write", process_id: "two", input: "printf one\n" });
  const changedInput = await classifyToolCall("process", { action: "write", process_id: "one", input: "printf changed\n" });
  const killOne = await classifyToolCall("process", { action: "kill", process_id: "one" });
  assert.notEqual(writeOne.approvalKey, writeTwo.approvalKey);
  assert.notEqual(writeOne.approvalKey, changedInput.approvalKey);
  assert.notEqual(writeOne.approvalKey, killOne.approvalKey);
  assert.match(JSON.stringify(writeOne.displayArguments), /printf one/);
  assert.equal(writeOne.allowSession, false);
  assert.equal(writeOne.allowPermanent, false);
});

test("mutation approval keys bind all arguments and redact body fields", async () => {
  const cases = [
    {
      tool: "memory",
      first: { action: "store", arguments: { target: "memory", content: "first memory", tags: ["one"] } },
      second: { action: "store", arguments: { target: "memory", content: "second memory", tags: ["one"] } },
      omitted: "content omitted",
    },
    {
      tool: "skill",
      first: { action: "update", arguments: { id: "review", instructions: "first instructions", version: "1" } },
      second: { action: "update", arguments: { id: "review", instructions: "second instructions", version: "1" } },
      omitted: "instructions omitted",
    },
    {
      tool: "schedule",
      first: { action: "update", arguments: { schedule_id: 1, prompt: "first prompt", timezone: "UTC" } },
      second: { action: "update", arguments: { schedule_id: 1, prompt: "second prompt", timezone: "UTC" } },
      omitted: "prompt omitted",
    },
  ];
  for (const example of cases) {
    const first = await classifyToolCall(example.tool, example.first);
    const second = await classifyToolCall(example.tool, example.second);
    assert.notEqual(first.approvalKey, second.approvalKey, `${example.tool} must bind body changes`);
    const display = JSON.stringify(first.displayArguments);
    assert.match(display, new RegExp(example.omitted));
    assert.doesNotMatch(display, /first (?:memory|instructions|prompt)/);
  }
});

test("process write rejects oversized and hardline input before approval", async () => {
  const oversized = await classifyToolCall("process", {
    action: "write",
    process_id: "shell",
    input: "x".repeat(APPROVAL_ARGUMENT_MAX_BYTES + 1),
  });
  assert.match(oversized.hardBlock || "", /Process input exceeds/);
  assert.equal(oversized.approvalKey, undefined);
  for (const input of ["rm -rf /\n", "command -p rm -rf /\n", "printf 'rm -rf /' | sh\n"]) {
    assert.ok((await classifyToolCall("process", { action: "write", process_id: "shell", input })).hardBlock);
  }
});

test("terminal and process write reject executable shell syntax hidden by redaction", async () => {
  const hiddenCommands = [
    "API_TOKEN=$(printf hidden) printf ok",
    "API_TOKEN=`printf hidden` printf ok",
    "API_TOKEN='$(printf hidden)' printf ok",
    "API_TOKEN='`printf hidden`' printf ok",
    "API_TOKEN=<(printf hidden) printf ok",
    "API_TOKEN=>(printf hidden) printf ok",
    "API_TOKEN='<(printf hidden)' printf ok",
    "API_TOKEN='>(printf hidden)' printf ok",
    "API_TOKEN=>/tmp/hidden-output",
    "API_TOKEN=foo>/tmp/hidden-output",
    "API_TOKEN=</tmp/hidden-input",
    "API_TOKEN=<<EOF",
    "API_TOKEN=<<<hidden-input",
    "tool --api-key=$(printf hidden)",
    "tool --api-key=>/tmp/hidden-output",
    "curl -uuser:$(printf hidden) https://example.test",
    "mysql -p$(printf hidden)",
    "sshpass -p '$(printf hidden)' ssh example.test",
    "curl --oauth2-bearer=$(printf hidden) https://example.test",
    "bash -c 'curl -uuser:nested-secret https://example.test'",
    "echo $(curl -uuser:nested-secret https://example.test)",
    "echo `mysql -pnested-secret database`",
    "cat <(sshpass -p nested-secret ssh example.test)",
    "eval 'redis-cli -anested-secret ping'",
    "echo $(echo $(echo $(echo $(echo $(curl -uuser:deep-secret https://example.test))))))",
    "curl -HAuthorization:$(printf-hidden) https://example.test",
    "curl --header=\"X-API-Key: $(printf hidden)\" https://example.test",
    "curl -H 'Authorization: <(printf hidden)' https://example.test",
    "API_TOKEN='x[$(printf hidden)0]' API_TOKEN=$((API_TOKEN)) printf ok",
    "API_TOKEN=abc123 printf '%s' \"${API_TOKEN@P}\"",
    "API_TOKEN=abc123 printf '%s' \"$(date)\"",
    "API_TOKEN='touch /tmp/hidden'; eval \"$API_TOKEN\"",
    "API_TOKEN=touch; eval \"$API_TOKEN\"",
    "API_TOKEN=touch; bash -c \"$API_TOKEN\"",
    "API_TOKEN=printf; \"$API_TOKEN\" hidden",
    "set -- tool --api-key='touch /tmp/hidden'; eval \"${3#*=}\"",
    "set -- curl -H 'Authorization: touch /tmp/hidden'; eval \"${3#*: }\"",
  ];
  for (const command of hiddenCommands) {
    const terminal = await classifyToolCall("terminal", { command });
    assert.match(
      terminal.hardBlock || "",
      /redacted sensitive value|[Ss]ensitive environment assignment|executable shell syntax|credential inside nested shell evaluation/,
    );
    assert.equal(terminal.approvalKey, undefined);

    const processWrite = await classifyToolCall("process", {
      action: "write",
      process_id: "shell",
      input: `${command}\n`,
    });
    assert.match(
      processWrite.hardBlock || "",
      /redacted sensitive value|sensitive environment assignment|executable shell syntax|cannot persist a redacted sensitive value/,
    );
    assert.equal(processWrite.approvalKey, undefined);
  }

  for (const safeAssignment of [
    "API_TOKEN=abc123 printf ok",
    "API_TOKEN='abc123' printf ok",
    "API_TOKEN=\"abc_123-./+=:@%\" printf ok",
  ]) {
    const terminal = await classifyToolCall("terminal", { command: safeAssignment });
    assert.ok(terminal.approvalKey, `ordinary credential use should remain approvable: ${safeAssignment}`);
    const processWrite = await classifyToolCall("process", {
      action: "write",
      process_id: "shell",
      input: `${safeAssignment}\n`,
    });
    assert.match(processWrite.hardBlock || "", /cannot persist a redacted sensitive value/);
  }

  for (const safeCommand of [
    "curl -H 'Authorization: Bearer ordinary-secret' https://example.test",
    "curl -HAuthorization:compact-secret https://example.test",
    "curl -H 'Authorization: foo>bar' https://example.test",
    "tool --api-key=foo\\>bar",
    "tool --api-key='complex secret value'",
    "printf '%s' 'documentation API_TOKEN=complex value'",
  ]) {
    const terminal = await classifyToolCall("terminal", { command: safeCommand });
    assert.ok(terminal.approvalKey, `ordinary credential use should remain approvable: ${safeCommand}`);
    const processWrite = await classifyToolCall("process", {
      action: "write",
      process_id: "shell",
      input: `${safeCommand}\n`,
    });
    assert.match(processWrite.hardBlock || "", /cannot persist a redacted sensitive value/);
  }
});

test("terminal and process write reject high-risk invisible and bidi controls", async () => {
  const codePoints = [
    0x00ad,
    0x061c,
    0x200b,
    0x200e,
    0x200f,
    ...range(0x202a, 0x202e),
    ...range(0x2060, 0x2069),
    0xfeff,
  ];
  for (const codePoint of codePoints) {
    const control = String.fromCodePoint(codePoint);
    const terminal = await classifyToolCall("terminal", { command: `printf 'left${control}right'` });
    assert.match(terminal.hardBlock || "", /forbidden control characters/, `U+${codePoint.toString(16)}`);
    const processWrite = await classifyToolCall("process", {
      action: "write",
      process_id: "shell",
      input: `printf 'left${control}right'\n`,
    });
    assert.match(processWrite.hardBlock || "", /forbidden control characters/, `U+${codePoint.toString(16)}`);
    assert.equal(redactCommandForApproval(`left${control}right`), "leftright");
  }
});

test("browser approval keys bind every structured argument while hiding typed text", async () => {
  const first = await classifyToolCall("browser", {
    action: "click",
    arguments: { tab_id: "tab", ref: "e1", selector: "#one" },
  });
  const differentRef = await classifyToolCall("browser", {
    action: "click",
    arguments: { tab_id: "tab", ref: "e2", selector: "#one" },
  });
  const differentSelector = await classifyToolCall("browser", {
    action: "click",
    arguments: { tab_id: "tab", ref: "e1", selector: "#two" },
  });
  assert.notEqual(first.approvalKey, differentRef.approvalKey);
  assert.notEqual(first.approvalKey, differentSelector.approvalKey);
  assert.deepEqual(first.displayArguments, {
    tool: "browser",
    action: "click",
    arguments: { tab_id: "tab", ref: "e1", selector: "#one" },
  });

  const typedOne = await classifyToolCall("browser", {
    action: "type",
    arguments: { tab_id: "tab", ref: "e1", text: "first private value", submit: true },
  });
  const typedTwo = await classifyToolCall("browser", {
    action: "type",
    arguments: { tab_id: "tab", ref: "e1", text: "second private value", submit: true },
  });
  assert.notEqual(typedOne.approvalKey, typedTwo.approvalKey);
  const displayed = JSON.stringify(typedOne.displayArguments);
  assert.doesNotMatch(displayed, /first private value/);
  assert.match(displayed, /input omitted/);
  assert.match(displayed, /"ref":"e1"/);
});

test("hardline command policy deobfuscates catastrophic commands and respects command position", () => {
  const blocked = [
    "rm -rf /",
    "rm -rf \"/\"",
    "r''m${IFS}-rf${IFS}/",
    "r$()m -rf /",
    "sudo -n /bin/rm --recursive --force /../..",
    "/usr/bin/env rm -rf /",
    "/usr/bin/sudo /bin/rm -rf /",
    "/usr/bin/command rm -rf /",
    "/bin/busybox rm -rf /",
    "command -p rm -rf /",
    "command -- rm -rf /",
    "exec -a helper rm -rf /",
    "nohup -- rm -rf /",
    "time -p rm -rf /",
    "nice rm -rf /",
    "rm -rf \"$HOME\"/*",
    "rm -rf \"${HOME:?}\"/.[!.]*",
    "find / -delete",
    "find -- / -delete",
    "find -H / -delete",
    "find / -exec rm -rf {} +",
    "cmd=rm; $cmd -rf /",
    "eval 'rm -rf /'",
    "printf 'rm -rf /' | sh",
    "echo ready && reboot",
    "echo $(shutdown -h now)",
    "bash -lc 'mkfs.ext4 /dev/sda1'",
    "dd if=/dev/zero of=/dev/nvme0n1",
    "wipefs --all /dev/sda",
    "printf x > /dev/sda",
    "printf x>/dev/mapper/root",
    ">/dev/sda echo x",
    "kill -9 -1",
    ":(){ :|:& };:",
  ];
  for (const command of blocked) {
    assert.ok(hardBlockedCommand(command), `expected hard block for ${command}`);
  }
  for (const command of [
    "echo reboot",
    "printf '%s' 'rm -rf /'",
    "git commit -m 'document shutdown and reboot'",
    "command -v rm",
    "command -V reboot",
    "printf data | sh -c 'cat >/dev/null'",
    "printf '%s' 'find / -delete; wipefs /dev/sda; rm -rf /'",
    "printf ok > /dev/null",
    "rm -rf ./build",
  ]) {
    assert.equal(hardBlockedCommand(command), undefined, `unexpected hard block for ${command}`);
  }
});

test("approval command display redacts credentials without changing policy normalization", () => {
  const token = `ghp_${"X".repeat(36)}`;
  const command = `API_TOKEN=${token} curl -H 'Authorization: Bearer ${token}' https://user:${token}@example.test`;
  const redacted = redactCommandForApproval(command);
  assert.doesNotMatch(redacted, new RegExp(token));
  assert.match(redacted, /\[redacted\]/);
  assert.match(normalizeCommandForApproval(command), new RegExp(token));
});

test("approval command display redacts common API credential headers", () => {
  const secrets = ["verysecretvalue", "second-secret", "third-secret"];
  const command = [
    `curl -H 'X-API-Key: ${secrets[0]}'`,
    `-H "Api-Key: ${secrets[1]}"`,
    `-H 'X-Auth-Token: ${secrets[2]}'`,
    "https://example.test",
  ].join(" ");
  const redacted = redactCommandForApproval(command);
  for (const secret of secrets) assert.doesNotMatch(redacted, new RegExp(secret));
  assert.equal(redacted.match(/\[redacted\]/g)?.length, secrets.length);
});

test("approval command display redacts compact, equals, and unquoted curl headers", () => {
  const cases = [
    ["compact-secret", "curl -HAuthorization:compact-secret https://example.test"],
    ["short-equals-secret", "curl -H=X-API-Key:short-equals-secret https://example.test"],
    ["long-equals-secret", "curl --header=X-Auth-Token:long-equals-secret https://example.test"],
    ["unquoted-secret", "curl --header Cookie:unquoted-secret https://example.test"],
    ["quoted-compact-secret", "curl -H\"Proxy-Authorization: quoted-compact-secret\" https://example.test"],
  ];
  for (const [secret, command] of cases) {
    const redacted = redactCommandForApproval(command ?? "");
    assert.doesNotMatch(redacted, new RegExp(secret ?? ""));
    assert.match(redacted, /\[redacted\]/);
  }
});

test("approval command display redacts common attached client credentials without hiding unrelated flags", () => {
  const cases = [
    ["curl-user-secret", "curl -uuser:curl-user-secret https://example.test"],
    ["curl-cookie-secret", "curl -bsid=curl-cookie-secret https://example.test"],
    ["curl-proxy-secret", "curl -Uproxy:curl-proxy-secret https://example.test"],
    ["oauth-secret", "curl --oauth2-bearer=oauth-secret https://example.test"],
    ["mysql-secret", "mysql -pmysql-secret database"],
    ["sshpass-secret", "sshpass -p sshpass-secret ssh example.test"],
    ["redis-secret", "redis-cli -aredis-secret ping"],
    ["container-secret", "docker login -pcontainer-secret registry.example.test"],
    ["wrapped-secret", "timeout 30 curl -uuser:wrapped-secret https://example.test"],
    ["literal-secret", "printf '%s' 'curl -uuser:literal-secret https://example.test'"],
  ];
  for (const [secret, command] of cases) {
    const redacted = redactCommandForApproval(command ?? "");
    assert.doesNotMatch(redacted, new RegExp(secret ?? ""));
    assert.match(redacted, /\[redacted\]/);
  }

  assert.equal(redactCommandForApproval("sudo -uroot id"), "sudo -uroot id");
  assert.equal(redactCommandForApproval("mkdir -p output"), "mkdir -p output");

  for (const command of [
    "bash -c 'curl -uuser:nested-secret https://example.test'",
    "echo $(mysql -pnested-secret database)",
  ]) {
    const redacted = redactCommandForApproval(command);
    assert.doesNotMatch(redacted, /nested-secret/);
    assert.match(redacted, /nested shell evaluation/);
  }
});

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}
