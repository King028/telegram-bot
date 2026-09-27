/**
 * Allowlist tests for the /status command restriction.
 *
 * Coverage:
 *   - isChatAllowed semantics via the createBot command handler
 *   - Positive: allowed chat receives a reply
 *   - Negative: blocked chat receives no reply (silent ignore)
 *   - Boundary: empty allowedChatIds means any chat is allowed
 *   - Config parsing: ALLOWED_CHAT_IDS env var is parsed correctly
 *   - Config validation: malformed entries are rejected at boot
 *   - Regression: /start and /help are never gated by the allowlist
 */

import assert from "node:assert/strict";
import test from "node:test";

// Bot helpers live in dist/ — tests always run against the built output.
import { createBot } from "../dist/bot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal UserFromGetMe that grammy needs to avoid calling getMe().
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

// Valid Soroban contract ids: C + 55 uppercase base32 chars [A-Z2-7].
// These are syntactically valid (pass the regex) but are not real deployments.
const VALID_CONTRACT_MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const VALID_CONTRACT_SQUAD  = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

/**
 * Build a minimal BotConfig that satisfies createBot without a real token.
 * createBot builds a grammy Bot, but we never call bot.start(), so the token
 * is never validated against Telegram's API.
 */
function makeConfig(allowedChatIds = []) {
  return {
    botToken: "0:fake-token",
    chatId: "-1001234567890",
    allowedChatIds,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: VALID_CONTRACT_MARKET,
    squadContractId: VALID_CONTRACT_SQUAD,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
}

function makeStatus() {
  return {
    running: true,
    cycles: 0,
    latestLedger: 1000,
    oldestLedger: 900,
    lastPollAt: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

/**
 * Simulate a grammy update for a given command sent from a given chat id.
 * Collects calls to sendMessage (which ctx.reply delegates to) and returns them.
 *
 * botInfo is pre-populated so grammy never calls getMe() / the Telegram API.
 * The api middleware intercept captures all sendMessage calls.
 */
async function dispatchCommand(bot, command, chatId) {
  const replies = [];

  // Intercept at the api transport layer so we capture ctx.reply calls.
  // grammy's api middleware is a "before" transformer stack; we add one once
  // per dispatchCommand call and it fires for the duration of that call only.
  const transformer = async (prev, method, payload, signal) => {
    if (method === "sendMessage") {
      replies.push({ chatId: payload.chat_id, text: payload.text, options: payload });
      return { ok: true, result: { message_id: 1, chat: { id: payload.chat_id, type: "private" }, date: 0 } };
    }
    return prev(method, payload, signal);
  };
  bot.api.config.use(transformer);

  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "Tester" },
      text: `/${command}`,
      entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
    },
  };

  await bot.handleUpdate(update);
  return replies;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("allowed chat receives a /status reply when it is in the allowlist", async () => {
  const allowedId = -1001234567890;
  const config = makeConfig([String(allowedId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "status", allowedId);
  assert.equal(replies.length, 1, "expected exactly one reply to be sent");
  assert.ok(replies[0].text.includes("Status"), "reply should contain status content");
});

test("blocked chat receives no reply when it is not in the allowlist", async () => {
  const allowedId = -1001234567890;
  const blockedId = -9999999999;
  const config = makeConfig([String(allowedId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "status", blockedId);
  assert.equal(replies.length, 0, "expected no reply to be sent to a blocked chat");
});

test("empty allowedChatIds means any chat can use /status", async () => {
  const config = makeConfig([]); // empty = open
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const anyId = -9876543210;
  const replies = await dispatchCommand(bot, "status", anyId);
  assert.equal(replies.length, 1, "expected a reply when allowlist is empty");
});

test("/status works for a second allowed chat in a multi-entry allowlist", async () => {
  const firstId = -1001111111111;
  const secondId = -1002222222222;
  const config = makeConfig([String(firstId), String(secondId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const repliesFirst = await dispatchCommand(bot, "status", firstId);
  const repliesSecond = await dispatchCommand(bot, "status", secondId);
  assert.equal(repliesFirst.length, 1, "first allowed chat should get a reply");
  assert.equal(repliesSecond.length, 1, "second allowed chat should get a reply");
});

test("/status is blocked for a third chat not in the multi-entry allowlist", async () => {
  const firstId = -1001111111111;
  const secondId = -1002222222222;
  const thirdId = -1003333333333;
  const config = makeConfig([String(firstId), String(secondId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "status", thirdId);
  assert.equal(replies.length, 0, "third chat not in the list should get no reply");
});

test("regression: /start is never gated by the allowlist", async () => {
  const allowedId = -1001234567890;
  const otherChatId = -9999999999;
  const config = makeConfig([String(allowedId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "start", otherChatId);
  assert.equal(replies.length, 1, "/start should always reply regardless of allowlist");
});

test("regression: /help is never gated by the allowlist", async () => {
  const allowedId = -1001234567890;
  const otherChatId = -9999999999;
  const config = makeConfig([String(allowedId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "help", otherChatId);
  assert.equal(replies.length, 1, "/help should always reply regardless of allowlist");
});

test("/status reply does not include the bot token in its text", async () => {
  const chatId = -1001234567890;
  const config = makeConfig([String(chatId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "status", chatId);
  assert.equal(replies.length, 1);
  assert.ok(
    !replies[0].text.includes("fake-token"),
    "status reply must not leak the bot token",
  );
});

test("/status reply is sent with MarkdownV2 parse mode", async () => {
  const chatId = -1001234567890;
  const config = makeConfig([String(chatId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "status", chatId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].options.parse_mode, "MarkdownV2");
});

test("/status reply has link_preview disabled", async () => {
  const chatId = -1001234567890;
  const config = makeConfig([String(chatId)]);
  const bot = createBot({ config, status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatchCommand(bot, "status", chatId);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].options.link_preview_options, { is_disabled: true });
});

// ---------------------------------------------------------------------------
// Config parsing tests — these do NOT boot a real grammy Bot; they only check
// that the collector's allowedChatIds() method behaves correctly.
// ---------------------------------------------------------------------------

test("config: ALLOWED_CHAT_IDS absent produces empty allowedChatIds (open)", async () => {
  const { loadConfig } = await import("../dist/config.js");

  const saved = { ...process.env };
  process.env.BOT_TOKEN = "123:fake";
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.MARKET_CONTRACT_ID = VALID_CONTRACT_MARKET;
  process.env.SQUAD_CONTRACT_ID = VALID_CONTRACT_SQUAD;
  delete process.env.ALLOWED_CHAT_IDS;

  let config;
  try {
    config = loadConfig();
  } finally {
    // Restore env exactly
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }

  assert.deepEqual(config.allowedChatIds, [], "absent ALLOWED_CHAT_IDS should be []");
});

test("config: ALLOWED_CHAT_IDS empty string produces empty allowedChatIds (open)", async () => {
  const { loadConfig } = await import("../dist/config.js");

  const saved = { ...process.env };
  process.env.BOT_TOKEN = "123:fake";
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.MARKET_CONTRACT_ID = VALID_CONTRACT_MARKET;
  process.env.SQUAD_CONTRACT_ID = VALID_CONTRACT_SQUAD;
  process.env.ALLOWED_CHAT_IDS = "";

  let config;
  try {
    config = loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }

  assert.deepEqual(config.allowedChatIds, [], "empty ALLOWED_CHAT_IDS should be []");
});

test("config: ALLOWED_CHAT_IDS parses multiple ids correctly", async () => {
  const { loadConfig } = await import("../dist/config.js");

  const saved = { ...process.env };
  process.env.BOT_TOKEN = "123:fake";
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.MARKET_CONTRACT_ID = VALID_CONTRACT_MARKET;
  process.env.SQUAD_CONTRACT_ID = VALID_CONTRACT_SQUAD;
  process.env.ALLOWED_CHAT_IDS = "-1001234567890, -1009876543210, @mychannel";

  let config;
  try {
    config = loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }

  assert.deepEqual(config.allowedChatIds, ["-1001234567890", "-1009876543210", "@mychannel"]);
});

test("config: invalid entry in ALLOWED_CHAT_IDS throws ConfigError", async () => {
  const { loadConfig, ConfigError } = await import("../dist/config.js");

  const saved = { ...process.env };
  process.env.BOT_TOKEN = "123:fake";
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.MARKET_CONTRACT_ID = VALID_CONTRACT_MARKET;
  process.env.SQUAD_CONTRACT_ID = VALID_CONTRACT_SQUAD;
  process.env.ALLOWED_CHAT_IDS = "not-a-valid-id";

  let threw = false;
  try {
    loadConfig();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof ConfigError, "should throw ConfigError for invalid entry");
    assert.ok(
      err.problems.some((p) => p.includes("not-a-valid-id")),
      "problem message should name the bad value",
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }

  assert.ok(threw, "expected ConfigError to be thrown");
});

test("config: single numeric id (positive) is valid", async () => {
  const { loadConfig } = await import("../dist/config.js");

  const saved = { ...process.env };
  process.env.BOT_TOKEN = "123:fake";
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.MARKET_CONTRACT_ID = VALID_CONTRACT_MARKET;
  process.env.SQUAD_CONTRACT_ID = VALID_CONTRACT_SQUAD;
  process.env.ALLOWED_CHAT_IDS = "123456789";

  let config;
  try {
    config = loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }

  assert.deepEqual(config.allowedChatIds, ["123456789"]);
});
