"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const runtimeRoot = path.resolve(__dirname, "..");
const patchScript = path.join(runtimeRoot, "patch-runtime.cjs");
const upstream = path.join(runtimeRoot, "node_modules", "@askjo", "camofox-browser");
const COPIED = ["package.json", "server.js", "lib/persistence.js", "lib/cookies.js", "plugins/persistence/index.js"];

// A temporary install of the locked upstream files the patch touches, patched twice (the patch must be idempotent).
function patchedCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-camofox-patch-"));
  const browser = path.join(root, "node_modules", "@askjo", "camofox-browser");
  for (const file of COPIED) {
    fs.mkdirSync(path.dirname(path.join(browser, file)), { recursive: true });
    fs.copyFileSync(path.join(upstream, file), path.join(browser, file));
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, [patchScript], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, browser };
}

test("locked Camoufox patch installs atomic pointer control idempotently", () => {
  const { root, browser } = patchedCopy();
  try {
    const patched = fs.readFileSync(path.join(browser, "server.js"), "utf8");
    assert.match(patched, /app\.post\('\/tabs\/:tabId\/pointer'/);
    const pointerStart = patched.indexOf("app.post('/tabs/:tabId/pointer'");
    const pointerEnd = patched.indexOf("\n// Type\n/**", pointerStart);
    assert.ok(pointerStart >= 0 && pointerEnd > pointerStart);
    const pointerRoute = patched.slice(pointerStart, pointerEnd);
    assert.match(pointerRoute, /action !== 'drag'/);
    assert.match(pointerRoute, /points\.length < 2 \|\| points\.length > 64/);
    assert.match(pointerRoute, /atMs > 10000/);
    assert.match(pointerRoute, /finally \{[\s\S]*tabState\.page\.mouse\.up/);
    assert.match(patched, /b\.newContext\(contextOptions, \{ agentPlatformUserId: String\(key\) \}\)/);
    assert.equal(patched.match(/newContext\(contextOptions/g)?.length, 1);
    assert.match(patched, /options\.clip = \{ x: clipX, y: clipY, width: clipWidth, height: clipHeight \}/);
    assert.match(patched, /scale: 'css'/);
    assert.equal(patched.match(/app\.post\('\/tabs\/:tabId\/pointer'/g)?.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function profile(profileDir, userId) {
  const dir = path.join(profileDir, crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "storage-state.json"), JSON.stringify({ cookies: [{ name: "sid", value: userId }], origins: [] }));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ userId }));
  return dir;
}

test("ephemeral identities are never persisted, restored or seeded, and old leftovers are removed at startup", async () => {
  const { root, browser } = patchedCopy();
  const profileDir = path.join(root, "profiles");
  const cookiesDir = path.join(root, "cookies");
  const previous = process.env.CAMOFOX_PROFILE_DIR;
  try {
    fs.mkdirSync(cookiesDir, { recursive: true });
    fs.writeFileSync(path.join(cookiesDir, "cookies.txt"), ".example.com\tTRUE\t/\tTRUE\t4102444800\tboot\t1\n");
    const leftovers = [profile(profileDir, "artifact-render:0d1e"), profile(profileDir, "web-fetch:7a2b")];
    const kept = profile(profileDir, "private:1");
    const unrelated = path.join(profileDir, "not-a-profile");
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "meta.json"), JSON.stringify({ userId: "web-fetch:x" }));

    process.env.CAMOFOX_PROFILE_DIR = profileDir;
    const plugin = await import(pathToFileURL(path.join(browser, "plugins", "persistence", "index.js")).href);
    const events = new EventEmitter();
    const emit = (name, payload) => Promise.all(events.listeners(name).map(listener => listener(payload)));
    await plugin.register({}, { events, config: { cookiesDir }, log: () => {} });

    for (const dir of leftovers) assert.equal(fs.existsSync(dir), false, dir);
    assert.equal(fs.existsSync(path.join(kept, "storage-state.json")), true, "other identities keep their profile");
    assert.equal(fs.existsSync(unrelated), true, "only profile-shaped directories are considered");

    const context = (userId) => {
      const added = [];
      return { added, async addCookies(cookies) { added.push(...cookies); },
        async storageState({ path: file }) { fs.writeFileSync(file, JSON.stringify({ cookies: [{ name: "c", value: userId }], origins: [] })); } };
    };
    for (const userId of ["web-fetch:1", "artifact-render:2", "private:1", "private:2"]) {
      const options = {};
      const ctx = context(userId);
      await emit("session:creating", { userId, contextOptions: options });
      await emit("session:created", { userId, context: ctx });
      await emit("session:destroying", { userId, reason: "delete" });
      const dir = path.join(profileDir, crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32));
      const ephemeral = !userId.startsWith("private:");
      assert.equal(options.storageState === undefined, userId !== "private:1", `${userId} restore`);
      assert.equal(ctx.added.length, userId === "private:2" ? 1 : 0, `${userId} bootstrap cookies`);
      assert.equal(fs.existsSync(dir), !ephemeral, `${userId} profile on disk`);
    }
  } finally {
    if (previous === undefined) delete process.env.CAMOFOX_PROFILE_DIR;
    else process.env.CAMOFOX_PROFILE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
