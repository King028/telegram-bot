import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { escapeMd, formatEvent } from "../dist/notifications/format.js";
import { formatUsdc } from "../dist/stellar/decode.js";

const reserved = "_*[]()~`>#+-=|{}.\\!";
const reservedSet = new Set(Array.from(reserved));

function expectedEscape(value) {
  return Array.from(value, (char) =>
    reservedSet.has(char) ? `\\${char}` : char,
  ).join("");
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("formatUsdc always renders all seven Stellar USDC decimals", () => {
  const cases = [
    [0n, "0.0000000"],
    [1n, "0.0000001"],
    [10_000_000n, "1.0000000"],
    [20_000_000n, "2.0000000"],
    [12_345_678n, "1.2345678"],
    [-1n, "-0.0000001"],
    [-12_345_678n, "-1.2345678"],
    [123_456_789_012_345_678_901_234_567n, "12345678901234567890.1234567"],
  ];

  for (const [units, expected] of cases) {
    assert.equal(formatUsdc(units), expected, String(units));
  }
});

test("formatted money notifications keep explicit decimals and escape the decimal point", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 43,
    txHash: "",
    at: 0,
    eventId: "43-0",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
  };

  const message = formatEvent(config, event);
  assert.match(message, /Stake: \*2\\\.0000000 USDC\*/);
});

test("unknown or malformed decoded events stay non-notifying", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 44,
    txHash: "",
    at: 0,
    eventId: "44-0",
    payload: { name: "unknown", eventName: "claim_challenged", reason: "malformed amount" },
  };

  assert.equal(formatEvent(config, event), null);
});

test("escapeMd escapes every MarkdownV2 reserved character exactly once", () => {
  assert.equal(escapeMd(reserved), expectedEscape(reserved));
  assert.equal(escapeMd("plain café 🛰️\nnext line"), "plain café 🛰️\nnext line");
});

test("escapeMd matches the character-wise rule for deterministic fuzz inputs", () => {
  const alphabet = Array.from(`${reserved}abcXYZ09 café\n\r\t\0🛰️e\u0301`);
  const random = seededRandom(0x5eedc0de);

  for (let sample = 0; sample < 1000; sample += 1) {
    const length = Math.floor(random() * 257);
    let input = "";
    for (let index = 0; index < length; index += 1) {
      input += alphabet[Math.floor(random() * alphabet.length)];
    }
    assert.equal(escapeMd(input), expectedEscape(input), `sample ${sample}`);
  }
});

test("formatted untrusted event text reaches Telegram as exact MarkdownV2", async () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "claim_created",
      claimId: 7,
      creator: "GABCD",
      category: reserved,
    },
  };
  const message = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${expectedEscape(reserved)}\n` +
    "Creator: `GABCD`\n_ledger 42_";
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  assert.equal(message, expectedMessage);
  await createNotifier(fakeBot, config)(message);
  assert.deepEqual(sent, [
    [
      config.chatId,
      expectedMessage,
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      },
    ],
  ]);
});

test("oversized event fields are clipped safely before MarkdownV2 escaping", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const category = `${"a".repeat(199)}🛰️`;
  const event = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "x".repeat(129),
    at: 0,
    eventId: "42-0",
    payload: { name: "claim_created", claimId: 7, creator: "GABCD", category },
  };

  const message = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${"a".repeat(199)}…\n` +
    "Creator: `GABCD`\n_ledger 42_";

  assert.equal(message, expectedMessage);
  assert.equal(message.length < 4096, true);
});

test("oversized squad questions are clipped without splitting emoji", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "squad",
    contractId: "squad",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "market_created",
      marketId: 7,
      captain: "GABCD",
      deadline: 1_800_000_000,
      feeBps: 25,
      question: `${"q".repeat(199)}🛰️`,
    },
  };

  const message = formatEvent(config, event);
  assert.match(message, new RegExp(`\\n${"q".repeat(199)}…\\n`));
  assert.equal(message.includes("🛰️"), false);
});

test("createNotifier preserves Telegram send failures for the poller", async () => {
  const error = new Error("Telegram API unavailable");
  const fakeBot = { api: { sendMessage: async () => Promise.reject(error) } };
  const notify = createNotifier(fakeBot, { chatId: "-1001234567890" });
  await assert.rejects(notify("message"), error);
});

test("createNotifier routes named contract sources and preserves the legacy fallback", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };
  const notify = createNotifier(fakeBot, {
    chatId: "-1001234567890",
    marketChatId: "-1001111111111",
    squadChatId: "@mimir_squad",
  });

  await notify("market event", "market");
  await notify("squad event", "squad");
  await notify("legacy event");

  assert.deepEqual(sent.map(([chatId, text]) => [chatId, text]), [
    ["-1001111111111", "market event"],
    ["@mimir_squad", "squad event"],
    ["-1001234567890", "legacy event"],
  ]);
});

test("escapeMd handles a long adversarial string without dropping characters", () => {
  const input = reserved.repeat(10_000);
  const escaped = escapeMd(input);
  assert.equal(escaped, expectedEscape(input));
});

test("txExplorerUrl is centralized and network-aware", async () => {
  const { txExplorerUrl, accountExplorerUrl, contractExplorerUrl, DEFAULT_EXPLORER_BASE_URL } =
    await import("../dist/stellar/client.js");

  const testnet = {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: DEFAULT_EXPLORER_BASE_URL,
  };
  assert.equal(
    txExplorerUrl(testnet, "abcd"),
    "https://stellar.expert/explorer/testnet/tx/abcd",
  );
  assert.equal(
    accountExplorerUrl(testnet, "G" + "A".repeat(55)),
    "https://stellar.expert/explorer/testnet/account/G" + "A".repeat(55),
  );
  assert.equal(
    contractExplorerUrl(testnet, testnet.marketContractId),
    `https://stellar.expert/explorer/testnet/contract/${testnet.marketContractId}`,
  );

  const pub = {
    ...testnet,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  };
  assert.equal(
    txExplorerUrl(pub, "ffff"),
    "https://stellar.expert/explorer/public/tx/ffff",
  );

  const custom = { ...testnet, explorerBaseUrl: "https://example.test/x/" };
  assert.equal(txExplorerUrl(custom, "zz"), "https://example.test/x/testnet/tx/zz");
  assert.equal(txExplorerUrl(testnet, "  "), "");
});

test("formatEvent prefixes message with [PREVIEW MODE] when channelPreviewMode is enabled", async () => {
  const { formatEvent } = await import("../dist/notifications/format.js");
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    channelPreviewMode: true,
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 100,
    txHash: "hash123",
    at: 0,
    eventId: "100-0",
    payload: {
      name: "claim_created",
      claimId: 5,
      creator: "GABCD",
      category: "sports",
    },
  };
  const message = formatEvent(config, event);
  assert.match(message, /^🧪 \*\[PREVIEW MODE\]\*\n🆕 \*New claim\*/);
});

test("formatFallbackEvent formats actionable degraded event notification with redacted reason", async () => {
  const { formatFallbackEvent } = await import("../dist/notifications/format.js");
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
  const event = {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 200,
    txHash: "hash456",
    at: 0,
    eventId: "200-0",
    payload: { name: "unknown" },
  };
  const fallback = formatFallbackEvent(config, event, "corrupt payload 123456789:SECRET-TOKEN-ABCD");
  assert.match(fallback, /⚠️ \*Event Notification Fallback\*/);
  assert.equal(fallback.includes("SECRET-TOKEN"), false);
});

