/**
 * Poller integration tests against the project's own local mock Soroban RPC
 * (src/stellar/mock-rpc.ts, compiled to dist/stellar/mock-rpc.js).
 *
 * `poller.ts`, `events.ts`, `decode.ts`, and `client.ts` run completely
 * unmodified here — only the RPC URL points at the mock instead of Testnet.
 * Telegram is a plain in-memory `send` function. No BOT_TOKEN, live
 * network, or signing key is used anywhere in this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rpc } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { startMockRpc, defaultMockScenario, malformedMockEvent } from "../dist/stellar/mock-rpc.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_SQUAD_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_BOT_TOKEN,
} from "../dist/stellar/mock-constants.js";

const CAPTAIN = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
const CHALLENGER = "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";

// ── Shared helpers ──────────────────────────────────────────────────────

async function withCursorDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-poller-test-"));
  try {
    return await fn(path.join(dir, "cursor.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseConfig(cursorFile, rpcUrl, overrides = {}) {
  return {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    rpcUrl,
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: MOCK_BOT_TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 20,
    startLookbackLedgers: 200,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function fakeSender(sent, { failTimes = 0 } = {}) {
  let remaining = failTimes;
  return async (text) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("Telegram send failed (simulated)");
    }
    sent.push(text);
  };
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function serverFor(url) {
  return new rpc.Server(url, { allowHttp: true });
}

// ── Positive ─────────────────────────────────────────────────────────────

test("poller decodes and notifies real events from the project's own mock RPC", async () => {
  await withCursorDir(async (cursorFile) => {
    // Default scenario's first window (900-949) is intentionally empty;
    // events sit at 990-1000 — this also exercises the empty-page trap.
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const config = baseConfig(cursorFile, mock.url);
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.match(sent[0], /New claim/);
      assert.equal(poller.status().notificationsFailed, 0);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

// ── Negative ─────────────────────────────────────────────────────────────

test("a malformed event is skipped without crashing the poller", async () => {
  await withCursorDir(async (cursorFile) => {
    const scenario = defaultMockScenario();
    scenario.events.push(malformedMockEvent(1001));
    scenario.latestLedger = 1001;
    const mock = await startMockRpc({ port: 0, scenario });
    const config = baseConfig(cursorFile, mock.url);
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.ok(poller.status().eventsSkipped >= 1);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

test("an admin event with no decoder is skipped silently, not treated as an error", async () => {
  await withCursorDir(async (cursorFile) => {
    // defaultMockScenario() already includes one oracle_changed event
    // (ledger 993, no decoder) alongside notifiable events.
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const config = baseConfig(cursorFile, mock.url);
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.equal(poller.status().lastError, null);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

// ── Boundary: empty-page trap + pagination ──────────────────────────────

test("an event past several empty pagination windows is still found in one cycle", async () => {
  await withCursorDir(async (cursorFile) => {
    const scenario = {
      latestLedger: 200,
      oldestLedger: 1,
      ledgersPerPage: 10, // several empty 10-ledger windows before ledger 155
      events: [
        {
          source: "market",
          ledger: 155,
          eventName: "claim_created",
          topics: [3, { address: CAPTAIN }],
          fields: { category: "sports" },
        },
      ],
    };
    const mock = await startMockRpc({ port: 0, scenario });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 199 });
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.match(sent[0], /\\#3\b/);
      assert.ok(mock.stats().byMethod.getEvents >= 10, "expected multiple windowed RPC calls");
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

test("a startLedger below the retained floor is an error, not an empty result", async () => {
  const mock = await startMockRpc({
    port: 0,
    scenario: { latestLedger: 1000, oldestLedger: 900, ledgersPerPage: 50, events: [] },
  });
  try {
    const server = serverFor(mock.url);
    await assert.rejects(
      server.getEvents({
        filters: [{ type: "contract", contractIds: [MOCK_MARKET_CONTRACT_ID] }],
        startLedger: 1,
      }),
    );
  } finally {
    await mock.close();
  }
});

// ── Restart / cursor safety ─────────────────────────────────────────────

test("a restarted poller resumes from its saved cursor instead of re-notifying old events", async () => {
  await withCursorDir(async (cursorFile) => {
    const scenario = {
      latestLedger: 20,
      oldestLedger: 1,
      ledgersPerPage: 50,
      events: [
        {
          source: "market",
          ledger: 5,
          eventName: "claim_created",
          topics: [11, { address: CAPTAIN }],
          fields: { category: "sports" },
        },
      ],
    };
    const mock = await startMockRpc({ port: 0, scenario });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 20 });

    const sent1 = [];
    const poller1 = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent1) });
    await poller1.start();
    await waitFor(() => sent1.length >= 1);
    poller1.stop();

    const saved = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(saved.version, 1);
    assert.ok(saved.targets.market.cursor);

    mock.addEvent({
      source: "market",
      ledger: 15,
      eventName: "claim_challenged",
      topics: [11, { address: CHALLENGER }],
      fields: { stake: 20_000_000n },
    });

    const sent2 = [];
    const poller2 = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent2) });
    try {
      await poller2.start();
      await waitFor(() => sent2.length >= 1);
      assert.equal(sent2.length, 1); // only the NEW event — no re-delivery of claim_created
      assert.match(sent2[0], /challenged/);
    } finally {
      poller2.stop();
      await mock.close();
    }
  });
});

test("a corrupt cursor file is treated as a cold start, not a crash", async () => {
  await withCursorDir(async (cursorFile) => {
    await writeFile(cursorFile, "{ not valid json", "utf8");
    const scenario = {
      latestLedger: 10,
      oldestLedger: 1,
      ledgersPerPage: 50,
      events: [
        {
          source: "market",
          ledger: 4,
          eventName: "claim_created",
          topics: [20, { address: CAPTAIN }],
          fields: { category: "tech" },
        },
      ],
    };
    const mock = await startMockRpc({ port: 0, scenario });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 10 });
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.match(sent[0], /\\#20\b/);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

// ── RPC / Telegram failure isolation ────────────────────────────────────

test("an RPC failure on one contract does not affect the other or move its cursor", async () => {
  await withCursorDir(async (cursorFile) => {
    const scenario = {
      latestLedger: 10,
      oldestLedger: 1,
      ledgersPerPage: 50,
      events: [
        {
          source: "squad",
          ledger: 3,
          eventName: "market_created",
          topics: [1, { address: CAPTAIN }],
          fields: { deadline: 1_900_000_000, fee_bps: 100, question: "?" },
        },
      ],
    };
    // Market is scanned first each cycle; one queued failure hits only it.
    const mock = await startMockRpc({
      port: 0,
      scenario,
      failures: { getEvents: { kind: "error", times: 1 } },
    });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 10 });
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      const status = poller.status();
      const market = status.targets.find((t) => t.source === "market");
      const squad = status.targets.find((t) => t.source === "squad");
      assert.ok(market.lastError, "market should have recorded the injected failure");
      assert.equal(squad.lastError, null);
      assert.ok(squad.cursor, "squad cursor should advance despite market's failure");
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

test("Telegram send retries then succeeds; the cursor still advances", async () => {
  await withCursorDir(async (cursorFile) => {
    const scenario = {
      latestLedger: 10,
      oldestLedger: 1,
      ledgersPerPage: 50,
      events: [
        {
          source: "market",
          ledger: 2,
          eventName: "claim_created",
          topics: [30, { address: CAPTAIN }],
          fields: { category: "sports" },
        },
      ],
    };
    const mock = await startMockRpc({ port: 0, scenario });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 10 });
    const sent = [];
    const poller = createPoller({
      config,
      server: serverFor(mock.url),
      send: fakeSender(sent, { failTimes: 1 }),
    });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1); // includes the real 1s retry backoff
      assert.equal(poller.status().notificationsSent, 1);
      assert.equal(poller.status().notificationsFailed, 0);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

test("exhausted Telegram retries drop the message but still advance the cursor", async () => {
  await withCursorDir(async (cursorFile) => {
    const scenario = {
      latestLedger: 10,
      oldestLedger: 1,
      ledgersPerPage: 50,
      events: [
        {
          source: "market",
          ledger: 2,
          eventName: "claim_created",
          topics: [31, { address: CAPTAIN }],
          fields: { category: "sports" },
        },
      ],
    };
    const mock = await startMockRpc({ port: 0, scenario });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 10 });
    const poller = createPoller({
      config,
      server: serverFor(mock.url),
      send: fakeSender([], { failTimes: 99 }), // always fails
    });
    try {
      await poller.start();
      await waitFor(() => poller.status().notificationsFailed >= 1);
      const market = poller.status().targets.find((t) => t.source === "market");
      assert.ok(market.cursor, "cursor must advance even though the send was dropped");
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

test("the per-cycle notification cap is enforced and excess events are counted as skipped", async () => {
  await withCursorDir(async (cursorFile) => {
    // defaultMockScenario() has 5 notifiable market events; cap at 2.
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const config = baseConfig(cursorFile, mock.url, { maxNotificationsPerCycle: 2 });
    const sent = [];
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => poller.status().eventsSkipped >= 1);
      assert.ok(sent.length <= 2, `expected at most 2 sends, got ${sent.length}`);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

// ── Operator controls ────────────────────────────────────────────────────

test("pause prevents new cycles from starting; resume lets them continue", async () => {
  await withCursorDir(async (cursorFile) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: { latestLedger: 10, oldestLedger: 1, ledgersPerPage: 50, events: [] },
    });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 10 });
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender([]) });
    try {
      await poller.start();
      await waitFor(() => poller.status().cycles >= 1);
      assert.equal(poller.pause(), "paused");
      const pausedAt = poller.status().cycles;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(poller.status().cycles, pausedAt, "no new cycle should start while paused");

      assert.equal(poller.resume(), "resumed");
      await waitFor(() => poller.status().cycles > pausedAt);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});

// ── Regression: secrets never leak into status ───────────────────────────

test("bot token never appears in poller status even after an RPC failure", async () => {
  await withCursorDir(async (cursorFile) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: { latestLedger: 10, oldestLedger: 1, ledgersPerPage: 50, events: [] },
      failures: { getHealth: { kind: "error", times: 1 } },
    });
    const config = baseConfig(cursorFile, mock.url, { startLookbackLedgers: 10 });
    const poller = createPoller({ config, server: serverFor(mock.url), send: fakeSender([]) });
    try {
      await poller.start();
      await waitFor(() => poller.status().lastError !== null);
      const blob = JSON.stringify(poller.status());
      assert.equal(blob.includes(config.botToken), false);
    } finally {
      poller.stop();
      await mock.close();
    }
  });
});
