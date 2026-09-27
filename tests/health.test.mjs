import assert from "node:assert/strict";
import test from "node:test";

import { createBot, healthMessage, registerCommands } from "../dist/bot.js";
import { buildHealthReport, startHealthServer } from "../dist/health.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 30_000,
    startupHealthRetryMs: 1_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    chainClockAt: 5_000,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test("buildHealthReport is ok for a fresh running poller", () => {
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500);
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
  assert.equal(report.service, "mimir-telegram-bot");
  assert.equal(report.network, "testnet");
  assert.equal(report.uptimeMs, 4_500);
  assert.equal(report.poller.channelPreviewMode, false);
  assert.equal(report.poller.targets[0].cursorPreview.endsWith("…"), true);
});

test("buildHealthReport reflects enabled channelPreviewMode", () => {
  const report = buildHealthReport(baseConfig({ channelPreviewMode: true }), baseStatus(), 5_500);
  assert.equal(report.poller.channelPreviewMode, true);
});


test("buildHealthReport is stopped when the poller is not running", () => {
  const report = buildHealthReport(baseConfig(), baseStatus({ running: false }), 5_500);
  assert.equal(report.ok, false);
  assert.equal(report.status, "stopped");
});

test("buildHealthReport treats an operator pause as healthy", () => {
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1 }),
    baseStatus({
      paused: true,
      lastSuccessAt: 1_000,
      consecutiveFailures: 10,
      targets: baseStatus().targets.map((target) => ({ ...target, cursorStale: true })),
    }),
    5_000,
  );
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
  assert.equal(report.poller.paused, true);
});

test("buildHealthReport alerts when one target has an unresolved stale cursor", () => {
  const target = { ...baseStatus().targets[0], cursorStale: true, rewindFromLedger: 40 };
  const status = baseStatus({ targets: [target] });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
  assert.equal(report.poller.targets[0].cursorStale, true);
  assert.match(healthMessage(baseConfig(), status, 5_500), /ALERT: stale cursor recovery from ledger 40/);
});

test("buildHealthReport is degraded after repeated failures", () => {
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({ consecutiveFailures: 10, lastSuccessAt: 5_000 }),
    5_500,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
});

test("buildHealthReport is degraded when success is stale", () => {
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1_000 }),
    baseStatus({ lastSuccessAt: 1_000 }),
    5_000,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
});

test("buildHealthReport never embeds bot token or chat id", () => {
  const config = baseConfig();
  const report = buildHealthReport(config, baseStatus(), 5_500);
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes(config.chatId), false);
  assert.equal(blob.includes("SECRET-TOKEN"), false);
});

test("buildHealthReport reports config provenance without any values", () => {
  const config = baseConfig();
  const report = buildHealthReport(config, baseStatus(), 5_500);

  // Names and origins only: enough to confirm which token and chat id are in
  // use, never enough to disclose either.
  assert.ok(report.config.entries.length > 0);
  const sources = new Set([
    "process-env",
    "env-file",
    "profile-default",
    "built-in-default",
    "derived",
    "unset",
  ]);
  for (const entry of report.config.entries) {
    assert.equal(typeof entry.key, "string");
    assert.ok(sources.has(entry.source), `${entry.key} has an unknown source`);
    assert.equal(typeof entry.secret, "boolean");
  }
  const token = report.config.entries.find((e) => e.key === "BOT_TOKEN");
  assert.ok(token, "the bot token's origin must be reported");
  assert.equal(token.secret, true);

  const blob = JSON.stringify(report.config);
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes(config.chatId), false);
});

test("buildHealthReport accepts injected provenance for a deterministic report", () => {
  const provenance = {
    profile: null,
    envFile: { present: false, suppliedKeys: 0 },
    entries: [{ key: "BOT_TOKEN", source: "process-env", secret: true }],
    counts: { "process-env": 1 },
    warnings: ["BOT_TOKEN is set but empty; nothing supplies the value"],
  };
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500, provenance);

  assert.deepEqual(report.config, provenance);
});

test("healthMessage names the configuration provenance without values", () => {
  const config = baseConfig();
  const text = healthMessage(config, baseStatus(), 5_500);

  assert.match(text, /Config: `profile=/);
  assert.equal(text.includes(config.botToken), false);
  assert.equal(text.includes("SECRET-TOKEN"), false);
  assert.equal(text.includes(config.chatId), false);
});

test("startHealthServer with HEALTH_PORT=0 does not bind", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 0 }),
    status: () => baseStatus(),
  });
  assert.equal(server.url, null);
  assert.equal(server.port, 0);
  await server.close();
});

test("GET /health returns 200 and redacted JSON for a healthy poller", async () => {
  const config = baseConfig({ healthPort: 0 });
  // Port 0 on listen means ephemeral — override after constructing deps.
  config.healthPort = 0;
  // Use ephemeral port via listen(0) by setting a non-zero request... we pass
  // healthPort: 0 to disable. Instead bind ephemeral explicitly:
  const listenConfig = baseConfig({ healthPort: 0 });
  // Force ephemeral: Node treats listen(0) as ephemeral. Our disable switch is
  // also 0, so we start with a high explicit port of 0 via a wrapper: use port
  // assignment by setting healthPort to an OS-picked value through listen —
  // startHealthServer uses config.healthPort===0 as disable, so pick port 0
  // disable path already tested. Use an ephemeral free port:
  const ephemeral = baseConfig({ healthPort: 18787 });
  const secret = ephemeral.botToken;
  const chat = ephemeral.chatId;
  let current = baseStatus();
  const server = startHealthServer({
    config: ephemeral,
    status: () => current,
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
    // Chain clock: baseStatus saw chain time at 5_000, the probe runs at 5_500.
    assert.equal(body.poller.chainClockAt, new Date(5_000).toISOString());
    assert.equal(body.poller.chainClockSkewMs, 500);
    const text = JSON.stringify(body);
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(chat), false);

    const live = await fetch(`${server.url}/health/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).status, "live");

    current = baseStatus({ running: false });
    const stopped = await fetch(`${server.url}/health`);
    assert.equal(stopped.status, 503);
    assert.equal((await stopped.json()).status, "stopped");

    const missing = await fetch(`${server.url}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("GET /health boundary: first boot before any success stays ok", () => {
  // No successful poll yet — do not mark degraded solely for a null lastSuccessAt.
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1_000 }),
    baseStatus({ lastSuccessAt: null, lastPollAt: null, cycles: 0 }),
    5_000,
  );
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
});

test("buildHealthReport surfaces a draining shutdown without calling it degraded", () => {
  // Stale success + repeated failures would be degraded for a running poller;
  // a deliberate drain is doing what it was told to do.
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1 }),
    baseStatus({
      stopping: true,
      pendingFlush: true,
      notificationsDropped: 3,
      lastFlushAt: 6_000,
      lastSuccessAt: 1_000,
      consecutiveFailures: 10,
    }),
    5_500,
  );

  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
  assert.equal(report.poller.stopping, true);
  assert.equal(report.poller.pendingFlush, true);
  assert.equal(report.poller.notificationsDropped, 3);
  assert.equal(report.poller.lastFlushAt, new Date(6_000).toISOString());
});

test("buildHealthReport reports stopped once a shutdown has finished", () => {
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({ running: false, stopping: true }),
    5_500,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "stopped");
  assert.equal(report.poller.stopping, true);
});

test("buildHealthReport fills in the shutdown fields when a status omits them", () => {
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500);
  assert.equal(report.poller.stopping, false);
  assert.equal(report.poller.pendingFlush, false);
  assert.equal(report.poller.notificationsDropped, 0);
  assert.equal(report.poller.lastFlushAt, null);
});

test("createBot /health command replies with exact MarkdownV2 payload for healthy poller", async () => {
  const config = baseConfig();
  const now = Date.now();
  const status = baseStatus({ lastSuccessAt: now, lastPollAt: now, startedAt: now - 1000 });
  const bot = createBot({ config, status: () => status });
  bot.botInfo = {
    id: 1000,
    is_bot: true,
    first_name: "TestBot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };

  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: 101, text: payload.text, chat: { id: payload.chat_id, type: "supergroup" }, date: 1700000000 } };
    }
    return { ok: true, result: true };
  });

  const update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1700000000,
      chat: { id: Number(config.chatId), type: "supergroup" },
      from: { id: 100, is_bot: false, first_name: "Tester" },
      text: "/health",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  };

  await bot.handleUpdate(update);

  assert.equal(sent.length, 1);
  assert.equal(String(sent[0].chat_id), config.chatId);
  assert.equal(sent[0].parse_mode, "MarkdownV2");
  assert.deepEqual(sent[0].link_preview_options, { is_disabled: true });

  const text = sent[0].text;
  assert.ok(text.includes("*Health* — OK on Stellar testnet"));
  assert.ok(text.includes("Status: `ok` \\(ok\\)"));
  assert.ok(text.includes("Poller: running"));
  assert.ok(text.includes("Chain tip: 42"));
  assert.doesNotMatch(text, /SECRET-TOKEN/);
});

test("createBot /health command reflects degraded status on RPC failure", async () => {
  const config = baseConfig();
  const status = baseStatus({
    consecutiveFailures: 5,
    lastError: { at: 5_000, message: "RPC endpoint timeout (504)" },
    targets: [
      {
        source: "market",
        contractId: config.marketContractId,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: "RPC endpoint timeout (504)",
      },
    ],
  });
  const bot = createBot({ config, status: () => status });
  bot.botInfo = {
    id: 1000,
    is_bot: true,
    first_name: "TestBot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };

  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: 102, text: payload.text, chat: { id: payload.chat_id, type: "supergroup" }, date: 1700000000 } };
    }
    return { ok: true, result: true };
  });

  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      date: 1700000000,
      chat: { id: Number(config.chatId), type: "supergroup" },
      from: { id: 100, is_bot: false, first_name: "Tester" },
      text: "/health",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  });

  assert.equal(sent.length, 1);
  const text = sent[0].text;
  assert.ok(text.includes("*Health* — DEGRADED on Stellar testnet"));
  assert.ok(text.includes("Status: `degraded` \\(action required\\)"));
  assert.ok(text.includes("consecutive failures: 5"));
  assert.ok(text.includes("RPC endpoint timeout \\(504\\)"));
});

test("createBot /health command reflects stopped status when poller is off", async () => {
  const config = baseConfig();
  const status = baseStatus({ running: false });
  const bot = createBot({ config, status: () => status });
  bot.botInfo = {
    id: 1000,
    is_bot: true,
    first_name: "TestBot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };

  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: 103, text: payload.text, chat: { id: payload.chat_id, type: "supergroup" }, date: 1700000000 } };
    }
    return { ok: true, result: true };
  });

  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      date: 1700000000,
      chat: { id: Number(config.chatId), type: "supergroup" },
      from: { id: 100, is_bot: false, first_name: "Tester" },
      text: "/health",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  });

  assert.equal(sent.length, 1);
  const text = sent[0].text;
  assert.ok(text.includes("*Health* — STOPPED on Stellar testnet"));
  assert.ok(text.includes("Poller: stopped"));
});

test("healthMessage escapes MarkdownV2 reserved characters in error messages", () => {
  const config = baseConfig();
  const status = baseStatus({
    consecutiveFailures: 3,
    lastError: { at: 5_000, message: "Error with _*[]()~`>#+-=|{}.! special characters" },
  });

  const msg = healthMessage(config, status, 5_500);
  assert.ok(msg.includes("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!"));
  assert.equal(msg.includes(config.botToken), false);
});

test("registerCommands registers /health command with setMyCommands", async () => {
  const calls = [];
  const fakeBot = {
    api: {
      setMyCommands: async (cmds) => {
        calls.push(cmds);
      },
    },
  };

  await registerCommands(fakeBot);
  assert.equal(calls.length, 1);
  const registered = calls[0];
  const healthCmd = registered.find((c) => c.command === "health");
  assert.ok(healthCmd);
  assert.equal(healthCmd.description, "Health assessment and operational readiness");
});

