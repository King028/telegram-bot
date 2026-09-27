/**
 * Bounded, safe rewind from the retained ledger floor.
 *
 * When a persisted cursor is *provably* below the RPC's retained floor, every
 * scan of that cursor fails and the events below the floor are already gone.
 * This suite pins the poller's recovery: rewind to the floor, resume reading
 * the oldest data that still exists, and stop if the walk never comes back
 * inside the window.
 *
 * Safety properties under test:
 *   - the rewind is gated on a fresh `getHealth()` and only fires for a cursor
 *     the TOID places below `oldestLedger` (never for opaque or ahead-of-tip
 *     cursors, and never when the window cannot be read);
 *   - the rewind target is exactly the floor (`startLedger`, no stale cursor)
 *     and it is persisted so a restart mid-rewind resumes from the same ledger;
 *   - it is bounded: a misbehaving RPC that keeps handing back a below-floor
 *     cursor exhausts the auto-rewind budget instead of looping;
 *   - logs, status and the cursor file stay bounded and token-free.
 *
 * Everything here is an in-process fake: fake RPC, fake Telegram send,
 * temporary cursor paths and a fake clock. No network, no live Telegram, no
 * credentials.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { xdr } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { buildStatusSnapshot, serializeStatus } from "../dist/status.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

const FLOOR = 900;
const TIP = 1000;
const WINDOW = { status: "healthy", oldestLedger: FLOOR, latestLedger: TIP };

/** Soroban TOID cursor for a ledger, matching `eventCursorLedger`. */
const makeCursor = (ledger) => `${(BigInt(ledger) << 32n) | 1n}-0`;

/** Ledger the TOID half of a cursor encodes. */
function ledgerOf(cursor) {
  const toid = String(cursor).split("-")[0];
  return Number(BigInt(toid) >> 32n);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

// ── Decodable event so the notification path really runs ─────────────────────

const scvStr = (s) => xdr.ScVal.scvString(s);
const scvU64 = (n) => xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
const scvI128 = (n) => {
  const v = BigInt(n);
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: v & ((1n << 64n) - 1n), hi: v >> 64n }));
};
const G = "G".padEnd(56, "A");

function claimChallenged(ledger, claimId = 7) {
  return {
    id: `${(BigInt(ledger) << 32n) | 1n}-0`,
    ledger,
    ledgerClosedAt: new Date(0).toISOString(),
    contractId: MARKET_ID,
    txHash: "",
    type: "contract",
    inSuccessfulContractCall: true,
    topic: [scvStr("claim_challenged"), scvU64(claimId), scvStr(G)],
    value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: scvStr("stake"), val: scvI128(20_000_000) })]),
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeServer({ health = WINDOW, onEvents }) {
  const requests = [];
  const healthCalls = { n: 0 };
  return {
    requests,
    healthCalls,
    async getHealth() {
      healthCalls.n += 1;
      const value = typeof health === "function" ? health(healthCalls.n) : health;
      if (value instanceof Error) throw value;
      return value;
    },
    async getEvents(req) {
      requests.push(req);
      return onEvents(req);
    },
  };
}

function makeConfig(cursorFile, overrides = {}) {
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
    pollIntervalMs: 20,
    startLookbackLedgers: 60,
    cursorFile,
    lockFile: `${cursorFile}.lock`,
    statusFile: path.join(path.dirname(cursorFile), "status.json"),
    maxNotificationsPerCycle: 20,
    dedupWindow: 64,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    shutdownTimeoutMs: 50,
    channelPreviewMode: false,
    ...overrides,
  };
}

function cursorFileJson(targets) {
  return `${JSON.stringify(
    { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", targets },
    null,
    2,
  )}\n`;
}

/** Monotonic fake clock so status timestamps never depend on the wall clock. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return () => (value += 1_000);
}

function targetOf(poller, source) {
  return poller.status().targets.find((t) => t.source === source);
}

/** Captures console output for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => lines.push(args.join(" "));
  console.log = console.warn = console.error = record;
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

function assertBoundedAndClean(lines) {
  for (const line of lines) {
    assert.ok(line.length <= 300, `log line exceeded 300 chars (${line.length}): ${line}`);
    assert.equal(line.includes(TOKEN), false, `bot token leaked into logs: ${line}`);
  }
}

async function readJsonEventually(file, predicate, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (predicate(parsed)) return parsed;
    } catch {
      // Not written (or mid-rename) yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

// ── Positive: rewind, recover, persist ───────────────────────────────────────

test("a cursor below the retained floor is rewound to the floor and the retained event is delivered", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(100), lastEventLedger: 100 },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );

    const sent = [];
    const server = makeServer({
      onEvents: (req) => {
        if (req.cursor && ledgerOf(req.cursor) < FLOOR) {
          throw new Error(
            `cursor is stale: ledger ${ledgerOf(req.cursor)} precedes the retained floor ${FLOOR}`,
          );
        }
        const isMarket = req.filters?.[0]?.contractIds?.[0] === MARKET_ID;
        return {
          events: isMarket ? [claimChallenged(995)] : [],
          cursor: makeCursor(TIP),
          latestLedger: TIP,
        };
      },
    });

    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async (text) => {
        sent.push(text);
      },
      sendOptions: { sendSpacingMs: 0 },
      now: fakeClock(),
    });

    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().cursorRewinds >= 1, "rewind triggered");
        await until(() => poller.status().notificationsSent >= 1, "retained event delivered");
        await until(
          () => poller.status().targets.every((t) => t.rewindFromLedger === null),
          "rewind completed",
        );
      } finally {
        poller.stop();
      }
    });

    const status = poller.status();
    assert.equal(status.cursorRewinds, 1, "exactly the stale market cursor was rewound");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Claim \\#7 challenged/);

    const market = targetOf(poller, "market");
    assert.equal(market.cursor, makeCursor(TIP), "the walk resumes past the floor");
    assert.equal(market.rewindFromLedger, null, "the transient hint clears after recovery");

    // The floor walk resumed by ledger, never by the stale cursor.
    assert.ok(
      server.requests.some(
        (req) => req.startLedger === FLOOR && !Object.prototype.hasOwnProperty.call(req, "cursor"),
      ),
      "expected a floor walk with startLedger 900 and no cursor",
    );

    // The rewind is persisted: the on-disk position is no longer the stale one.
    const onDisk = await readJsonEventually(
      cursorFile,
      (json) => json.targets?.market?.cursor === makeCursor(TIP),
      "rewound cursor persisted",
    );
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.targets.market.rewindFromLedger, undefined, "a finished rewind is dropped");

    assert.ok(lines.join("\n").includes("rewinding to the floor 900"), "the rewind is logged");
    assertBoundedAndClean(lines);
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
  }));

// ── Negative: only a provably below-floor cursor is rewound ──────────────────

test("a cursor inside the window is never rewound, even when the RPC calls it stale", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(950), lastEventLedger: 950 },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );
    const server = makeServer({
      onEvents: () => {
        throw new Error("cursor is stale: unexpected rejection");
      },
    });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().consecutiveFailures >= 1, "failed cycle");
        await sleep(40);
      } finally {
        poller.stop();
      }
    });
    assert.equal(poller.status().cursorRewinds, 0);
    assert.equal(targetOf(poller, "market").cursor, makeCursor(950), "an in-window cursor is kept");
    assert.equal(targetOf(poller, "market").rewindFromLedger, null);
    assert.equal(lines.join("\n").includes("rewinding to the floor"), false);
    assertBoundedAndClean(lines);
  }));

test("an opaque cursor is never rewound", () =>
  withTempDataDir(async (dir) => {
    const opaque = "opaque-resume-token-not-a-toid";
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: opaque, lastEventLedger: null },
        squad: { cursor: opaque, lastEventLedger: null },
      }),
      "utf8",
    );
    const server = makeServer({
      onEvents: () => {
        throw new Error("cursor is stale: unknown token shape");
      },
    });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().consecutiveFailures >= 1, "failed cycle");
        await sleep(40);
      } finally {
        poller.stop();
      }
    });
    assert.equal(poller.status().cursorRewinds, 0);
    assert.equal(targetOf(poller, "market").cursor, opaque, "an unknown cursor shape is forwarded");
  }));

test("a window that cannot be read leaves the stale cursor untouched", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(100), lastEventLedger: 100 },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );
    // First health read feeds the scan; the rewind's own read fails.
    const server = makeServer({
      health: (call) => (call === 1 ? WINDOW : new Error("rpc down")),
      onEvents: (req) => {
        if (req.cursor && ledgerOf(req.cursor) < FLOOR) {
          throw new Error("cursor is stale: precedes the retained floor");
        }
        return { events: [], cursor: makeCursor(TIP), latestLedger: TIP };
      },
    });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().consecutiveFailures >= 1, "failed cycle");
        await sleep(40);
      } finally {
        poller.stop();
      }
    });
    assert.equal(poller.status().cursorRewinds, 0, "no rewind without a readable window");
    assert.equal(targetOf(poller, "market").cursor, makeCursor(100), "the cursor is kept");
    assert.ok(
      lines.join("\n").includes("could not read the retained window to rewind safely"),
      "the skipped rewind is logged",
    );
    assertBoundedAndClean(lines);
  }));

// ── Boundary ─────────────────────────────────────────────────────────────────

test("a cursor exactly at the floor is a valid boundary, not a rewind", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(FLOOR), lastEventLedger: FLOOR },
        squad: { cursor: makeCursor(FLOOR), lastEventLedger: FLOOR },
      }),
      "utf8",
    );
    const server = makeServer({
      onEvents: () => {
        throw new Error("cursor is stale: boundary rejection");
      },
    });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().consecutiveFailures >= 1, "failed cycle");
        await sleep(40);
      } finally {
        poller.stop();
      }
    });
    assert.equal(poller.status().cursorRewinds, 0);
    assert.equal(targetOf(poller, "market").cursor, makeCursor(FLOOR), "the floor cursor is kept");
  }));

test("an ahead-of-tip cursor is not rewound and no request is sent", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(2_000), lastEventLedger: 2_000 },
        squad: { cursor: makeCursor(2_000), lastEventLedger: 2_000 },
      }),
      "utf8",
    );
    const server = makeServer({ onEvents: () => ({ events: [], cursor: "", latestLedger: TIP }) });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().consecutiveFailures >= 1, "refused cursor");
        await sleep(40);
      } finally {
        poller.stop();
      }
    });
    assert.equal(poller.status().cursorRewinds, 0);
    assert.equal(targetOf(poller, "market").cursor, makeCursor(2_000), "the cursor is kept");
    assert.equal(server.requests.length, 0, "no request may be sent for an impossible cursor");
  }));

// ── Restart: a pending rewind survives ───────────────────────────────────────

test("a restart mid-rewind resumes from the persisted floor, not a lookback", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    // A rewind that was pending when the previous process stopped: the cursor
    // is empty but the floor target was persisted.
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: null, lastEventLedger: null, rewindFromLedger: FLOOR },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );
    const server = makeServer({
      onEvents: () => ({ events: [], cursor: makeCursor(TIP), latestLedger: TIP }),
    });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    await captureLogs(async () => {
      await poller.start();
      try {
        await until(
          () => server.requests.some((req) => req.startLedger === FLOOR),
          "floor walk after restart",
        );
        await until(
          () => targetOf(poller, "market").rewindFromLedger === null,
          "restart rewind completed",
        );
      } finally {
        poller.stop();
      }
    });
    const marketRequest = server.requests.find((req) => req.startLedger === FLOOR);
    assert.ok(marketRequest, "the persisted floor drove the first request");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(marketRequest, "cursor"),
      "a starting-ledger request must not also carry a cursor",
    );
    assert.equal(poller.status().cursorRewinds, 0, "a reloaded hint is not a new rewind");
    assert.equal(targetOf(poller, "market").cursor, makeCursor(TIP));
  }));

// ── Bounded: a thrashing RPC exhausts the budget ─────────────────────────────

test("a floor walk that keeps returning a below-floor cursor exhausts the rewind budget", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(100), lastEventLedger: 100 },
        squad: { cursor: makeCursor(950), lastEventLedger: 950 },
      }),
      "utf8",
    );
    const server = makeServer({
      onEvents: (req) => {
        if (req.cursor) {
          // A normal resume inside the window makes progress; the stale market
          // cursor (and the hostile floor-walk cursor below) are rejected.
          if (ledgerOf(req.cursor) < FLOOR) {
            throw new Error("cursor is stale: precedes the retained floor");
          }
          return { events: [], cursor: makeCursor(TIP), latestLedger: TIP };
        }
        // Hostile: the floor walk hands back a cursor still below the floor and
        // a bogus tip at that ledger, so the walk terminates holding it.
        return { events: [], cursor: makeCursor(100), latestLedger: 100 };
      },
    });
    const poller = createPoller({
      config: makeConfig(cursorFile, { pollIntervalMs: 10 }),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().cursorRewinds >= 3, "rewind budget reached");
        await sleep(80); // several more cycles must not add another rewind
      } finally {
        poller.stop();
      }
    });
    const status = poller.status();
    assert.equal(status.cursorRewinds, 3, "the auto-rewind budget is a hard bound");
    assert.equal(targetOf(poller, "market").cursor, makeCursor(100), "the cursor is kept, not wiped");
    assert.ok(
      lines.join("\n").includes("auto-rewind budget (3) is spent"),
      "the exhausted budget is surfaced",
    );
    assertBoundedAndClean(lines);
  }));

// ── Regression: cold start is not a rewind ───────────────────────────────────

test("a cold start with a stale-shaped RPC error is not rewound", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const server = makeServer({
      onEvents: () => {
        throw new Error("cursor is stale: nothing to resume");
      },
    });
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => undefined,
      now: fakeClock(),
    });
    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().consecutiveFailures >= 1, "failed cold cycle");
        await sleep(40);
      } finally {
        poller.stop();
      }
    });
    assert.equal(poller.status().cursorRewinds, 0);
    assert.equal(targetOf(poller, "market").cursor, null, "a cold start has nothing to rewind");
    assert.equal(lines.join("\n").includes("rewinding to the floor"), false);
  }));

// ── Status output: the recovery is observable and bounded ────────────────────

test("status snapshot carries cursorRewinds and a bounded rewindFromLedger", () => {
  const cursorFile = "/tmp/mimir-rewind-status/cursor.json";
  const config = makeConfig(cursorFile);
  const snapshot = buildStatusSnapshot(
    config,
    {
      running: true,
      paused: false,
      stopping: false,
      chainClockAt: null,
      startedAt: 1_000,
      cycles: 2,
      lastPollAt: 2_000,
      lastSuccessAt: 2_000,
      latestLedger: TIP,
      oldestLedger: FLOOR,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      notificationsDropped: 0,
      eventsDeduplicated: 0,
      cursorRewinds: 2,
      consecutiveFailures: 0,
      lastError: null,
      lockFile: null,
      lockPid: null,
      pendingFlush: false,
      lastFlushAt: null,
      circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
      targets: [
        {
          source: "market",
          contractId: MARKET_ID,
          cursor: null,
          lastEventLedger: null,
          rewindFromLedger: FLOOR,
          lastError: null,
        },
      ],
    },
    2_000,
  );
  assert.equal(snapshot.cursorRewinds, 2);
  assert.equal(snapshot.targets[0].rewindFromLedger, FLOOR);
  const text = serializeStatus(snapshot);
  assert.equal(text.includes(TOKEN), false);
  assert.ok(text.length < 2_000, `status is ${text.length} bytes`);
});
