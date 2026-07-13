import assert from "node:assert/strict";
import test from "node:test";
import { EventJournal } from "../src/event-journal.js";

test("EventJournal assigns sequence numbers and replays from a cursor", () => {
  const journal = new EventJournal("run_one");
  journal.publish("run.queued");
  journal.publish("run.started");
  const received: number[] = [];
  journal.subscribe(1, (event) => received.push(event.sequence));
  journal.publish("message.delta", { delta: "hello" });
  assert.deepEqual(received, [2, 3]);
});

test("EventJournal closes subscriptions after a terminal event", () => {
  const journal = new EventJournal("run_one");
  journal.publish("run.completed", { output: "done" });
  const events = journal.list();
  assert.equal(journal.isTerminal, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "run.completed");
});

test("EventJournal retains only the newest configured event count", () => {
  const journal = new EventJournal("run_bounded_count", { maxEvents: 3, maxBytes: 8_192 });
  for (let index = 0; index < 5; index += 1) journal.publish("message.delta", { delta: String(index) });
  assert.deepEqual(journal.list().map((event) => event.sequence), [3, 4, 5]);
});

test("EventJournal bounds retained bytes and marks an oversized event", () => {
  const maxBytes = 512;
  const journal = new EventJournal("run_bounded_bytes", { maxEvents: 10, maxBytes });
  const published = journal.publish("message.delta", { delta: "x".repeat(10_000) });
  assert.equal(published.data.truncated, true);
  assert.equal(typeof published.data.original_bytes, "number");
  assert.match(String(published.data.delta), /…$/);
  const retainedBytes = journal.list().reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
  assert.ok(retainedBytes <= maxBytes, `${retainedBytes} retained bytes exceeded ${maxBytes}`);
});
