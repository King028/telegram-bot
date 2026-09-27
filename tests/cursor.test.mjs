/**
 * Deterministic, credential-free tests for the poller's cursor lifecycle:
 * cold starts, resume, corrupt files, restart persistence, and the failure
 * policy (an RPC failure never moves a cursor; a failed Telegram send still
 * advances it).
 *
 * The RPC and Telegram are both fakes. Wire events are REAL xdr (built with
 * `xdr.ScVal`), so the full decode -> format -> notify path runs — no live
 * Testnet RPC, no bot token.
 *
 * The fakes mirror the real contracts:
 *   - `server.getHealth()` -> `{ status, oldestLedger, latestLedger }`
 *   - `server.getEvents(request)` -> `{ events, latestLedger, cursor }`, with
 *     `request.filters` fanning events out per watched contract.
 * Each test waits on the specific observable it cares about (a decoded event's
 * ledger, a send counter, an error) rather than on `cycles`, which increments
 * when a cycle STARTS, not when it finishes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { xdr } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeoutMs = 10_000, label = "condition" } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

// ── Wire xdr helpers ─────────────────────────────────────────────────────────

function scvStr(s) {
  return xdr.ScVal.scvString(s);
}

function scvU64(n) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
}

function scvI128(n) {
  const v = BigInt(n);
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: v & ((1n << 64n) - 1n), hi: v >> 64n }));
}

/** A cursor string whose TOID encodes `ledger`. */
const toid = (ledger) => `${(BigInt(ledger) << 32n).toString()}-0`;

const MARKET_CID = "C".padEnd(56, "A");
const SQUAD_CID = "C".padEnd(56, "B");
const G = "G".padEnd(56, "A");

function claimChallenged({ ledger, claimId = 7n, challenger = G, stake = 20_000_000n } = {}) {
  return {
    id: `${toid(ledger)}-0`,
    ledger,
    ledgerClosedAt: new Date(0).toISOString(),
    contractId: MARKET_CID,
    txHash: "",
    type: "contract",
    inSuccessfulContractCall: true,
    topic: [scvStr("claim_challenged"), scvU64(claimId), scvStr(challenger)],
    value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: scvStr("stake"), val: scvI128(stake) })]),
  };
}

/** An admin event — logged as an audit record, skipped for Telegram notifications. */
function unknownEvent({ ledger = 4_226_898 } = {}) {
  return {
    id: `${toid(ledger)}-0`,
    ledger,
    ledgerClosedAt: new Date(0).toISOString(),
    contractId: MARKET_CID,
    txHash: "",
    type: "contract",
    inSuccessfulContractCall: true,
    topic: [scvStr("oracle_changed"), scvU64(1n)],
    value: xdr.ScVal.scvMap([]),
  };
}

/**
 * A scriptable stand-in for the Soroban RPC. Events are fanned out per
 * contract, exactly like the real `getEvents`: only the watched contract sees
 * its own events. A `failing` server rejects every request.
 */
function fakeRpc({ market = [], squad = [], cursorLedger = 4_226_900, failing = false } = {}) {
  const calls = { health: 0, events: 0 };
  const cursor = toid(cursorLedger);
  const byContract = new Map([
    [MARKET_CID, market],
    [SQUAD_CID, squad],
  ]);

  return {
    calls,
    health: { status: "healthy", oldestLedger: 4_226_880, latestLedger: 4_226_900 },
    async getHealth() {
      calls.health += 1;
      if (failing) throw new Error("rpc down");
      return this.health;
    },
    async getEvents(request) {
      calls.events += 1;
      if (failing) throw new Error("rpc down");
      const contractIds = request.filters?.[0]?.contractIds ?? [];
      const events = contractIds.flatMap((id) => byContract.get(id) ?? []);
      return { events, latestLedger: this.health.latestLedger, cursor };
    },
  };
}

function marketOf(poller) {
  return poller.status().targets.find((t) => t.source === "market");
}

/**
 * A full valid BotConfig. `maxNotificationsPerCycle` defaults to 1 so the
 * end-of-cycle send spacing (`SEND_SPACING_MS`) sleep never fires in
 * single-event tests — they stay fast without a live Telegram.
 */
function makeConfig(dir, overrides = {}) {
  return {
    botToken: "fake-token",
    chatId: "-1001234567890",
    marketContractId: MARKET_CID,
    squadContractId: SQUAD_CID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 10,
    cursorFile: path.join(dir, "cursor.json"),
    maxNotificationsPerCycle: 1,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function writeCursorFile(dir, targets) {
  return writeFile(
    path.join(dir, "cursor.json"),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), targets }, null, 2),
  );
}

function readCursorFile(dir) {
  return JSON.parse(readFileSync(path.join(dir, "cursor.json"), "utf8"));
}

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-"));
  t.after(async () => {
    // The last cycle may still be finishing its cursor write; retry until it
    // releases the files so cleanup on Windows does not hit ENOTEMPTY.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  });
  return dir;
}

test("cold start with no cursor file: lookback scan, notify, persist", async (t) => {
  const dir = await tmpDir(t);
  const server = fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] });
  const sent = [];
  const poller = createPoller({
    config: makeConfig(dir),
    server,
    send: async (text) => sent.push(text),
  });

  await poller.start();
  try {
    await until(() => marketOf(poller).lastEventLedger === 4_226_899, { label: "first scan" });

    const market = marketOf(poller);
    assert.equal(market.lastError, null);
    assert.equal(market.lastEventLedger, 4_226_899);
    assert.equal(market.cursor, toid(4_226_900));
    assert.equal(poller.status().notificationsSent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Claim \\#7 challenged/);
  } finally {
    poller.stop();
  }
});

test("warm start resumes cursor and last-event ledger from the file", async (t) => {
  const dir = await tmpDir(t);
  const resumeCursor = toid(4_226_899);
  await writeCursorFile(dir, {
    market: { cursor: resumeCursor, lastEventLedger: 4_226_899 },
    squad: { cursor: resumeCursor, lastEventLedger: 4_226_899 },
  });

  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] }),
    send: async () => {},
  });

  await poller.start();
  try {
    // Resume happens before the first cycle: the persisted position is loaded
    // into state and reported by /status immediately.
    const resumed = marketOf(poller);
    assert.equal(resumed.cursor, resumeCursor);
    assert.equal(resumed.lastEventLedger, 4_226_899);
  } finally {
    poller.stop();
  }
});

test("restart persistence: new instance continues from the written file", async (t) => {
  const dir = await tmpDir(t);
  const config = makeConfig(dir);
  const pollerA = createPoller({
    config,
    server: fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] }),
    send: async () => {},
  });

  await pollerA.start();
  try {
    await until(() => marketOf(pollerA).lastEventLedger === 4_226_899, {
      label: "first instance scan",
    });
    await until(() => existsSync(path.join(dir, "cursor.json")), { label: "cursor file write" });
    // Write-then-rename: the temp path must not linger behind.
    assert.equal(existsSync(path.join(dir, "cursor.json.tmp")), false);
  } finally {
    pollerA.stop();
  }

  const saved = readCursorFile(dir);
  assert.equal(saved.version, 1);
  assert.equal(saved.targets.market.cursor, toid(4_226_900));
  assert.equal(saved.targets.market.lastEventLedger, 4_226_899);

  const pollerB = createPoller({
    config,
    server: fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] }),
    send: async () => {},
  });
  await pollerB.start();
  try {
    const resumed = marketOf(pollerB);
    assert.equal(resumed.cursor, toid(4_226_900), "the new instance picks up the persisted cursor");
    assert.equal(resumed.lastEventLedger, 4_226_899);
  } finally {
    pollerB.stop();
  }
});

test("corrupt cursor file is a cold start, not a crash", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, "cursor.json"), "this is not json", "utf8");

  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] }),
    send: async () => {},
  });

  await poller.start();
  try {
    await until(() => marketOf(poller).lastEventLedger === 4_226_899, {
      label: "cold-start scan after corrupt resume",
    });
    const market = marketOf(poller);
    assert.equal(poller.status().running, true);
    assert.equal(market.lastEventLedger, 4_226_899);
    assert.equal(market.cursor, toid(4_226_900));
  } finally {
    poller.stop();
  }
});

test("RPC failure on a cold start fails the cycle without advancing a cursor", async (t) => {
  const dir = await tmpDir(t);
  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({ failing: true }),
    send: async () => {},
  });

  await poller.start();
  try {
    await until(() => marketOf(poller).lastError !== null, { label: "failed cycle" });
    assert.equal(poller.status().running, true);
    assert.equal(poller.status().consecutiveFailures, 1);
    assert.equal(marketOf(poller).cursor, null);
    assert.match(marketOf(poller).lastError, /rpc down/);
  } finally {
    poller.stop();
  }
});

test("RPC failure leaves a persisted cursor untouched", async (t) => {
  const dir = await tmpDir(t);
  const persisted = toid(4_226_899);
  await writeCursorFile(dir, {
    market: { cursor: persisted, lastEventLedger: 4_226_899 },
    squad: { cursor: persisted, lastEventLedger: 4_226_899 },
  });

  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({ failing: true }),
    send: async () => {},
  });

  await poller.start();
  try {
    await until(() => marketOf(poller).lastError !== null, { label: "failed cycle" });
    assert.equal(marketOf(poller).cursor, persisted, "cursor must not move on an RPC failure");
    assert.match(marketOf(poller).lastError, /rpc down/);
  } finally {
    poller.stop();
  }
});

test("a failed Telegram send advances the cursor (lossy by design)", async (t) => {
  const dir = await tmpDir(t);
  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] }),
    send: async () => {
      throw new Error("telegram 502");
    },
  });

  await poller.start();
  try {
    // Retrying 3 times with 1s/2s backoff makes this the slowest test (~3.5s).
    await until(
      () => poller.status().notificationsFailed >= 1 && marketOf(poller).cursor !== null,
      { timeoutMs: 15_000, label: "send retries to exhaust and the cursor to advance" },
    );
    assert.equal(poller.status().notificationsSent, 0);
    assert.equal(marketOf(poller).cursor, toid(4_226_900), "the cursor advances even when the send fails");
  } finally {
    poller.stop();
  }
});

test("notification cap skips overflow events but the cursor still advances", async (t) => {
  const dir = await tmpDir(t);
  const sent = [];
  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({
      market: [
        claimChallenged({ ledger: 4_226_898, claimId: 1n }),
        claimChallenged({ ledger: 4_226_899, claimId: 2n }),
      ],
    }),
    send: async (text) => sent.push(text),
  });

  await poller.start();
  try {
    await until(() => poller.status().notificationsSent === 1, { label: "capped cycle" });
    assert.equal(sent.length, 1);
    assert.equal(poller.status().eventsSkipped, 1, "the overflow event is dropped at the cap");
    assert.equal(marketOf(poller).cursor, toid(4_226_900));
  } finally {
    poller.stop();
  }
});

test("undefined/unknown events are skipped without blocking the cursor", async (t) => {
  const dir = await tmpDir(t);
  const sent = [];
  const poller = createPoller({
    config: makeConfig(dir),
    server: fakeRpc({
      market: [unknownEvent(), claimChallenged({ ledger: 4_226_899 })],
    }),
    send: async (text) => sent.push(text),
  });

  await poller.start();
  try {
    await until(() => poller.status().notificationsSent === 1, { label: "skip cycle" });
    assert.equal(sent.length, 1);
    assert.equal(poller.status().eventsSkipped, 1, "the unknown event is logged, not posted");
    assert.equal(marketOf(poller).cursor, toid(4_226_900));
  } finally {
    poller.stop();
  }
});

test("unwritable cursor file is logged and does not stop the poller", async (t) => {
  const dir = await tmpDir(t);
  // A regular file where a directory must be created makes every mkdir fail.
  const blocker = path.join(dir, "blocker");
  await writeFile(blocker, "i am a file, not a directory", "utf8");
  const cursorFile = path.join(blocker, "cursor.json");

  const poller = createPoller({
    config: makeConfig(dir, { cursorFile }),
    server: fakeRpc({ market: [claimChallenged({ ledger: 4_226_899 })] }),
    send: async () => {},
  });

  await poller.start();
  try {
    await until(() => marketOf(poller).lastEventLedger === 4_226_899, {
      label: "cycle with unwritable cursor",
    });
    await sleep(100);
    const market = marketOf(poller);
    assert.equal(poller.status().running, true);
    assert.equal(market.cursor, toid(4_226_900), "in-memory cursor keeps working while write fails");
  } finally {
    poller.stop();
  }
});