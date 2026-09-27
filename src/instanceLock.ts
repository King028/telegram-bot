/**
 * Exclusive instance lock — only one notifier process may own the cursor.
 *
 * Two processes against the same `CURSOR_FILE` race on write-then-rename and
 * double-post the same events to Telegram. The lock sits next to the cursor by
 * default and records only pid / hostname / time — never tokens or keys.
 *
 * Acquisition is exclusive-create (`O_EXCL` / `wx`). A lock whose pid is dead
 * (or whose file is corrupt) is treated as stale and removed so a supervisor
 * restart can reclaim ownership. A live foreign pid fails loud and fast.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LockPayload {
  version: 1;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface InstanceLockHandle {
  path: string;
  payload: LockPayload;
  release: () => Promise<void>;
}

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export interface AcquireLockOptions {
  /** Absolute ceiling before a lock with a dead/missing pid is always cleared. */
  staleMs?: number;
  pid?: number;
  hostname?: string;
  now?: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `pid` exists (or is unsignalable — treat as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: process exists but we cannot signal it.
    return code === "EPERM";
  }
}

async function readLockFile(lockFile: string): Promise<LockPayload | null> {
  try {
    const raw = await readFile(lockFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (parsed.version !== 1 || typeof parsed.pid !== "number") return null;
    if (typeof parsed.hostname !== "string" || typeof parsed.acquiredAt !== "string") return null;
    return {
      version: 1,
      pid: parsed.pid,
      hostname: parsed.hostname,
      acquiredAt: parsed.acquiredAt,
    };
  } catch {
    return null;
  }
}

async function unlinkQuiet(lockFile: string): Promise<void> {
  try {
    await unlink(lockFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * Acquire an exclusive lock at `lockFile`.
 *
 * @throws {InstanceLockError} when another live instance holds the lock.
 */
export async function acquireInstanceLock(
  lockFile: string,
  opts: AcquireLockOptions = {},
): Promise<InstanceLockHandle> {
  const pid = opts.pid ?? process.pid;
  const hostname = opts.hostname ?? os.hostname();
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 24 * 60 * 60 * 1000;

  await mkdir(path.dirname(lockFile), { recursive: true });

  const payload: LockPayload = {
    version: 1,
    pid,
    hostname,
    acquiredAt: new Date(now()).toISOString(),
  };

  async function tryCreate(): Promise<boolean> {
    try {
      const fh = await open(lockFile, "wx");
      try {
        await fh.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      } finally {
        await fh.close();
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      throw err;
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await tryCreate()) {
      let released = false;
      return {
        path: lockFile,
        payload,
        async release() {
          if (released) return;
          released = true;
          try {
            const existing = await readLockFile(lockFile);
            if (existing && existing.pid === pid) {
              await unlinkQuiet(lockFile);
            }
          } catch (err) {
            console.warn(`[lock] release failed: ${errorMessage(err)}`);
          }
        },
      };
    }

    const existing = await readLockFile(lockFile);
    if (existing && isProcessAlive(existing.pid) && existing.pid !== pid) {
      throw new InstanceLockError(
        `Another bot instance is already running (pid ${existing.pid} on ${existing.hostname}, ` +
          `lock ${lockFile}, acquired ${existing.acquiredAt}). ` +
          `Stop that process before starting another — only one instance may own the cursor.`,
      );
    }

    const acquiredAtMs = existing?.acquiredAt ? Date.parse(existing.acquiredAt) : Number.NaN;
    const age = Number.isFinite(acquiredAtMs) ? now() - acquiredAtMs : Number.POSITIVE_INFINITY;
    const reason = existing
      ? existing.pid === pid
        ? `same pid ${existing.pid} left a leftover lock`
        : `pid ${existing.pid} is not running` +
          (age > staleMs ? " and lock exceeded stale budget" : "")
      : "lock file unreadable or corrupt";

    console.warn(`[lock] removing stale lock at ${lockFile}: ${reason}`);
    await unlinkQuiet(lockFile);
  }

  throw new InstanceLockError(`Could not acquire instance lock at ${lockFile} after retries`);
}
