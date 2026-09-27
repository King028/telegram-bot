/**
 * Event ordering metadata (issue #48): preserved through decoding and
 * normalization, deterministic across pages and poll cycles, safe on
 * malformed input.
 *
 * Synthetic Soroban responses only. No network, no RPC credentials, no bot
 * tokens. Imports run against `dist/` (built by `npm test` before `node
 * --test`), mirroring the existing format/health suites.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { txExplorerUrl } from "../dist/stellar/client.js";
import {
  compareEvents,
  decodeEvent,
  dedupeEvents,
  isUsableTxHash,
  sortEvents,
} from "../dist/stellar/decode.js";
import { eventCursorLedger, readContractEvents } from "../dist/stellar/events.js";
import { formatEvent } from "../dist/notifications/format.js";

// ── Synthetic helpers ────────────────────────────────────────────────────────

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** TOID-style paging token for a ledger, matching `eventCursorLedger`. */
function cursorFor(ledger, order = 0) {
  return `${(BigInt(ledger) << 32n).toString()}-${order}`;
}

/** Minimal raw Soroban RPC event. `topic`/`value` decode to `unknown`. */
function rawEvent(overrides = {}) {
  return {
    id: cursorFor(100),
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: HASH_A,
    contractId: "",
    topic: [],
    value: undefined,
    ...overrides,
  };
}

/** A real decodable event: `claim_cancelled` needs only topic[1] (u64 id). */
function rawClaimCancelled({ claimId = 7, ...overrides } = {}) {
  return rawEvent({
    topic: [xdr.ScVal.scvString("claim_cancelled"), nativeToScVal(claimId, { type: "u64" })],
    value: xdr.ScVal.scvVoid(),
    ...overrides,
  });
}

function fakeServer({ health, pages }) {
  let calls = 0;
  return {
    getCalls: () => calls,
    async getHealth() {
      return health;
    },
    async getEvents() {
      const page = pages[calls];
      calls += 1;
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

function page({ events, cursor, latestLedger }) {
  return { events, cursor, latestLedger };
}

const TARGET = { source: "market", contractId: "C" + "A".repeat(55) };

const FORMAT_CONFIG = {
  chatId: "-1001234567890",
  marketContractId: TARGET.contractId,
  squadContractId: "C" + "B".repeat(55),
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
};

// ── Positive ─────────────────────────────────────────────────────────────────

test("decodeEvent preserves ordering metadata from the RPC response", () => {
  const decoded = decodeEvent("market", rawClaimCancelled({ claimId: 9 }));
  assert.equal(decoded.payload.name, "claim_cancelled");
  assert.equal(decoded.ledger, 100);
  assert.equal(decoded.txHash, HASH_A);
  assert.equal(decoded.eventId, cursorFor(100));
  assert.equal(decoded.eventType, "contract");
  assert.equal(decoded.transactionIndex, 1);
  assert.equal(decoded.operationIndex, 0);
  assert.equal(decoded.inSuccessfulContractCall, true);
  assert.ok(Number.isFinite(decoded.at));
});

test("compareEvents orders by ledger, then tx, then op, then paging token", () => {
  const base = decodeEvent("market", rawEvent());
  const earlier = (patch) => decodeEvent("market", rawEvent(patch));
  const cases = [
    earlier({ ledger: 99 }),
    earlier({ transactionIndex: 0 }),
    earlier({ operationIndex: -1, transactionIndex: 1 }),
    base,
  ];
  // operationIndex -1 coerces to null (unknown) and sorts after known ones.
  assert.ok(compareEvents(cases[0], cases[1]) < 0);
  assert.ok(compareEvents(cases[1], base) < 0);
  assert.ok(compareEvents(base, cases[2]) < 0);
  assert.equal(compareEvents(base, decodeEvent("market", rawEvent())), 0);
});

test("sortEvents is deterministic regardless of input order", () => {
  const mk = (ledger, tx, op, order) =>
    decodeEvent(
      "market",
      rawEvent({ id: cursorFor(ledger, order), ledger, transactionIndex: tx, operationIndex: op }),
    );
  const ordered = [mk(100, 0, 0, 0), mk(100, 0, 1, 1), mk(100, 1, 0, 2), mk(101, 0, 0, 0)];
  const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
  assert.deepEqual(
    sortEvents(shuffled).map((e) => e.eventId),
    ordered.map((e) => e.eventId),
  );
  // Input array is untouched.
  assert.equal(shuffled[0].eventId, ordered[2].eventId);
});

test("readContractEvents sorts across pages and dedupes boundary repeats", async () => {
  const e1 = rawClaimCancelled({ id: cursorFor(100, 0), ledger: 100, transactionIndex: 1 });
  const e2 = rawClaimCancelled({ id: cursorFor(100, 1), ledger: 100, transactionIndex: 0 });
  const e3 = rawClaimCancelled({ id: cursorFor(101, 0), ledger: 101, transactionIndex: 0 });
  const server = fakeServer({
    health: { oldestLedger: 90, latestLedger: 101 },
    pages: [
      page({ events: [e1, e2], cursor: cursorFor(100, 1), latestLedger: 101 }),
      // Boundary repeat of e2 plus a newer event, unsorted on the wire.
      page({ events: [e3, e2], cursor: cursorFor(101, 0), latestLedger: 101 }),
    ],
  });

  const scan = await readContractEvents(server, TARGET, { cursor: cursorFor(99) });
  assert.equal(scan.pages, 2);
  assert.equal(scan.cursor, cursorFor(101, 0));
  assert.equal(scan.lastEventLedger, 101);
  assert.deepEqual(
    scan.events.map((e) => e.eventId),
    [cursorFor(100, 1), cursorFor(100, 0), cursorFor(101, 0)],
  );
  assert.ok(scan.events.every((e) => e.payload.name === "claim_cancelled"));
});

test("decoded events with extended metadata still notify", () => {
  const decoded = decodeEvent("market", rawClaimCancelled({ claimId: 7 }));
  const message = formatEvent(FORMAT_CONFIG, decoded);
  assert.equal(typeof message, "string");
  assert.match(message, /Claim \\#7 cancelled/);
  assert.match(message, /ledger 100/);
  assert.ok(message.includes(`testnet/tx/${HASH_A}`));
});

// ── Negative ─────────────────────────────────────────────────────────────────

test("malformed XDR and malformed entries never crash the scanner", async () => {
  const server = fakeServer({
    health: { oldestLedger: 90, latestLedger: 100 },
    pages: [
      page({
        events: [
          null,
          42,
          "not-an-event",
          rawEvent({ id: cursorFor(100, 0), topic: "not-an-array", value: "!!!not-xdr!!!" }),
          rawEvent({ id: cursorFor(100, 1), topic: [null], value: null }),
          rawEvent({
            id: cursorFor(100, 2),
            ledger: "abc",
            transactionIndex: -5,
            operationIndex: 1.5,
          }),
          rawClaimCancelled({ claimId: 3, id: cursorFor(100, 3) }),
        ],
        cursor: cursorFor(100),
        latestLedger: 100,
      }),
    ],
  });

  const scan = await readContractEvents(server, TARGET, { cursor: cursorFor(99) });
  // Non-objects skipped; everything else decodes (possibly to `unknown`).
  assert.equal(scan.events.length, 4);
  assert.ok(scan.events.some((e) => e.payload.name === "claim_cancelled"));
  for (const event of scan.events) {
    assert.ok(Number.isFinite(event.ledger));
    assert.ok(Number.isFinite(event.at));
    assert.ok(event.transactionIndex === null || Number.isInteger(event.transactionIndex));
  }
  // Cursor still advances on a successful-but-messy scan.
  assert.equal(scan.cursor, cursorFor(100));
});

test("malformed ordering metadata degrades to safe defaults, never NaN", () => {
  const decoded = decodeEvent(
    "market",
    rawEvent({
      id: 42,
      type: "weird",
      ledger: "abc",
      ledgerClosedAt: "not-a-date",
      transactionIndex: "x",
      operationIndex: -1,
      inSuccessfulContractCall: "yes",
      txHash: 12345,
    }),
  );
  assert.equal(decoded.ledger, 0);
  assert.equal(decoded.at, 0);
  assert.equal(decoded.txHash, "");
  assert.equal(decoded.eventId, "");
  assert.equal(decoded.eventType, "unknown");
  assert.equal(decoded.transactionIndex, null);
  assert.equal(decoded.operationIndex, null);
  assert.equal(decoded.inSuccessfulContractCall, null);
  assert.equal(decoded.payload.name, "unknown");
});

test("decodeEvent never throws, even on null input", () => {
  const decoded = decodeEvent("squad", null);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.ledger, 0);
  assert.equal(decoded.eventId, "");
});

test("unexpected RPC shapes are treated as empty pages, not crashes", async () => {
  const server = fakeServer({
    health: { oldestLedger: 90, latestLedger: 100 },
    pages: [
      page({ events: null, cursor: cursorFor(100), latestLedger: 100 }),
      page({ events: "oops", cursor: cursorFor(100), latestLedger: 100 }),
      page({ events: undefined, cursor: 42, latestLedger: 100 }),
    ],
  });
  const scan = await readContractEvents(server, TARGET, { cursor: cursorFor(99) });
  assert.deepEqual(scan.events, []);
  assert.equal(scan.lastEventLedger, null);
});

test("RPC failure rejects the scan so the poller keeps its cursor", async () => {
  const failure = new Error("getEvents failed: cursor not found (oldestLedger=95)");
  const server = fakeServer({
    health: { oldestLedger: 95, latestLedger: 100 },
    pages: [failure],
  });
  await assert.rejects(readContractEvents(server, TARGET, { cursor: cursorFor(10) }), failure);
  assert.equal(server.getCalls(), 1);
});

// ── Boundary ─────────────────────────────────────────────────────────────────

test("multiple events in one transaction order by operation index", () => {
  const ops = [2, 0, 1].map((op) =>
    decodeEvent("market", rawEvent({ operationIndex: op, id: cursorFor(100, op) })),
  );
  assert.deepEqual(
    sortEvents(ops).map((e) => e.operationIndex),
    [0, 1, 2],
  );
});

test("multiple transactions in one ledger order by transaction index", () => {
  const txs = [2, 0, 1].map((tx) =>
    decodeEvent("market", rawEvent({ transactionIndex: tx, id: cursorFor(100, tx) })),
  );
  assert.deepEqual(
    sortEvents(txs).map((e) => e.transactionIndex),
    [0, 1, 2],
  );
});

test("events across consecutive ledgers order by ledger", () => {
  const ledgers = [102, 100, 101].map((ledger) =>
    decodeEvent("market", rawEvent({ ledger, id: cursorFor(ledger) })),
  );
  assert.deepEqual(
    sortEvents(ledgers).map((e) => e.ledger),
    [100, 101, 102],
  );
});

test("missing optional metadata sorts after known positions, never invented", () => {
  const known = decodeEvent("market", rawEvent({ transactionIndex: 0, id: cursorFor(100, 0) }));
  const missing = decodeEvent(
    "market",
    rawEvent({ transactionIndex: undefined, id: cursorFor(100, 9) }),
  );
  assert.equal(missing.transactionIndex, null);
  assert.ok(compareEvents(known, missing) < 0);
  // Same ledger, both unknown: paging token decides.
  const other = decodeEvent(
    "market",
    rawEvent({ transactionIndex: undefined, id: cursorFor(100, 1) }),
  );
  assert.ok(compareEvents(missing, other) > 0);
});

test("equal ordering keys keep input order (stable sort)", () => {
  const a = decodeEvent("market", rawEvent({ txHash: HASH_A }));
  const b = decodeEvent("market", rawEvent({ txHash: HASH_A }));
  assert.equal(compareEvents(a, b), 0);
  assert.deepEqual(sortEvents([a, b]), [a, b]);
});

test("dedupeEvents drops repeat paging tokens and keeps unidentified events", () => {
  const a = decodeEvent("market", rawEvent({ id: cursorFor(100, 0) }));
  const dup = decodeEvent("market", rawEvent({ id: cursorFor(100, 0), txHash: HASH_B }));
  const noId = decodeEvent("market", rawEvent({ id: "" }));
  const noId2 = decodeEvent("market", rawEvent({ id: "" }));
  const out = dedupeEvents([a, dup, noId, noId2]);
  assert.equal(out.length, 3);
  assert.equal(out[0].txHash, HASH_A);
  assert.ok(out.includes(noId) && out.includes(noId2));
});

test("empty event sets resolve with cursor and null lastEventLedger", async () => {
  const server = fakeServer({
    health: { oldestLedger: 90, latestLedger: 100 },
    pages: [page({ events: [], cursor: cursorFor(100), latestLedger: 100 })],
  });
  const scan = await readContractEvents(server, TARGET, { cursor: cursorFor(99) });
  assert.deepEqual(scan.events, []);
  assert.equal(scan.cursor, cursorFor(100));
  assert.equal(scan.lastEventLedger, null);
  assert.equal(scan.truncated, false);
});

test("maxPages bound truncates instead of looping forever", async () => {
  const server = fakeServer({
    health: { oldestLedger: 1, latestLedger: 200 },
    pages: [page({ events: [], cursor: cursorFor(50), latestLedger: 200 })],
  });
  const scan = await readContractEvents(server, TARGET, { cursor: cursorFor(10), maxPages: 1 });
  assert.equal(scan.truncated, true);
  assert.equal(scan.pages, 1);
  assert.equal(scan.cursor, cursorFor(50));
});

// ── Restart / regression ─────────────────────────────────────────────────────

test("cursor file format is still version 1 (restart compatible)", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(path.join(here, "fixtures", "cursor-valid.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.ok(parsed.targets.market.cursor);
  assert.ok(parsed.targets.squad.cursor);
  // Saved cursors still parse as ledger positions.
  assert.ok(Number.isInteger(eventCursorLedger(parsed.targets.market.cursor)));
  assert.equal(eventCursorLedger("not-a-cursor"), null);
});

test("restart replays nothing: same set sorts identically across cycles", () => {
  const mk = (ledger, tx, order) =>
    decodeEvent(
      "market",
      rawEvent({ id: cursorFor(ledger, order), ledger, transactionIndex: tx }),
    );
  const full = [mk(101, 1, 1), mk(100, 0, 0), mk(101, 0, 0), mk(100, 2, 2)];
  const once = sortEvents(full).map((e) => e.eventId);
  // Two cycles, split at a different point: each cycle sorted, then merged.
  const cycleA = sortEvents([full[0], full[1]]);
  const cycleB = sortEvents([full[2], full[3]]);
  const merged = sortEvents([...cycleA, ...cycleB]).map((e) => e.eventId);
  assert.deepEqual(merged, once);
});

test("stale cursor error keeps the scan failed (no silent skip)", async () => {
  const server = fakeServer({
    health: { oldestLedger: 95, latestLedger: 100 },
    pages: [new Error("invalid cursor: startLedger 10 is before oldestLedger 95")],
  });
  await assert.rejects(readContractEvents(server, TARGET, { cursor: cursorFor(10) }), /oldestLedger/);
});

test("decoded metadata carries only bounded fields (no raw RPC payloads)", () => {
  const decoded = decodeEvent("market", rawClaimCancelled({}));
  const allowed = new Set([
    "source",
    "contractId",
    "ledger",
    "txHash",
    "at",
    "eventId",
    "eventType",
    "transactionIndex",
    "operationIndex",
    "inSuccessfulContractCall",
    "payload",
  ]);
  for (const key of Object.keys(decoded)) {
    assert.ok(allowed.has(key), `unexpected key ${key}`);
  }
});

// ── Explorer links ───────────────────────────────────────────────────────────

test("isUsableTxHash accepts only 64-hex transaction hashes", () => {
  assert.equal(isUsableTxHash(HASH_A), true);
  assert.equal(isUsableTxHash("A".repeat(64)), true);
  assert.equal(isUsableTxHash("  " + HASH_A + "  "), true);
  assert.equal(isUsableTxHash(""), false);
  assert.equal(isUsableTxHash("abcd"), false);
  assert.equal(isUsableTxHash("z".repeat(64)), false);
  assert.equal(isUsableTxHash(HASH_A.slice(0, 63)), false);
});

test("footer links valid hashes and omits malformed ones without breaking", () => {
  const good = formatEvent(FORMAT_CONFIG, decodeEvent("market", rawClaimCancelled({})));
  assert.ok(good.includes(txExplorerUrl(FORMAT_CONFIG, HASH_A)));

  const short = formatEvent(
    FORMAT_CONFIG,
    decodeEvent("market", rawClaimCancelled({ txHash: "abcd" })),
  );
  assert.ok(!short.includes("[tx]("));
  assert.match(short, /ledger 100/);

  const empty = formatEvent(
    FORMAT_CONFIG,
    decodeEvent("market", rawClaimCancelled({ txHash: "" })),
  );
  assert.ok(!empty.includes("[tx]("));
});
