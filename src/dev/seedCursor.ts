/**
 * Seeded local cursor command for credential-free developer checks.
 *
 * Writes a version-1 cursor file the poller can resume from, using the same
 * write-then-rename discipline as `src/poller.ts`. Never contacts Stellar or
 * Telegram and never reads bot tokens or signing keys.
 */

import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Opaque Soroban paging cursor shape used throughout this repo. */
export type OpaqueCursor = string;

export interface SeededCursorTarget {
  cursor: OpaqueCursor | null;
  lastEventLedger: number | null;
}

export interface SeededCursorFile {
  version: 1;
  updatedAt: string;
  targets: {
    market: SeededCursorTarget;
    squad: SeededCursorTarget;
  };
}

/**
 * Deterministic seed matching the README cursor-persistence example so local
 * fixtures stay recognizable and stable across restarts.
 */
export const DEFAULT_SEEDED_TARGETS: SeededCursorFile["targets"] = {
  market: {
    cursor: "0018276211125911551-4294967295",
    lastEventLedger: 4226729,
  },
  squad: {
    cursor: "0018276211125911551-4294967295",
    lastEventLedger: 4226733,
  },
};

export const EMPTY_SEEDED_TARGETS: SeededCursorFile["targets"] = {
  market: { cursor: null, lastEventLedger: null },
  squad: { cursor: null, lastEventLedger: null },
};

export interface BuildSeedOptions {
  /** ISO timestamp; defaults to a fixed seed so output is reproducible in tests. */
  updatedAt?: string;
  /** When true, both targets get null cursor / ledger (file present, cold resume). */
  empty?: boolean;
  market?: Partial<SeededCursorTarget>;
  squad?: Partial<SeededCursorTarget>;
}

/** Fixed timestamp used when callers omit `updatedAt` — keeps fixtures byte-stable. */
export const DEFAULT_SEED_UPDATED_AT = "2026-08-21T10:00:00.000Z";

export function buildSeededCursorFile(options: BuildSeedOptions = {}): SeededCursorFile {
  const base = options.empty ? EMPTY_SEEDED_TARGETS : DEFAULT_SEEDED_TARGETS;
  const market: SeededCursorTarget = {
    cursor: options.market?.cursor !== undefined ? options.market.cursor : base.market.cursor,
    lastEventLedger:
      options.market?.lastEventLedger !== undefined
        ? options.market.lastEventLedger
        : base.market.lastEventLedger,
  };
  const squad: SeededCursorTarget = {
    cursor: options.squad?.cursor !== undefined ? options.squad.cursor : base.squad.cursor,
    lastEventLedger:
      options.squad?.lastEventLedger !== undefined
        ? options.squad.lastEventLedger
        : base.squad.lastEventLedger,
  };

  assertTargetSafe(market, "market");
  assertTargetSafe(squad, "squad");

  return {
    version: 1,
    updatedAt: options.updatedAt ?? DEFAULT_SEED_UPDATED_AT,
    targets: { market, squad },
  };
}

function assertTargetSafe(target: SeededCursorTarget, label: string): void {
  if (target.lastEventLedger !== null) {
    if (!Number.isInteger(target.lastEventLedger) || target.lastEventLedger < 0) {
      throw new Error(`${label}.lastEventLedger must be a non-negative integer or null`);
    }
  }
  if (target.cursor !== null) {
    if (typeof target.cursor !== "string" || target.cursor.trim() === "") {
      throw new Error(`${label}.cursor must be a non-empty opaque string or null`);
    }
    // Refuse values that look like Telegram bot tokens or GitHub PATs.
    if (target.cursor.includes(":") || /^(ghp_|github_pat_)/i.test(target.cursor)) {
      throw new Error(`${label}.cursor looks like a secret; refusing to seed it`);
    }
  }
}

export interface WriteSeedOptions extends BuildSeedOptions {
  /** Absolute or cwd-relative destination. Defaults to ./data/cursor.json. */
  outPath?: string;
  /** Overwrite an existing file. Default false — protects live cursor state. */
  force?: boolean;
}

export async function writeSeededCursorFile(
  options: WriteSeedOptions = {},
): Promise<{ filePath: string; payload: SeededCursorFile }> {
  const filePath = path.resolve(process.cwd(), options.outPath ?? "./data/cursor.json");
  const payload = buildSeededCursorFile(options);

  if (!options.force) {
    try {
      await access(filePath);
      throw new Error(
        `cursor file already exists at ${filePath}; pass --force to overwrite ` +
          `(refusing so a live resume position is not clobbered)`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) throw err;
      // ENOENT — fine to create.
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);

  return { filePath, payload };
}

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseOptionalLedger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer; got "${raw}"`);
  }
  return n;
}

async function main(): Promise<void> {
  const outPath = flag("out");
  const force = hasFlag("force");
  const empty = hasFlag("empty");
  const marketLedger = parseOptionalLedger(flag("market-ledger"), "--market-ledger");
  const squadLedger = parseOptionalLedger(flag("squad-ledger"), "--squad-ledger");
  const marketCursor = flag("market-cursor");
  const squadCursor = flag("squad-cursor");

  const { filePath, payload } = await writeSeededCursorFile({
    outPath,
    force,
    empty,
    market: {
      ...(marketCursor !== undefined ? { cursor: marketCursor } : {}),
      ...(marketLedger !== undefined ? { lastEventLedger: marketLedger } : {}),
    },
    squad: {
      ...(squadCursor !== undefined ? { cursor: squadCursor } : {}),
      ...(squadLedger !== undefined ? { lastEventLedger: squadLedger } : {}),
    },
  });

  // Status only — never dump env, tokens, or unbounded payloads.
  console.log(
    `[seed-cursor] wrote version=${payload.version} ` +
      `market=${payload.targets.market.cursor ?? "none"}@${payload.targets.market.lastEventLedger ?? "none"} ` +
      `squad=${payload.targets.squad.cursor ?? "none"}@${payload.targets.squad.lastEventLedger ?? "none"} ` +
      `→ ${filePath}`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
