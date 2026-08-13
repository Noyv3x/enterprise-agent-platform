import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(scriptPath));
const compiledTestDirectory = join(packageRoot, "dist/test");

// Files that assert sub-second real timers, or share waitUntil/deadline
// windows with those assertions. They must not share a Node process with
// the rest of the suite: `--test-concurrency>1` turns runner scheduling
// into fake product idle/timeouts.
export const SERIAL_TEST_FILES = Object.freeze([
  "background-task-guard.test.js",
  "concurrency.test.js",
  "run-timeout.test.js",
]);

export function classifyCompiledTests(names) {
  const tests = names.filter((name) => name.endsWith(".test.js")).sort();
  const missing = SERIAL_TEST_FILES.filter((name) => !tests.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `serial runtime tests missing from dist/test: ${missing.join(", ")}`,
    );
  }
  const serial = new Set(SERIAL_TEST_FILES);
  return {
    serial: SERIAL_TEST_FILES.slice(),
    parallel: tests.filter((name) => !serial.has(name)),
  };
}

function runNodeTest(concurrency, files) {
  const result = spawnSync(
    process.execPath,
    ["--test", `--test-concurrency=${concurrency}`, ...files],
    { cwd: packageRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const { serial, parallel } = classifyCompiledTests(
    readdirSync(compiledTestDirectory),
  );
  assert.ok(serial.length > 0, "serial runtime test set must not be empty");
  assert.ok(parallel.length > 0, "parallel runtime test set must not be empty");
  runNodeTest(
    1,
    serial.map((name) => join(compiledTestDirectory, name)),
  );
  runNodeTest(
    4,
    parallel.map((name) => join(compiledTestDirectory, name)),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
