import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import tmp from "node:os";
import path from "node:path";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";

const VALID_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CURSOR_1999 = `${1999n << 32n}-1`;

function mockConfig(cursorFile) {
  return {
    botToken: "test-token",
    chatId: "-1001234567890",
    marketContractId: "CCONTRACTMARKET",
    squadContractId: "CCONTRACTSQUAD",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    cursorFile,
    pollIntervalMs: 10000,
    startLookbackLedgers: 100,
    maxNotificationsPerCycle: 10,
    sendSpacingMs: 0,
    initialBackoffMs: 1,
  };
}

function mockServer(overrides = {}) {
  return {
    getHealth: async () => ({
      oldestLedger: 1000,
      latestLedger: 2000,
      ...(overrides.health ?? {}),
    }),
    getEvents: async (req) => {
      if (overrides.getEventsError) {
        throw new Error(overrides.getEventsError);
      }
      if (overrides.getEvents) {
        return overrides.getEvents(req);
      }
      return {
        events: [],
        latestLedger: 2000,
        cursor: req.cursor ?? CURSOR_1999,
      };
    },
  };
}

test("poller initializes and handles cold start when cursor file is missing", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);
  const server = mockServer();
  const sent = [];
  const send = async (msg) => { sent.push(msg); };

  const poller = createPoller({ config, server, send });
  await poller.start();
  const status = poller.status();

  assert.equal(status.running, true);
  assert.equal(status.targets.length, 2);
  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller persists cursor upon successful cycle and reloads upon restart", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);

  const server = mockServer({
    getEvents: async (req) => ({
      events: [],
      latestLedger: 2000,
      cursor: CURSOR_1999,
    }),
  });

  const send = async () => {};
  const poller = createPoller({ config, server, send });
  await poller.start();

  await new Promise((resolve) => setTimeout(resolve, 100));
  poller.stop();

  const savedRaw = await readFile(cursorFile, "utf8");
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.version, 1);
  assert.equal(saved.targets.market.cursor, CURSOR_1999);

  const poller2 = createPoller({ config, server, send });
  await poller2.start();
  const status2 = poller2.status();
  const marketTarget = status2.targets.find((t) => t.source === "market");
  assert.equal(marketTarget.cursor, CURSOR_1999);
  poller2.stop();

  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller continues and does not lose cursor state during transient RPC failures", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = { ...mockConfig(cursorFile), pollIntervalMs: 50 };

  let failRPC = false;
  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async (req) => {
      if (failRPC) {
        throw new Error("RPC Connection Refused");
      }
      return { events: [], latestLedger: 2000, cursor: CURSOR_1999 };
    },
  };

  const poller = createPoller({ config, server, send: async () => {} });
  await poller.start();
  await new Promise((r) => setTimeout(r, 80));

  failRPC = true;
  await new Promise((r) => setTimeout(r, 120));

  const status = poller.status();
  assert.ok(status.lastError);
  assert.match(status.lastError.message, /RPC Connection Refused/);

  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller logs and handles Telegram send retries/failures without stalling cursor", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);

  const topics = [
    xdr.ScVal.scvSymbol("claim_created"),
    nativeToScVal(1),
    nativeToScVal(VALID_ACCOUNT),
  ];
  const value = nativeToScVal({ category: "crypto" });

  const server = mockServer({
    getEvents: async (req) => {
      if (req.cursor) {
        return { events: [], latestLedger: 2000, cursor: req.cursor };
      }
      return {
        events: [
          {
            contractId: req.filters?.[0]?.contractIds?.[0] ?? "CCONTRACTMARKET",
            ledger: 100,
            txHash: "0x1234",
            ledgerClosedAt: "2026-01-01T00:00:00Z",
            id: "100-1",
            topic: topics,
            value,
          },
        ],
        latestLedger: 2000,
        cursor: CURSOR_1999,
      };
    },
  });

  const send = async () => {
    throw new Error("Telegram 429 Too Many Requests");
  };

  const poller = createPoller({ config, server, send, sendOptions: { sendSpacingMs: 0, initialBackoffMs: 10 } });
  await poller.start();
  await new Promise((r) => setTimeout(r, 200));

  const status = poller.status();
  assert.ok(status.notificationsFailed >= 1);
  const marketTarget = status.targets.find((t) => t.source === "market");
  assert.equal(marketTarget.cursor, CURSOR_1999);

  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller circuit breaker opens after consecutive RPC failures", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = { ...mockConfig(cursorFile), pollIntervalMs: 20 };

  let failCount = 0;
  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async () => {
      failCount++;
      throw new Error("RPC timeout");
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    circuitBreakerOptions: { failureThreshold: 3, cooldownMs: 500 },
  });

  await poller.start();
  // Wait for enough failures to trigger circuit breaker (3 failures)
  await new Promise((r) => setTimeout(r, 150));

  const status = poller.status();
  assert.equal(status.circuitBreaker.open, true, "circuit breaker should be open");
  assert.ok(status.circuitBreaker.failureCount >= 3, "failure count should meet threshold");
  assert.ok(status.circuitBreaker.openedAt !== null, "openedAt should be set");

  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller circuit breaker skips RPC calls when open", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = { ...mockConfig(cursorFile), pollIntervalMs: 20 };

  let rpcCallCount = 0;
  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async () => {
      rpcCallCount++;
      throw new Error("RPC timeout");
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 1000 },
  });

  await poller.start();
  // Wait for circuit breaker to open (2 failures)
  await new Promise((r) => setTimeout(r, 80));

  const statusAfterOpen = poller.status();
  assert.equal(statusAfterOpen.circuitBreaker.open, true);
  const callsAtOpen = rpcCallCount;

  // Wait for additional cycles - RPC calls should be skipped
  await new Promise((r) => setTimeout(r, 100));

  const statusAfterCooldown = poller.status();
  const callsAfterCooldown = rpcCallCount;

  // RPC calls should not increase significantly while circuit is open
  assert.ok(callsAfterCooldown <= callsAtOpen + 1, "RPC calls should be skipped while circuit is open");

  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller circuit breaker closes after cooldown and successful RPC", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = { ...mockConfig(cursorFile), pollIntervalMs: 20 };

  let failRPC = true;
  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async () => {
      if (failRPC) {
        throw new Error("RPC timeout");
      }
      return { events: [], latestLedger: 2000, cursor: CURSOR_1999 };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 100 },
  });

  await poller.start();
  // Wait for circuit breaker to open
  await new Promise((r) => setTimeout(r, 80));

  const statusOpen = poller.status();
  assert.equal(statusOpen.circuitBreaker.open, true);

  // Allow RPC to succeed and cooldown to elapse
  failRPC = false;
  await new Promise((r) => setTimeout(r, 200));

  const statusClosed = poller.status();
  assert.equal(statusClosed.circuitBreaker.open, false, "circuit breaker should close after successful RPC");
  assert.equal(statusClosed.circuitBreaker.failureCount, 0, "failure count should reset");

  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("poller circuit breaker resets on successful RPC before threshold", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = { ...mockConfig(cursorFile), pollIntervalMs: 20 };

  let callCount = 0;
  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async () => {
      callCount++;
      // Fail first call, succeed second
      if (callCount === 1) {
        throw new Error("RPC timeout");
      }
      return { events: [], latestLedger: 2000, cursor: CURSOR_1999 };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    circuitBreakerOptions: { failureThreshold: 3, cooldownMs: 1000 },
  });

  await poller.start();
  await new Promise((r) => setTimeout(r, 80));

  const status = poller.status();
  assert.equal(status.circuitBreaker.open, false, "circuit breaker should not open");
  assert.equal(status.circuitBreaker.failureCount, 0, "failure count should reset after success");

  poller.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
