import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from "../dist/dedup.js";

// ── positive ─────────────────────────────────────────────────────────────────

test("a new id is accepted once and reported as duplicate afterwards", () => {
  const window = new EventDedupWindow(8);

  assert.equal(window.add("0000000005-0000000001"), true);
  assert.equal(window.has("0000000005-0000000001"), true);
  assert.equal(window.add("0000000005-0000000001"), false);
  assert.equal(window.size, 1);
});

test("eventKey prefers the RPC id and accepts a decoded event's eventId", () => {
  assert.equal(eventKey({ id: "1-2", eventId: "9-9", txHash: "aa" }), "1-2");
  assert.equal(eventKey({ eventId: "9-9", txHash: "aa", ledger: 5 }), "9-9");
  assert.equal(eventKey({ id: "", eventId: "9-9" }), "9-9");
});

test("eventKey falls back to ledger/tx/topic-count when no id is present", () => {
  assert.equal(eventKey({ txHash: "aa", ledger: 5, topic: [1, 2] }), "5:aa:2");
  assert.equal(eventKey({ txHash: "aa", ledger: 5, topic: [] }), "5:aa:0");
});

// ── negative ─────────────────────────────────────────────────────────────────

test("a window with capacity 0 disables dedup: every id is reported new", () => {
  const window = new EventDedupWindow(0);

  assert.equal(window.add("x"), true);
  assert.equal(window.add("x"), true);
  assert.equal(window.size, 0);
  assert.deepEqual(window.toJSON(), []);
});

test("eventKey returns null when there is nothing stable to key on", () => {
  assert.equal(eventKey({}), null);
  assert.equal(eventKey({ id: null, eventId: undefined, txHash: "" }), null);
});

test("a null key is never recorded and never reported as duplicate", () => {
  const window = new EventDedupWindow(4);
  assert.equal(window.add(null), true);
  assert.equal(window.add(null), true);
  assert.equal(window.size, 0);
});

// ── boundary ─────────────────────────────────────────────────────────────────

test("the window holds exactly capacity ids and evicts the oldest first", () => {
  const window = new EventDedupWindow(3);

  for (const id of ["a", "b", "c"]) assert.equal(window.add(id), true);
  assert.equal(window.size, 3);

  // Adding a fourth evicts "a" — the oldest — and not "b" or "c".
  assert.equal(window.add("d"), true);
  assert.equal(window.size, 3);
  assert.deepEqual(window.toJSON(), ["b", "c", "d"]);

  assert.equal(window.add("a"), true, "evicted id is new again");
  assert.equal(window.add("d"), false, "recent id is still a duplicate");
});

test("a capacity of 1 keeps only the most recent id", () => {
  const window = new EventDedupWindow(1);
  window.add("a");
  window.add("b");

  assert.equal(window.has("a"), false);
  assert.equal(window.has("b"), true);
});

test("the default capacity is applied when none is given", () => {
  const window = new EventDedupWindow();
  assert.equal(window.capacity, DEFAULT_DEDUP_WINDOW);
});

test("a non-finite or fractional capacity is sanitised to a whole number", () => {
  assert.equal(new EventDedupWindow(Number.NaN).capacity, 0);
  assert.equal(new EventDedupWindow(2.9).capacity, 2);
  assert.equal(new EventDedupWindow(-5).capacity, 0);
});

// ── restart / serialisation ──────────────────────────────────────────────────

test("a window survives a JSON round trip (restart) and still rejects redelivery", () => {
  const before = new EventDedupWindow(4);
  for (const id of ["1", "2", "3"]) before.add(id);

  const restored = EventDedupWindow.fromJSON(JSON.parse(JSON.stringify(before.toJSON())), 4);

  assert.deepEqual(restored.toJSON(), ["1", "2", "3"]);
  assert.equal(restored.add("3"), false, "redelivered id is suppressed after restart");
  assert.equal(restored.add("4"), true, "a genuinely new id is still accepted");
});

test("fromJSON tolerates garbage, non-string entries, and oversized input", () => {
  for (const garbage of [null, undefined, 42, "not-an-array", {}, [1, null, "ok", {}]]) {
    const window = EventDedupWindow.fromJSON(garbage, 2);
    assert.ok(window.size <= 2, "window stays bounded");
  }

  const oversized = Array.from({ length: 100 }, (_, i) => `e${i}`);
  const window = EventDedupWindow.fromJSON(oversized, 8);
  assert.equal(window.size, 8);
  assert.deepEqual(window.toJSON(), ["e92", "e93", "e94", "e95", "e96", "e97", "e98", "e99"]);
});

// ── regression ───────────────────────────────────────────────────────────────

test("dedup is order-stable: duplicates in a stream are dropped in place", () => {
  const window = new EventDedupWindow(16);
  const stream = ["a", "b", "a", "c", "b", "d"];
  const kept = stream.filter((id) => window.add(id));

  assert.deepEqual(kept, ["a", "b", "c", "d"]);
});
