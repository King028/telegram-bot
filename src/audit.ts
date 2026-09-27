/**
 * Operator audit trail: what happened, when, and nothing that must stay secret.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The notifier is designed to fail soft: a dropped message or a failed scan is
 * logged once and the loop carries on. Over weeks of uptime that makes the
 * important question "what actually happened while I was asleep?" — and a
 * chat-scrolled console log does not answer it. The audit trail is an append-
 * only record of every bounded, interesting event (scan failures, send
 * failures, skipped and cap-dropped events, cursor problems) that survives
 * restarts, can be read back with `/audit`, and is safe to paste into an issue.
 *
 * ── Safety rules (enforced at record time, not by caller discipline) ─────────
 *
 *  1. EVERY free-text detail passes through {@link redact} before it is stored:
 *     bot tokens, secret/seed strkeys, URLs and any long opaque token are
 *     replaced, and the remainder is length-clamped. A payload that was too
 *     long to log is a redaction, never a chat-sized dump.
 *  2. Entries are small, fixed-shape objects (`v`, `t`, `kind`, optional
 *     `source` and `detail`). No counters of unbounded size, no payloads, no
 *     payment data — the chain is the record, not the audit log.
 *  3. The in-memory buffer and the JSONL file are both bounded on read: a
 *     report renders at most `maxEntries` most-recent lines and says so.
 *  4. The log never throws into the poller: persistence is append-with-catch
 *     on the caller's side, and a bad line in the file is skipped and counted,
 *     never fatal.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import type { ContractSource } from "./stellar/decode.js";

// ── Kinds ────────────────────────────────────────────────────────────────────

/** Every audit event type. Closed set: a typo is a compile error, not a mystery string. */
export const AUDIT_KINDS = [
  "boot",
  "shutdown",
  "cursor_loaded",
  "cursor_persist_failed",
  "stale_cursor",
  "cycle_failed",
  "cycle_recovered",
  "event_skipped",
  "cap_reached",
  "send_failed",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Kinds that mean "an operator may need to look at this". */
export const AUDIT_ERROR_KINDS: readonly AuditKind[] = [
  "cycle_failed",
  "send_failed",
  "cursor_persist_failed",
  "stale_cursor",
];

export function isAuditKind(value: unknown): value is AuditKind {
  return typeof value === "string" && (AUDIT_KINDS as readonly string[]).includes(value);
}

export function isErrorKind(kind: AuditKind): boolean {
  return (AUDIT_ERROR_KINDS as readonly string[]).includes(kind);
}

// ── Entries ──────────────────────────────────────────────────────────────────

/** Audit format version. Bumped only when the on-disk shape changes. */
export const AUDIT_FORMAT_VERSION = 1;

/** A stored detail line is a hint, not a log dump. */
export const AUDIT_MAX_DETAIL = 240;

/** In-memory ring buffer size — the queryable window for a running process. */
export const AUDIT_MAX_BUFFERED = 500;

/** Most entries a single report reads from disk. */
export const AUDIT_REPORT_MAX_ENTRIES = 500;

export interface AuditEntry {
  /** On-disk format version. */
  readonly v: typeof AUDIT_FORMAT_VERSION;
  /** Wall-clock time of the event, unix ms. */
  readonly t: number;
  readonly kind: AuditKind;
  /** Which watched contract this belongs to, when it belongs to one. */
  readonly source?: ContractSource;
  /** Short, redacted, human-readable detail. Already bounded. */
  readonly detail?: string;
}

export interface AuditEntryOptions {
  source?: ContractSource | undefined;
  detail?: string | undefined;
  /** Override the wall-clock time (unix ms) — used by tests. */
  at?: number | undefined;
}

// ── Redaction ────────────────────────────────────────────────────────────────

export interface RedactionRule {
  readonly pattern: RegExp;
  /** A template string for `String.replace` (may use `$1` etc.). */
  readonly replacement: string;
}

/** Like {@link RedactionRule}, but the replacement decides per match. */
export interface FnRedactionRule {
  readonly pattern: RegExp;
  readonly replacement: (match: string) => string;
}

/**
 * What a detail line must never carry, wherever it came from (an RPC error, a
 * Telegram error, an operator env dump pasted into a message):
 *
 *  - Telegram bot tokens (`123456789:AA…`), with or without the `bot` prefix.
 *  - Secret/seed strkeys (`S…`, `D…`, `B…`, `T…`). `C…` contract ids are public
 *    chain configuration and stay readable on purpose.
 *  - URLs: the configured RPC/Horizon endpoints are not secret, but error text
 *    can embed query strings (and tokens) that are.
 *  - Any remaining ≥40-character opaque token: by this point it is not human
 *    language, and "unrecognized long token" is strictly safer than guessing.
 */
export const DEFAULT_REDACTION_RULES: readonly (RedactionRule | FnRedactionRule)[] = [
  { pattern: /\bbot\d{6,}:[A-Za-z0-9_-]{30,}\b/g, replacement: "[redacted:bot token]" },
  { pattern: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, replacement: "[redacted:bot token]" },
  { pattern: /\b(token|secret|password|authorization)\s*[=:]\s*\S+/gi, replacement: "$1=[redacted]" },
  // `S` + 55 base32 chars = the 56-char ed25519 secret seed strkey.
  { pattern: /\bS[A-Z2-7]{55}\b/g, replacement: "[redacted:secret key]" },
  { pattern: /\bhttps?:\/\/\S+/gi, replacement: "[redacted:url]" },
  // Public strkeys (account `G…`, contract `C…`) are chain identifiers the bot
  // already prints in /status, so a match that IS one survives verbatim. Every
  // other long token is unknown-origin and unreadable anyway, so it is
  // replaced wholesale. A keep-then-redact pair of rules cannot express this
  // (later rules would re-match), hence the per-match decision.
  {
    pattern: /\S{40,}/g,
    replacement: (match: string): string =>
      /^[GC][A-Z2-7]{55}$/.test(match) ? match : "[redacted:long token]",
  },
];

/** Apply the default redactions, then clamp to {@link AUDIT_MAX_DETAIL}. */
export function redact(
  text: string,
  rules: readonly (RedactionRule | FnRedactionRule)[] = DEFAULT_REDACTION_RULES,
): string {
  let out = text;
  for (const rule of rules) {
    // The branches look the same but are not: the typeof check narrows the
    // rule, so each call resolves the String.replace overload matching its
    // replacement type (template string vs per-match function).
    out =
      typeof rule.replacement === "string"
        ? out.replace(rule.pattern, rule.replacement)
        : out.replace(rule.pattern, rule.replacement);
  }

  out = out.trim();
  if (out.length > AUDIT_MAX_DETAIL) {
    out = `${out.slice(0, AUDIT_MAX_DETAIL - 1)}…`;
  }
  return out;
}

/** Extract a redactable message from anything thrown at us. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    // The SDK's JSON-RPC layer throws raw response error objects
    // ({ code, message, data }), not Error instances.
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Build one audit entry. The free-text detail is redacted and length-clamped
 * here so no call site can skip the safety rules.
 */
export function auditEntry(kind: AuditKind, opts: AuditEntryOptions = {}): AuditEntry {
  if (!isAuditKind(kind)) throw new TypeError(`unknown audit kind: ${String(kind)}`);

  const detail = opts.detail === undefined ? undefined : redact(opts.detail);
  const entry: AuditEntry = {
    v: AUDIT_FORMAT_VERSION,
    t: opts.at ?? Date.now(),
    kind,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(detail !== undefined && detail !== "" ? { detail } : {}),
  };
  return Object.freeze(entry);
}

/** Build an entry from a thrown value, with the message redacted. */
export function auditFromError(
  err: unknown,
  kind: AuditKind,
  opts: AuditEntryOptions = {},
): AuditEntry {
  const message = errorText(err);
  return auditEntry(kind, {
    ...opts,
    detail: opts.detail ? `${opts.detail}: ${message}` : message,
  });
}

// ── In-memory log ────────────────────────────────────────────────────────────

export interface AuditLog {
  record(entry: AuditEntry): void;
  /**
   * Record from a thrown value: `detail` (when given) prefixes the redacted
   * error message, so the entry reads `context: message`.
   */
  recordError(err: unknown, kind: AuditKind, opts?: AuditEntryOptions): void;
  /** The bounded queryable window (most recent `max` entries, oldest first). */
  entries(): AuditEntry[];
  tail(n: number): AuditEntry[];
  count(kind: AuditKind): number;
  lastError(): AuditEntry | null;
  /** Entries recorded since the previous flush — the increment to persist. */
  flush(): AuditEntry[];
}

export function createAuditLog(opts: { max?: number } = {}): AuditLog {
  const max = Math.max(1, opts.max ?? AUDIT_MAX_BUFFERED);
  const ring: AuditEntry[] = [];
  let pending: AuditEntry[] = [];

  return {
    record(entry: AuditEntry): void {
      ring.push(entry);
      if (ring.length > max) ring.splice(0, ring.length - max);
      pending.push(entry);
    },

    recordError(err, kind, recordOpts = {}): void {
      const message = errorText(err);
      this.record(
        auditEntry(kind, {
          ...recordOpts,
          detail: recordOpts.detail ? `${recordOpts.detail}: ${message}` : message,
        }),
      );
    },

    entries(): AuditEntry[] {
      return [...ring];
    },

    tail(n: number): AuditEntry[] {
      return ring.slice(Math.max(0, ring.length - n));
    },

    count(kind: AuditKind): number {
      return ring.filter((e) => e.kind === kind).length;
    },

    lastError(): AuditEntry | null {
      for (let i = ring.length - 1; i >= 0; i -= 1) {
        const entry = ring[i];
        if (entry && isErrorKind(entry.kind)) return entry;
      }
      return null;
    },

    flush(): AuditEntry[] {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

// ── JSONL persistence ────────────────────────────────────────────────────────

/**
 * Append entries as one JSON object per line. Callers own the error handling:
 * the poller treats a failed append like a failed cursor write (log it, keep
 * running).
 */
export async function appendAuditFile(file: string, entries: readonly AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  await appendFile(file, `${lines}\n`, "utf8");
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (e.v !== AUDIT_FORMAT_VERSION) return false;
  if (!isAuditKind(e.kind)) return false;
  if (typeof e.t !== "number" || !Number.isFinite(e.t)) return false;
  if (e.detail !== undefined && typeof e.detail !== "string") return false;
  if (e.source !== undefined && e.source !== "market" && e.source !== "squad") return false;
  return true;
}

export interface AuditFileSummary {
  file: string;
  generatedAt: string;
  /** Parseable entries kept for the report (the most recent `maxEntries`). */
  entries: AuditEntry[];
  /** Older parseable entries dropped from the report by the read cap. */
  droppedFromReport: number;
  /** Lines that were not valid audit entries (skipped, never fatal). */
  unreadableLines: number;
}

/** Read an audit JSONL file into a bounded report summary. */
export async function readAuditFile(
  file: string,
  opts: { maxEntries?: number } = {},
): Promise<AuditFileSummary> {
  const maxEntries = Math.max(1, opts.maxEntries ?? AUDIT_REPORT_MAX_ENTRIES);

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {
      file,
      generatedAt: new Date().toISOString(),
      entries: [],
      droppedFromReport: 0,
      unreadableLines: 0,
    };
  }

  const all: AuditEntry[] = [];
  let unreadableLines = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isAuditEntry(parsed)) all.push(parsed);
      else unreadableLines += 1;
    } catch {
      unreadableLines += 1;
    }
  }

  const entries = all.slice(Math.max(0, all.length - maxEntries));
  return {
    file,
    generatedAt: new Date().toISOString(),
    entries,
    droppedFromReport: all.length - entries.length,
    unreadableLines,
  };
}

// ── Summaries and rendering ──────────────────────────────────────────────────

export interface AuditStats {
  total: number;
  byKind: { kind: AuditKind; count: number }[];
  errorCount: number;
  lastError: AuditEntry | null;
  sendFailures: number;
  skippedEvents: number;
  cappedDrops: number;
  scanFailures: number;
  firstAt: string | null;
  lastAt: string | null;
}

/** Aggregate report entries. Pure: same entries in, same stats out. */
export function summarizeAudit(entries: readonly AuditEntry[]): AuditStats {
  const counts = new Map<AuditKind, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);

  let lastError: AuditEntry | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && isErrorKind(entry.kind)) {
      lastError = entry;
      break;
    }
  }

  const time = (entry: AuditEntry | undefined): string | null =>
    entry ? new Date(entry.t).toISOString() : null;

  return {
    total: entries.length,
    byKind: [...counts]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    errorCount: entries.filter((e) => isErrorKind(e.kind)).length,
    lastError,
    sendFailures: counts.get("send_failed") ?? 0,
    skippedEvents: counts.get("event_skipped") ?? 0,
    cappedDrops: counts.get("cap_reached") ?? 0,
    scanFailures: counts.get("cycle_failed") ?? 0,
    firstAt: time(entries[0]),
    lastAt: time(entries[entries.length - 1]),
  };
}

/** One line: `<iso> [kind] source: detail`. Re-redacted defensively. */
export function renderAuditLine(entry: AuditEntry): string {
  const when = new Date(entry.t).toISOString();
  const source = entry.source ? ` ${entry.source}:` : "";
  const detail = entry.detail ? ` ${redact(entry.detail)}` : "";
  return `${when} [${entry.kind}]${source}${detail}`;
}

/**
 * The human-readable report. Plain text on purpose: audit lines are arbitrary
 * redacted strings, so sending them through MarkdownV2 would either need full
 * escaping everywhere or mangle them.
 */
export function renderAuditReport(summary: AuditFileSummary, opts: { tail?: number } = {}): string {
  const stats = summarizeAudit(summary.entries);
  const lines: string[] = [];

  lines.push(`Operator audit report — ${summary.file}`);
  lines.push(`Generated: ${summary.generatedAt}`);

  if (stats.total === 0) {
    if (summary.unreadableLines > 0) {
      lines.push(`No readable entries; ${summary.unreadableLines} unreadable line(s) skipped.`);
    } else {
      lines.push("No entries recorded yet.");
    }
    return lines.join("\n");
  }

  lines.push(
    `Window: ${stats.firstAt} .. ${stats.lastAt} ` +
      `(${stats.total} entries` +
      (summary.droppedFromReport > 0 ? `, ${summary.droppedFromReport} older not shown` : "") +
      (summary.unreadableLines > 0 ? `, ${summary.unreadableLines} unreadable skipped` : "") +
      ")",
  );
  lines.push(
    `Errors: ${stats.errorCount} · scan failures: ${stats.scanFailures} · ` +
      `send failures: ${stats.sendFailures} · skipped events: ${stats.skippedEvents} · ` +
      `cap drops: ${stats.cappedDrops}`,
  );
  lines.push(
    `By kind: ${stats.byKind.map(({ kind, count }) => `${kind} ${count}`).join(", ")}`,
  );

  if (stats.lastError) {
    lines.push(`Last error: ${renderAuditLine(stats.lastError)}`);
  }

  const tail = Math.max(0, opts.tail ?? 10);
  if (tail > 0) {
    lines.push("", "Recent:");
    for (const entry of summary.entries.slice(-tail)) {
      lines.push(renderAuditLine(entry));
    }
  }

  return lines.join("\n");
}
