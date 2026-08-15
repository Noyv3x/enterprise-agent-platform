import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  CodexFileDraftProjector,
  FILE_DRAFT_MAX_BYTES,
  type RuntimeFileDraftProjection,
} from "../src/file-draft-projector.js";

type DraftUpdate = Extract<
  AssistantMessageEvent,
  { type: "toolcall_delta" | "toolcall_end" }
>;

function assistantMessage(
  toolCall: ToolCall,
  provider = "openai-codex",
  api: AssistantMessage["api"] = "openai-codex-responses",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ignored leading block" }, toolCall],
    api,
    provider,
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function update(
  type: DraftUpdate["type"],
  name: string,
  arguments_: Record<string, unknown>,
  options: {
    id?: string;
    provider?: string;
    api?: AssistantMessage["api"];
    partialArguments?: Record<string, unknown>;
  } = {},
): DraftUpdate {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: options.id ?? "call-stable",
    name,
    arguments: arguments_,
  };
  const partialToolCall = options.partialArguments
    ? { ...toolCall, arguments: options.partialArguments }
    : toolCall;
  const partial = assistantMessage(
    partialToolCall,
    options.provider,
    options.api,
  );
  return type === "toolcall_delta"
    ? {
      type,
      contentIndex: 1,
      delta: "RAW_JSON_FRAGMENT_MUST_NOT_BE_CONSUMED",
      partial,
    }
    : {
      type,
      contentIndex: 1,
      toolCall,
      partial,
    };
}

function textOfLength(length: number): string {
  const line = "const visibleValue = 1;\n";
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

test("projects cumulative Codex write_file arguments at visible checkpoints and toolcall_end", () => {
  const projector = new CodexFileDraftProjector(true);
  const projections: RuntimeFileDraftProjection[] = [];
  for (const length of [640, 768, 1_024, 1_536]) {
    const projection = projector.project(update("toolcall_delta", "write_file", {
      target: "sandbox",
      path: "/workspace/src/./app.ts",
      content: textOfLength(length),
    }));
    if (projection) projections.push(projection);
  }
  const finalContent = textOfLength(1_536);
  projections.push(projector.project(update("toolcall_end", "write_file", {
    path: "/workspace/src/./app.ts",
    content: finalContent,
  }, {
    partialArguments: { path: "/workspace/src/./app.ts", content: "stale-partial" },
  }))!);

  assert.deepEqual(projections.map((projection) => projection.file_draft.revision), [1, 2, 3, 4, 5]);
  assert.deepEqual(projections.map((projection) => projection.file_draft.complete), [false, false, false, false, true]);
  assert.equal(projections[0]?.tool_call_id, "call-stable");
  assert.equal(projections[0]?.tool_name, "write_file");
  assert.equal(projections[0]?.file_draft.workspace_path, "src/app.ts");
  assert.equal(projections[0]?.file_draft.kind, "file");
  assert.equal(projections.at(-1)?.file_draft.content, finalContent);
  assert.doesNotMatch(JSON.stringify(projections), /RAW_JSON_FRAGMENT|ignored/);
});

test("patch drafts expose only the replacement fragment", () => {
  const projector = new CodexFileDraftProjector(true);
  const oldText = `old-secret-${"do-not-project ".repeat(80)}`;
  const newText = textOfLength(800);
  const incremental = projector.project(update("toolcall_delta", "patch_file", {
    target: "sandbox",
    path: "src/app.ts",
    old_text: oldText,
    new_text: newText,
  }));
  const complete = projector.project(update("toolcall_end", "patch_file", {
    path: "src/app.ts",
    old_text: oldText,
    new_text: newText,
  }));

  assert.equal(incremental?.file_draft.kind, "replacement");
  assert.equal(complete?.file_draft.kind, "replacement");
  assert.equal(complete?.file_draft.content, newText);
  assert.doesNotMatch(JSON.stringify([incremental, complete]), /old-secret|do-not-project/);
});

test("redacts credentials that cross updates, incomplete PEM, opaque tokens, and long hex", () => {
  const splitProjector = new CodexFileDraftProjector(true);
  const prefix = textOfLength(700);
  const token = `ghp_${"Ab3".repeat(12)}`;
  const first = splitProjector.project(update("toolcall_delta", "write_file", {
    target: "sandbox",
    path: "secrets.txt",
    content: `${prefix}\n${token.slice(0, 9)}`,
  }));
  const second = splitProjector.project(update("toolcall_delta", "write_file", {
    target: "sandbox",
    path: "secrets.txt",
    content: `${prefix}\n${token}\n${textOfLength(400)}`,
  }));
  const final = splitProjector.project(update("toolcall_end", "write_file", {
    path: "secrets.txt",
    content: `${prefix}\n${token}\n${textOfLength(400)}`,
  }));
  const splitJournal = JSON.stringify([first, second, final]);
  assert.doesNotMatch(splitJournal, /ghp_|Ab3Ab3/);
  assert.match(splitJournal, /redacted-token/);

  const pemProjector = new CodexFileDraftProjector(true);
  const pemBody = "QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTArLw==".repeat(16);
  const incompletePem = pemProjector.project(update("toolcall_delta", "write_file", {
    target: "sandbox",
    path: "key.pem",
    content: `${prefix}-----BEGIN PRIVATE KEY-----\n${pemBody}`,
  }));
  const opaque = "Aa0_Bb1-Cc2_Dd3-Ee4_Ff5-Gg6_Hh7-Ii8_Jj9-Kk0_Ll1-Mm2";
  const longHex = "abcdef0123456789".repeat(4);
  const completedPem = pemProjector.project(update("toolcall_end", "write_file", {
    path: "key.pem",
    content: `${prefix}-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n${opaque}\n${longHex}`,
  }));
  const pemJournal = JSON.stringify([incompletePem, completedPem]);
  assert.doesNotMatch(pemJournal, /BEGIN PRIVATE KEY|QWxhZGRp|Aa0_Bb1|abcdef0123456789/);
  assert.match(pemJournal, /redacted-private-key/);
  assert.match(pemJournal, /redacted-opaque-token/);
  assert.match(pemJournal, /redacted-long-hex/);
});

test("redacts complete and unfinished URL userinfo without changing ordinary URLs", () => {
  const projector = new CodexFileDraftProjector(true);
  const prefix = textOfLength(700);
  const password = "CorrectHorseBattery".repeat(40);
  const unfinished = projector.project(update("toolcall_delta", "write_file", {
    target: "sandbox",
    path: "config.txt",
    content: `${prefix}\nendpoint=HTTPS://alice:${password}`,
  }));
  const completedContent = `${prefix}\nendpoint=HTTPS://alice:${password}@internal.example/path\n${textOfLength(700)}`;
  const completed = projector.project(update("toolcall_delta", "write_file", {
    target: "sandbox",
    path: "config.txt",
    content: completedContent,
  }));
  const final = projector.project(update("toolcall_end", "write_file", {
    path: "config.txt",
    content: completedContent,
  }));
  const journal = JSON.stringify([unfinished, completed, final]);

  assert.ok(unfinished, "the >512-byte unfinished credential must exercise a visible draft revision");
  assert.doesNotMatch(journal, /CorrectHorseBattery/);
  assert.match(journal, /alice:\[redacted\]@internal\.example/);

  const ordinaryContent = [
    "https://example.test/path?q=visible#section",
    "http://localhost:8080/health",
    "ssh://git@example.test/repository.git",
    "https://[2001:db8::1]:8443/status",
    "HTTP://localhost:8080",
  ].join("\n");
  const ordinary = new CodexFileDraftProjector(true).project(update("toolcall_end", "write_file", {
    path: "links.txt",
    content: ordinaryContent,
  }));
  assert.equal(ordinary?.file_draft.content, ordinaryContent);
});

test("withdraws a published identity when target or path becomes unsafe", () => {
  for (const unsafeArguments of [
    { target: "host", path: "draft.txt", content: textOfLength(900) },
    { target: "sandbox", path: "../outside.txt", content: textOfLength(900) },
  ]) {
    const projector = new CodexFileDraftProjector(true);
    const published = projector.project(update("toolcall_delta", "write_file", {
      target: "sandbox",
      path: "draft.txt",
      content: textOfLength(640),
    }));
    const discarded = projector.project(update("toolcall_delta", "write_file", unsafeArguments));
    const finalDiscard = projector.project(update("toolcall_end", "write_file", unsafeArguments));

    assert.equal(published?.file_draft.revision, 1);
    assert.deepEqual(
      {
        id: discarded?.tool_call_id,
        name: discarded?.tool_name,
        revision: discarded?.file_draft.revision,
        complete: discarded?.file_draft.complete,
        discarded: discarded?.file_draft.discarded,
        content: discarded?.file_draft.content,
      },
      {
        id: "call-stable",
        name: "write_file",
        revision: 2,
        complete: false,
        discarded: true,
        content: undefined,
      },
    );
    assert.equal(finalDiscard?.file_draft.revision, 3);
    assert.equal(finalDiscard?.file_draft.complete, true);
    assert.equal(finalDiscard?.file_draft.discarded, true);
  }
});

test("host-only, non-Codex, wrong API, and disabled projectors expose no body", () => {
  const hostArguments = { target: "host", path: "/tmp/secret", content: textOfLength(900) };
  const safeArguments = { target: "sandbox", path: "safe.txt", content: textOfLength(900) };
  assert.equal(
    new CodexFileDraftProjector(true).project(update("toolcall_end", "write_file", hostArguments)),
    undefined,
  );
  assert.equal(
    new CodexFileDraftProjector(true).project(update("toolcall_end", "write_file", safeArguments, {
      provider: "xai",
      api: "openai-completions",
    })),
    undefined,
  );
  assert.equal(
    new CodexFileDraftProjector(true).project(update("toolcall_end", "write_file", safeArguments, {
      api: "openai-responses",
    })),
    undefined,
  );
  assert.equal(
    new CodexFileDraftProjector(false).project(update("toolcall_end", "write_file", safeArguments)),
    undefined,
  );
});

test("holds small files and absent target until the complete tool call", () => {
  const smallProjector = new CodexFileDraftProjector(true);
  const smallArguments = {
    target: "sandbox",
    path: "small.txt",
    content: textOfLength(512),
  };
  assert.equal(
    smallProjector.project(update("toolcall_delta", "write_file", smallArguments)),
    undefined,
  );
  assert.equal(
    smallProjector.project(update("toolcall_end", "write_file", smallArguments))?.file_draft.content,
    smallArguments.content,
  );

  const defaultTargetProjector = new CodexFileDraftProjector(true);
  const defaultTargetArguments = { path: "default.txt", content: textOfLength(900) };
  assert.equal(
    defaultTargetProjector.project(update("toolcall_delta", "write_file", defaultTargetArguments)),
    undefined,
    "an unfinished object can still append target=host",
  );
  const completed = defaultTargetProjector.project(
    update("toolcall_end", "write_file", defaultTargetArguments),
  );
  assert.equal(completed?.file_draft.complete, true);
  assert.equal(completed?.file_draft.workspace_path, "default.txt");
});

test("rejects empty, oversized, and control-bearing tool call identities", () => {
  const arguments_ = { target: "sandbox", path: "safe.txt", content: textOfLength(900) };
  for (const id of ["", "   ", " call-spaced", "x".repeat(513), "call\nunsafe"]) {
    assert.equal(
      new CodexFileDraftProjector(true).project(update("toolcall_end", "write_file", arguments_, { id })),
      undefined,
    );
  }
});

test("an invalid completed call does not poison a reused content index", () => {
  const projector = new CodexFileDraftProjector(true);
  assert.equal(projector.project(update("toolcall_end", "write_file", {
    target: "host",
    path: "/tmp/secret",
    content: textOfLength(900),
  }, { id: "call-host" })), undefined);

  const safe = projector.project(update("toolcall_end", "write_file", {
    target: "sandbox",
    path: "safe.txt",
    content: textOfLength(900),
  }, { id: "call-safe" }));
  assert.equal(safe?.tool_call_id, "call-safe");
  assert.equal(safe?.file_draft.workspace_path, "safe.txt");
});

test("final content is UTF-8 safe and bounded near 16 KiB", () => {
  const projector = new CodexFileDraftProjector(true);
  const projection = projector.project(update("toolcall_end", "write_file", {
    path: "unicode.txt",
    content: "🙂 line of code\n".repeat(4_000),
  }));
  const content = projection?.file_draft.content ?? "";

  assert.equal(projection?.file_draft.truncated, true);
  assert.ok(Buffer.byteLength(content) <= FILE_DRAFT_MAX_BYTES);
  assert.doesNotMatch(content, /�/u);
});
