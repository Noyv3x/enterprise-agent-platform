import assert from "node:assert/strict";
import test from "node:test";
import {
  SERIAL_TEST_FILES,
  classifyCompiledTests,
} from "./run-compiled-tests.mjs";

test("serial wall-clock files are a closed subset of compiled tests", () => {
  const names = [
    "approval-broker.test.js",
    "helpers.js",
    "run-timeout.test.js",
    "background-task-guard.test.js",
    "concurrency.test.js",
    "tools.test.js",
  ];
  const classified = classifyCompiledTests(names);
  assert.deepEqual(classified.serial, [...SERIAL_TEST_FILES]);
  assert.deepEqual(classified.parallel, [
    "approval-broker.test.js",
    "tools.test.js",
  ]);
});

test("missing serial compiled files fail closed", () => {
  assert.throws(
    () => classifyCompiledTests(["approval-broker.test.js"]),
    /serial runtime tests missing from dist\/test: background-task-guard\.test\.js, concurrency\.test\.js, run-timeout\.test\.js/,
  );
});
