import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createPoller } from "../dist/poller.js";
import { createRpcServer } from "../dist/stellar/client.js";
import { readContractEvents } from "../dist/stellar/events.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_RPC_DEFAULT_PORT,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";
import {
  defaultMockScenario,
  malformedMockEvent,
  parseMockCli,
  startMockRpc,
} from "../dist/stellar/mock-rpc.js";

/**
 * Local Soroban mock: scanner walks, poller failure modes, cursor safety,
 * restart behaviour, log bounds, and the two runnable entry points.
 *
 * Everything here is loopback-only: no Testnet, no Telegram, no credentials.
 * The fixed bot token below is a fake shape used solely to prove secrets never
 * reach the logs.
 */

const execFileAsync = promisify(execFile);

const TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const ALICE = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
const BOB = "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";

const TIP = 1000;
const TIP_CURSOR = `${(BigInt(TIP) << 32n) | 0xffffffffn}-4294967295`;
const PRE_EVENT_CURSOR = `${(949n << 32n) | 0xffffffffn}-4294967295`;
const STALE_CURSOR = `${100n << 32n}-0`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SECRET_RE = /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/;

// ── Harness ─────────────────────────────────────────────────────────────────

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(3);
  }
}

async function waitForCursorFile(file, predicate, label, timeoutMs = 8000) {
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

function captureConsole() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const push = (level) => (...args) => {
    lines.push({ level, text: args.map(String).join(" ") });
  };
  console.log = push("log");
  console.warn = push("warn");
  console.error = push("error");
  return {
    lines,
    text: () => lines.map((l) => l.text).join("\n"),
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/** Logs must stay bounded and must never carry a bot token. */
function assertBoundedLogs(lines) {
  for (const { text } of lines) {
    assert.ok(text.length <= 300, `log line exceeded 300 chars (${text.length}): ${text}`);
    assert.ok(!text.includes(TOKEN), `bot token leaked into logs: ${text}`);
    assert.ok(!SECRET_RE.test(text), `token-shaped secret leaked into logs: ${text}`);
  }
}

function scenario(events, overrides = {}) {
  return {
    latestLedger: TIP,
    oldestLedger: 900,
    ledgersPerPage: 50,
    events,
    ...overrides,
  };
}

const marketEvent = (ledger, claimId) => ({
  source: "market",
  ledger,
  eventName: "claim_challenged",
  topics: [claimId, { address: ALICE }],
  fields: { stake: 20000000n },
});

const squadEvent = (ledger, marketId) => ({
  source: "squad",
  ledger,
  eventName: "deposited",
  topics: [marketId, 1, { address: BOB }],
  fields: { amount: 50000000n, shares: 49900000n },
});

async function startScenario(scen) {
  return startMockRpc({ port: 0, scenario: scen });
}

function stellarConfig(mock) {
  return {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    rpcUrl: mock.url,
    horizonUrl: "http://127.0.0.1:1/",
    networkPassphrase: "Local Mimir Mock ; Mimir Notifier",
    explorerBaseUrl: "http://127.0.0.1:1/",
  };
}

function botConfig(cursorFile, mock, overrides = {}) {
  return {
    ...stellarConfig(mock),
    botToken: TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 25,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 1,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90000,
    ...overrides,
  };
}

async function tmpCursorFile(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-mock-test-"));
  const file = path.join(dir, "cursor.mock.json");
  if (contents !== undefined) await writeFile(file, contents, "utf8");
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function cursorFileJson(marketCursor, squadCursor = marketCursor) {
  return `${JSON.stringify(
    {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      targets: {
        market: { cursor: marketCursor, lastEventLedger: null },
        squad: { cursor: squadCursor, lastEventLedger: null },
      },
    },
    null,
    2,
  )}\n`;
}

async function runPoller(config, send) {
  const poller = createPoller({ config, server: createRpcServer(config), send });
  await poller.start();
  return poller;
}

function targetState(poller, source) {
  return poller.status().targets.find((t) => t.source === source);
}

/** `stats().byMethod` only contains keys a request has already used. */
function methodCount(stats, method) {
  return stats.byMethod[method] ?? 0;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

test("scanner walks through empty pages and decodes both contracts", async () => {
  const mock = await startScenario(scenario([marketEvent(995, 7), squadEvent(996, 3)]));
  const server = createRpcServer(stellarConfig(mock));
  try {
    const before = mock.stats();

    const market = await readContractEvents(
      server,
      { source: "market", contractId: MOCK_MARKET_CONTRACT_ID },
      { startLedger: 900 },
    );
    // Window 900-949 comes back empty; a short-page stop would find nothing.
    assert.equal(market.pages, 3, "must continue past the empty first window");
    assert.equal(market.events.length, 1);
    assert.equal(market.truncated, false);
    const m = market.events[0];
    assert.equal(m.payload.name, "claim_challenged");
    assert.equal(m.payload.claimId, 7);
    assert.equal(m.payload.challenger, ALICE);
    assert.equal(m.payload.stake, 20000000n);
    assert.equal(m.ledger, 995);
    assert.equal(m.contractId, MOCK_MARKET_CONTRACT_ID);
    assert.match(m.txHash, /^[0-9a-f]{64}$/);
    assert.equal(market.cursor, TIP_CURSOR);

    const squad = await readContractEvents(
      server,
      { source: "squad", contractId: MOCK_SQUAD_CONTRACT_ID },
      { startLedger: 900 },
    );
    assert.equal(squad.pages, 3);
    assert.equal(squad.events.length, 1);
    const s = squad.events[0];
    assert.equal(s.payload.name, "deposited");
    assert.equal(s.payload.marketId, 3);
    assert.equal(s.payload.side, 1);
    assert.equal(s.payload.participant, BOB);
    assert.equal(s.payload.amount, 50000000n);

    const after = mock.stats();
    assert.equal(methodCount(after, "getHealth") - methodCount(before, "getHealth"), 2);
    assert.equal(methodCount(after, "getEvents") - methodCount(before, "getEvents"), 6);
    assert.equal(after.requests - before.requests, 8);
  } finally {
    await mock.close();
  }
});

test("request validation mirrors the real RPC", async () => {
  const mock = await startScenario(scenario([marketEvent(995, 7)]));
  const server = createRpcServer(stellarConfig(mock));
  try {
    const rejects = async (fn, needle) => {
      await assert.rejects(fn, (err) => {
        assert.ok(err && typeof err.message === "string", `expected a message: ${String(err)}`);
        assert.ok(err.message.includes(needle), `message "${err.message}" lacks "${needle}"`);
        assert.ok(err.message.length <= 200, `mock error not bounded: ${err.message.length}`);
        return true;
      }, `expected rejection containing "${needle}"`);
    };

    // startLedger below the retained floor: an error, not an empty result.
    await rejects(
      () => server.getEvents({ filters: [], startLedger: 10, limit: 5 }),
      "before the retained floor 900",
    );
    // A cursor from before the retained window is stale.
    await rejects(
      () => server.getEvents({ filters: [], cursor: STALE_CURSOR, limit: 5 }),
      "cursor is stale: ledger 100 precedes the retained floor 900",
    );
    // A cursor past the tip is rejected.
    await rejects(
      () => server.getEvents({ filters: [], cursor: `${(2000n << 32n).toString()}-0`, limit: 5 }),
      "ahead of the chain tip",
    );
    // Garbage is rejected as an invalid resume token.
    await rejects(
      () => server.getEvents({ filters: [], cursor: "garbage", limit: 5 }),
      "not a valid resume token",
    );
    // Both pagination modes in one request is rejected.
    await rejects(
      () =>
        server._getEvents({
          filters: [],
          startLedger: 950,
          cursor: TIP_CURSOR,
          limit: 5,
        }),
      "mutually exclusive",
    );

    // And a well-formed request still succeeds after all that.
    const ok = await server.getEvents({ filters: [], startLedger: 950, limit: 5 });
    assert.ok(Array.isArray(ok.events));
  } finally {
    await mock.close();
  }
});

test("a large scenario stays within page, request, time, and log bounds", async () => {
  const events = Array.from({ length: 300 }, (_, i) => ({
    source: "market",
    ledger: 5 + i * 6,
    eventName: "claim_challenged",
    topics: [i, { address: ALICE }],
    fields: { stake: 1n },
  }));
  const mock = await startScenario(scenario(events, { oldestLedger: 1, latestLedger: 2000, ledgersPerPage: 10 }));
  const server = createRpcServer(stellarConfig(mock));
  const cap = captureConsole();
  try {
    const before = mock.stats();
    const started = Date.now();
    const scan = await readContractEvents(
      server,
      { source: "market", contractId: MOCK_MARKET_CONTRACT_ID },
      { startLedger: 1 },
    );
    const elapsed = Date.now() - started;

    assert.equal(scan.truncated, true, "maxPages must stop the walk");
    assert.equal(scan.pages, 20);
    assert.ok(scan.events.length > 0);
    assert.ok(scan.events.length <= 20 * 200);
    // Windows are cursor-exclusive at each boundary, so 20 pages of 10 cover
    // up to ledger 181: events at 5, 11, … 179 → 30 of the 300.
    assert.equal(scan.events.length, 30);
    assert.ok(scan.cursor !== null);
    assert.ok(elapsed < 5000, `scan took ${elapsed}ms`);

    const after = mock.stats();
    assert.equal(methodCount(after, "getEvents") - methodCount(before, "getEvents"), 20);
    assert.equal(methodCount(after, "getHealth") - methodCount(before, "getHealth"), 1);
    assert.ok(after.requests - before.requests <= 21);
    assertBoundedLogs(cap.lines);
  } finally {
    cap.restore();
    await mock.close();
  }
});

test("limit=5 paginates a dense ledger down to every event", async () => {
  const events = Array.from({ length: 12 }, (_, i) => ({
    source: "market",
    ledger: 995,
    eventName: "claim_challenged",
    topics: [i, { address: ALICE }],
    fields: { stake: 1n },
  }));
  const mock = await startScenario(scenario(events));
  const server = createRpcServer(stellarConfig(mock));
  try {
    const scan = await readContractEvents(
      server,
      { source: "market", contractId: MOCK_MARKET_CONTRACT_ID },
      { startLedger: 900, limit: 5 },
    );
    assert.equal(scan.events.length, 12, "a tight limit must paginate, not drop");
    assert.equal(scan.truncated, false);
    assert.ok(scan.pages > 1);
    assert.equal(new Set(scan.events.map((e) => e.txHash)).size, 12);
    const ids = scan.events.map((e) => e.payload.claimId);
    assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  } finally {
    await mock.close();
  }
});

// ── Poller: cursor safety under failure ─────────────────────────────────────

test("a stale cursor below the retained floor is rewound and the scan recovers", async () => {
  const { file, cleanup } = await tmpCursorFile(cursorFileJson(STALE_CURSOR));
  const mock = await startScenario(scenario([marketEvent(995, 7), squadEvent(996, 3)]));
  const cap = captureConsole();
  const sends = [];
  let poller;
  try {
    poller = await runPoller(botConfig(file, mock), (text) => {
      sends.push(text);
    });

    // Ledger 100 precedes the mock's retained floor of 900, so the rejection is
    // confirmed against getHealth() and the target is rewound to the floor.
    await waitFor(() => poller.status().cursorRewinds >= 1, "floor rewind");
    // The floor walk then hands back an in-window cursor and drops the hint.
    await waitFor(
      () => targetState(poller, "market").cursor === TIP_CURSOR,
      "floor walk cursor",
    );
    await waitFor(() => sends.length >= 1, "event delivered after the rewind");

    const status = poller.status();
    const market = targetState(poller, "market");
    assert.ok(status.cursorRewinds >= 1, "the floor rewind is counted");
    assert.equal(market.rewindFromLedger, null, "the transient hint is cleared");
    assert.ok(
      cap.text().includes("rewinding to the floor 900"),
      "the recovery logs the retained floor it resumed from",
    );
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

test("injected JSON-RPC failures stay bounded, redacted, and recover", async () => {
  const { file, cleanup } = await tmpCursorFile(cursorFileJson(PRE_EVENT_CURSOR));
  const mock = await startScenario(scenario([marketEvent(995, 7), squadEvent(996, 3)]));
  mock.setFailure("getEvents", { kind: "error" });
  const cap = captureConsole();
  const sends = [];
  let poller;
  try {
    poller = await runPoller(botConfig(file, mock), (text) => {
      sends.push(text);
    });
    await waitFor(() => poller.status().consecutiveFailures >= 1, "injected failure");

    let status = poller.status();
    assert.equal(status.running, true, "the loop must survive an RPC failure");
    assert.equal(status.notificationsSent, 0, "no events may be delivered by a failed scan");
    // Squad is scanned last, so its error occupies the shared lastError slot;
    // both targets must have recorded the same bounded, code-prefixed failure.
    assert.equal(
      status.lastError.message,
      "squad: -32603: injected mock getEvents failure: error",
    );
    assert.ok(status.lastError.message.length <= 240);
    assert.equal(
      targetState(poller, "market").lastError,
      "-32603: injected mock getEvents failure: error",
    );
    // The events sit just beyond the seeded cursor — a dropped or drifted cursor
    // would deliver them now (duplicate) or later (loss).
    assert.equal(targetState(poller, "market").cursor, PRE_EVENT_CURSOR);
    assert.equal(targetState(poller, "squad").cursor, PRE_EVENT_CURSOR);
    assert.ok(
      cap
        .text()
        .includes("[poller] market scan failed: -32603: injected mock getEvents failure: error"),
    );

    // Failure budget spent; clear the injection and the very next cycle must
    // deliver exactly the events behind the cursor, once.
    mock.setFailure("getEvents", null);
    await waitFor(
      () => {
        const s = poller.status();
        return s.consecutiveFailures === 0 && s.lastSuccessAt !== null;
      },
      "recovery cycle",
    );
    await waitFor(() => poller.status().notificationsSent === 2, "both events delivered once");
    status = poller.status();
    assert.equal(status.notificationsSent, 2, "both contracts' events exactly once");
    assert.equal(status.notificationsFailed, 0);
    assert.notEqual(targetState(poller, "market").cursor, PRE_EVENT_CURSOR);
    assert.equal(sends.length, 2);
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

test("HTTP-shaped 429/500 failures are survivable and actionable", async () => {
  const { dir, cleanup } = await tmpCursorFile();
  const mock = await startScenario(scenario([marketEvent(995, 7)]));
  const cap = captureConsole();
  const sends = [];
  let poller;
  try {
    // No cursor file: cold start, so a cursor appearing would mean drift.
    poller = await runPoller(botConfig(path.join(dir, "cursor.mock.json"), mock), (text) => {
      sends.push(text);
    });

    for (const [kind, needle] of [
      ["rate-limit", "429"],
      ["http-500", "500"],
    ]) {
      const failuresBefore = poller.status().consecutiveFailures;
      mock.setFailure("getEvents", { kind });
      // Keyed on cycle completion, not the first error line: clearing an
      // injection mid-cycle would let the second target recover alone.
      await waitFor(
        () => {
          const s = poller.status();
          return (
            s.consecutiveFailures > failuresBefore &&
            (s.lastError?.message ?? "").includes(needle)
          );
        },
        `${kind} surfaced in lastError`,
      );
      const status = poller.status();
      assert.equal(status.running, true, `poller must keep running through ${kind}`);
      assert.match(status.lastError.message, new RegExp(`status code ${needle}`));
      assert.ok(status.lastError.message.length <= 240);
      for (const t of status.targets) assert.equal(t.cursor, null);
      assert.equal(status.notificationsSent, 0);
    }

    mock.setFailure("getEvents", null);
    await waitFor(
      () => {
        const s = poller.status();
        return s.consecutiveFailures === 0 && s.lastSuccessAt !== null;
      },
      "recovery after rate limit",
    );
    await waitFor(() => poller.status().notificationsSent === 1, "event delivered after recovery");
    assert.equal(poller.status().notificationsSent, 1, "delivered once after recovery");
    assert.equal(sends.length, 1);
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

// ── Poller: delivery behaviour ──────────────────────────────────────────────

test("a malformed event is skipped with a bounded reason while the cursor advances", async () => {
  const { file, cleanup } = await tmpCursorFile();
  const mock = await startScenario(
    scenario([marketEvent(995, 7), malformedMockEvent(996)]),
  );
  const cap = captureConsole();
  const sends = [];
  let poller;
  try {
    poller = await runPoller(botConfig(file, mock), (text) => {
      sends.push(text);
    });
    await waitFor(
      () => {
        const s = poller.status();
        return s.notificationsSent === 1 && s.eventsSkipped === 1;
      },
      "send plus malformed skip",
    );

    const status = poller.status();
    assert.equal(status.notificationsFailed, 0);
    const market = targetState(poller, "market");
    assert.ok(market.cursor !== null, "an undecodable event must not hold the cursor back");

    const skipLine = cap.lines.find((l) => l.text.includes("skipped market event"));
    assert.ok(skipLine, `no skip line in: ${cap.text()}`);
    assert.match(
      skipLine.text,
      /\[poller\] skipped market event "claim_challenged" at ledger 996 \(.*expected a Stellar address strkey.*\)/,
    );
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

test("the per-cycle burst cap drops extras without losing cursor position", async () => {
  const { file, cleanup } = await tmpCursorFile();
  const mock = await startScenario(
    scenario([marketEvent(995, 0), marketEvent(995, 1), marketEvent(995, 2)]),
  );
  const cap = captureConsole();
  const sends = [];
  let poller;
  try {
    poller = await runPoller(botConfig(file, mock), (text) => {
      sends.push(text);
    });
    await waitFor(
      () => {
        const s = poller.status();
        return s.notificationsSent === 1 && s.eventsSkipped === 2;
      },
      "cap enforced",
    );

    assert.equal(sends.length, 1, "only one send may escape the cap");
    const status = poller.status();
    assert.ok(targetState(poller, "market").cursor !== null, "cursor still advances past drops");
    assert.ok(
      cap.lines.some((l) =>
        /\[poller\] cycle notification cap \(1\) reached; dropping claim_challenged at ledger 995/.test(l.text),
      ),
      `no cap warning in: ${cap.text()}`,
    );
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

test("Telegram send failures: bounded retries, drop, cursor advances, token redacted", async () => {
  const { file, cleanup } = await tmpCursorFile();
  const mock = await startScenario(scenario([marketEvent(995, 7)]));
  const cap = captureConsole();
  const attempts = [];
  let poller;
  try {
    poller = await runPoller(botConfig(file, mock), (text) => {
      attempts.push(text);
      return Promise.reject(new Error(`Too Many Requests (429): ${TOKEN}`));
    });
    await waitFor(() => poller.status().notificationsFailed >= 1, "send failure counted", 12000);
    await waitForCursorFile(
      file,
      (j) => typeof j.targets?.market?.cursor === "string",
      "cursor persisted after failed send",
    );

    const status = poller.status();
    assert.equal(attempts.length, 3, "exactly MAX_SEND_RETRIES attempts");
    assert.equal(status.notificationsSent, 0);
    assert.equal(status.notificationsFailed, 1);
    assert.ok(targetState(poller, "market").cursor !== null, "failed sends must not wedge the cursor");

    const text = cap.text();
    assert.match(text, /send attempt 1 failed, retrying in 1000ms: /);
    assert.match(text, /send attempt 2 failed, retrying in 2000ms: /);
    assert.match(text, /send failed for claim_challenged at ledger 995 after retries: /);
    assert.ok(text.includes("[REDACTED]"), "token must be redacted in the failure line");
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

test("restart resumes from the version-1 cursor file with no replay and no drop", async () => {
  const { file, cleanup } = await tmpCursorFile();
  const mock = await startScenario(scenario([marketEvent(995, 7)]));
  const cap = captureConsole();
  const first = [];
  const second = [];
  let poller1;
  let poller2;
  try {
    poller1 = await runPoller(botConfig(file, mock), (text) => {
      first.push(text);
    });
    const saved = await waitForCursorFile(
      file,
      (j) => typeof j.targets?.market?.cursor === "string" && j.targets.market.cursor !== null,
      "first run persisted a cursor",
    );
    assert.equal(saved.version, 1);
    const cursor1 = saved.targets.market.cursor;
    assert.equal(first.length, 1, "the event behind the lookback is delivered once");

    poller1.stop();
    await sleep(40);

    poller2 = await runPoller(botConfig(file, mock), (text) => {
      second.push(text);
    });
    await waitFor(
      () => poller2.status().cycles >= 1 && poller2.status().lastSuccessAt !== null,
      "second run completed a cycle",
    );
    assert.equal(second.length, 0, "restart must not replay the already-delivered event");
    assert.equal(poller2.status().notificationsSent, 0);

    mock.addEvent({
      source: "market",
      ledger: 1001,
      eventName: "claim_created",
      topics: [11, { address: ALICE }],
      fields: { category: "crypto" },
    });
    await waitFor(() => second.length === 1, "appended event delivered after restart");
    assert.equal(poller2.status().notificationsSent, 1);
    assert.equal(poller2.status().notificationsFailed, 0);

    // The send happens before the cursor advances inside the cycle, so wait for
    // the version-1 file itself to reflect the new position.
    const final = await waitForCursorFile(
      file,
      (j) => j.targets?.market?.cursor !== cursor1,
      "cursor advanced on disk for the appended event",
    );
    assert.equal(final.version, 1);
    assert.notEqual(final.targets.market.cursor, cursor1, "cursor advanced for the new event");
    assert.ok(typeof final.targets.squad.cursor === "string");
    assert.equal(first.length, 1, "first run sent exactly one message overall");
    assertBoundedLogs(cap.lines);
  } finally {
    poller1?.stop();
    poller2?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

test("a corrupt cursor file cold-starts instead of crashing", async () => {
  const { file, cleanup } = await tmpCursorFile("not-json{{{");
  const mock = await startScenario(scenario([marketEvent(995, 7)]));
  const cap = captureConsole();
  const sends = [];
  let poller;
  try {
    poller = await runPoller(botConfig(file, mock), (text) => {
      sends.push(text);
    });
    await waitFor(() => poller.status().lastSuccessAt !== null, "cold start cycle");
    await waitFor(() => sends.length === 1, "event delivered after corrupt-file cold start");

    const status = poller.status();
    assert.equal(status.running, true);
    assert.ok(targetState(poller, "market").cursor !== null);
    assert.ok(
      cap.lines.some((l) => l.text.includes("cursor file unreadable, starting cold")),
      `no corrupt-file warning in: ${cap.text()}`,
    );
    assertBoundedLogs(cap.lines);
  } finally {
    poller?.stop();
    cap.restore();
    await sleep(40);
    await mock.close();
    await cleanup();
  }
});

// ── CLI parsing ─────────────────────────────────────────────────────────────

test("parseMockCli: ports, failure kinds, shorthands, and invalid input", () => {
  const defaults = parseMockCli([]);
  assert.equal(defaults.ok, true);
  assert.equal(defaults.options.port, MOCK_RPC_DEFAULT_PORT);
  assert.equal(defaults.options.malformed, false);
  assert.equal(defaults.options.getEvents, undefined);

  const port = parseMockCli(["--port", "0"]);
  assert.equal(port.ok, true);
  assert.equal(port.options.port, 0);

  const general = parseMockCli(["--fail-events", "rate-limit"]);
  assert.equal(general.ok, true);
  assert.deepEqual(general.options.getEvents, { kind: "rate-limit" });

  const shorthand = parseMockCli(["--stale-cursor", "--fail-health", "http-500", "--malformed"]);
  assert.equal(shorthand.ok, true);
  assert.deepEqual(shorthand.options.getEvents, { kind: "stale-cursor" });
  assert.deepEqual(shorthand.options.getHealth, { kind: "http-500" });
  assert.equal(shorthand.options.malformed, true);

  // The general form wins over a shorthand for the same slot.
  const both = parseMockCli(["--fail-events", "error", "--rate-limit"]);
  assert.equal(both.ok, true);
  assert.deepEqual(both.options.getEvents, { kind: "error" });

  const badKind = parseMockCli(["--fail-events", "bogus"]);
  assert.equal(badKind.ok, false);
  assert.match(badKind.error, /unknown failure kind "bogus"/);

  const badPort = parseMockCli(["--port", "99999"]);
  assert.equal(badPort.ok, false);
  assert.match(badPort.error, /0-65535/);

  const missingKind = parseMockCli(["--fail-events"]);
  assert.equal(missingKind.ok, false);
  assert.match(missingKind.error, /requires a kind/);
});

// ── Runnable entry points (child processes) ─────────────────────────────────

const ENV_STRIP = [
  "MIMIR_PROFILE",
  "MARKET_CONTRACT_ID",
  "SQUAD_CONTRACT_ID",
  "STELLAR_RPC_URL",
  "STELLAR_HORIZON_URL",
  "STELLAR_NETWORK_PASSPHRASE",
  "STELLAR_EXPLORER_BASE_URL",
  "CURSOR_FILE",
  "BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "OPERATOR_TELEGRAM_USER_ID",
  "POLL_INTERVAL_MS",
  "START_LOOKBACK_LEDGERS",
  "MAX_NOTIFICATIONS_PER_CYCLE",
  "HEALTH_HOST",
  "HEALTH_PORT",
  "HEALTH_STALE_MS",
];

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ENV_STRIP) delete env[key];
  return { ...env, ...overrides };
}

const EVENTS_CLI = fileURLToPath(new URL("../dist/stellar/events.js", import.meta.url));
const MOCK_RUN_CLI = fileURLToPath(new URL("../dist/mock-run.js", import.meta.url));

test("scanner CLI --mock runs with zero credentials against the local mock", async () => {
  const mock = await startScenario(scenario([marketEvent(995, 7), squadEvent(996, 3)]));
  const { dir, cleanup } = await tmpCursorFile();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [EVENTS_CLI, "--mock", "--pages", "5", "--show", "2"],
      {
        cwd: dir,
        env: childEnv({ STELLAR_RPC_URL: mock.url }),
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    assert.match(stdout, /RPC\s+http:\/\/127\.0\.0\.1:\d+ \(mock\)/);
    assert.ok(stdout.includes(`=== market  ${MOCK_MARKET_CONTRACT_ID} ===`));
    assert.ok(stdout.includes(`=== squad  ${MOCK_SQUAD_CONTRACT_ID} ===`));
    assert.match(stdout, /truncated=false/);
    assert.ok(stdout.includes("claim_challenged"));
    assert.ok(stdout.includes("deposited"));
    assert.ok(stdout.includes("challenged by"));
    assert.doesNotMatch(stdout, SECRET_RE, "no credential-shaped secret in scanner output");
    assert.doesNotMatch(stdout, /soroban-testnet/, "must never touch live Testnet");
  } finally {
    await mock.close();
    await cleanup();
  }
});

test("mock:poll boots a credential-free dry run and shuts down cleanly", async () => {
  const { dir, cleanup } = await tmpCursorFile();
  const env = childEnv({ HEALTH_PORT: "0" });
  const child = spawn(process.execPath, [MOCK_RUN_CLI, "--port", "0"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out += chunk;
  });

  try {
    await waitFor(
      () => out.includes("[dry-run] health") && out.includes("would send"),
      "dry-run boot and first send log",
      15000,
    );

    assert.match(out, /\[dry-run\] profile\s+mock/);
    assert.match(out, /\[dry-run\] network\s+mock · rpc http:\/\/127\.0\.0\.1:\d+/);
    assert.match(out, new RegExp(`\\[dry-run\\] market\\s+${MOCK_MARKET_CONTRACT_ID}`));
    assert.ok(out.includes("cursor.mock.json"), "drill must use the isolated cursor file");
    assert.match(out, /\[dry-run\] would send \d+ chars: /);
    assert.doesNotMatch(out, SECRET_RE, "no credential-shaped secret in dry-run output");
    assert.doesNotMatch(out, /MOCK-PROFILE-NOT-A-BOT-TOKEN/, "placeholder token never printed");

    const sendLine = out.split("\n").find((line) => line.includes("[dry-run] would send"));
    assert.ok(sendLine.length <= 300, `send preview not bounded: ${sendLine.length}`);

    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, `expected clean exit, output:\n${out}`);
    assert.ok(out.includes("[dry-run] SIGTERM received"), `no graceful stop in:\n${out}`);
    assertBoundedLogs(
      out.split("\n").filter(Boolean).map((text) => ({ text })),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await cleanup();
  }
});

test("the default scenario stays coherent for the documented drills", () => {
  const scen = defaultMockScenario();
  assert.equal(scen.latestLedger, 1000);
  assert.equal(scen.oldestLedger, 900);
  assert.ok(scen.events.length >= 8);
  assert.ok(scen.events.every((e) => e.ledger >= 900 && e.ledger <= 1000));
  const names = new Set(scen.events.map((e) => `${e.source}:${e.eventName}`));
  assert.ok(names.has("market:claim_challenged"));
  assert.ok(names.has("squad:deposited"));
  assert.ok(names.has("market:oracle_changed"), "the skip-path event must exist");
});
