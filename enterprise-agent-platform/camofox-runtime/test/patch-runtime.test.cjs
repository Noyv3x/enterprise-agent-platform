"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const runtimeRoot = path.resolve(__dirname, "..");
const patchScript = path.join(runtimeRoot, "patch-runtime.cjs");
const upstreamServer = path.join(
  runtimeRoot,
  "node_modules",
  "@askjo",
  "camofox-browser",
  "server.js",
);

test("locked Camoufox patch installs atomic pointer control idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-camofox-patch-"));
  const target = path.join(
    root,
    "node_modules",
    "@askjo",
    "camofox-browser",
    "server.js",
  );
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(upstreamServer, target);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(process.execPath, [patchScript], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }

    const patched = fs.readFileSync(target, "utf8");
    assert.match(patched, /app\.post\('\/tabs\/:tabId\/pointer'/);
    const pointerStart = patched.indexOf("app.post('/tabs/:tabId/pointer'");
    const pointerEnd = patched.indexOf("\n// Type\n/**", pointerStart);
    assert.ok(pointerStart >= 0 && pointerEnd > pointerStart);
    const pointerRoute = patched.slice(pointerStart, pointerEnd);
    assert.match(pointerRoute, /action !== 'drag'/);
    assert.match(pointerRoute, /points\.length < 2 \|\| points\.length > 64/);
    assert.match(pointerRoute, /atMs > 10000/);
    assert.match(pointerRoute, /finally \{[\s\S]*tabState\.page\.mouse\.up/);
    assert.match(patched, /scale: 'css'/);
    assert.equal(
      patched.match(/app\.post\('\/tabs\/:tabId\/pointer'/g)?.length,
      1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
