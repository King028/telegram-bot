import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SEEDED_TARGETS,
  DEFAULT_SEED_UPDATED_AT,
  EMPTY_SEEDED_TARGETS,
  buildSeededCursorFile,
  writeSeededCursorFile,
} from "../dist/dev/seedCursor.js";

test("buildSeededCursorFile returns the documented deterministic seed", () => {
  const payload = buildSeededCursorFile();
  assert.equal(payload.version, 1);
  assert.equal(payload.updatedAt, DEFAULT_SEED_UPDATED_AT);
  assert.deepEqual(payload.targets, DEFAULT_SEEDED_TARGETS);
});

test("buildSeededCursorFile --empty yields null cursors for restart coverage", () => {
  const payload = buildSeededCursorFile({ empty: true });
  assert.deepEqual(payload.targets, EMPTY_SEEDED_TARGETS);
});

test("buildSeededCursorFile accepts per-target ledger overrides (boundary)", () => {
  const payload = buildSeededCursorFile({
    market: { lastEventLedger: 0 },
    squad: { lastEventLedger: 1 },
  });
  assert.equal(payload.targets.market.lastEventLedger, 0);
  assert.equal(payload.targets.squad.lastEventLedger, 1);
  assert.equal(payload.targets.market.cursor, DEFAULT_SEEDED_TARGETS.market.cursor);
});

test("buildSeededCursorFile rejects negative ledgers and secret-shaped cursors", () => {
  assert.throws(
    () => buildSeededCursorFile({ market: { lastEventLedger: -1 } }),
    /non-negative integer/,
  );
  assert.throws(
    () => buildSeededCursorFile({ market: { cursor: "123456:AA-fake-bot-token" } }),
    /looks like a secret/,
  );
  assert.throws(
    () => buildSeededCursorFile({ squad: { cursor: "ghp_not_a_real_token_value" } }),
    /looks like a secret/,
  );
});

test("writeSeededCursorFile creates a poller-compatible file and refuses overwrite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-seed-cursor-"));
  const outPath = path.join(dir, "cursor.json");

  try {
    const { filePath, payload } = await writeSeededCursorFile({ outPath });
    assert.equal(filePath, outPath);

    const raw = await readFile(outPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, payload);
    assert.equal(parsed.version, 1);
    assert.ok(parsed.targets.market.cursor);
    assert.ok(parsed.targets.squad.cursor);

    await assert.rejects(
      () => writeSeededCursorFile({ outPath }),
      /already exists/,
    );

    const forced = await writeSeededCursorFile({ outPath, force: true, empty: true });
    assert.equal(forced.payload.targets.market.cursor, null);
    assert.equal(forced.payload.targets.squad.cursor, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeSeededCursorFile status path never embeds a live token fixture", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-seed-cursor-"));
  const outPath = path.join(dir, "nested", "cursor.json");

  try {
    // Plant a decoy secret file nearby; the seeder must not read or echo it.
    await writeFile(path.join(dir, ".env"), "BOT_TOKEN=123456:AA-should-never-appear\n", "utf8");
    const { payload } = await writeSeededCursorFile({ outPath, force: true });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("BOT_TOKEN"), false);
    assert.equal(serialized.includes("AA-should-never-appear"), false);
    assert.equal(serialized.includes("123456:"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
