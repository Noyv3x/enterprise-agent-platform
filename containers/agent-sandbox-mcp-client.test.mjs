import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeMcpRequest } from "./agent-sandbox-mcp-client.mjs";

const serverSource = `
import { appendFile } from "node:fs/promises";
const [literalArgument, marker] = process.argv.slice(2);
await appendFile(marker, "started\\n", "utf8");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" }
      } }) + "\\n");
    } else if (message.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
        literalArgument,
        configuredEnv: process.env.MCP_FIXTURE_ENV,
        inheritedSecret: process.env.PLATFORM_SECRET_SHOULD_NOT_LEAK ?? null
      } }) + "\\n");
    } else if (message.method === "tools/call" && message.params.name === "fail") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: {
        code: -32001, message: "fixture rejected the call", data: { retryable: false }
      } }) + "\\n");
    } else if (message.method === "tools/call" && message.params.name === "oversized") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: "x".repeat(300 * 1024) }]
      } }) + "\\n");
    } else if (message.method === "tools/call" && message.params.name !== "hang") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: JSON.stringify(message.params.arguments) }]
      } }) + "\\n");
    }
  }
});
`;

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-mcp-client-"));
  const platformDirectory = join(workspaceRoot, ".agent-platform");
  const configPath = join(platformDirectory, "mcp.json");
  const serverPath = join(workspaceRoot, "server.mjs");
  const markerPath = join(workspaceRoot, "started.log");
  await mkdir(platformDirectory, { recursive: true });
  await writeFile(serverPath, serverSource, "utf8");
  return { workspaceRoot, configPath, serverPath, markerPath };
}

function config(serverPath, markerPath, id = "local") {
  return {
    mcpServers: {
      [id]: {
        command: "node",
        args: [serverPath, "literal;touch should-not-run", markerPath],
        env: { MCP_FIXTURE_ENV: "configured" },
        cwd: ".",
      },
    },
  };
}

test("server discovery is hot-read and never starts configured processes", async () => {
  const files = await fixture();
  try {
    await writeFile(files.configPath, JSON.stringify(config(files.serverPath, files.markerPath)), "utf8");
    assert.deepEqual(
      await executeMcpRequest({ action: "list" }, files),
      { servers: ["local"] },
    );
    await assert.rejects(access(files.markerPath), { code: "ENOENT" });

    await writeFile(files.configPath, JSON.stringify(config(files.serverPath, files.markerPath, "updated")), "utf8");
    assert.deepEqual(
      await executeMcpRequest({ action: "list" }, files),
      { servers: ["updated"] },
    );
  } finally {
    await rm(files.workspaceRoot, { recursive: true, force: true });
  }
});

test("one workspace cannot read another workspace MCP config", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    await writeFile(first.configPath, JSON.stringify(config(first.serverPath, first.markerPath, "first")), "utf8");
    await writeFile(second.configPath, JSON.stringify(config(second.serverPath, second.markerPath, "second")), "utf8");
    assert.deepEqual(await executeMcpRequest({ action: "list" }, first), { servers: ["first"] });
    await assert.rejects(
      executeMcpRequest({ action: "list" }, {
        workspaceRoot: first.workspaceRoot,
        configPath: second.configPath,
      }),
      /config must remain inside the workspace/,
    );
  } finally {
    await rm(first.workspaceRoot, { recursive: true, force: true });
    await rm(second.workspaceRoot, { recursive: true, force: true });
  }
});

test("stdio list and call use argv without shell, isolate env, and preserve bounded protocol errors", async () => {
  const files = await fixture();
  const previousSecret = process.env.PLATFORM_SECRET_SHOULD_NOT_LEAK;
  process.env.PLATFORM_SECRET_SHOULD_NOT_LEAK = "must-not-leak";
  try {
    await writeFile(files.configPath, JSON.stringify(config(files.serverPath, files.markerPath)), "utf8");
    const listed = await executeMcpRequest({ action: "list", server: "local" }, files);
    assert.deepEqual(listed, {
      server: "local",
      result: {
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
        literalArgument: "literal;touch should-not-run",
        configuredEnv: "configured",
        inheritedSecret: null,
      },
    });
    assert.equal((await readFile(files.markerPath, "utf8")).trim(), "started");

    const called = await executeMcpRequest({
      action: "call",
      server: "local",
      tool: "echo",
      arguments: { text: "hello" },
    }, files);
    assert.deepEqual(called, {
      server: "local",
      tool: "echo",
      result: { content: [{ type: "text", text: '{"text":"hello"}' }] },
    });

    const failed = await executeMcpRequest({
      action: "call",
      server: "local",
      tool: "fail",
      arguments: {},
    }, files);
    assert.deepEqual(failed, {
      server: "local",
      tool: "fail",
      error: { code: -32001, message: "fixture rejected the call", data: { retryable: false } },
    });
  } finally {
    if (previousSecret === undefined) delete process.env.PLATFORM_SECRET_SHOULD_NOT_LEAK;
    else process.env.PLATFORM_SECRET_SHOULD_NOT_LEAK = previousSecret;
    await rm(files.workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace command and cwd execute through pinned descriptors", async () => {
  const files = await fixture();
  const commandPath = join(files.workspaceRoot, "server-command");
  try {
    await writeFile(commandPath, "#!/bin/sh\nexec node \"$@\"\n", { encoding: "utf8", mode: 0o700 });
    const value = config(files.serverPath, files.markerPath);
    value.mcpServers.local.command = "./server-command";
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    const listed = await executeMcpRequest({ action: "list", server: "local" }, files);
    assert.equal(listed.server, "local");
    assert.equal(listed.result.literalArgument, "literal;touch should-not-run");
  } finally {
    await rm(files.workspaceRoot, { recursive: true, force: true });
  }
});

test("client fails closed on workspace escape and timeout", async () => {
  const files = await fixture();
  try {
    await writeFile(files.configPath, JSON.stringify({
      mcpServers: {
        local: { ...config(files.serverPath, files.markerPath).mcpServers.local, command: process.execPath },
      },
    }), "utf8");
    await assert.rejects(
      executeMcpRequest({ action: "list" }, files),
      /command path must remain inside the workspace/,
    );

    await writeFile(files.configPath, JSON.stringify({
      mcpServers: {
        local: { ...config(files.serverPath, files.markerPath).mcpServers.local, cwd: ".." },
      },
    }), "utf8");
    await assert.rejects(
      executeMcpRequest({ action: "list" }, files),
      /cwd must be a workspace directory/,
    );

    await writeFile(files.configPath, JSON.stringify(config(files.serverPath, files.markerPath)), "utf8");
    await assert.rejects(
      executeMcpRequest({
        action: "call",
        server: "local",
        tool: "hang",
        arguments: {},
      }, { ...files, timeoutMs: 50 }),
      /timed out/,
    );
  } finally {
    await rm(files.workspaceRoot, { recursive: true, force: true });
  }
});

test("client rejects an oversized server output line", async () => {
  const files = await fixture();
  try {
    await writeFile(files.configPath, JSON.stringify(config(files.serverPath, files.markerPath)), "utf8");
    await assert.rejects(
      executeMcpRequest({
        action: "call",
        server: "local",
        tool: "oversized",
        arguments: {},
      }, files),
      /message limit|256 KiB/,
    );
  } finally {
    await rm(files.workspaceRoot, { recursive: true, force: true });
  }
});
