import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireInstanceLock,
  InstanceLockError,
  isProcessAlive,
} from "../dist/instanceLock.js";

async function tempLockPath(name = "poller.lock") {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-lock-"));
  return path.join(dir, name);
}

test("acquireInstanceLock succeeds and writes pid-only payload", async () => {
  const lockFile = await tempLockPath();
  const handle = await acquireInstanceLock(lockFile, {
    pid: process.pid,
    hostname: "test-host",
    now: () => Date.parse("2026-09-24T00:00:00.000Z"),
  });

  const raw = await readFile(lockFile, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.hostname, "test-host");
  assert.equal(parsed.acquiredAt, "2026-09-24T00:00:00.000Z");
  // Never persist secrets in the lock file.
  assert.equal("token" in parsed, false);
  assert.equal("botToken" in parsed, false);
  assert.match(raw, /^\{/);

  await handle.release();
  await assert.rejects(readFile(lockFile, "utf8"), { code: "ENOENT" });
});

test("second acquire against a live holder fails loud", async () => {
  const lockFile = await tempLockPath();
  const first = await acquireInstanceLock(lockFile, { pid: process.pid, hostname: "a" });

  await assert.rejects(
    () => acquireInstanceLock(lockFile, { pid: process.pid + 1_000_000, hostname: "b" }),
    (err) => {
      assert.ok(err instanceof InstanceLockError);
      assert.match(err.message, /Already running|already running/i);
      assert.doesNotMatch(err.message, /ghp_|BOT_TOKEN|eyJ/);
      return true;
    },
  );

  await first.release();
});

test("stale lock with dead pid is stolen on restart", async () => {
  const lockFile = await tempLockPath();
  // Pid 1 is almost never our process; pick a definitely-dead pid.
  let deadPid = 2_147_483_646;
  while (isProcessAlive(deadPid) && deadPid > 2_147_480_000) deadPid -= 1;
  assert.equal(isProcessAlive(deadPid), false);

  await writeFile(
    lockFile,
    `${JSON.stringify({ version: 1, pid: deadPid, hostname: "gone", acquiredAt: "2020-01-01T00:00:00.000Z" }, null, 2)}\n`,
    "utf8",
  );

  const handle = await acquireInstanceLock(lockFile, {
    pid: process.pid,
    hostname: "restarted",
  });
  const parsed = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.hostname, "restarted");
  await handle.release();
});

test("corrupt lock file is treated as stale and replaced", async () => {
  const lockFile = await tempLockPath();
  await writeFile(lockFile, "not-json{{{", "utf8");
  const handle = await acquireInstanceLock(lockFile, { pid: process.pid, hostname: "recover" });
  const parsed = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(parsed.pid, process.pid);
  await handle.release();
});

test("release is idempotent and does not unlink a foreign lock", async () => {
  const lockFile = await tempLockPath();
  const handle = await acquireInstanceLock(lockFile, { pid: process.pid, hostname: "mine" });
  await handle.release();
  await handle.release();

  // Simulate another instance taking ownership after we released.
  await writeFile(
    lockFile,
    `${JSON.stringify({ version: 1, pid: process.pid + 1, hostname: "other", acquiredAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  // Releasing again must not steal the foreign lock (released flag is set).
  await handle.release();
  const parsed = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(parsed.hostname, "other");
});

test("isProcessAlive reports the current pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(0), false);
});
