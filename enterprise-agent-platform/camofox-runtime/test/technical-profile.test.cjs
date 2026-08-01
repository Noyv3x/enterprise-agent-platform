"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const preload = path.resolve(__dirname, "..", "loopback-preload.cjs");

function runPreload(overrides = {}) {
  const environment = {
    PATH: process.env.PATH,
    AGENT_PLATFORM_TECHNICAL_PROFILE: "agent-platform-v1",
    AGENT_PLATFORM_CAMOFOX_BIND_HOST: "127.0.0.1",
    ...overrides,
  };
  return spawnSync(process.execPath, ["--require", preload, "--eval", "process.stdout.write('ready')"], {
    encoding: "utf8",
    env: environment,
  });
}

test("target Camoufox preload accepts the target technical profile", () => {
  const result = runPreload();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready");
});

test("target Camoufox preload rejects missing, unknown, and source-prefixed identity", () => {
  const missing = runPreload({ AGENT_PLATFORM_TECHNICAL_PROFILE: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /AGENT_PLATFORM_TECHNICAL_PROFILE must be agent-platform-v1/);

  const unknown = runPreload({ AGENT_PLATFORM_TECHNICAL_PROFILE: "future-profile-v1" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /AGENT_PLATFORM_TECHNICAL_PROFILE must be agent-platform-v1/);

  const source = runPreload({ UBITECH_CAMOFOX_BIND_HOST: "0.0.0.0" });
  assert.notEqual(source.status, 0);
  assert.match(source.stderr, /Source-profile environment is not accepted/);

  const mixed = runPreload({ ENTERPRISE_PLATFORM_DATA: "/tmp/source" });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /Source-profile environment is not accepted/);
});
