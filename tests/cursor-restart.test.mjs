/**
 * Cursor safety and restart behaviour, run against an ephemeral data directory.
 *
 * Nothing here touches the repo's data/ directory, live RPC, or Telegram.
 */

import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPoller } from "../dist/poller.js";
import { createTempDataDir, withTempDataDir } from "./helpers/temp-data.mjs";

const TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

function baseConfig(cursorFile) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 9_999_999,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

/** Server that returns an empty page; can fail for one contract. */
function fakeServer({ failFor = null, error = new Error("boom") } = {}) {
  return {
    getHealth: async () => ({ status: "healthy", oldestLedger: 4000, latestLedger: 5000 }),
    getEvents: async (req) => {
      const id = req.filters?.[0]?.contractIds?.[0];
      if (failFor && id === failFor) throw error;
      return { events: [], cursor: `9000-${id === MARKET_ID ? 1 : 2}`, latestLedger: 5000 };
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

/** Captures console output for one method while `fn` runs. */
async function captured(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return lines;
}

/** Starts a poller, lets the load step finish, then stops it before a cycle can change cursors. */
async function loadOnly(cursorFile) {
  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: { getHealth: () => new Promise(() => undefined) }, // scan never completes
    send: async () => undefined,
  });
  const warnings = await captured("warn", () => poller.start());
  poller.stop();
  return { poller, warnings };
}

const cursorOf = (poller, source) => poller.status().targets.find((t) => t.source === source).cursor;

test("ephemeral data dir is unique, outside the repo, and removed on cleanup", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const a = await createTempDataDir();
  const b = await createTempDataDir();
  try {
    assert.notEqual(a.root, b.root);
    assert.ok(a.root.startsWith(os.tmpdir()), "must live under the OS temp dir");
    assert.ok(!path.resolve(a.root).startsWith(path.join(repoRoot, "data")), "must not be repo data/");
    await writeFile(a.file("cursor.json"), "{}", "utf8");
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
  await assert.rejects(stat(a.root), { code: "ENOENT" });
});

test("withTempDataDir removes the directory even when the body throws", async () => {
  let root;
  await assert.rejects(
    withTempDataDir(async (dir) => {
      root = dir.root;
      await writeFile(dir.file("x.json"), "x", "utf8");
      throw new Error("assertion failed mid-test");
    }),
    /mid-test/,
  );
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("cursor round-trip: a cycle persists version 1 and a restart resumes without .tmp leftovers", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("nested/state/cursor.json"); // parent dir does not exist yet
    const first = createPoller({ config: baseConfig(cursorFile), server: fakeServer(), send: async () => undefined });
    await first.start();
    let saved;
    await waitFor(async () => {
      try {
        saved = JSON.parse(await readFile(cursorFile, "utf8"));
        return saved.targets.market.cursor !== null;
      } catch {
        return false; // not written yet
      }
    });
    first.stop();

    assert.equal(saved.version, 1);
    assert.equal(saved.targets.market.cursor, "9000-1");
    assert.equal(saved.targets.squad.cursor, "9000-2");
    assert.deepEqual((await readdir(path.dirname(cursorFile))).filter((f) => f.endsWith(".tmp")), []);

    const { poller: second } = await loadOnly(cursorFile);
    assert.equal(cursorOf(second, "market"), "9000-1");
    assert.equal(cursorOf(second, "squad"), "9000-2");
  }));

test("a stale cursor below the retained floor is rewound while the other target keeps advancing", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        targets: { market: { cursor: "1-0", lastEventLedger: 1 }, squad: { cursor: "2-0", lastEventLedger: 2 } },
      }),
      "utf8",
    );
    // The market contract rejects every scan. The fake window floor is 4000 and
    // the saved cursor sits at ledger 1, so the poller may safely rewind it.
    const server = fakeServer({ failFor: MARKET_ID, error: new Error(`cursor too old ${TOKEN} ${"z".repeat(2000)}`) });
    const poller = createPoller({ config: baseConfig(cursorFile), server, send: async () => undefined });
    const logs = await captured("error", async () => {
      await poller.start();
      await waitFor(() => poller.status().cursorRewinds >= 1 && cursorOf(poller, "squad") !== "2-0");
      poller.stop();
    });

    const status = poller.status();
    const market = status.targets.find((t) => t.source === "market");
    assert.equal(market.cursor, null, "the unreachable cursor is dropped, not guessed at");
    assert.equal(market.rewindFromLedger, 4000, "the scan resumes from the retained floor");
    assert.equal(status.cursorRewinds, 1, "one bounded rewind is recorded");
    assert.equal(cursorOf(poller, "squad"), "9000-2", "healthy target still advances");
    assert.ok(status.lastError.message.length <= 250);
    assert.equal(status.lastError.message.includes(TOKEN), false);
    assert.equal(logs.join("\n").includes(TOKEN), false);
  }));

test("an unwritable data directory is logged and the in-memory cursor keeps working", () =>
  withTempDataDir(async (dir) => {
    // A regular file where the parent directory should be makes mkdir/write fail on every OS.
    const blocker = dir.file("blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const poller = createPoller({
      config: baseConfig(path.join(blocker, "cursor.json")),
      server: fakeServer(),
      send: async () => undefined,
    });
    let logs = [];
    logs = await captured("error", async () => {
      await poller.start();
      await waitFor(() => cursorOf(poller, "market") !== null);
      await sleep(50); // let the failed save log
      poller.stop();
    });
    assert.equal(cursorOf(poller, "market"), "9000-1");
    assert.ok(logs.some((l) => /could not persist cursor/.test(l)));
    assert.equal(logs.join("\n").includes(TOKEN), false);
  }));
