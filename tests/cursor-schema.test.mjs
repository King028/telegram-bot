/**
 * Cursor schema migration tests for src/poller.ts
 *
 * Covers: v1 roundtrip, legacy-unversioned / flat / string-map migration,
 * unknown version rejection, malformed payloads, and in-place rewrite on start.
 *
 * Uses temporary cursor paths and a fake clock. No live Telegram / RPC calls
 * for the pure parser tests; rewrite test uses a fake server.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURSOR_SCHEMA_VERSION,
  buildCursorFile,
  createPoller,
  parseAndMigrateCursorFile,
} from "../dist/poller.js";

const FIXED_NOW = new Date("2026-09-24T12:00:00.000Z");

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

function makeConfig(overrides = {}) {
  return {
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "fake-token",
    chatId: "-1001234567890",
    pollIntervalMs: 999_999,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 5,
    ...overrides,
  };
}

function makeServer({ latestLedger = 5100, oldestLedger = 1000 } = {}) {
  return {
    async getHealth() {
      return { status: "healthy", latestLedger, oldestLedger };
    },
    async getEvents() {
      return {
        events: [],
        cursor: cursorAt(latestLedger),
        latestLedger,
      };
    },
  };
}

// ── Pure parser / migrator ────────────────────────────────────────────────────

test("parseAndMigrateCursorFile accepts a current v1 document unchanged", () => {
  const raw = JSON.stringify({
    version: 1,
    updatedAt: "2026-08-21T10:00:00.000Z",
    targets: {
      market: { cursor: cursorAt(4000), lastEventLedger: 4000 },
      squad: { cursor: null, lastEventLedger: null },
    },
  });
  const result = parseAndMigrateCursorFile(raw, { now: () => FIXED_NOW });
  assert.equal(result.migrated, false);
  assert.equal(result.source, "v1");
  assert.equal(result.file.version, CURSOR_SCHEMA_VERSION);
  assert.equal(result.file.updatedAt, "2026-08-21T10:00:00.000Z");
  assert.equal(result.file.targets.market.cursor, cursorAt(4000));
  assert.equal(result.file.targets.squad.cursor, null);
});

test("parseAndMigrateCursorFile migrates legacy-unversioned targets envelope", () => {
  const raw = JSON.stringify({
    updatedAt: "2026-01-01T00:00:00.000Z",
    targets: {
      market: { cursor: cursorAt(1111), lastEventLedger: 1111 },
    },
  });
  const result = parseAndMigrateCursorFile(raw, { now: () => FIXED_NOW });
  assert.equal(result.migrated, true);
  assert.equal(result.source, "legacy-unversioned");
  assert.equal(result.file.version, 1);
  assert.equal(result.file.updatedAt, FIXED_NOW.toISOString());
  assert.equal(result.file.targets.market.lastEventLedger, 1111);
});

test("parseAndMigrateCursorFile migrates legacy-flat object map", () => {
  const raw = JSON.stringify({
    market: { cursor: cursorAt(2222), lastEventLedger: 2222 },
    squad: { cursor: cursorAt(2000), lastEventLedger: 2000 },
  });
  const result = parseAndMigrateCursorFile(raw, { now: () => FIXED_NOW });
  assert.equal(result.migrated, true);
  assert.equal(result.source, "legacy-flat");
  assert.deepEqual(result.file.targets.squad, {
    cursor: cursorAt(2000),
    lastEventLedger: 2000,
  });
});

test("parseAndMigrateCursorFile migrates legacy-string-map cursors", () => {
  const raw = JSON.stringify({
    market: cursorAt(3333),
    squad: cursorAt(3000),
  });
  const result = parseAndMigrateCursorFile(raw, { now: () => FIXED_NOW });
  assert.equal(result.migrated, true);
  assert.equal(result.source, "legacy-string-map");
  assert.equal(result.file.targets.market.cursor, cursorAt(3333));
  assert.equal(result.file.targets.market.lastEventLedger, null);
  assert.equal(result.file.targets.squad.cursor, cursorAt(3000));
});

test("parseAndMigrateCursorFile rejects unsupported future schema versions", () => {
  const raw = JSON.stringify({
    version: 99,
    updatedAt: FIXED_NOW.toISOString(),
    targets: { market: { cursor: null, lastEventLedger: null } },
  });
  assert.throws(
    () => parseAndMigrateCursorFile(raw),
    /unsupported schema version 99/,
  );
});

test("parseAndMigrateCursorFile rejects version 0 and non-objects", () => {
  assert.throws(
    () => parseAndMigrateCursorFile(JSON.stringify({ version: 0, targets: {} })),
    /unsupported schema version 0/,
  );
  assert.throws(() => parseAndMigrateCursorFile("[]"), /root must be a JSON object/);
  assert.throws(
    () => parseAndMigrateCursorFile(JSON.stringify({ hello: 1 })),
    /unrecognised shape/,
  );
});

test("parseAndMigrateCursorFile rejects malformed target entries", () => {
  assert.throws(
    () =>
      parseAndMigrateCursorFile(
        JSON.stringify({
          version: 1,
          updatedAt: FIXED_NOW.toISOString(),
          targets: { market: { cursor: 12, lastEventLedger: null } },
        }),
      ),
    /cursor must be a string or null/,
  );
  assert.throws(
    () =>
      parseAndMigrateCursorFile(
        JSON.stringify({
          version: 1,
          updatedAt: FIXED_NOW.toISOString(),
          targets: { market: { cursor: "x", lastEventLedger: 1.5 } },
        }),
      ),
    /lastEventLedger must be an integer or null/,
  );
});

test("buildCursorFile always emits the current schema version", () => {
  const file = buildCursorFile(
    [
      { source: "market", cursor: "abc", lastEventLedger: 9 },
      { source: "squad", cursor: null, lastEventLedger: null },
    ],
    FIXED_NOW.toISOString(),
  );
  assert.equal(file.version, CURSOR_SCHEMA_VERSION);
  assert.equal(file.updatedAt, FIXED_NOW.toISOString());
  assert.deepEqual(file.targets.market, { cursor: "abc", lastEventLedger: 9 });
});

// ── In-place rewrite on poller start ─────────────────────────────────────────

test("createPoller migrates a legacy flat cursor file before the first cycle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-cursor-schema-"));
  const cursorFile = path.join(dir, "cursor.json");
  const marketCursor = cursorAt(4000);
  const squadCursor = cursorAt(3900);

  await writeFile(
    cursorFile,
    JSON.stringify({
      market: { cursor: marketCursor, lastEventLedger: 4000 },
      squad: { cursor: squadCursor, lastEventLedger: 3900 },
    }) + "\n",
  );

  const poller = createPoller({
    config: makeConfig({ cursorFile }),
    server: makeServer(),
    send: async () => {
      throw new Error("send should not be called with empty pages");
    },
    now: () => FIXED_NOW.getTime(),
  });

  await poller.start();
  // Allow the async first cycle to settle so we stop cleanly.
  await new Promise((r) => setTimeout(r, 80));
  poller.stop();

  const saved = JSON.parse(await readFile(cursorFile, "utf8"));
  assert.equal(saved.version, CURSOR_SCHEMA_VERSION);
  assert.ok(typeof saved.updatedAt === "string");
  assert.ok(saved.targets.market.cursor, "market cursor must survive migration");
  assert.ok(saved.targets.squad.cursor, "squad cursor must survive migration");

  const st = poller.status();
  assert.equal(st.cycles, 1);
  for (const target of st.targets) {
    assert.equal(target.lastError, null, `${target.source} should not error`);
  }
});

test("createPoller cold-starts on unsupported schema version without crashing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-cursor-schema-"));
  const cursorFile = path.join(dir, "cursor.json");
  await writeFile(
    cursorFile,
    JSON.stringify({
      version: 7,
      updatedAt: FIXED_NOW.toISOString(),
      targets: {
        market: { cursor: cursorAt(9999), lastEventLedger: 9999 },
      },
    }) + "\n",
  );

  const poller = createPoller({
    config: makeConfig({ cursorFile }),
    server: makeServer(),
    send: async () => {},
    now: () => FIXED_NOW.getTime(),
  });

  await poller.start();
  await new Promise((r) => setTimeout(r, 80));
  poller.stop();

  const st = poller.status();
  assert.equal(st.cycles, 1);
  // Unsupported version → cold start: in-memory cursors begin null, then the
  // successful scan writes a fresh v1 file.
  const saved = JSON.parse(await readFile(cursorFile, "utf8"));
  assert.equal(saved.version, CURSOR_SCHEMA_VERSION);
});
