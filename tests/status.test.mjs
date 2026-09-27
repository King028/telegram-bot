import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_ERROR_CHARS,
  STATUS_SCHEMA_VERSION,
  boundText,
  buildStatusSnapshot,
  redactChatId,
  serializeStatus,
  writeStatusFile,
} from "../dist/status.js";

const config = {
  botToken: "123456789:AA-super-secret-token",
  chatId: "-1001234567890",
  marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  pollIntervalMs: 30000,
  startLookbackLedgers: 60,
  cursorFile: "/tmp/cursor.json",
  statusFile: "/tmp/status.json",
  maxNotificationsPerCycle: 20,
};

function status(overrides = {}) {
  return {
    running: true,
    startedAt: 1_000_000,
    cycles: 3,
    lastPollAt: 1_060_000,
    lastSuccessAt: 1_060_000,
    latestLedger: 4226733,
    oldestLedger: 4105773,
    notificationsSent: 11,
    notificationsFailed: 0,
    eventsSkipped: 3,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: config.marketContractId,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4226729,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test("snapshot is machine-readable and carries the documented schema version", () => {
  const snapshot = buildStatusSnapshot(config, status(), 1_060_000);

  assert.equal(snapshot.schemaVersion, STATUS_SCHEMA_VERSION);
  assert.equal(snapshot.generatedAt, new Date(1_060_000).toISOString());
  assert.equal(snapshot.uptimeMs, 60_000);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.network, "testnet");
  assert.equal(snapshot.latestLedger, 4226733);
  assert.equal(snapshot.targets.length, 1);
  assert.equal(snapshot.targets[0].cursor, "0018276211125911551-4294967295");

  // Round-trips through JSON, which is the whole point of the file.
  assert.deepEqual(JSON.parse(serializeStatus(snapshot)), snapshot);
});

test("snapshot never contains the bot token or a raw chat id", () => {
  const serialized = serializeStatus(buildStatusSnapshot(config, status(), 1_060_000));

  assert.ok(!serialized.includes(config.botToken), "bot token leaked");
  assert.ok(!serialized.includes("AA-super-secret-token"), "token fragment leaked");
  assert.ok(!serialized.includes(config.chatId), "raw chat id leaked");
  assert.equal(JSON.parse(serialized).chatId, "-…7890");
});

test("redactChatId keeps only a coarse shape", () => {
  assert.equal(redactChatId("-1001234567890"), "-…7890");
  assert.equal(redactChatId("123456789"), "…6789");
  assert.equal(redactChatId("@mimir_channel"), "@m…");
  assert.equal(redactChatId(""), "…");
  assert.equal(redactChatId("@"), "@…");
});

test("boundText collapses whitespace and truncates unbounded remote payloads", () => {
  assert.equal(boundText("  a\n\nb\tc  "), "a b c");
  assert.equal(boundText("x".repeat(MAX_ERROR_CHARS)), "x".repeat(MAX_ERROR_CHARS));

  const long = boundText("y".repeat(MAX_ERROR_CHARS * 10));
  assert.equal(long.length, MAX_ERROR_CHARS);
  assert.ok(long.endsWith("…"));
});

test("snapshot bounds error strings and cursors from the RPC", () => {
  const hostile = `boom\n${"z".repeat(5000)}`;
  const snapshot = buildStatusSnapshot(
    config,
    status({
      lastError: { at: 1_050_000, message: hostile },
      targets: [
        {
          source: "market",
          contractId: config.marketContractId,
          cursor: "c".repeat(5000),
          lastEventLedger: null,
          lastError: hostile,
        },
      ],
    }),
    1_060_000,
  );

  assert.ok(snapshot.lastError.message.length <= MAX_ERROR_CHARS);
  assert.ok(!snapshot.lastError.message.includes("\n"));
  assert.ok(snapshot.targets[0].lastError.length <= MAX_ERROR_CHARS);
  assert.ok(snapshot.targets[0].cursor.length <= 128);
});

test("snapshot reports a cold start and a stopped process honestly", () => {
  const cold = buildStatusSnapshot(
    config,
    status({
      running: false,
      startedAt: 0,
      cycles: 0,
      lastPollAt: null,
      lastSuccessAt: null,
      latestLedger: null,
      oldestLedger: null,
      targets: [
        {
          source: "market",
          contractId: config.marketContractId,
          cursor: null,
          lastEventLedger: null,
          lastError: null,
        },
      ],
    }),
    1_060_000,
  );

  assert.equal(cold.running, false);
  assert.equal(cold.uptimeMs, null);
  assert.equal(cold.lastPollAt, null);
  assert.equal(cold.targets[0].cursor, null);
});

test("snapshot surfaces consecutive failures for a health check", () => {
  const failing = buildStatusSnapshot(
    config,
    status({
      consecutiveFailures: 4,
      lastSuccessAt: 1_000_000,
      lastError: { at: 1_059_000, message: "market: rpc timeout" },
    }),
    1_060_000,
  );

  assert.equal(failing.consecutiveFailures, 4);
  assert.equal(failing.lastError.message, "market: rpc timeout");
  assert.equal(failing.lastSuccessAt, 1_000_000);
});

test("writeStatusFile writes atomically and leaves no temp file behind", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-status-"));
  const file = path.join(dir, "nested", "status.json");
  try {
    const snapshot = buildStatusSnapshot(config, status(), 1_060_000);
    assert.equal(await writeStatusFile(file, snapshot), true);

    const onDisk = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(onDisk, snapshot);

    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(path.dirname(file)), ["status.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeStatusFile overwrites a previous snapshot (restart safety)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-status-"));
  const file = path.join(dir, "status.json");
  try {
    await writeStatusFile(file, buildStatusSnapshot(config, status({ cycles: 1 }), 1_000));
    await writeStatusFile(file, buildStatusSnapshot(config, status({ cycles: 2 }), 2_000));

    const onDisk = JSON.parse(await readFile(file, "utf8"));
    assert.equal(onDisk.cycles, 2);
    assert.equal(onDisk.generatedAt, new Date(2_000).toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeStatusFile reports failure instead of throwing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-status-"));
  const file = path.join(dir, "status.json");
  try {
    // A directory where the file should be: the rename cannot succeed.
    await mkdir(path.join(dir, "blocker"));
    const snapshot = buildStatusSnapshot(config, status(), 1_000);
    assert.equal(await writeStatusFile(path.join(dir, "blocker"), snapshot), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
