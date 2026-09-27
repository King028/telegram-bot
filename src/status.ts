/**
 * Machine-readable status snapshot.
 *
 * ── Why a file, not just `/status` ───────────────────────────────────────────
 *
 * `/status` is for a human in the chat. An operator (or a supervisor, or a
 * dashboard) needs the same facts without a Telegram round trip, and needs them
 * in a shape a program can parse. So every poll cycle writes one small JSON
 * document to `STATUS_FILE` (default `./data/status.json`).
 *
 * ── Safety rules this file enforces ──────────────────────────────────────────
 *
 *  - The snapshot is built from an ALLOWLIST of fields. Nothing is spread in
 *    wholesale, so a future field on the poller status cannot leak by accident.
 *  - Secrets never appear: no bot token, no private key, no payment proof. The
 *    only identifiers written are public contract ids and the chat id, and the
 *    chat id is redacted to a coarse shape (see {@link redactChatId}).
 *  - Remote payloads are BOUNDED: error strings are truncated and newlines are
 *    collapsed, so a hostile or chatty RPC cannot write an unbounded blob into
 *    the file or into a log line.
 *  - The write is atomic (write-then-rename), so a reader never sees a
 *    half-written document and a crash cannot leave a truncated one behind.
 *
 * The chain remains the source of truth. This file is a report about the
 * reader, never a substitute for reading the chain.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";

/** Bumped when the shape of the snapshot changes incompatibly. */
export const STATUS_SCHEMA_VERSION = 1;

/** Longest error string kept in the snapshot. Anything past this is dropped. */
export const MAX_ERROR_CHARS = 300;

/** Longest cursor string kept. Real cursors are `<TOID>-<index>`, far shorter. */
export const MAX_CURSOR_CHARS = 128;

/**
 * Collapse whitespace and truncate. Applied to every string that originates
 * outside this process (RPC errors, Telegram errors, cursors), so the snapshot
 * and the logs derived from it stay bounded and single-line.
 */
export function boundText(value: string, max = MAX_ERROR_CHARS): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Reduce a chat id to something safe to persist. A numeric id keeps only its
 * sign and last four digits; a `@username` keeps only the leading character.
 * Enough to tell two deployments apart, not enough to be a usable target.
 */
export function redactChatId(chatId: string): string {
  if (chatId.startsWith("@")) {
    return chatId.length > 1 ? `@${chatId[1]}…` : "@…";
  }
  const digits = chatId.replace(/[^0-9]/g, "");
  if (digits.length === 0) return "…";
  const sign = chatId.trimStart().startsWith("-") ? "-" : "";
  return `${sign}…${digits.slice(-4)}`;
}

export interface StatusTargetSnapshot {
  source: string;
  contractId: string;
  cursor: string | null;
  lastEventLedger: number | null;
  /**
   * Ledger a target is resuming from after an automatic floor rewind, or null.
   * A bounded ledger number, never a cursor, token, or remote payload.
   */
  rewindFromLedger: number | null;
  lastError: string | null;
}

export interface StatusSnapshot {
  schemaVersion: number;
  /** ISO-8601, so a reader needs no clock agreement with the writer. */
  generatedAt: string;
  /** Milliseconds since the process started, or null before `start()`. */
  uptimeMs: number | null;
  running: boolean;
  network: string;
  rpcUrl: string;
  chatId: string;
  pollIntervalMs: number;
  maxNotificationsPerCycle: number;
  cycles: number;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  latestLedger: number | null;
  oldestLedger: number | null;
  notificationsSent: number;
  notificationsFailed: number;
  eventsSkipped: number;
  /** Cursors automatically rewound to the RPC's retained floor this run. */
  cursorRewinds: number;
  consecutiveFailures: number;
  lastError: { at: number; message: string } | null;
  targets: StatusTargetSnapshot[];
}

/**
 * Build the snapshot. Pure: same inputs, same output, no clock read except the
 * one passed in, which is what makes it testable.
 */
export function buildStatusSnapshot(
  config: BotConfig,
  status: PollerStatus,
  now: number = Date.now(),
): StatusSnapshot {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    uptimeMs: status.startedAt > 0 ? Math.max(0, now - status.startedAt) : null,
    running: status.running,
    network: networkLabel(config),
    rpcUrl: config.rpcUrl,
    chatId: redactChatId(config.chatId),
    pollIntervalMs: config.pollIntervalMs,
    maxNotificationsPerCycle: config.maxNotificationsPerCycle,
    cycles: status.cycles,
    lastPollAt: status.lastPollAt,
    lastSuccessAt: status.lastSuccessAt,
    latestLedger: status.latestLedger,
    oldestLedger: status.oldestLedger,
    notificationsSent: status.notificationsSent,
    notificationsFailed: status.notificationsFailed,
    eventsSkipped: status.eventsSkipped,
    cursorRewinds: status.cursorRewinds ?? 0,
    consecutiveFailures: status.consecutiveFailures,
    lastError: status.lastError
      ? { at: status.lastError.at, message: boundText(status.lastError.message) }
      : null,
    targets: status.targets.map((target) => ({
      source: target.source,
      contractId: target.contractId,
      cursor: target.cursor === null ? null : boundText(target.cursor, MAX_CURSOR_CHARS),
      lastEventLedger: target.lastEventLedger,
      rewindFromLedger:
        typeof target.rewindFromLedger === "number" ? target.rewindFromLedger : null,
      lastError: target.lastError === null ? null : boundText(target.lastError),
    })),
  };
}

/** Serialize with a trailing newline so the file is diff- and `cat`-friendly. */
export function serializeStatus(snapshot: StatusSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Write the snapshot atomically. Never throws: a status file that cannot be
 * written is a degraded observability signal, not a reason to stop notifying.
 * Returns true when the file was written.
 */
export async function writeStatusFile(
  file: string,
  snapshot: StatusSnapshot,
): Promise<boolean> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, serializeStatus(snapshot), "utf8");
    await rename(tmp, file);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[status] could not write ${file}: ${boundText(message)}`);
    return false;
  }
}
