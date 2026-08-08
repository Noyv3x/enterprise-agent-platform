import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { redactToolArgumentsForJournal } from "../src/approval-policy.js";
import { redactToolArgumentsForModelHistory } from "../src/model-history.js";
import { createTools } from "../src/tools.js";

test("model-history redaction preserves executable tool schemas and keeps audit envelopes separate", () => {
  const secret = `ghp_${"H".repeat(36)}`;
  const tools = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["terminal", { command: `API_TOKEN=${secret} printf ok`, cwd: "." }],
    ["process", {
      tool: "process",
      action: "write",
      arguments: { process_id: "shell", input: `API_TOKEN=${secret} printf ok` },
    }],
    ["write_file", { path: "report.txt", content: secret }],
    ["patch_file", { path: "report.txt", old_text: secret, new_text: `${secret}-new` }],
    ["browser", {
      tool: "browser",
      action: "type",
      arguments: { tab_id: "tab", ref: "e1", text: secret },
    }],
    ["browser", {
      action: "extract",
      arguments: { schema: { type: "object", description: secret } },
    }],
    ["memory", {
      action: "store",
      arguments: { content: secret, target: "memory", tags: [secret] },
    }],
    ["skill", {
      action: "create",
      arguments: { name: "Review", description: secret, instructions: secret },
    }],
    ["schedule", {
      action: "create",
      arguments: {
        name: secret,
        prompt: secret,
        schedule: { type: "interval", every_seconds: 300 },
      },
    }],
    ["mail", {
      action: "send",
      arguments: {
        account_id: 1,
        to: ["recipient@example.com"],
        subject: secret,
        text_body: secret,
      },
    }],
    ["sylver_platform", {
      tool: "sylver_platform",
      action: "propose_wiki",
      arguments: {
        project_slug: "platform",
        title: "Security notes",
        slug: "security-notes",
        content: secret,
        source_document_id: "platform/security-notes",
        content_format: "markdown",
        order: 0,
        change_summary: secret,
      },
    }],
    ["delegate_task", { prompt: secret, system_prompt: `${secret}-system` }],
  ];

  for (const [toolName, args] of cases) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `missing ${toolName} tool`);
    const redacted = redactToolArgumentsForModelHistory(toolName, args);
    assert.doesNotMatch(JSON.stringify(redacted), new RegExp(secret));
    assert.doesNotThrow(
      () => validateToolArguments(
        tool,
        { ...fauxToolCall(toolName, args), arguments: redacted },
      ),
      `${toolName} model-history arguments must still match its executable schema`,
    );
  }

  assert.deepEqual(
    redactToolArgumentsForModelHistory("process", cases[1]?.[1] ?? {}),
    {
      action: "write",
      process_id: "shell",
      input: "API_TOKEN=[redacted] printf ok",
    },
    "process history stays flat like the executable process schema",
  );
  assert.deepEqual(
    redactToolArgumentsForJournal("browser", {
      action: "snapshot",
      arguments: { tab_id: "tab" },
    }),
    {
      tool: "browser",
      action: "snapshot",
      arguments: { tab_id: "tab" },
    },
    "audit display keeps its explicit tool envelope",
  );
  assert.deepEqual(
    redactToolArgumentsForJournal("sylver_platform", {
      action: "comment_approval",
      arguments: { approval_id: 7, body: "private comment" },
    }),
    {
      tool: "sylver_platform",
      action: "comment_approval",
      arguments: { approval_id: 7, body: "private comment" },
    },
    "Sylver Lining approval display keeps the complete short mutation body",
  );
});

test("model-history canonicalization retains mismatched and unknown fields for strict rejection", () => {
  assert.deepEqual(
    redactToolArgumentsForModelHistory("browser", {
      tool: "web",
      action: "navigate",
      arguments: { url: "https://example.com/" },
    }),
    {
      tool: "web",
      action: "navigate",
      arguments: { url: "https://example.com/" },
    },
  );
  assert.deepEqual(
    redactToolArgumentsForModelHistory("browser", {
      tool: "browser",
      action: "navigate",
      arguments: { url: "https://example.com/" },
      user_id: "other-user",
    }),
    {
      action: "navigate",
      arguments: { url: "https://example.com/" },
      user_id: "other-user",
    },
  );
});

test("model-history uses schema-compatible redaction for constrained identifiers and paths", () => {
  const tools = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  });
  const skill = tools.find((candidate) => candidate.name === "skill");
  assert.ok(skill);
  const id = "sk-abcdefghijklmnop";
  const path = `scripts/${id}`;

  for (const args of [
    { action: "load", arguments: { id } },
    { action: "read", arguments: { id, file_path: path } },
  ]) {
    const projected = redactToolArgumentsForModelHistory("skill", args);
    assert.doesNotMatch(JSON.stringify(projected), /sk-abcdefghijklmnop/);
    assert.doesNotThrow(() => validateToolArguments(
      skill,
      { ...fauxToolCall("skill", args), arguments: projected },
    ));
  }
});

test("model-history bounds arbitrary browser extraction schemas without changing root shape", () => {
  const tools = createTools({
    runId: "run",
    request: { scope_key: "private:1" } as never,
    processes: {} as never,
    gateway: {} as never,
    querySession: async () => null,
    delegate: async () => "",
    markSideEffect: () => undefined,
  });
  const browser = tools.find((candidate) => candidate.name === "browser");
  assert.ok(browser);
  let nested: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 100; index += 1) nested = { child: nested };
  const args = {
    action: "extract",
    arguments: {
      schema: {
        nested,
        many: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, index])),
      },
    },
  };

  const projected = redactToolArgumentsForModelHistory("browser", args);
  assert.doesNotThrow(() => validateToolArguments(
    browser,
    { ...fauxToolCall("browser", args), arguments: projected },
  ));
  assert.ok(JSON.stringify(projected).length < 10_000);
  assert.match(JSON.stringify(projected), /\[omitted\]/);
});
