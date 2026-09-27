/**
 * Long-run soak test: thousands of poll cycles under RPC failures, stale
 * cursors, Telegram failures and malformed events, asserting that memory,
 * timers, logs and status output stay bounded.
 *
 * Deterministic and offline: fake RPC server, fake Telegram send, mocked
 * timers (no real waiting on backoff or send spacing), and a throwaway
 * cursor directory. No live Testnet, Telegram credentials or signing keys.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";

// Forced GC without requiring a CLI flag, so the heap comparison is meaningful.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const TOKEN = "123456789:SOAK-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const HUGE = "remote-payload-".repeat(400); // ~6 KB of hostile error text

/** Measured cycles, warmup cycles, and the heap growth allowed across them. */
const WARMUP_CYCLES = 200;
const MEASURED_CYCLES = 1_500;
const MAX_HEAP_GROWTH_BYTES = 4 * 1024 * 1024;
const MAX_LOG_LINE = 500;

const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) => Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42)).publicKey();

function cursorFor(ledger) {
  return `${BigInt(ledger) << 32n}-0`;
}

function eventAt(ledger) {
  const base = { contractId: MARKET_ID, ledger, txHash: "abc", ledgerClosedAt: "2026-01-01T00:00:00Z" };
  return [
    // Notifiable: reaches the (always failing) Telegram send path.
    { ...base, id: `${ledger}-0`, topic: [scStr("claim_created"), scU64(ledger), scAddress(ADDR)], value: nativeToScVal({ category: "crypto" }) },
    // Unknown event name and an empty-topic malformed event: skipped, never sent.
    { ...base, id: `${ledger}-1`, topic: [scStr("mystery_event")], value: nativeToScVal(1) },
    { ...base, id: `${ledger}-2`, topic: [], value: nativeToScVal(1) },
  ];
}

/**
 * Scripted fake RPC. The market contract cycles through four modes so every
 * failure class is exercised over and over; squad always returns an empty page.
 */
function makeServer() {
  let ledger = 5_000;
  let marketCalls = 0;
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: 4_000, latestLedger: ledger };
    },
    async getEvents(req) {
      const id = req.filters?.[0]?.contractIds?.[0];
      if (id !== MARKET_ID) return { events: [], cursor: cursorFor(ledger), latestLedger: ledger };

      const mode = marketCalls++ % 4;
      if (mode === 1) throw new Error(`getEvents 503 ${TOKEN} ${HUGE}`); // RPC outage
      if (mode === 2) throw new Error(`cursor is older than the retained window ${HUGE}`); // stale cursor
      ledger += 1;
      const events = mode === 0 ? eventAt(ledger) : [];
      return { events, cursor: cursorFor(ledger), latestLedger: ledger };
    },
  };
}

function baseConfig(cursorFile) {
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
    pollIntervalMs: 1_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

/** Advances mocked time until `poller` has started `cycles` cycles. */
async function driveTo(poller, cycles) {
  // Cursor saves are real file I/O, so the guard is wall-clock, not iteration count.
  let seen = poller.status().cycles;
  let lastProgress = Date.now();
  while (poller.status().cycles < cycles) {
    const now = poller.status().cycles;
    if (now !== seen) {
      seen = now;
      lastProgress = Date.now();
    } else if (Date.now() - lastProgress > 15_000) {
      throw new Error(`poller stalled at cycle ${now}`);
    }
    mock.timers.tick(1_000);
    await flush();
  }
}

/** Console capture that keeps counters, not lines, so the harness cannot leak either. */
async function withQuietConsole(fn) {
  const stats = { lines: 0, maxLen: 0, tokenHits: 0 };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => {
    const line = args.join(" ");
    stats.lines += 1;
    stats.maxLen = Math.max(stats.maxLen, line.length);
    if (line.includes(TOKEN)) stats.tokenHits += 1;
  };
  console.log = console.warn = console.error = record;
  try {
    await fn();
  } finally {
    Object.assign(console, originals);
  }
  return stats;
}

/** Runs a full soak and reports heap growth across the measured window. */
async function soak({ send }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-soak-"));
  mock.timers.enable({ apis: ["setTimeout"] });
  const poller = createPoller({ config: baseConfig(path.join(dir, "cursor.json")), server: makeServer(), send });
  const result = {};
  try {
    result.logs = await withQuietConsole(async () => {
      await poller.start();
      await driveTo(poller, WARMUP_CYCLES);
      gc();
      const before = process.memoryUsage().heapUsed;
      await driveTo(poller, WARMUP_CYCLES + MEASURED_CYCLES);
      gc();
      result.heapGrowth = process.memoryUsage().heapUsed - before;
    });
    result.status = poller.status();
  } finally {
    poller.stop();
    mock.timers.reset();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  return result;
}

test("soak: heap, status and logs stay bounded across failures and malformed events", { timeout: 120_000 }, async () => {
  const result = await soak({
    send: async () => {
      throw new Error(`Telegram unavailable ${TOKEN} ${HUGE}`);
    },
  });

  // The scripted failure classes really happened, many times over.
  const { status } = result;
  assert.ok(status.cycles >= WARMUP_CYCLES + MEASURED_CYCLES);
  assert.ok(status.notificationsFailed > 100, `expected many failed sends, got ${status.notificationsFailed}`);
  assert.ok(status.eventsSkipped > 200, `expected many skipped events, got ${status.eventsSkipped}`);
  assert.equal(status.notificationsSent, 0);

  // Memory: no growth proportional to the number of cycles.
  assert.ok(
    result.heapGrowth < MAX_HEAP_GROWTH_BYTES,
    `heap grew ${(result.heapGrowth / 1024 / 1024).toFixed(2)} MB over ${MEASURED_CYCLES} cycles`,
  );

  // Status output: fixed shape, bounded text, no secrets.
  const serialized = JSON.stringify(status);
  assert.ok(serialized.length < 4_000, `status is ${serialized.length} bytes`);
  assert.equal(serialized.includes(TOKEN), false);
  assert.ok(status.lastError === null || status.lastError.message.length <= 250);
  for (const target of status.targets) {
    assert.ok(target.lastError === null || target.lastError.length <= 250);
    assert.ok(target.cursor === null || target.cursor.length <= 128);
  }

  // The scripted stale rejections land on a cursor that is inside the retained
  // window, so they must never trigger a floor rewind: the market cursor is
  // kept and the rewind counter stays at zero.
  assert.equal(status.cursorRewinds, 0, "an in-window stale rejection must not rewind");
  assert.notEqual(status.targets.find((t) => t.source === "market").cursor, null);

  // Logs: plenty of them, but every line bounded and token-free.
  assert.ok(result.logs.lines > 100);
  assert.ok(result.logs.maxLen <= MAX_LOG_LINE, `longest log line was ${result.logs.maxLen} chars`);
  assert.equal(result.logs.tokenHits, 0);
});

test("soak harness detects a real leak (sensitivity control)", { timeout: 120_000 }, async () => {
  const retained = [];
  const result = await soak({
    send: async (text) => {
      retained.push(Array.from({ length: 2_000 }, () => Math.random())); // real heap objects, retained per send attempt
      throw new Error("Telegram unavailable");
    },
  });
  assert.ok(retained.length > 0);
  assert.ok(
    result.heapGrowth >= MAX_HEAP_GROWTH_BYTES,
    `a deliberate leak must exceed the threshold; only ${(result.heapGrowth / 1024 / 1024).toFixed(2)} MB`,
  );
});

test("soak: real timers, one scheduled poll at most, none after stop()", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-soak-timers-"));
  const config = { ...baseConfig(path.join(dir, "cursor.json")), pollIntervalMs: 1 };
  const failingServer = {
    getHealth: async () => {
      throw new Error(`RPC down ${TOKEN}`);
    },
  };
  const poller = createPoller({
    config,
    server: failingServer,
    send: async () => undefined,
    // This test measures timer hygiene under sustained failure; keep the breaker from pausing RPC calls.
    circuitBreakerOptions: { failureThreshold: Number.POSITIVE_INFINITY },
  });
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const baseline = timeouts();
  let peak = 0;

  try {
    await withQuietConsole(async () => {
      await poller.start();
      for (let i = 0; i < 4_000 && poller.status().cycles < 300; i += 1) {
        peak = Math.max(peak, timeouts() - baseline);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      poller.stop();
      // Let any in-flight cycle settle, then nothing may be left scheduled.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.ok(poller.status().cycles >= 300, "poller kept cycling under sustained RPC failure");
    assert.ok(peak <= 2, `at most one poll timer (plus the test's own) may be pending, saw ${peak}`);
    assert.equal(timeouts(), baseline, "stop() leaves no poll timer behind");
    assert.ok(poller.status().consecutiveFailures >= 300);
    assert.equal(JSON.stringify(poller.status()).includes(TOKEN), false);
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
