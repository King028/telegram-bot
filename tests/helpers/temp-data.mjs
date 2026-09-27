/**
 * Ephemeral data directory for tests.
 *
 * Every test that needs a cursor file gets a fresh directory under the OS temp
 * dir and removes it afterwards, so tests never read or write the repo's
 * `data/` directory, never collide on fixed `/tmp` names, and never leave state
 * behind that changes a later run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempDataDir(prefix = "mimir-data-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    root,
    /** Absolute path of `name` inside the ephemeral directory. */
    file: (name) => path.join(root, name),
    // Retries cover a poller that is still finishing its last cursor write.
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** Runs `fn(dir)` and always removes the directory, even if `fn` throws. */
export async function withTempDataDir(fn, prefix) {
  const dir = await createTempDataDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await dir.cleanup();
  }
}
