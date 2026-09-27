import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditEntry, createAuditLog } from "../dist/audit.js";
import {
  registerCommandHandlers,
  resumeMessage,
} from "../dist/bot.js";
import { safeErrorMessage } from "../dist/notifications/format.js";

const TELEGRAM_OPTIONS = {
  parse_mode: "MarkdownV2",
  link_preview_options: { is_disabled: true },
};

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

function mockedBot(deps) {
  const handlers = new Map();
  const bot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerCommandHandlers(bot, deps);
  return { bot, handlers };
}

function commandContext(userId, updateId = 1) {
  const replies = [];
  return {
    ctx: {
      from: { id: userId },
      update: { update_id: updateId },
      reply: async (...args) => {
        replies.push(args);
      },
    },
    replies,
  };
}

async function withoutWarnings(fn) {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

test("operator /resume sends the exact MarkdownV2 payload and calls poller resume", async () => {
  let resumeCalls = 0;
  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus({ paused: true }),
    pause: () => "paused",
    resume: () => {
      resumeCalls += 1;
      return "resumed";
    },
  });
  const { ctx, replies } = commandContext(42, 72);

  await handlers.get("resume")(ctx);

  assert.equal(resumeCalls, 1);
  assert.deepEqual(replies, [
    [
      "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.",
      TELEGRAM_OPTIONS,
    ],
  ]);
});

test("non-operator /resume is ignored without mutating state or replying", async () => {
  let resumeCalls = 0;
  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => {
      resumeCalls += 1;
      return "resumed";
    },
  });
  const { ctx, replies } = commandContext(43, 73);

  await withoutWarnings(() => handlers.get("resume")(ctx));

  assert.equal(resumeCalls, 0);
  assert.deepEqual(replies, []);
});

test("operator controls are disabled when no operator id is configured", async () => {
  let calls = 0;
  const { handlers } = mockedBot({
    config: baseConfig({ operatorTelegramUserId: null }),
    status: () => baseStatus(),
    pause: () => {
      calls += 1;
      return "paused";
    },
    resume: () => {
      calls += 1;
      return "resumed";
    },
  });
  const { ctx, replies } = commandContext(42, 74);

  await withoutWarnings(async () => {
    await handlers.get("pause")(ctx);
    await handlers.get("resume")(ctx);
  });

  assert.equal(calls, 0);
  assert.deepEqual(replies, []);
});

test("operator /audit renders the report from the live in-memory window", async () => {
  const auditFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mimir-audit-gate-")),
    "audit.jsonl",
  );
  const audit = createAuditLog();
  audit.record(auditEntry("boot", { detail: "test boot entry" }));

  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    audit,
    auditFile,
  });
  const { ctx, replies } = commandContext(42, 81);

  await handlers.get("audit")(ctx);

  assert.equal(replies.length, 1);
  const [text, options] = replies[0];
  assert.match(text, /^\*Audit\* — /);
  assert.match(text, /boot/);
  assert.equal(options.parse_mode, undefined);

  fs.rmSync(path.dirname(auditFile), { recursive: true, force: true });
});

test("non-operator /audit is silently ignored without reading the file or replying", async () => {
  const auditFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mimir-audit-gate-")),
    "audit.jsonl",
  );
  let auditReadCalls = 0;
  const audit = {
    record: () => undefined,
    tail: () => {
      auditReadCalls += 1;
      return [];
    },
    flush: () => [],
  };

  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    audit,
    auditFile,
  });
  const { ctx, replies } = commandContext(43, 82);

  await withoutWarnings(() => handlers.get("audit")(ctx));

  assert.deepEqual(replies, []);
  assert.equal(auditReadCalls, 0);

  fs.rmSync(path.dirname(auditFile), { recursive: true, force: true });
});

test("operator controls disabled means /audit is ignored even for the right user id", async () => {
  const { handlers } = mockedBot({
    config: baseConfig({ operatorTelegramUserId: null }),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });
  const { ctx, replies } = commandContext(42, 83);

  await withoutWarnings(() => handlers.get("audit")(ctx));

  assert.deepEqual(replies, []);
});

test("idempotent and shutdown resume results have bounded exact replies", () => {
  assert.equal(resumeMessage("already-running"), "*Polling is already running*");
  assert.equal(
    resumeMessage("stopped"),
    "*Polling cannot resume* — the process is stopping\\.",
  );
});

test("safeErrorMessage redacts Telegram-shaped tokens and clips remote payloads", () => {
  const configuredToken = "123456789:CONFIGURED-TOKEN-ABCDEFGHIJKLMN";
  const upstreamToken = "987654321:UPSTREAM-TOKEN-ZYXWVUTSRQPON";
  const message = safeErrorMessage(
    new Error(`${configuredToken} ${upstreamToken} ${"remote-payload".repeat(100)}`),
    [configuredToken],
  );

  assert.equal(message.includes(configuredToken), false);
  assert.equal(message.includes(upstreamToken), false);
  assert.equal(message.length, 240);
  assert.match(message, /^\[REDACTED] \[REDACTED] remote-payload/);
});

test("/preview command sends exact MarkdownV2 preview payload for market and squad", async () => {
  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  let marketReplied = false;
  const ctxMarket = {
    message: { text: "/preview market" },
    update: { update_id: 101 },
    reply: async (...args) => {
      marketReplied = true;
      assert.match(args[0], /🧪 \*Channel Preview — mimir\\-market\*/);
      assert.deepEqual(args[1], TELEGRAM_OPTIONS);
    },
  };
  await handlers.get("preview")(ctxMarket);
  assert.equal(marketReplied, true);

  let squadReplied = false;
  const ctxSquad = {
    message: { text: "/preview squad" },
    update: { update_id: 102 },
    reply: async (...args) => {
      squadReplied = true;
      assert.match(args[0], /🧪 \*Channel Preview — mimir\\-squad\*/);
      assert.deepEqual(args[1], TELEGRAM_OPTIONS);
    },
  };
  await handlers.get("preview")(ctxSquad);
  assert.equal(squadReplied, true);
});

