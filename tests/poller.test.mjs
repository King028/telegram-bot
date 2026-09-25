/**
 * Poller integration tests against a fake Soroban RPC server.
 *
 * `poller.ts`, `events.ts`, `decode.ts`, and `client.ts` run completely
 * unmodified here — only the RPC URL points at a local HTTP server
 * (tests/support/fake-rpc.mjs) instead of Testnet. Telegram is a plain
 * in-memory `send` function; no BOT_TOKEN or live network is required
 * anywhere in this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPoller } from "../dist/poller.js";
import { createRpcServer } from "../dist/stellar/client.js";
import { paginatedGetEvents, readContractEvents } from "../dist/stellar/events.js";
import { createFakeRpc } from "./support/fake-rpc.mjs";
import {
  marketEvent,
  squadEvent,
  malformedClaimChallenged,
  unknownNamedEvent,
} from "./support/scval.mjs";
import { addressFor } from "./support/strkey.mjs";

const MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

// ── Shared helpers ────────────────────────────────────────────────────────

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
    marketContractId: MARKET_CONTRACT_ID,
    squadContractId: SQUAD_CONTRACT_ID,
    rpcUrl,
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: "0000000000:FAKE-TEST-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 20,
    startLookbackLedgers: 1000,
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

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function startFake(overrides) {
  const fake = createFakeRpc(overrides);
  const url = await fake.listen();
  return { fake, url };
}

// ── Positive ─────────────────────────────────────────────────────────────

test("poller decodes and notifies a real event over real HTTP", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const creator = addressFor("creator-1");
    const fx = marketEvent.claimCreated({ claimId: 7, creator, category: "sports" });
    fake.addEvent({ contractId: MARKET_CONTRACT_ID, ledger: 3, ...fx });

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });

    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);

      assert.match(sent[0], /New claim.*\\#7/s);
      assert.match(sent[0], /Category: sports/);
      const status = poller.status();
      assert.equal(status.notificationsSent, 1);
      assert.equal(status.notificationsFailed, 0);
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

// ── Negative ─────────────────────────────────────────────────────────────

test("a malformed known-name event is skipped, logged, and does not stop the poller", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const challenger = addressFor("challenger-1");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 2,
      ...malformedClaimChallenged({ claimId: 1, challenger }),
    });
    // A well-formed event right after it proves the malformed one did not wedge the scan.
    const creator = addressFor("creator-2");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 4,
      ...marketEvent.claimCreated({ claimId: 2, creator, category: "news" }),
    });

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });

    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);

      assert.equal(sent.length, 1); // only the well-formed event produced a message
      assert.match(sent[0], /\\#2/);
      const status = poller.status();
      assert.ok(status.eventsSkipped >= 1);
      assert.equal(status.consecutiveFailures, 0); // a decode failure is not an RPC failure
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

test("a real event with no decoder (admin event) is skipped silently, not treated as an error", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 2,
      ...marketEvent.oracleChanged(),
    });
    const creator = addressFor("creator-3");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 5,
      ...marketEvent.claimCreated({ claimId: 9, creator, category: "weather" }),
    });

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });

    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /\\#9/);
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

// ── Boundary ─────────────────────────────────────────────────────────────

test("an event past several empty pagination windows is still found in one cycle", async () => {
  // windowLedgers=5 means the scan walks 1-5, 6-10, ... in separate RPC
  // calls. The only event sits at ledger 42 — several empty windows must
  // not end the scan early (the trap events.ts's docstring warns about).
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 45, windowLedgers: 5 });
    const captain = addressFor("captain-1");
    fake.addEvent({
      contractId: SQUAD_CONTRACT_ID,
      ledger: 42,
      ...squadEvent.marketCreated({
        marketId: 3,
        captain,
        deadline: 1_800_000_000,
        feeBps: 250,
        question: "Will it rain?",
      }),
    });

    const config = baseConfig(cursorFile, url, { startLookbackLedgers: 1000 });
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });

    try {
      await poller.start();
      await waitFor(() => sent.length >= 1, { timeoutMs: 6000 });
      assert.match(sent[0], /New squad market/);
      assert.ok(fake.state.calls.getEvents >= 9, "expected multiple windowed RPC calls");
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

test("paginatedGetEvents stops at maxPages and reports truncated", async () => {
  const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 1000, windowLedgers: 1 });
  const server = createRpcServer({ rpcUrl: url });
  try {
    const scan = await paginatedGetEvents(
      server,
      [{ type: "contract", contractIds: [MARKET_CONTRACT_ID] }],
      { startLedger: 1, maxPages: 3 },
    );
    assert.equal(scan.truncated, true);
    assert.equal(scan.pages, 3);
    assert.ok(scan.cursor); // resumable — never silently drops position
  } finally {
    await fake.close();
  }
});

test("an RPC start-ledger below the retained floor errors instead of returning an empty result", async () => {
  const { fake, url } = await startFake({ oldestLedger: 500, latestLedger: 1000 });
  const server = createRpcServer({ rpcUrl: url });
  try {
    await assert.rejects(
      readContractEvents(server, { source: "market", contractId: MARKET_CONTRACT_ID }, {
        startLedger: 1,
      }),
    );
  } finally {
    await fake.close();
  }
});

// ── Restart / cursor safety ─────────────────────────────────────────────

test("a restarted poller resumes from its saved cursor instead of re-notifying old events", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const creator = addressFor("creator-4");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 3,
      ...marketEvent.claimCreated({ claimId: 11, creator, category: "sports" }),
    });

    const config = baseConfig(cursorFile, url);
    const server1 = createRpcServer(config);
    const sent1 = [];
    const poller1 = createPoller({ config, server: server1, send: fakeSender(sent1) });
    await poller1.start();
    await waitFor(() => sent1.length >= 1);
    poller1.stop();

    const saved = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(saved.version, 1);
    assert.ok(saved.targets.market.cursor);

    fake.setLatestLedger(20);
    const challenger = addressFor("challenger-2");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 15,
      ...marketEvent.claimChallenged({ claimId: 11, challenger, stake: 20_000_000n }),
    });

    const server2 = createRpcServer(config);
    const sent2 = [];
    const poller2 = createPoller({ config, server: server2, send: fakeSender(sent2) });
    try {
      await poller2.start();
      await waitFor(() => sent2.length >= 1);
      assert.equal(sent2.length, 1); // only the NEW event — no re-delivery of claim_created
      assert.match(sent2[0], /challenged/);
    } finally {
      poller2.stop();
      await fake.close();
    }
  });
});

test("a corrupt cursor file is treated as a cold start, not a crash", async () => {
  await withCursorDir(async (cursorFile) => {
    await writeFile(cursorFile, "{ not valid json", "utf8");
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const creator = addressFor("creator-5");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 4,
      ...marketEvent.claimCreated({ claimId: 20, creator, category: "tech" }),
    });

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);
      assert.match(sent[0], /\\#20/);
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

// ── RPC / Telegram failure isolation ────────────────────────────────────

test("an RPC failure on one contract does not affect the other, and does not move its cursor", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const captain = addressFor("captain-2");
    fake.addEvent({
      contractId: SQUAD_CONTRACT_ID,
      ledger: 3,
      ...squadEvent.marketCreated({
        marketId: 1,
        captain,
        deadline: 1_800_000_000,
        feeBps: 100,
        question: "?",
      }),
    });
    // Market is scanned first each cycle (poller.ts target order) — one
    // queued failure hits only market's call.
    fake.queueFailure("getEvents", { error: { code: -32000, message: "simulated RPC outage" } }, 1);

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1);

      const status = poller.status();
      const market = status.targets.find((t) => t.source === "market");
      const squad = status.targets.find((t) => t.source === "squad");
      assert.ok(market.lastError, "market scan should have recorded the simulated failure");
      assert.equal(squad.lastError, null);
      assert.ok(squad.cursor, "squad's cursor should have advanced despite market's failure");
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

test("Telegram send retries then succeeds; the cursor still advances on eventual success", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const creator = addressFor("creator-6");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 2,
      ...marketEvent.claimCreated({ claimId: 30, creator, category: "sports" }),
    });

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent, { failTimes: 1 }) });
    try {
      await poller.start();
      await waitFor(() => sent.length >= 1, { timeoutMs: 8000 }); // includes real 1s backoff
      assert.equal(poller.status().notificationsSent, 1);
      assert.equal(poller.status().notificationsFailed, 0);
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

test("exhausted Telegram retries drop the message but still advance the cursor", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const creator = addressFor("creator-7");
    fake.addEvent({
      contractId: MARKET_CONTRACT_ID,
      ledger: 2,
      ...marketEvent.claimCreated({ claimId: 31, creator, category: "sports" }),
    });

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const poller = createPoller({
      config,
      server,
      send: fakeSender([], { failTimes: 99 }), // always fails
    });
    try {
      await poller.start();
      await waitFor(() => poller.status().notificationsFailed >= 1, { timeoutMs: 8000 });
      const status = poller.status();
      assert.equal(status.notificationsFailed, 1);
      const market = status.targets.find((t) => t.source === "market");
      assert.ok(market.cursor, "cursor must advance even though the send was dropped");
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

test("the per-cycle notification cap is enforced and excess events are counted as skipped", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    for (let i = 0; i < 3; i += 1) {
      fake.addEvent({
        contractId: MARKET_CONTRACT_ID,
        ledger: 2 + i,
        ...marketEvent.claimCreated({ claimId: 40 + i, creator: addressFor(`creator-cap-${i}`), category: "x" }),
      });
    }

    const config = baseConfig(cursorFile, url, { maxNotificationsPerCycle: 2 });
    const server = createRpcServer(config);
    const sent = [];
    const poller = createPoller({ config, server, send: fakeSender(sent) });
    try {
      await poller.start();
      await waitFor(() => poller.status().cycles >= 1 && poller.status().eventsSkipped >= 1);
      assert.equal(sent.length, 2);
      assert.equal(poller.status().eventsSkipped, 1);
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});

// ── Operator controls ────────────────────────────────────────────────────

test("pause prevents new cycles from starting; resume lets them continue", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const poller = createPoller({ config, server, send: fakeSender([]) });
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
      await fake.close();
    }
  });
});

// ── Regression: secrets never leak into status/logs ─────────────────────

test("bot token never appears in poller status even after an RPC failure", async () => {
  await withCursorDir(async (cursorFile) => {
    const { fake, url } = await startFake({ oldestLedger: 1, latestLedger: 10 });
    fake.queueFailure("getEvents", { error: { code: -32000, message: "simulated outage" } }, 1);

    const config = baseConfig(cursorFile, url);
    const server = createRpcServer(config);
    const poller = createPoller({ config, server, send: fakeSender([]) });
    try {
      await poller.start();
      await waitFor(() => poller.status().lastError !== null);
      const blob = JSON.stringify(poller.status());
      assert.equal(blob.includes(config.botToken), false);
    } finally {
      poller.stop();
      await fake.close();
    }
  });
});
