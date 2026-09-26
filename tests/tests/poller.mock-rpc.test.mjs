/**
 * Additional poller coverage against the project's own local mock Soroban
 * RPC (src/stellar/mock-rpc.ts, compiled to dist/stellar/mock-rpc.js),
 * running over real HTTP — complementary to the in-process-fake suite in
 * tests/poller.test.mjs, not a replacement for it.
 *
 * `poller.ts`, `events.ts`, `decode.ts`, and `client.ts` run completely
 * unmodified here — only the RPC URL points at the mock instead of Testnet.
 * Telegram is a plain in-memory `send` function. No BOT_TOKEN, live
 * network, or signing key is used anywhere in this file.
 *
 * Covered here that the in-process-fake suite does not exercise:
 *   - Real XDR-encoded events decoded through the real SDK end to end
 *   - The bounded-pagination-window "empty page ≠ done" trap
 *   - paginatedGetEvents's own startLedger-below-floor error, over real HTTP
 *   - Cursor persistence and resumption across two separate poller instances
 *     (a closer approximation of an actual process restart)
 *   - Operator pause/resume against a live (non-stuck) scan
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { rpc } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { startMockRpc, defaultMockScenario, malformedMockEvent } from "../dist/stellar/mock-rpc.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_SQUAD_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_BOT_TOKEN,
} from "../dist/stellar/mock-constants.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const CAPTAIN = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
const CHALLENGER = "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";

// Ephemeral data directory: no test touches the repo data/ dir or fixed /tmp names.
const dataDir = await createTempDataDir("mimir-poller-mock-rpc-");
test.after(() => dataDir.cleanup());

/** Polls `cond` until true or `timeoutMs` elapses (then fails the test). */
async function waitFor(cond, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
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

function serverFor(url) {
  return new rpc.Server(url, { allowHttp: true });
}

// ── Positive: real XDR events, decoded end to end ───────────────────────────

test("poller (mock rpc): decodes and notifies real events over real HTTP", async () => {
  // Default scenario's first window (900-949) is intentionally empty;
  // events sit at 990-1000 — this also exercises the empty-page trap.
  const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
  const config = baseConfig(dataDir.file("positive.json"), mock.url);
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

test("poller (mock rpc): a malformed event is skipped without crashing the poller", async () => {
  const scenario = defaultMockScenario();
  scenario.events.push(malformedMockEvent(1001));
  scenario.latestLedger = 1001;
  const mock = await startMockRpc({ port: 0, scenario });
  const config = baseConfig(dataDir.file("malformed.json"), mock.url);
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

// ── Boundary: empty-page pagination trap ────────────────────────────────────

test("poller (mock rpc): an event past several empty pagination windows is still found in one cycle", async () => {
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
  const config = baseConfig(dataDir.file("empty-windows.json"), mock.url, { startLookbackLedgers: 199 });
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

test("poller (mock rpc): a startLedger below the retained floor errors over real HTTP", async () => {
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

// ── Restart / cursor safety across two separate poller instances ──────────

test("poller (mock rpc): a restarted poller resumes from its saved cursor instead of re-notifying old events", async () => {
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
  const cursorFile = dataDir.file("restart.json");
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

test("poller (mock rpc): a corrupt cursor file is treated as a cold start, not a crash", async () => {
  const cursorFile = dataDir.file("corrupt.json");
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

// ── Telegram retry, over real HTTP RPC ──────────────────────────────────────

test("poller (mock rpc): Telegram send retries then succeeds; the cursor still advances", async () => {
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
  const config = baseConfig(dataDir.file("retry.json"), mock.url, { startLookbackLedgers: 10 });
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

// ── Operator controls against a live (non-stuck) scan ───────────────────────

test("poller (mock rpc): pause prevents new cycles from starting; resume lets them continue", async () => {
  const mock = await startMockRpc({
    port: 0,
    scenario: { latestLedger: 10, oldestLedger: 1, ledgersPerPage: 50, events: [] },
  });
  const config = baseConfig(dataDir.file("pause-resume.json"), mock.url, { startLookbackLedgers: 10 });
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
