import assert from "node:assert/strict";
import test from "node:test";

import { createBot, contractsMessage, registerCommands } from "../dist/bot.js";

const MARKET_ID = "C".padEnd(56, "M");
const SQUAD_ID = "C".padEnd(56, "S");

function fakeConfig(overrides = {}) {
  return {
    botToken: "TEST_TOKEN",
    chatId: "-1001234567890",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    ...overrides,
  };
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

/** A bot wired to createBot(), pre-initialized, with sendMessage calls captured instead of sent. */
function harness(config, status = () => {
  throw new Error("status() should not be called by /contracts");
}) {
  const bot = createBot({ config, status });
  bot.botInfo = BOT_INFO;

  const sent = [];
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return Promise.resolve({ ok: true, result: {} });
    }
    return prev(method, payload, signal);
  });

  return { bot, sent };
}

function commandUpdate(text, updateId = 1) {
  // The bot_command entity covers the whole "/command" or "/command@username"
  // token — up to the first space, exactly like Telegram itself sends it.
  const spaceIndex = text.indexOf(" ");
  const commandLength = spaceIndex === -1 ? text.length : spaceIndex;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: -1001234567890, type: "supergroup" },
      from: { id: 42, is_bot: false, first_name: "U" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: commandLength }],
    },
  };
}

// ── positive ─────────────────────────────────────────────────────────────────

test("contractsMessage renders both contract ids, testnet explorer links, and the read-only note", () => {
  const config = fakeConfig();
  const message = contractsMessage(config);

  assert.equal(
    message,
    "*Contracts* — Mimir on Stellar testnet\n" +
      "\n" +
      "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.\n" +
      "\n" +
      "*mimir\\-market*\n" +
      `\`${MARKET_ID}\`\n` +
      `[View on stellar\\.expert](https://stellar.expert/explorer/testnet/contract/${MARKET_ID})\n` +
      "\n" +
      "*mimir\\-squad*\n" +
      `\`${SQUAD_ID}\`\n` +
      `[View on stellar\\.expert](https://stellar.expert/explorer/testnet/contract/${SQUAD_ID})`,
  );
});

test("contractsMessage switches to the public explorer on the public network passphrase", () => {
  const config = fakeConfig({
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  });
  const message = contractsMessage(config);

  assert.match(message, /Mimir on Stellar public/);
  assert.match(
    message,
    new RegExp(`stellar\\.expert/explorer/public/contract/${MARKET_ID}`),
  );
  assert.doesNotMatch(message, /explorer\/testnet/);
});

test("/contracts reaches Telegram as the exact MarkdownV2 payload, unaffected by poller status", async () => {
  const config = fakeConfig();
  const { bot, sent } = harness(config);

  await bot.handleUpdate(commandUpdate("/contracts"));

  // ctx.reply targets the chat the update came from (a number here), not
  // config.chatId (used only by the poller's separate createNotifier path).
  // Compare the fields this handler controls rather than the whole payload:
  // grammy's Api layer adds its own undefined-valued fields to the object.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, -1001234567890);
  assert.equal(sent[0].text, contractsMessage(config));
  assert.equal(sent[0].parse_mode, "MarkdownV2");
  assert.deepEqual(sent[0].link_preview_options, { is_disabled: true });
});

// ── negative ─────────────────────────────────────────────────────────────────

test("plain text that is not a command sends nothing", async () => {
  const config = fakeConfig();
  const { bot, sent } = harness(config);

  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 0,
      chat: { id: -1001234567890, type: "supergroup" },
      from: { id: 42, is_bot: false, first_name: "U" },
      text: "contracts", // no leading slash, no entity
    },
  });

  assert.deepEqual(sent, []);
});

test("/contracts@another_bot (addressed to a different bot) is not handled here", async () => {
  const config = fakeConfig();
  const { bot, sent } = harness(config);

  await bot.handleUpdate(commandUpdate("/contracts@some_other_bot"));

  assert.deepEqual(sent, []);
});

// ── boundary ─────────────────────────────────────────────────────────────────

test("/contracts with trailing arguments still returns the plain contracts message", async () => {
  const config = fakeConfig();
  const { bot, sent } = harness(config);

  await bot.handleUpdate(commandUpdate("/contracts market please"));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, contractsMessage(config));
});

test("/contracts@<this bot's username> is matched the same as the bare command", async () => {
  const config = fakeConfig();
  const { bot, sent } = harness(config);

  await bot.handleUpdate(commandUpdate(`/contracts@${BOT_INFO.username}`));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, contractsMessage(config));
});

test("contractsMessage escapes a contract id that (unexpectedly) contains MarkdownV2 reserved characters", () => {
  // CONTRACT_ID_RE in config.ts rejects this at startup, but the formatter
  // must not assume that guarantee reaches it unchanged — defense in depth.
  const config = fakeConfig({ marketContractId: "C.evil*id" });
  const message = contractsMessage(config);

  assert.match(message, /`C\\\.evil\\\*id`/);
});

// ── restart / regression ─────────────────────────────────────────────────────

test("contractsMessage is pure: identical config always yields an identical message across calls", () => {
  const config = fakeConfig();
  const first = contractsMessage(config);
  const second = contractsMessage(config);
  assert.equal(first, second);
});

test("/contracts answers identically before and after a simulated poller restart (status() never touched)", async () => {
  const config = fakeConfig();
  let statusCalls = 0;
  const { bot, sent } = harness(config, () => {
    statusCalls += 1;
    throw new Error("status() should not be called by /contracts");
  });

  await bot.handleUpdate(commandUpdate("/contracts", 10));
  // Simulate the poller having restarted between the two calls; /contracts
  // depends only on static config, so this must not matter.
  await bot.handleUpdate(commandUpdate("/contracts", 11));

  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, sent[1].text);
  assert.equal(statusCalls, 0);
});

test("registerCommands includes /contracts alongside the existing commands", async () => {
  const config = fakeConfig();
  const { bot } = harness(config);
  const calls = [];
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === "setMyCommands") {
      calls.push(payload);
      return Promise.resolve({ ok: true, result: true });
    }
    return prev(method, payload, signal);
  });

  await registerCommands(bot);

  assert.equal(calls.length, 1);
  const commands = calls[0].commands.map((c) => c.command);
  assert.deepEqual(commands, ["start", "help", "status", "audit", "contracts", "health", "preview", "pause", "resume"]);
});
