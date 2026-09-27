import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cursorQuarantinePath,
  isValidCursorFile,
  parseCursorFile,
  quarantineCorruptCursorFile,
  createPoller,
} from "../dist/poller.js";

const validCursor = {
  version: 1,
  updatedAt: "2026-08-21T10:00:00.000Z",
  targets: {
    market: { cursor: "0018276211125911551-4294967295", lastEventLedger: 4226729 },
    squad: { cursor: null, lastEventLedger: null },
  },
};

test("isValidCursorFile accepts a well-formed v1 file", () => {
  assert.equal(isValidCursorFile(validCursor), true);
});

test("isValidCursorFile rejects wrong version, arrays, and bad entry types", () => {
  assert.equal(isValidCursorFile({ ...validCursor, version: 2 }), false);
  assert.equal(isValidCursorFile({ ...validCursor, targets: [] }), false);
  assert.equal(
    isValidCursorFile({
      ...validCursor,
      targets: { market: { cursor: 12, lastEventLedger: null } },
    }),
    false,
  );
  assert.equal(
    isValidCursorFile({
      ...validCursor,
      targets: { market: { cursor: null, lastEventLedger: "nope" } },
    }),
    false,
  );
  assert.equal(isValidCursorFile(null), false);
  assert.equal(isValidCursorFile("nope"), false);
});

test("parseCursorFile throws on invalid JSON and invalid schema", () => {
  assert.throws(() => parseCursorFile("{"), /invalid JSON/);
  assert.throws(() => parseCursorFile(JSON.stringify({ version: 1 })), /schema/);
  assert.deepEqual(parseCursorFile(JSON.stringify(validCursor)), validCursor);
});

test("cursorQuarantinePath is deterministic and beside the live file", () => {
  const at = new Date("2026-09-24T12:00:00.000Z");
  assert.equal(
    cursorQuarantinePath("/tmp/data/cursor.json", at),
    "/tmp/data/cursor.json.corrupt.2026-09-24T12-00-00-000Z",
  );
});

test("quarantineCorruptCursorFile renames the live file aside", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-cursor-"));
  const cursorFile = path.join(dir, "cursor.json");
  await writeFile(cursorFile, "{not-json", "utf8");
  const at = new Date("2026-09-24T12:34:56.789Z");
  const dest = await quarantineCorruptCursorFile(cursorFile, "invalid JSON", at);
  assert.equal(dest, `${cursorFile}.corrupt.2026-09-24T12-34-56-789Z`);
  await assert.rejects(() => access(cursorFile));
  assert.equal(await readFile(dest, "utf8"), "{not-json");
});

function baseConfig(cursorFile) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 60_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

test("createPoller.start quarantines corrupt cursor and cold-starts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-poller-"));
  const cursorFile = path.join(dir, "cursor.json");
  await writeFile(cursorFile, '{"version":1,"updatedAt":"x","targets":[]}', "utf8");

  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: /** @type {any} */ ({}),
    send: async () => {
      throw new Error("send should not run in this test");
    },
  });

  // start() loads cursors then kicks the loop; stop immediately to avoid RPC.
  await poller.start();
  poller.stop();

  await assert.rejects(() => access(cursorFile), /ENOENT/);
  const entries = await (await import("node:fs/promises")).readdir(dir);
  const quarantined = entries.filter((name) => name.startsWith("cursor.json.corrupt."));
  assert.equal(quarantined.length, 1);
  assert.equal(
    await readFile(path.join(dir, quarantined[0]), "utf8"),
    '{"version":1,"updatedAt":"x","targets":[]}',
  );

  const status = poller.status();
  for (const t of status.targets) {
    assert.equal(t.cursor, null);
    assert.equal(t.lastEventLedger, null);
  }
});

test("createPoller.start resumes from a valid cursor file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-poller-ok-"));
  const cursorFile = path.join(dir, "cursor.json");
  await writeFile(cursorFile, `${JSON.stringify(validCursor, null, 2)}\n`, "utf8");

  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: /** @type {any} */ ({}),
    send: async () => {},
  });
  await poller.start();
  poller.stop();

  // Live file must remain (not quarantined).
  assert.equal((await readFile(cursorFile, "utf8")).includes('"version": 1'), true);
  const status = poller.status();
  const market = status.targets.find((t) => t.source === "market");
  const squad = status.targets.find((t) => t.source === "squad");
  assert.equal(market?.cursor, validCursor.targets.market.cursor);
  assert.equal(market?.lastEventLedger, 4226729);
  assert.equal(squad?.cursor, null);
  assert.equal(squad?.lastEventLedger, null);
});

test("createPoller.start treats missing cursor as cold start without quarantine noise", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-poller-missing-"));
  await mkdir(dir, { recursive: true });
  const cursorFile = path.join(dir, "cursor.json");

  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: /** @type {any} */ ({}),
    send: async () => {},
  });
  await poller.start();
  poller.stop();

  const entries = await (await import("node:fs/promises")).readdir(dir);
  assert.equal(entries.some((n) => n.includes(".corrupt.")), false);
});
