import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNotifier } from "../dist/bot.js";
import {
  eventExplorerUrl,
  explorerKeyboard,
  formatEvent,
} from "../dist/notifications/format.js";
import { txExplorerUrl } from "../dist/stellar/client.js";
import { decodeEvent } from "../dist/stellar/decode.js";
import { eventCursorLedger } from "../dist/stellar/events.js";
import { createPoller } from "../dist/poller.js";

const VALID_TX = "0123456789abcdef".repeat(4);
assert.equal(VALID_TX.length, 64);

function testnetConfig(overrides = {}) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    chatId: "-1001234567890",
    ...overrides,
  };
}

function claimChallengedEvent(overrides = {}) {
  return {
    source: "market",
    contractId: "market",
    ledger: 4226692,
    txHash: VALID_TX,
    at: 0,
    eventId: "0018276211125911551-0000000001",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
    ...overrides,
  };
}

// ── Positive ─────────────────────────────────────────────────────────────────

test("event notification includes an explorer button with the canonical URL", () => {
  const config = testnetConfig();
  const event = claimChallengedEvent();

  const url = eventExplorerUrl(config, event);
  assert.equal(url, `https://stellar.expert/explorer/testnet/tx/${VALID_TX}`);

  const keyboard = explorerKeyboard(config, event);
  assert.deepEqual(keyboard, {
    inline_keyboard: [[{ text: "View on Explorer", url }]],
  });
});

test("existing message content stays intact when the button is added", () => {
  const config = testnetConfig();
  const event = claimChallengedEvent();

  const message = formatEvent(config, event);
  assert.match(message, /Claim \\#7 challenged/);
  assert.match(message, /Stake: \*2\\\.0000000 USDC\*/);
  // The pre-existing footer link is kept as the text fallback.
  assert.ok(message.includes(`[tx](${eventExplorerUrl(config, event)})`));
  assert.ok(message.includes("_ledger 4226692_"));
});

test("notifier sends the exact Telegram payload: MarkdownV2 text + inline keyboard", async () => {
  const config = testnetConfig();
  const event = claimChallengedEvent();
  const text = formatEvent(config, event);
  const keyboard = explorerKeyboard(config, event);

  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  await createNotifier(fakeBot, config)(text, undefined, { reply_markup: keyboard });

  assert.deepEqual(sent, [
    [
      config.chatId,
      text,
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [{ text: "View on Explorer", url: `https://stellar.expert/explorer/testnet/tx/${VALID_TX}` }],
          ],
        },
      },
    ],
  ]);
});

test("explorer URL follows the network passphrase (public vs testnet)", () => {
  const event = claimChallengedEvent();
  const publicUrl = eventExplorerUrl(
    testnetConfig({ networkPassphrase: "Public Global Stellar Network ; September 2015" }),
    event,
  );
  assert.equal(publicUrl, `https://stellar.expert/explorer/public/tx/${VALID_TX}`);
  assert.equal(txExplorerUrl(testnetConfig(), VALID_TX).includes("/testnet/"), true);
});

test("notification routing still uses the configured chat id", async () => {
  const config = testnetConfig({ chatId: "@mychannel" });
  const sent = [];
  const fakeBot = { api: { sendMessage: async (...a) => { sent.push(a); return {}; } } };
  await createNotifier(fakeBot, config)("hello");
  assert.equal(sent[0][0], "@mychannel");
});

// ── Negative ─────────────────────────────────────────────────────────────────

test("missing transaction identifier means text-only, no button, no crash", async () => {
  const config = testnetConfig();
  for (const txHash of ["", "   ", undefined]) {
    const event = claimChallengedEvent({ txHash });
    assert.equal(eventExplorerUrl(config, event), null);
    assert.equal(explorerKeyboard(config, event), undefined);
    const message = formatEvent(config, event);
    assert.ok(message.includes("_ledger 4226692_"));
    assert.ok(!message.includes("[tx]"));

    const sent = [];
    const fakeBot = { api: { sendMessage: async (...a) => { sent.push(a); return {}; } } };
    await createNotifier(fakeBot, config)(message);
    // Regression: no reply_markup key at all, exactly the old payload shape.
    assert.deepEqual(sent, [
      [config.chatId, message, { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } }],
    ]);
  }
});

test("invalid explorer inputs never produce a button or an invalid URL", () => {
  const config = testnetConfig();
  const bad = [
    "short",
    "xyz".repeat(30),
    `${VALID_TX}ff`, // 66 chars: too long
    VALID_TX.slice(0, 63), // too short
    `https://evil.example/${VALID_TX}`,
    `${VALID_TX}\nhttps://evil.example`,
    "javascript:alert(1)".padEnd(64, "0"),
    "<script>alert(1)</script>".padEnd(64, "a"),
    "..//..//etc/passwd".padEnd(64, "b"),
  ];
  for (const txHash of bad) {
    const event = claimChallengedEvent({ txHash });
    assert.equal(eventExplorerUrl(config, event), null, txHash.slice(0, 20));
    assert.equal(explorerKeyboard(config, event), undefined, txHash.slice(0, 20));
  }
});

test("malformed events decode to unknown and stay non-notifying without throwing", () => {
  const malformed = [
    { topic: undefined, value: undefined, ledger: 1, txHash: "", ledgerClosedAt: "bad-date", id: "x" },
    { topic: [], value: 42, ledger: 0, txHash: "", ledgerClosedAt: "", id: "" },
    { topic: null, value: null, ledger: -1, txHash: null, ledgerClosedAt: null, id: null },
  ];
  for (const raw of malformed) {
    const decoded = decodeEvent("market", raw);
    assert.equal(decoded.payload.name, "unknown");
    assert.equal(formatEvent(testnetConfig(), decoded), null);
    assert.equal(explorerKeyboard(testnetConfig(), decoded), undefined);
  }
});

test("Telegram API failure propagates (bounded: the poller drops one message, no retry loop)", async () => {
  const err429 = new Error("Too Many Requests: retry after 35");
  err429.retry_after = 35;
  let calls = 0;
  const fakeBot = {
    api: {
      sendMessage: async () => {
        calls += 1;
        throw err429;
      },
    },
  };
  const notify = createNotifier(fakeBot, testnetConfig());
  await assert.rejects(notify("text", undefined, { reply_markup: explorerKeyboard(testnetConfig(), claimChallengedEvent()) }), err429);
  assert.equal(calls, 1, "notifier must not retry internally");
});

// ── Boundary ─────────────────────────────────────────────────────────────────

test("long identifiers and unusual values are bounded and safe", () => {
  const config = testnetConfig();
  assert.equal(eventExplorerUrl(config, claimChallengedEvent({ txHash: "ab".repeat(5000) })), null);
  assert.equal(explorerKeyboard(config, claimChallengedEvent({ txHash: "ab".repeat(5000) })), undefined);

  const huge = claimChallengedEvent({
    payload: { name: "claim_challenged", claimId: 2 ** 40, challenger: "GABCD", stake: 2n ** 200n },
  });
  const message = formatEvent(config, huge);
  assert.ok(typeof message === "string" && message.length < 4000);

  const unicode = claimChallengedEvent({
    txHash: VALID_TX.toUpperCase(),
    payload: { name: "claim_created", claimId: 1, creator: "GABCD", category: "crypto 🛰️\nnewline _*[]()~`>#+-=|{}.!\\" },
  });
  assert.ok(eventExplorerUrl(config, unicode)?.endsWith(VALID_TX.toUpperCase()));
  assert.ok(formatEvent(config, unicode)?.includes("New claim"));
});

test("missing optional fields fall back to text-only", () => {
  const config = testnetConfig();
  const noSummary = {
    source: "market", contractId: "market", ledger: 9, txHash: "", at: 0, eventId: "9-0",
    payload: { name: "claim_resolved", claimId: 3, winnerSide: 2, summary: "", confidence: 100, evidenceHash: "" },
  };
  const message = formatEvent(config, noSummary);
  assert.ok(message.includes("resolved"));
  assert.equal(explorerKeyboard(config, noSummary), undefined);
});

test("stale and malformed cursors parse safely", () => {
  assert.equal(eventCursorLedger(""), null);
  assert.equal(eventCursorLedger("not-a-cursor"), null);
  assert.equal(eventCursorLedger("4294967295-0"), 0);
  const ledger = 4226691;
  const cursor = `${(BigInt(ledger) << 32n).toString()}-0000000001`;
  assert.equal(eventCursorLedger(cursor), ledger);
});

// ── Restart / cursor compatibility ───────────────────────────────────────────

test("cursor file format stays v1-compatible across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-cursor-"));
  const cursorFile = path.join(dir, "cursor.json");
  const saved = {
    version: 1,
    updatedAt: new Date().toISOString(),
    targets: {
      market: { cursor: `${(BigInt(100) << 32n).toString()}-0000000001`, lastEventLedger: 100 },
      squad: { cursor: `${(BigInt(200) << 32n).toString()}-0000000002`, lastEventLedger: 200 },
    },
  };
  await writeFile(cursorFile, `${JSON.stringify(saved, null, 2)}\n`, "utf8");

  const emptyServer = {
    getHealth: async () => ({ oldestLedger: 1, latestLedger: 1000 }),
    getEvents: async () => ({ events: [], cursor: "", latestLedger: 1000 }),
  };
  const base = {
    ...testnetConfig(),
    cursorFile,
    pollIntervalMs: 60_000,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 20,
  };

  const first = createPoller({ config: base, server: emptyServer, send: async () => {} });
  await first.start();
  try {
    const status = first.status();
    assert.equal(status.targets.find((t) => t.source === "market")?.cursor, saved.targets.market.cursor);
    assert.equal(status.targets.find((t) => t.source === "squad")?.cursor, saved.targets.squad.cursor);
    await new Promise((r) => setTimeout(r, 150));
    const onDisk = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.targets.market.cursor, saved.targets.market.cursor);
  } finally {
    first.stop();
  }

  // Reinitialising (restart) resumes the same cursors.
  const second = createPoller({ config: base, server: emptyServer, send: async () => {} });
  await second.start();
  try {
    const status = second.status();
    assert.equal(status.targets.find((t) => t.source === "market")?.cursor, saved.targets.market.cursor);
  } finally {
    second.stop();
  }
});

test("RPC failure leaves the cursor untouched and the poller recoverable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-rpcfail-"));
  const cursorFile = path.join(dir, "cursor.json");
  const failingServer = {
    getHealth: async () => { throw new Error("RPC unavailable"); },
    getEvents: async () => { throw new Error("unreachable"); },
  };
  const poller = createPoller({
    config: { ...testnetConfig(), cursorFile, pollIntervalMs: 60_000, startLookbackLedgers: 60, maxNotificationsPerCycle: 20 },
    server: failingServer,
    send: async () => { throw new Error("send must not be called with no events"); },
  });
  await poller.start();
  try {
    await new Promise((r) => setTimeout(r, 150));
    const status = poller.status();
    assert.equal(status.running, true);
    assert.ok(status.consecutiveFailures >= 1);
    assert.ok(status.lastError?.message.includes("RPC unavailable"));
    for (const t of status.targets) assert.equal(t.cursor, null, "failed RPC must not advance the cursor");
  } finally {
    poller.stop();
  }
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test("payloads and errors expose no tokens, keys, or unbounded remote objects", async () => {
  const config = { ...testnetConfig(), botToken: "123456:SECRET-TOKEN" };
  const sent = [];
  const fakeBot = { api: { sendMessage: async (...a) => { sent.push(a); return {}; } } };
  const text = formatEvent(config, claimChallengedEvent());
  await createNotifier(fakeBot, config)(text, undefined, { reply_markup: explorerKeyboard(config, claimChallengedEvent()) });
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes("SECRET-TOKEN"));
  assert.ok(wire.length < 10_000, "bounded payload");

  const decoded = decodeEvent("market", { topic: [], value: "x", ledger: 1, txHash: "", ledgerClosedAt: "", id: "e1" });
  assert.ok(JSON.stringify(decoded).length < 2000);
});
