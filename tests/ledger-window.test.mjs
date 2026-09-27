/**
 * Tests for the ledger-window bounds: src/stellar/client.ts + src/stellar/events.ts
 *
 * The window is the pair `getHealth()` reports — the retained floor and the
 * chain tip. `getEvents` rejects anything outside it, so these tests pin the
 * local validation that refuses such a request before it is spent, with a
 * bounded, secret-free message.
 *
 * Everything is an in-process fake: no network, no Testnet, no Telegram.
 *
 * Covered:
 *   - validateLedgerWindow: positive, malformed, inverted, boundary
 *   - clampStartLedger: inside, floor, tip, above-tip, invalid
 *   - resumeCursorProblem: inside, floor, tip, below/above, opaque cursor
 *   - paginatedGetEvents: clamps start, refuses out-of-window cursors
 *   - scanner: malformed XDR never crashes decoding or JSON serialization
 *   - restart: an in-window cursor resumes; an ahead-of-tip cursor is kept and
 *     surfaced as a bounded error
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { nativeToScVal } from "@stellar/stellar-sdk";

import { clampStartLedger, LedgerWindowError, validateLedgerWindow } from "../dist/stellar/client.js";
import {
  buildScanJsonReport,
  buildScanJsonTarget,
  eventCursorLedger,
  formatScanJson,
  paginatedGetEvents,
  readContractEvents,
  resumeCursorProblem,
} from "../dist/stellar/events.js";
import { createPoller } from "../dist/poller.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

/** Build a cursor that encodes `ledger` the way Soroban does. */
const makeCursor = (ledger, tx = 1) => `${(BigInt(ledger) << 32n) | BigInt(tx)}-0`;

const WINDOW = { oldestLedger: 900, latestLedger: 1000 };

/** Minimal fake rpc.Server; records the requests it was asked to serve. */
function makeServer(health, pages = []) {
  const queue = [...pages];
  const requests = [];
  return {
    requests,
    async getHealth() {
      return health;
    },
    async getEvents(req) {
      requests.push(req);
      const page = queue[Math.min(requests.length - 1, queue.length - 1)] ?? {};
      return {
        events: page.events ?? [],
        cursor: page.cursor ?? "",
        latestLedger: page.latestLedger ?? health.latestLedger,
      };
    },
  };
}

/** A rejection predicate that also pins the bounded-message contract. */
function windowError(problem, needle) {
  return (err) => {
    assert.ok(err instanceof LedgerWindowError, `expected a LedgerWindowError, got ${String(err)}`);
    assert.equal(err.problem, problem);
    assert.match(err.message, needle);
    assert.ok(err.message.length <= 240, `message not bounded: ${err.message.length}`);
    assert.equal(err.message.includes(TOKEN), false, "a window error must never carry a token");
    return true;
  };
}

// ── validateLedgerWindow ─────────────────────────────────────────────────────

test("validateLedgerWindow: a healthy window is returned unchanged", () => {
  assert.deepEqual(validateLedgerWindow(WINDOW), WINDOW);
});

test("validateLedgerWindow: a single-ledger window is a valid boundary", () => {
  assert.deepEqual(validateLedgerWindow({ oldestLedger: 500, latestLedger: 500 }), {
    oldestLedger: 500,
    latestLedger: 500,
  });
});

test("validateLedgerWindow: missing, negative, or non-integer bounds are refused", () => {
  for (const health of [
    { latestLedger: 1000 },
    { oldestLedger: 900 },
    { oldestLedger: -1, latestLedger: 1000 },
    { oldestLedger: 900, latestLedger: 10.5 },
    { oldestLedger: Number.NaN, latestLedger: 1000 },
    { oldestLedger: "900", latestLedger: 1000 },
  ]) {
    assert.throws(
      () => validateLedgerWindow(health),
      windowError("malformed-window", /malformed ledger window/),
    );
  }
});

test("validateLedgerWindow: an inverted window is refused", () => {
  assert.throws(
    () => validateLedgerWindow({ oldestLedger: 1000, latestLedger: 900 }),
    windowError("malformed-window", /inverted ledger window/),
  );
});

test("validateLedgerWindow: a hostile bound cannot produce an unbounded message", () => {
  assert.throws(
    () => validateLedgerWindow({ oldestLedger: 900, latestLedger: `${TOKEN}${"z".repeat(4000)}` }),
    (err) => {
      assert.ok(err instanceof LedgerWindowError);
      assert.equal(err.problem, "malformed-window");
      assert.ok(err.message.length <= 240, `message not bounded: ${err.message.length}`);
      assert.ok(!err.message.includes("z".repeat(100)), "remote payload must be clipped");
      return true;
    },
  );
});

// ── clampStartLedger ─────────────────────────────────────────────────────────

test("clampStartLedger: a start inside the window is not clamped", () => {
  assert.deepEqual(clampStartLedger(950, WINDOW), { startLedger: 950, clamped: false });
});

test("clampStartLedger: the floor and tip are inclusive boundaries", () => {
  assert.deepEqual(clampStartLedger(900, WINDOW), { startLedger: 900, clamped: false });
  assert.deepEqual(clampStartLedger(1000, WINDOW), { startLedger: 1000, clamped: false });
});

test("clampStartLedger: a start below the floor is clamped up to it", () => {
  assert.deepEqual(clampStartLedger(1, WINDOW), { startLedger: 900, clamped: true });
});

test("clampStartLedger: a start above the tip is refused, never silently moved", () => {
  assert.throws(
    () => clampStartLedger(1001, WINDOW),
    windowError("start-after-tip", /ahead of the chain tip 1000/),
  );
});

test("clampStartLedger: zero, negative, and non-integer starts are refused", () => {
  for (const requested of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "900"]) {
    assert.throws(
      () => clampStartLedger(requested, WINDOW),
      windowError("start-invalid", /positive integer/),
    );
  }
});

// ── resumeCursorProblem ──────────────────────────────────────────────────────

test("resumeCursorProblem: a cursor inside the window is accepted", () => {
  assert.equal(resumeCursorProblem(makeCursor(950), WINDOW), null);
});

test("resumeCursorProblem: floor and tip cursors are accepted boundaries", () => {
  assert.equal(resumeCursorProblem(makeCursor(900), WINDOW), null);
  assert.equal(resumeCursorProblem(makeCursor(1000), WINDOW), null);
});

test("resumeCursorProblem: a cursor below the floor is classified as stale", () => {
  // Classified, but the reader still forwards it: retention is the RPC's call.
  // The poller decides whether to rewind, and only after a fresh `getHealth()`
  // proves the cursor is below the floor (see the scan test below).
  assert.equal(resumeCursorProblem(makeCursor(899), WINDOW), "cursor-before-floor");
});

test("resumeCursorProblem: a cursor above the tip is impossible and refused", () => {
  assert.equal(resumeCursorProblem(makeCursor(1001), WINDOW), "cursor-after-tip");
});

test("resumeCursorProblem: an opaque cursor is forwarded, not refused", () => {
  // A cursor shape this build cannot read must reach the RPC: cursor formats are
  // opaque and forward compatibility beats local guessing.
  assert.equal(resumeCursorProblem("not-a-toid", WINDOW), null);
  assert.equal(resumeCursorProblem("", WINDOW), null);
});

// ── paginatedGetEvents integration ───────────────────────────────────────────

test("paginatedGetEvents: an in-window cursor is forwarded and startLedger omitted", async () => {
  const cursor = makeCursor(950);
  const server = makeServer(WINDOW, [{ events: [], cursor: makeCursor(1000), latestLedger: 1000 }]);

  const scan = await paginatedGetEvents(server, [], { cursor });

  assert.equal(server.requests[0].cursor, cursor);
  assert.ok(!("startLedger" in server.requests[0]), "cursor request must not include startLedger");
  assert.equal(scan.startLedger, null, "a resumed walk has no start ledger");
  assert.equal(scan.startClamped, false);
});

test("paginatedGetEvents: a stale cursor is forwarded so the RPC's rejection is authoritative", async () => {
  const cursor = makeCursor(100);
  const server = makeServer(WINDOW, [{ events: [], cursor: makeCursor(1000), latestLedger: 1000 }]);

  // Below the floor is a retention judgement the RPC owns: the cursor is not
  // rewritten or dropped locally. It is sent on, and the poller decides whether
  // to rewind only after a fresh `getHealth()` confirms it is below the floor.
  const scan = await paginatedGetEvents(server, [], { cursor });

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].cursor, cursor);
  assert.equal(scan.startLedger, null, "a resumed walk still has no start ledger");
});

test("paginatedGetEvents: an ahead-of-tip cursor is refused before any request is sent", async () => {
  const server = makeServer(WINDOW, []);

  await assert.rejects(
    () => paginatedGetEvents(server, [], { cursor: makeCursor(2000) }),
    windowError("cursor-after-tip", /cursor ledger 2000 is ahead of the chain tip 1000/),
  );
  assert.equal(server.requests.length, 0);
});

test("paginatedGetEvents: a start ledger below the floor is clamped up and reported", async () => {
  const server = makeServer(WINDOW, [{ events: [], cursor: makeCursor(1000), latestLedger: 1000 }]);

  const scan = await paginatedGetEvents(server, [], { startLedger: 10 });

  assert.equal(server.requests[0].startLedger, 900);
  assert.equal(scan.startLedger, 900);
  assert.equal(scan.startClamped, true);
});

test("paginatedGetEvents: a start ledger above the tip is refused, not clamped down", async () => {
  const server = makeServer(WINDOW, []);

  await assert.rejects(
    () => paginatedGetEvents(server, [], { startLedger: 5000 }),
    windowError("start-after-tip", /startLedger 5000 is ahead of the chain tip 1000/),
  );
  assert.equal(server.requests.length, 0);
});

test("paginatedGetEvents: a cold-start lookback lands inside the window", async () => {
  const server = makeServer(WINDOW, [{ events: [], cursor: makeCursor(1000), latestLedger: 1000 }]);

  const scan = await paginatedGetEvents(server, [], { lookbackLedgers: 40 });

  assert.equal(server.requests[0].startLedger, 960);
  assert.equal(scan.startLedger, 960);
  assert.equal(scan.startClamped, false);
});

test("paginatedGetEvents: a malformed health window fails with a bounded error", async () => {
  const server = makeServer({ oldestLedger: 900 }, []);

  await assert.rejects(
    () => paginatedGetEvents(server, [], { startLedger: 950 }),
    windowError("malformed-window", /malformed ledger window/),
  );
  assert.equal(server.requests.length, 0);
});

test("eventCursorLedger: boundary cursors place on the expected ledgers", () => {
  assert.equal(eventCursorLedger(makeCursor(900)), 900);
  assert.equal(eventCursorLedger(makeCursor(1001)), 1001);
});

// ── Scanner: malformed XDR must never crash ──────────────────────────────────

test("scanner: malformed XDR decodes to unknown and never throws", async () => {
  const malformedValue = { __notAnScVal: true };
  const server = makeServer(WINDOW, [
    {
      events: [
        {
          id: "950-0",
          contractId: MARKET_ID,
          ledger: 950,
          txHash: "deadbeef",
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          topic: [nativeToScVal("claim_created", { type: "symbol" })],
          value: malformedValue,
        },
        {
          id: "951-0",
          contractId: MARKET_ID,
          ledger: 951,
          txHash: "feedface",
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          topic: [malformedValue],
          value: malformedValue,
        },
      ],
      cursor: makeCursor(1000),
      latestLedger: 1000,
    },
  ]);

  // The whole point: a bad event is data, not an exception.
  const scan = await readContractEvents(
    server,
    { source: "market", contractId: MARKET_ID },
    { startLedger: 900 },
  );

  assert.equal(scan.events.length, 2, "both malformed events must still be returned");
  for (const event of scan.events) {
    assert.equal(event.payload.name, "unknown");
  }
  assert.match(scan.events[0].payload.reason, /malformed event value XDR/);
  assert.equal(scan.cursor, makeCursor(1000), "the cursor still advances past a bad event");
  assert.equal(scan.lastEventLedger, 951);

  // The scanner's JSON path must serialize the same bad events without throwing.
  const target = buildScanJsonTarget(scan, 5);
  assert.equal(target.eventCount, 2);
  assert.equal(target.startLedger, 900);
  assert.equal(target.startClamped, false);
  assert.ok(Object.keys(target.histogram).every((key) => key.startsWith("unknown")));

  const report = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban.example.invalid",
    oldestLedger: WINDOW.oldestLedger,
    latestLedger: WINDOW.latestLedger,
    targets: [target],
  });
  const text = formatScanJson(report);
  const parsed = JSON.parse(text);
  assert.equal(parsed.targets[0].events[0].payload.name, "unknown");
  assert.doesNotMatch(text, /BOT_TOKEN|ghp_|private.?key/i);
  assert.equal(text.includes(TOKEN), false);
});

// ── Restart: cursor safety against the window ────────────────────────────────

function pollerConfig(cursorFile) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 9_999_999,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

function cursorFileJson(cursor) {
  return `${JSON.stringify(
    {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      targets: {
        market: { cursor, lastEventLedger: null },
        squad: { cursor, lastEventLedger: null },
      },
    },
    null,
    2,
  )}\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

test("restart: a persisted in-window cursor resumes with no window error", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(cursorFile, cursorFileJson(makeCursor(950)), "utf8");

    const server = makeServer(WINDOW, [
      { events: [], cursor: makeCursor(1000), latestLedger: 1000 },
    ]);
    const poller = createPoller({ config: pollerConfig(cursorFile), server, send: async () => {} });
    try {
      await poller.start();
      await waitFor(() => poller.status().lastSuccessAt !== null);
      await sleep(60); // let the cycle's cursor save land

      const status = poller.status();
      assert.equal(status.lastError, null);
      const market = status.targets.find((t) => t.source === "market");
      assert.equal(market.cursor, makeCursor(1000), "the cursor advances past the restart point");
      assert.ok(server.requests.every((req) => typeof req.cursor === "string"));
    } finally {
      poller.stop();
    }
  }));

test("restart: an ahead-of-tip cursor is kept and surfaced as a bounded error", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const saved = makeCursor(2000);
    await writeFile(cursorFile, cursorFileJson(saved), "utf8");

    const server = makeServer(WINDOW, [
      { events: [], cursor: makeCursor(1000), latestLedger: 1000 },
    ]);
    const poller = createPoller({ config: pollerConfig(cursorFile), server, send: async () => {} });
    try {
      await poller.start();
      await waitFor(() => poller.status().consecutiveFailures >= 1);
      await sleep(60); // let the failed cycle's cursor save land

      const status = poller.status();
      assert.ok(status.lastError);
      assert.match(
        status.lastError.message,
        /^(market|squad): cursor ledger 2000 is ahead of the chain tip 1000$/,
      );
      assert.ok(status.lastError.message.length <= 240);
      assert.equal(status.lastError.message.includes(TOKEN), false);

      for (const target of status.targets) {
        assert.equal(target.cursor, saved, "an out-of-window cursor is never rewound or wiped");
        assert.match(target.lastError, /ahead of the chain tip/);
      }
      assert.equal(server.requests.length, 0, "no request may be sent for an impossible cursor");
    } finally {
      poller.stop();
    }
  }));
