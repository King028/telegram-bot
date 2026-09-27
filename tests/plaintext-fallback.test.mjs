import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GrammyError } from "grammy";

import { createNotifier, isMarkdownParseError } from "../dist/bot.js";
import {
  formatEvent,
  formatPlainTextEvent,
} from "../dist/notifications/format.js";
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
    pollIntervalMs: 60_000,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 20,
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
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
    ...overrides,
  };
}

/** Real grammy error shape for a MarkdownV2 entity rejection. */
function parseError() {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities: character '.' is reserved and must be escaped with a preceding '\\'" },
    "sendMessage",
    {},
  );
}

function collectingBot(behavior) {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return behavior(sent.length, args);
      },
    },
  };
  return { fakeBot, sent };
}

// ── Classifier ───────────────────────────────────────────────────────────────

test("isMarkdownParseError matches only Telegram entity-parse failures", () => {
  assert.equal(isMarkdownParseError(parseError()), true);
  // Duck-typed Bot API error without the class.
  assert.equal(
    isMarkdownParseError({ error_code: 400, description: "Bad Request: can't find end of the entity starting at byte offset 5" }),
    true,
  );
  // grammy embeds code+description in message; still matches without error_code.
  assert.equal(isMarkdownParseError(new Error("Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: bad)")), true);

  const notParse = [
    new Error("Too Many Requests: retry after 35"),
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 429, description: "Too Many Requests: retry after 35" }, "sendMessage", {}),
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 401, description: "Unauthorized" }, "sendMessage", {}),
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: "Bad Request: message is too long" }, "sendMessage", {}),
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "sendMessage", {}),
    { name: "HttpError", message: "Network request for 'sendMessage' failed!" },
    null,
    undefined,
    "can't parse entities",
    { error_code: 400 },
    { description: "can't parse entities" , error_code: 200 },
  ];
  for (const err of notParse) {
    assert.equal(isMarkdownParseError(err), false, String(err && err.description ? err.description : err));
  }
});

// ── Positive ─────────────────────────────────────────────────────────────────

test("valid MarkdownV2 notification sends once with the exact legacy payload", async () => {
  const config = testnetConfig();
  const text = formatEvent(config, claimChallengedEvent());
  const { fakeBot, sent } = collectingBot(async () => ({}));

  await createNotifier(fakeBot, config)(text, "market", { plainText: "unused fallback" });

  assert.equal(sent.length, 1, "no fallback when MarkdownV2 succeeds");
  assert.deepEqual(sent, [
    [config.chatId, text, { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } }],
  ]);
});

test("MarkdownV2 parse failure triggers exactly one plain-text fallback", async () => {
  const config = testnetConfig();
  const event = claimChallengedEvent();
  const text = formatEvent(config, event);
  const plain = formatPlainTextEvent(config, event);
  const err = parseError();
  const { fakeBot, sent } = collectingBot(async (n) => {
    if (n === 1) throw err;
    return {};
  });

  await createNotifier(fakeBot, config)(text, "market", { plainText: plain });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], [config.chatId, text, { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } }]);
  // Fallback snapshot: same chat, plain body, NO parse_mode.
  assert.deepEqual(sent[1], [config.chatId, plain, { link_preview_options: { is_disabled: true } }]);
});

test("fallback keeps the explorer button when one was attached", async () => {
  const config = testnetConfig();
  const keyboard = { inline_keyboard: [[{ text: "View on Explorer", url: "https://example.invalid/x" }]] };
  const { fakeBot, sent } = collectingBot(async (n) => {
    if (n === 1) throw parseError();
    return {};
  });

  await createNotifier(fakeBot, config)("md", "market", { reply_markup: keyboard, plainText: "plain" });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1][2], { link_preview_options: { is_disabled: true }, reply_markup: keyboard });
});

test("plain-text formatter carries the same information without MarkdownV2 syntax", () => {
  const config = testnetConfig();
  const plain = formatPlainTextEvent(config, claimChallengedEvent());
  assert.equal(
    plain,
    `Claim #7 challenged\n` +
      `Stake: 2.0000000 USDC\n` +
      `Challenger: GABCD\n` +
      `ledger 4226692\n` +
      `tx: https://stellar.expert/explorer/testnet/tx/${VALID_TX}`,
  );
  assert.ok(!plain.includes("*"), "no emphasis markup");
  assert.ok(!plain.includes("`"), "no code markup");
  assert.ok(!plain.includes("[tx]("), "no Markdown link syntax");
  assert.ok(!plain.includes("\\#"), "no MarkdownV2 escapes");
});

// ── Negative ─────────────────────────────────────────────────────────────────

test("plain-text fallback failure is surfaced (second error propagates)", async () => {
  const first = parseError();
  const second = new Error("socket hang up");
  const { fakeBot, sent } = collectingBot(async (n) => {
    throw n === 1 ? first : second;
  });

  await assert.rejects(createNotifier(fakeBot, testnetConfig())("md", "market", { plainText: "plain" }), (err) => {
    assert.equal(err, second);
    return true;
  });
  assert.equal(sent.length, 2);
});

test("unrelated Telegram errors never trigger the fallback", async () => {
  const failures = [
    Object.assign(new Error("Too Many Requests: retry after 35"), { error_code: 429 }),
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 401, description: "Unauthorized" }, "sendMessage", {}),
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "sendMessage", {}),
    new Error("socket hang up"),
  ];
  for (const failure of failures) {
    let calls = 0;
    const fakeBot = { api: { sendMessage: async () => { calls += 1; throw failure; } } };
    await assert.rejects(
      createNotifier(fakeBot, testnetConfig())("md", "market", { plainText: "plain" }),
      (err) => err === failure,
    );
    assert.equal(calls, 1, `fallback must not fire for: ${failure.message}`);
  }
});

test("parse failure without a plain-text alternative propagates unchanged (legacy path)", async () => {
  const err = parseError();
  let calls = 0;
  const fakeBot = { api: { sendMessage: async () => { calls += 1; throw err; } } };
  await assert.rejects(createNotifier(fakeBot, testnetConfig())("md"), (e) => e === err);
  assert.equal(calls, 1);
});

test("malformed notification data never crashes the plain-text formatter", () => {
  const config = testnetConfig();
  // Unknown payloads stay non-notifying, like formatEvent.
  assert.equal(formatPlainTextEvent(config, { ...claimChallengedEvent(), payload: { name: "unknown", eventName: "x" } }), null);
  // Throwing payload access degrades to a minimal bounded line.
  const evil = { ...claimChallengedEvent() };
  Object.defineProperty(evil, "payload", { get() { throw new Error("boom"); } });
  const minimal = formatPlainTextEvent(config, evil);
  assert.ok(typeof minimal === "string" && minimal.length > 0 && minimal.length <= 4000);
  assert.ok(minimal.includes("4226692"));
});

// ── Boundary ─────────────────────────────────────────────────────────────────

test("MarkdownV2-special characters arrive literally in plain text", () => {
  const config = testnetConfig();
  const reserved = "_*[]()~`>#+-=|{}.!\\";
  const event = claimChallengedEvent({
    payload: { name: "claim_created", claimId: 9, creator: "GABCD", category: reserved },
  });
  const plain = formatPlainTextEvent(config, event);
  assert.ok(plain.includes(`Category: ${reserved}`), "no escaping in plain text");
  const md = formatEvent(config, event);
  assert.ok(md.includes("\\_\\*"), "MarkdownV2 path still escapes");
});

test("valid explorer URL is kept, invalid or missing hash drops the tx line", () => {
  const config = testnetConfig();
  assert.ok(formatPlainTextEvent(config, claimChallengedEvent()).includes(`tx: https://stellar.expert/explorer/testnet/tx/${VALID_TX}`));

  for (const txHash of ["", "   ", "short", `${VALID_TX}ff`, undefined]) {
    const plain = formatPlainTextEvent(config, claimChallengedEvent({ txHash }));
    assert.ok(typeof plain === "string" && plain.includes("ledger 4226692"));
    assert.ok(!plain.includes("tx:"), `no tx line for ${String(txHash)}`);
  }
});

test("long but bounded content is clipped to the plain-text ceiling", () => {
  const config = testnetConfig();
  const event = claimChallengedEvent({
    payload: { name: "claim_resolved", claimId: 1, winnerSide: 1, summary: "X".repeat(20_000), confidence: 50, evidenceHash: "00" },
  });
  const plain = formatPlainTextEvent(config, event);
  assert.ok(plain.length <= 4000);
  assert.ok(plain.includes("…"));
  assert.ok(plain.includes("resolved"));
});

// ── Regression: poller integration + cursor ──────────────────────────────────

test("poller falls back to plain text on parse errors and still advances the cursor", async () => {
  const { nativeToScVal, xdr } = await import("@stellar/stellar-sdk");
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-fallback-"));
  const cursorFile = path.join(dir, "cursor.json");
  const ledger = 4226692;
  const cursor = `${(BigInt(ledger) << 32n).toString()}-0000000001`;
  const txHash = VALID_TX;

  // Real decodable wire shape: claim_cancelled needs only topic[1] (u64 id).
  const rawEvent = {
    id: cursor,
    type: "contract",
    ledger,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash,
    contractId: "market",
    topic: [xdr.ScVal.scvString("claim_cancelled"), nativeToScVal(7, { type: "u64" })],
    value: xdr.ScVal.scvVoid(),
  };
  const server = {
    getHealth: async () => ({ oldestLedger: 1, latestLedger: ledger }),
    getEvents: async () => ({ events: [rawEvent], cursor, latestLedger: ledger }),
  };

  // Telegram rejects the MarkdownV2 render, accepts the plain-text retry.
  const delivered = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId, text, options) => {
        delivered.push([chatId, text, options]);
        if (options?.parse_mode === "MarkdownV2") throw parseError();
        return {};
      },
    },
  };
  const notify = createNotifier(fakeBot, testnetConfig());
  const poller = createPoller({
    config: { ...testnetConfig(), cursorFile, statusFile: path.join(dir, "status.json") },
    server,
    send: (text, source, extra) => notify(text, source, extra),
  });
  await poller.start();
  try {
    const deadline = Date.now() + 8000;
    let status = poller.status();
    while (status.notificationsSent < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      status = poller.status();
    }
    // Cursor commit happens after notify() returns (post-send spacing sleep).
    const cursorDeadline = Date.now() + 8000;
    status = poller.status();
    while (status.targets.find((t) => t.source === "market")?.cursor === null && Date.now() < cursorDeadline) {
      await new Promise((r) => setTimeout(r, 50));
      status = poller.status();
    }
    assert.equal(status.notificationsSent, 1, "fallback delivery counts as sent");
    assert.equal(status.notificationsFailed, 0);
    assert.equal(delivered.length, 2, "MarkdownV2 attempt + exactly one plain-text retry");
    assert.equal(delivered[0][2]?.parse_mode, "MarkdownV2");
    assert.ok(!("parse_mode" in (delivered[1][2] ?? {})), "fallback carries no parse_mode");
    assert.ok(delivered[1][1].includes("cancelled"), "fallback text notifies the event");
    assert.equal(
      status.targets.find((t) => t.source === "market")?.cursor,
      cursor,
      "cursor advances on fallback success exactly as on a direct send",
    );
  } finally {
    poller.stop();
  }
});

test("notifier failure still rejects so the poller counts it (no silent loss)", async () => {
  const err = new Error("socket hang up");
  const fakeBot = { api: { sendMessage: async () => { throw err; } } };
  await assert.rejects(createNotifier(fakeBot, testnetConfig())("md", "market", { plainText: "plain" }), (e) => e === err);
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test("fallback payloads expose no tokens or unbounded content", async () => {
  const config = { ...testnetConfig(), botToken: "123456:SECRET-TOKEN" };
  const { fakeBot, sent } = collectingBot(async (n) => {
    if (n === 1) throw parseError();
    return {};
  });
  const event = claimChallengedEvent();
  await createNotifier(fakeBot, config)(formatEvent(config, event), "market", {
    plainText: formatPlainTextEvent(config, event),
  });
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes("SECRET-TOKEN"));
  assert.ok(wire.length < 10_000, "bounded payload");
});
