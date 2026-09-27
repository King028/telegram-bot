/**
 * Chain clock skew: how the bot shows the difference between its own clock and
 * the newest chain time it has actually observed.
 *
 * Coverage:
 *   - Positive: a scan with events sets the chain clock from `ledgerClosedAt`
 *   - Negative: an event with no close time never sets it (never epoch 0)
 *   - Boundary: sub-second skew reads "in sync"; exact seconds read as seconds
 *   - Failure: a failed RPC scan leaves the clock at the last observed value
 *   - Restart: the clock is persisted with the cursors and resumes on boot
 *   - Regression: an invalid saved clock is dropped without losing cursors
 *
 * Everything is in-process: a scripted fake RPC, an ephemeral cursor file, and
 * a pre-populated grammy bot. No live RPC, no Telegram, no repo data/ dir.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createBot, healthMessage } from "../dist/bot.js";
import { buildHealthReport, chainClockLabel } from "../dist/health.js";
import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

/** A whole-second chain close time, as `event.at` can only ever be whole seconds. */
const CHAIN_TIME = Math.floor((Date.now() - 60_000) / 1_000) * 1_000;
const CHAIN_TIME_EARLIER = CHAIN_TIME - 86_400_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

/** Captures one console method's output while `fn` runs. */
async function captured(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return lines;
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
    operatorTelegramUserId: "42",
    allowedChatIds: [],
    channelPreviewMode: false,
    pollIntervalMs: 9_999_999, // single cycle unless a test overrides it
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

function makeCursor(ledger) {
  const toid = (BigInt(ledger) << 32n) | 1n;
  return `${toid}-0`;
}

/** An event with no decoder (empty topics): it counts, but is never sent. */
function makeEvent(ledger, contractId, closedAt) {
  const event = {
    id: `${ledger}-0`,
    contractId,
    ledger,
    txHash: "ab".repeat(32),
    topic: [],
    value: null,
  };
  if (closedAt !== undefined) event.ledgerClosedAt = closedAt;
  return event;
}

/**
 * Scripted RPC. `state.fail` flips every scan into an outage, `state.events`
 * decides what each contract returns — both are mutated mid-run by the tests.
 */
function fakeServer(state) {
  const ledger = state.ledger ?? 5000;
  return {
    getHealth: async () => ({ status: "healthy", oldestLedger: 4000, latestLedger: ledger }),
    getEvents: async (req) => {
      if (state.fail) throw new Error("RPC unavailable");
      const id = req.filters?.[0]?.contractIds?.[0];
      return {
        events: state.events[id] ?? [],
        cursor: makeCursor(ledger),
        latestLedger: ledger,
      };
    },
  };
}

/** A scan that never answers, so `start()` can be observed right after loading. */
const hangingServer = () => ({ getHealth: () => new Promise(() => undefined) });

function makePoller(config, server) {
  return createPoller({
    config,
    server,
    send: async () => undefined,
    sendOptions: { sendSpacingMs: 0, maxSendRetries: 1, initialBackoffMs: 1 },
  });
}

function statusFixture(overrides = {}) {
  return {
    running: true,
    paused: false,
    chainClockAt: null,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

// ── Label rendering ──────────────────────────────────────────────────────────

test("chainClockLabel: unknown before the first observation", () => {
  assert.equal(chainClockLabel(null, 10_000), "unknown");
  assert.equal(chainClockLabel(undefined, 10_000), "unknown");
  assert.equal(chainClockLabel(Number.NaN, 10_000), "unknown");
});

test("chainClockLabel: boundary at one second and direction wording", () => {
  assert.equal(chainClockLabel(10_000, 10_000), "in sync");
  // 999 ms of skew is still inside the boundary; exactly 1000 ms is a duration.
  assert.equal(chainClockLabel(10_000 - 999, 10_000), "in sync");
  assert.equal(chainClockLabel(10_000 - 1_000, 10_000), "local clock 1.0s ahead of chain");
  assert.equal(chainClockLabel(10_000 + 1_000, 10_000), "chain clock 1.0s ahead of local");
});

test("chainClockLabel: durations stay bounded for long outages", () => {
  const now = 100 * 86_400_000;
  assert.equal(chainClockLabel(now - 120_000, now), "local clock 2m ahead of chain");
  assert.equal(chainClockLabel(now - 3_600_000, now), "local clock 1h ahead of chain");
  assert.equal(chainClockLabel(now - 86_400_000 * 3, now), "local clock 3d ahead of chain");
  assert.equal(chainClockLabel(now - 86_400_000 * 365 * 2, now), "local clock 2y ahead of chain");
  // A clock far in the future still renders as a bounded string, never NaN.
  const far = chainClockLabel(now + 86_400_000 * 3, now);
  assert.equal(far, "chain clock 3d ahead of local");
  assert.ok(far.length <= 40, `label must stay short: ${far}`);
});

// ── Health report ────────────────────────────────────────────────────────────

test("buildHealthReport exposes the chain clock and a numeric skew", () => {
  const report = buildHealthReport(baseConfig("/tmp/unused.json"), statusFixture({ chainClockAt: 500 }), 5_500);
  assert.equal(report.poller.chainClockAt, new Date(500).toISOString());
  assert.equal(report.poller.chainClockSkewMs, 5_000);
});

test("buildHealthReport reports null skew — never NaN — when no chain time was seen", () => {
  for (const chainClockAt of [null, undefined, Number.NaN, "1970"]) {
    const report = buildHealthReport(
      baseConfig("/tmp/unused.json"),
      statusFixture({ chainClockAt }),
      5_500,
    );
    assert.equal(report.poller.chainClockAt, null, `unexpected clock for ${String(chainClockAt)}`);
    assert.equal(report.poller.chainClockSkewMs, null);
  }
  // The whole report must survive JSON round-tripping with no secret and no NaN.
  const blob = JSON.stringify(
    buildHealthReport(baseConfig("/tmp/unused.json"), statusFixture(), 5_500),
  );
  assert.equal(blob.includes(TOKEN), false);
  assert.equal(blob.includes("null,\"chainClockSkewMs\":null"), true);
});

// ── Telegram surface ─────────────────────────────────────────────────────────

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

async function dispatch(bot, command) {
  const replies = [];
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === "sendMessage") {
      replies.push(payload);
      return { ok: true, result: { message_id: 1, chat: { id: -1, type: "private" }, date: 0 } };
    }
    return prev(method, payload, signal);
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -1001234567890, type: "private" },
      from: { id: 1, is_bot: false, first_name: "Tester" },
      text: `/${command}`,
      entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
    },
  });
  return replies;
}

test("/status shows the chain clock skew alongside the chain tip", async () => {
  const config = baseConfig("./data/unused.json");
  const bot = createBot({
    config,
    status: () => statusFixture({ chainClockAt: Date.now() }),
    botInfo: FAKE_BOT_INFO,
  });

  const replies = await dispatch(bot, "status");
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes("Chain tip: 42"));
  assert.ok(replies[0].text.includes("Chain clock skew: in sync"));
  assert.equal(replies[0].text.includes(TOKEN), false);
});

test("/status escapes the skew label for MarkdownV2", async () => {
  const config = baseConfig("./data/unused.json");
  const bot = createBot({
    config,
    // Whole seconds in the past: the label contains a decimal point, which
    // MarkdownV2 reserves, so the rendered text must carry an escaped one.
    status: () => statusFixture({ chainClockAt: Date.now() - 2_500 }),
    botInfo: FAKE_BOT_INFO,
  });

  const replies = await dispatch(bot, "status");
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Chain clock skew: local clock \d\\\.\ds ahead of chain/);
});

test("a status with no chain clock yet still renders a bounded unknown label", async () => {
  const config = baseConfig("./data/unused.json");
  const bot = createBot({
    config,
    status: () => statusFixture({ chainClockAt: null }),
    botInfo: FAKE_BOT_INFO,
  });

  const replies = await dispatch(bot, "status");
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes("Chain clock skew: unknown"));
});

test("/health reports the same skew wording as /status", async () => {
  const config = baseConfig("./data/unused.json");
  const now = 10_000;
  const msg = healthMessage(config, statusFixture({ chainClockAt: 5_000 }), now);
  assert.ok(
    msg.includes("Chain clock skew: local clock 5\\.0s ahead of chain"),
    `expected the MarkdownV2-escaped skew line, got:\n${msg}`,
  );
  assert.equal(msg.includes(TOKEN), false);

  const unknown = healthMessage(config, statusFixture({ chainClockAt: null }), now);
  assert.ok(unknown.includes("Chain clock skew: unknown"));
});

// ── Poller tracking ──────────────────────────────────────────────────────────

test("a scan with events sets the chain clock from the close time", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const state = { fail: false, events: {} };
      state.events[MARKET_ID] = [makeEvent(4900, MARKET_ID, new Date(CHAIN_TIME).toISOString())];
      const poller = makePoller(baseConfig(dir.file("cursor.json")), fakeServer(state));

      assert.equal(poller.status().chainClockAt, null, "cold start has no chain clock");
      await poller.start();
      await waitFor(() => poller.status().chainClockAt !== null);
      poller.stop();

      assert.equal(poller.status().chainClockAt, CHAIN_TIME);
    } finally {
      await dir.cleanup();
    }
  }));

test("an event with no close time never sets the chain clock", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const state = { fail: false, events: {} };
      state.events[MARKET_ID] = [makeEvent(4900, MARKET_ID)]; // no ledgerClosedAt
      const poller = makePoller(baseConfig(dir.file("cursor.json")), fakeServer(state));
      await poller.start();
      await waitFor(() => poller.status().lastSuccessAt !== null);
      poller.stop();

      assert.equal(poller.status().chainClockAt, null, "epoch 0 must never be mistaken for a chain time");
      assert.ok(poller.status().eventsSkipped >= 1, "the undecodable event is still counted");
    } finally {
      await dir.cleanup();
    }
  }));

test("an implausible close time is warned about and never adopted", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const state = { fail: false, events: {} };
      state.events[MARKET_ID] = [makeEvent(4900, MARKET_ID, "2999-01-01T00:00:00Z")];
      const config = { ...baseConfig(dir.file("cursor.json")), pollIntervalMs: 20 };
      const poller = makePoller(config, fakeServer(state));

      const warnings = await captured("warn", async () => {
        await poller.start();
        await waitFor(() => poller.status().lastSuccessAt !== null);
      });

      assert.equal(poller.status().chainClockAt, null, "a far-future close time must not be adopted");
      const clockWarnings = warnings.filter((line) => line.includes("implausible chain close time"));
      assert.ok(clockWarnings.length >= 1, `expected a bounded warning, got: ${warnings.join("\n")}`);
      assert.ok(
        clockWarnings.every((line) => line.length < 200 && line.includes(TOKEN) === false),
        "the warning must stay bounded and secret-free",
      );

      // A good value after the bad one still lands: nothing is wedged.
      state.events[MARKET_ID] = [makeEvent(4901, MARKET_ID, new Date(CHAIN_TIME).toISOString())];
      await waitFor(() => poller.status().chainClockAt === CHAIN_TIME);
      poller.stop();
      assert.equal(poller.status().chainClockAt, CHAIN_TIME);
    } finally {
      await dir.cleanup();
    }
  }));

test("the chain clock never moves backwards and quiet scans leave it alone", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const state = { fail: false, events: {} };
      state.events[MARKET_ID] = [makeEvent(4900, MARKET_ID, new Date(CHAIN_TIME).toISOString())];
      const config = { ...baseConfig(dir.file("cursor.json")), pollIntervalMs: 20 };
      const poller = makePoller(config, fakeServer(state));

      await poller.start();
      await waitFor(() => poller.status().chainClockAt === CHAIN_TIME);
      await waitFor(() => poller.status().lastSuccessAt !== null);

      // A later, older event must not rewind the clock.
      state.events[MARKET_ID] = [makeEvent(4901, MARKET_ID, new Date(CHAIN_TIME_EARLIER).toISOString())];
      const seenAfterClock = poller.status().lastSuccessAt;
      await waitFor(() => poller.status().lastSuccessAt !== seenAfterClock);
      assert.equal(poller.status().chainClockAt, CHAIN_TIME, "an older close time must not rewind");

      // A quiet chain (no events at all) must not fabricate a newer time.
      state.events[MARKET_ID] = [];
      const seenBeforeQuiet = poller.status().lastSuccessAt;
      await waitFor(() => poller.status().lastSuccessAt !== seenBeforeQuiet);
      poller.stop();
      assert.equal(poller.status().chainClockAt, CHAIN_TIME, "a quiet scan must not move the clock");
    } finally {
      await dir.cleanup();
    }
  }));

test("a failed scan leaves the chain clock at the last observed value", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const state = { fail: false, events: {} };
      state.events[MARKET_ID] = [makeEvent(4900, MARKET_ID, new Date(CHAIN_TIME).toISOString())];
      const config = { ...baseConfig(dir.file("cursor.json")), pollIntervalMs: 20 };
      const poller = makePoller(config, fakeServer(state));

      await poller.start();
      await waitFor(() => poller.status().chainClockAt === CHAIN_TIME);

      state.fail = true;
      await waitFor(() => poller.status().consecutiveFailures >= 1);
      poller.stop();

      assert.ok(poller.status().consecutiveFailures >= 1, "the outage must be visible");
      assert.equal(poller.status().chainClockAt, CHAIN_TIME, "an outage must not invent chain time");
      // The skew against a frozen chain clock is the signal operators read.
      const report = buildHealthReport(baseConfig(dir.file("cursor.json")), poller.status());
      assert.equal(report.poller.chainClockAt, new Date(CHAIN_TIME).toISOString());
      assert.ok(report.poller.chainClockSkewMs > 0);
    } finally {
      await dir.cleanup();
    }
  }));

// ── Persistence and restarts ─────────────────────────────────────────────────

test("the chain clock is persisted with the cursors and resumes on restart", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const cursorFile = dir.file("cursor.json");
      const state = { fail: false, events: {} };
      state.events[MARKET_ID] = [makeEvent(4900, MARKET_ID, new Date(CHAIN_TIME).toISOString())];
      const first = makePoller(baseConfig(cursorFile), fakeServer(state));

      await first.start();
      await waitFor(() => first.status().chainClockAt === CHAIN_TIME);
      let saved;
      await waitFor(async () => {
        try {
          saved = JSON.parse(await readFile(cursorFile, "utf8"));
          return saved.chainClockAt === CHAIN_TIME;
        } catch {
          return false; // not written yet
        }
      });
      first.stop();

      assert.equal(saved.version, 1, "the cursor file format stays version 1");
      assert.equal(saved.targets.market.cursor !== null, true, "cursors are saved alongside the clock");

      // Boot again with a scan that never answers: only loadCursors can have
      // run, so a non-null clock proves it came back from the file.
      const second = makePoller(baseConfig(cursorFile), hangingServer());
      await second.start();
      const resumed = second.status();
      second.stop();

      assert.equal(resumed.chainClockAt, CHAIN_TIME, "restart resumes the chain clock");
      assert.equal(resumed.targets.find((t) => t.source === "market").cursor !== null, true);
    } finally {
      await dir.cleanup();
    }
  }));

test("an invalid saved chain clock is dropped without losing the cursors", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const cursorFile = dir.file("cursor.json");
      const badValues = [
        "yesterday",
        -1,
        1.5,
        true,
        { at: CHAIN_TIME },
        Date.UTC(3000, 0, 1), // far future: outside the plausible window
        Date.UTC(1999, 0, 1), // before Stellar existed
      ];
      for (const bad of badValues) {
        await writeFile(
          cursorFile,
          JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString(),
            chainClockAt: bad,
            targets: {
              market: { cursor: "12345-0", lastEventLedger: 100 },
              squad: { cursor: "12345-1", lastEventLedger: 101 },
            },
          }),
          "utf8",
        );

        const poller = makePoller(baseConfig(cursorFile), hangingServer());
        await poller.start();
        const status = poller.status();
        poller.stop();

        assert.equal(status.chainClockAt, null, `bad clock ${JSON.stringify(bad)} must be dropped`);
        assert.equal(status.targets.find((t) => t.source === "market").cursor, "12345-0");
        assert.equal(status.targets.find((t) => t.source === "squad").cursor, "12345-1");
      }
    } finally {
      await dir.cleanup();
    }
  }));

test("a cursor file written before the chain clock existed still loads", () =>
  createTempDataDir("mimir-chain-clock-").then(async (dir) => {
    try {
      const cursorFile = dir.file("cursor.json");
      await writeFile(
        cursorFile,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          targets: { market: { cursor: "77-0", lastEventLedger: 7 }, squad: { cursor: null, lastEventLedger: null } },
        }),
        "utf8",
      );

      const poller = makePoller(baseConfig(cursorFile), hangingServer());
      await poller.start();
      const status = poller.status();
      poller.stop();

      assert.equal(status.chainClockAt, null, "an absent field loads as unknown, not as epoch 0");
      assert.equal(status.targets.find((t) => t.source === "market").cursor, "77-0");
    } finally {
      await dir.cleanup();
    }
  }));
