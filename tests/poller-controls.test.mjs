import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const CURSOR_FILE = JSON.stringify({
  version: 1,
  updatedAt: "2026-09-24T00:00:00.000Z",
  targets: {
    market: { cursor: "123-0", lastEventLedger: 40 },
    squad: { cursor: "456-0", lastEventLedger: 41 },
  },
});

function baseConfig(cursorFile) {
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
    pollIntervalMs: 5_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

function stuckServer() {
  return {
    getHealth: async () => new Promise(() => undefined),
  };
}

async function waitForFailedCycle(poller) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (poller.status().consecutiveFailures > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("poller failure cycle did not finish");
}

test("pause/resume is bounded during an in-flight scan and restart reloads version-1 cursors", async () => {
  const dataDir = await createTempDataDir("mimir-resume-");
  const cursorFile = dataDir.file("cursor.json");
  await writeFile(cursorFile, CURSOR_FILE, "utf8");

  const first = createPoller({
    config: baseConfig(cursorFile),
    server: stuckServer(),
    send: async () => undefined,
  });

  try {
    await first.start();
    assert.equal(first.status().paused, false);
    assert.equal(first.status().running, true);
    assert.equal(first.status().targets[0].cursor, "123-0");

    assert.equal(first.pause(), "paused");
    assert.equal(first.status().paused, true);
    assert.equal(first.pause(), "already-paused");
    assert.equal(first.resume(), "resumed");
    assert.equal(first.status().paused, false);
    assert.equal(first.resume(), "already-running");

    // Operator control never rewrites the version-1 cursor compatibility shape.
    assert.equal(JSON.parse(await readFile(cursorFile, "utf8")).version, 1);
  } finally {
    first.stop();
  }

  const second = createPoller({
    config: baseConfig(cursorFile),
    server: stuckServer(),
    send: async () => undefined,
  });
  try {
    await second.start();
    assert.equal(second.status().paused, false, "pause must not survive a process restart");
    assert.equal(second.status().targets[1].cursor, "456-0");
  } finally {
    second.stop();
    await dataDir.cleanup();
  }
});

test("stopped poller rejects both operator controls", () => {
  const poller = createPoller({
    config: baseConfig(path.join(os.tmpdir(), "mimir-never-written", "cursor.json")),
    server: stuckServer(),
    send: async () => undefined,
  });

  poller.stop();
  assert.equal(poller.pause(), "stopped");
  assert.equal(poller.resume(), "stopped");
  assert.equal(poller.status().running, false);
  assert.equal(poller.status().paused, false);
});

test("RPC failures are bounded and redact the configured bot token in status", async () => {
  const dataDir = await createTempDataDir("mimir-rpc-failure-");
  const cursorFile = dataDir.file("cursor.json");
  await writeFile(cursorFile, CURSOR_FILE, "utf8");
  const secret = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
  const longPayload = "remote-payload".repeat(100);
  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: {
      getHealth: async () => {
        throw new Error(`${secret} ${longPayload}`);
      },
    },
    send: async () => undefined,
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await poller.start();
    await waitForFailedCycle(poller);
    const status = poller.status();
    assert.equal(status.consecutiveFailures, 1);
    assert.equal(status.targets.find((target) => target.source === "market").cursor, "123-0");
    assert.match(status.lastError.message, /^(market|squad): /);
    assert.equal(status.lastError.message.includes(secret), false);
    assert.ok(status.lastError.message.length <= 250);
    assert.equal(logs.join("\n").includes(secret), false);
  } finally {
    console.error = originalError;
    poller.stop();
    await dataDir.cleanup();
  }
});
