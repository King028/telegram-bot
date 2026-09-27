/**
 * Read contract events from Soroban RPC, cursor-paginated.
 *
 * ── Why this is not a block-range scan ───────────────────────────────────────
 *
 * The instinct carried over from EVM is `eth_getLogs(fromBlock, toBlock)`:
 * addressable, chunkable, parallelisable, and done when a page comes back
 * short. Soroban's `getEvents` is none of those things:
 *
 *  - It returns an opaque `cursor` that must be fed into the next request, so
 *    the walk is inherently SEQUENTIAL. There is no chunk fan-out to tune.
 *  - `startLedger`/`endLedger` and `cursor` are MUTUALLY EXCLUSIVE in the
 *    request; sending both is rejected. Hence the two request shapes below.
 *  - The RPC keeps only a ROLLING WINDOW of events (~120_960 ledgers, about a
 *    week, on Testnet). A `startLedger` below the retained `oldestLedger` is an
 *    ERROR, not an empty result — so the floor is clamped from `getHealth()`
 *    before the first request. A `startLedger` ABOVE the tip, or a resume cursor
 *    outside the window, is likewise an error, and is refused here with a
 *    bounded message instead of being sent. This is also why event history can
 *    never be the source of truth for current state.
 *  - **AN EMPTY PAGE DOES NOT MEAN THE SCAN IS DONE.** This is the trap. One
 *    request scans a bounded slice of ledgers and returns whatever it found
 *    there — frequently nothing — plus a cursor to carry on from. Stopping on a
 *    short or empty page (correct for `eth_getLogs`) silently returns zero
 *    events for any contract whose activity is far past the scan floor.
 *
 * So the walk terminates on the CURSOR, not on the payload: when the cursor
 * stops advancing, runs out, or passes the end of the requested range.
 *
 * ── Difference from a one-shot scan ──────────────────────────────────────────
 *
 * This reader is built for TAILING, so it returns the last cursor it saw even
 * when it reached the chain tip. That is the resume token the poller persists;
 * a scan that only returned a cursor when it gave up early would force the next
 * cycle to re-derive its position from a ledger number and re-notify.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { rpc } from "@stellar/stellar-sdk";

import { readAuditFile, renderAuditReport, summarizeAudit } from "../audit.js";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from "../dedup.js";
import { loadStellarConfig, networkLabel } from "../config.js";
import {
  clampStartLedger,
  createRpcServer,
  LedgerWindowError,
  validateLedgerWindow,
  type LedgerWindow,
} from "./client.js";
import {
  decodeEvent,
  dedupeEvents,
  formatUsdc,
  isAdminPayload,
  sortEvents,
  type ContractSource,
  type DecodedEvent,
} from "./decode.js";

/** Events per request. The RPC caps this; 200 is well inside it. */
export const EVENT_PAGE_LIMIT = 200;

/** Pages per scan. Bounds one poll cycle's worst case. */
export const EVENT_MAX_PAGES = 20;

export interface ScanOptions {
  /** Resume token from a previous scan. Ignored `startLedger` when set. */
  cursor?: string | undefined;
  /** Only used when there is no `cursor`. Clamped up to the retained floor. */
  startLedger?: number | undefined;
  /**
   * Used when neither `cursor` nor `startLedger` is given: start this many
   * ledgers behind the tip. A cold-start bound, so a fresh bot does not replay
   * a week of history into the chat.
   */
  lookbackLedgers?: number | undefined;
  limit?: number | undefined;
  maxPages?: number | undefined;
  /**
   * Event ids already processed before this walk — the previous cycle's
   * window, restored from the cursor file. Seeding them is what stops an
   * inclusive cursor boundary from re-announcing an event after a resume or a
   * restart.
   */
  seenEventIds?: readonly string[] | undefined;
  /**
   * How many recent event ids to retain while suppressing redelivery. `0`
   * disables deduplication. Defaults to {@link DEFAULT_DEDUP_WINDOW}.
   */
  dedupWindow?: number | undefined;
}

export interface RawScan {
  events: rpc.Api.EventResponse[];
  /** Last cursor observed — feed back as `cursor` next cycle. */
  cursor: string | null;
  latestLedger: number;
  /** Oldest ledger the RPC still retains. Anything earlier is invisible. */
  oldestLedger: number;
  /** True when `maxPages` stopped the walk before the tip. */
  truncated: boolean;
  pages: number;
  /** Events dropped because an earlier page or cycle already returned them. */
  duplicates: number;
  /** Ledger the walk started from after clamping, or null when resuming. */
  startLedger: number | null;
  /** True when the requested start was below the retained floor and clamped up. */
  startClamped: boolean;
}

/**
 * A cursor is `<TOID>-<index>`, and a TOID packs the ledger sequence into its
 * high 32 bits. Reading it lets the walk know it reached the end of the range
 * from the response it already has, instead of spending another round trip to
 * discover the cursor stopped moving.
 *
 * Returns `null` for anything that is not a numeric `<TOID>-…` cursor — an
 * opaque token the RPC is free to change shape on. Callers must treat `null`
 * as "unknown position", never as ledger 0.
 */
export function eventCursorLedger(cursor: string): number | null {
  if (typeof cursor !== "string") return null;
  const toid = cursor.split("-")[0];
  if (!toid || !/^\d+$/.test(toid)) return null;
  try {
    return Number(BigInt(toid) >> 32n);
  } catch {
    return null;
  }
}

/** Where a resume cursor falls relative to the retained window. */
export type ResumeCursorIssue = "cursor-before-floor" | "cursor-after-tip";

/**
 * Place a resume cursor relative to the retained window.
 *
 * Returns null when the cursor is inside the window *or* when its ledger cannot
 * be read from the opaque token. Opacity matters: a cursor shape this build does
 * not understand must still be forwarded to the RPC, so only a cursor this build
 * can *positively* place outside the window is classified at all.
 *
 * `cursor-before-floor` is a retention boundary the RPC owns, so the reader
 * classifies it but still forwards the cursor — the RPC's bounded stale
 * rejection stays authoritative. The poller uses the same classification to
 * decide whether to rewind to the floor, and it only does so when a fresh
 * `getHealth()` proves the cursor is below it (see `src/poller.ts`).
 * `cursor-after-tip` is impossible for a token this chain minted, so the caller
 * refuses it rather than sending a request that is guaranteed to fail.
 */
export function resumeCursorProblem(
  cursor: string,
  window: LedgerWindow,
): ResumeCursorIssue | null {
  const ledger = eventCursorLedger(cursor);
  if (ledger === null) return null;
  if (ledger < window.oldestLedger) return "cursor-before-floor";
  if (ledger > window.latestLedger) return "cursor-after-tip";
  return null;
}

export async function paginatedGetEvents(
  server: rpc.Server,
  filters: rpc.Api.EventFilter[],
  opts: ScanOptions = {},
): Promise<RawScan> {
  const limit = Math.max(1, opts.limit ?? EVENT_PAGE_LIMIT);
  const maxPages = Math.max(1, opts.maxPages ?? EVENT_MAX_PAGES);

  const window = validateLedgerWindow(await server.getHealth());
  const oldestLedger = window.oldestLedger;

  // One window for the whole walk, pre-seeded with what earlier cycles have
  // already announced. Pages of a cursor walk can overlap; without this the
  // same event is both notified twice and re-counted.
  const dedup = new EventDedupWindow(opts.dedupWindow ?? DEFAULT_DEDUP_WINDOW);
  for (const id of opts.seenEventIds ?? []) dedup.add(id);

  const events: rpc.Api.EventResponse[] = [];
  let cursor: string | undefined = opts.cursor;
  let lastCursor: string | null = opts.cursor ?? null;
  let previousCursor = "";
  let latestLedger = window.latestLedger;
  let truncated = false;
  let pages = 0;
  let duplicates = 0;

  // Resolve the first request against the window before spending it: a cursor
  // wins over `startLedger` (the RPC rejects both together), and a start ledger
  // is placed inside the window.
  let startLedger: number | null = null;
  let startClamped = false;

  if (cursor) {
    // Only a cursor above the tip is refused here. A cursor below the retained
    // floor is forwarded: retention is the RPC's to judge, and its bounded
    // stale rejection is what the poller acts on (rewinding only when it can
    // prove the cursor is below the floor).
    if (resumeCursorProblem(cursor, window) === "cursor-after-tip") {
      const ledger = eventCursorLedger(cursor);
      throw new LedgerWindowError(
        "cursor-after-tip",
        `cursor ledger ${ledger} is ahead of the chain tip ${window.latestLedger}`,
      );
    }
  } else {
    const requestedStart = Math.max(
      1,
      Number(opts.startLedger ?? window.latestLedger - (opts.lookbackLedgers ?? 0)),
    );
    const clamped = clampStartLedger(requestedStart, window);
    startLedger = clamped.startLedger;
    startClamped = clamped.clamped;
  }

  const firstStartLedger = startLedger ?? window.oldestLedger;

  for (;;) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    pages += 1;

    // The two request shapes are a discriminated union on `cursor`, so they are
    // built separately rather than spread into one object.
    const response: rpc.Api.GetEventsResponse = cursor
      ? await server.getEvents({ filters, cursor, limit })
      : await server.getEvents({ filters, startLedger: firstStartLedger, limit });

    const rawEvents = Array.isArray(response?.events) ? response.events : [];
    // Drop anything an earlier page (or an earlier cycle) already produced.
    // Order is preserved: the first occurrence wins, matching the RPC's own
    // event ordering.
    for (const event of rawEvents) {
      if (dedup.add(eventKey(event))) events.push(event);
      else duplicates += 1;
    }
    latestLedger = response?.latestLedger ?? latestLedger;

    const nextCursor = typeof response?.cursor === "string" ? response.cursor : "";
    // Out of cursor, or the server stopped moving: nothing left to read.
    if (!nextCursor || nextCursor === previousCursor) break;

    lastCursor = nextCursor;

    // The cursor's ledger says how far the scan actually got. At or past the
    // chain tip and there is no more to ask for — but keep the cursor, that is
    // exactly where the next cycle resumes.
    const reached = eventCursorLedger(nextCursor);
    if (reached !== null && reached >= latestLedger) break;

    previousCursor = nextCursor;
    cursor = nextCursor;
  }

  return {
    events,
    cursor: lastCursor,
    latestLedger,
    oldestLedger,
    truncated,
    pages,
    duplicates,
    startLedger,
    startClamped,
  };
}

export interface WatchTarget {
  source: ContractSource;
  contractId: string;
}

export interface ContractScan extends Omit<RawScan, "events"> {
  source: ContractSource;
  contractId: string;
  events: DecodedEvent[];
  /** Highest ledger among the returned events, or null when there were none. */
  lastEventLedger: number | null;
}

/** Scan one contract and decode everything it returned. */
export async function readContractEvents(
  server: rpc.Server,
  target: WatchTarget,
  opts: ScanOptions = {},
): Promise<ContractScan> {
  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [target.contractId] }],
    opts,
  );

  // `decodeEvent` never throws, so a malformed entry degrades to an `unknown`
  // payload instead of killing the scan. Raw entries that are not objects at
  // all are skipped — there is nothing to decode and no paging token to keep.
  const rawEvents = Array.isArray(scan.events) ? scan.events : [];
  const decoded: DecodedEvent[] = [];
  for (const event of rawEvents) {
    if (!event || typeof event !== "object") continue;
    decoded.push(decodeEvent(target.source, event));
  }

  // Deterministic order from chain metadata (ledger → transaction index →
  // operation index → paging token), independent of RPC page splits. Duplicate
  // paging tokens — the RPC may repeat a page-boundary event — notify once.
  const events = sortEvents(dedupeEvents(decoded));
  const ledgers = events.map((e) => e.ledger).filter((l) => l > 0);

  return {
    source: target.source,
    contractId: target.contractId,
    events,
    cursor: scan.cursor,
    latestLedger: scan.latestLedger,
    oldestLedger: scan.oldestLedger,
    truncated: scan.truncated,
    pages: scan.pages,
    duplicates: scan.duplicates,
    startLedger: scan.startLedger,
    startClamped: scan.startClamped,
    lastEventLedger: ledgers.length > 0 ? Math.max(...ledgers) : null,
  };
}

// ── Standalone verification CLI ───────────────────────────────────────────────
//
//   npm run scan                  # both contracts, from the retained floor
//   npm run scan -- --pages 40    # walk further
//   npm run scan -- --show 5      # print 5 decoded events per contract
//   npm run scan -- --from 123456 # explicit start ledger
//   npm run scan -- --json        # machine-readable JSON on stdout (progress on stderr)
//
// Needs no BOT_TOKEN: the public Testnet RPC is unauthenticated, so this reads
// live chain data with nothing but the contract ids.
//
// `--json` prints one mimir-scan-v1 document to stdout so the scan can be piped
// into jq / CI. Progress and errors go to stderr so they never corrupt the JSON.
//   npm run scan -- --mock        # local mock profile: no network, no credentials
//
// Needs no BOT_TOKEN: the public Testnet RPC is unauthenticated, so this reads
// live chain data with nothing but the contract ids. `--mock` instead points
// the same reader at a local mock Soroban RPC (`npm run mock:rpc`), selecting
// the `MIMIR_PROFILE=mock` defaults for anything the environment leaves unset.
//
// The same built binary also renders the operator audit report (npm run audit,
// src/audit-cli.ts): report from data/audit.jsonl, --tail, --json, --file.

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** True when `--name` appears anywhere in argv (boolean CLI switches). */
export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** JSON.stringify replacer: bigint becomes a decimal string (never leaked as Number). */
export function scanJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export interface ScanJsonEvent {
  ledger: number;
  txHash: string;
  eventId: string;
  summary: string;
  /** Decoded payload; bigints serialize as decimal strings via {@link scanJsonReplacer}. */
  payload: DecodedEvent["payload"];
}

export interface ScanJsonTarget {
  source: ContractSource;
  contractId: string;
  pages: number;
  eventCount: number;
  truncated: boolean;
  lastEventLedger: number | null;
  cursor: string | null;
  /** Ledger the walk started from after clamping, or null when resuming. */
  startLedger: number | null;
  /** True when the requested start was below the retained floor and clamped up. */
  startClamped: boolean;
  histogram: Record<string, number>;
  /** Last N decoded events (controlled by `--show`); never includes secrets. */
  events: ScanJsonEvent[];
}

export interface ScanJsonReport {
  format: "mimir-scan-v1";
  network: string;
  rpcUrl: string;
  ledgers: { oldest: number; latest: number };
  targets: ScanJsonTarget[];
}

/** Event-name histogram used by both the human CLI and JSON report. */
export function eventHistogram(events: DecodedEvent[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key =
      event.payload.name === "unknown"
        ? `unknown:${event.payload.eventName || "?"}`
        : event.payload.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Build one contract's JSON target from a completed {@link ContractScan}. */
export function buildScanJsonTarget(scan: ContractScan, show: number): ScanJsonTarget {
  const limit = Number.isFinite(show) && show > 0 ? Math.floor(show) : 0;
  return {
    source: scan.source,
    contractId: scan.contractId,
    pages: scan.pages,
    eventCount: scan.events.length,
    truncated: scan.truncated,
    lastEventLedger: scan.lastEventLedger,
    cursor: scan.cursor,
    startLedger: scan.startLedger ?? null,
    startClamped: scan.startClamped ?? false,
    histogram: eventHistogram(scan.events),
    // slice(-0) would return everything, so show=0 must be special-cased
    events: (limit > 0 ? scan.events.slice(-limit) : []).map((event) => ({
      ledger: event.ledger,
      txHash: event.txHash,
      eventId: event.eventId,
      summary: summarize(event),
      payload: event.payload,
    })),
  };
}

export function buildScanJsonReport(input: {
  network: string;
  rpcUrl: string;
  oldestLedger: number;
  latestLedger: number;
  targets: ScanJsonTarget[];
}): ScanJsonReport {
  return {
    format: "mimir-scan-v1",
    network: input.network,
    rpcUrl: input.rpcUrl,
    ledgers: { oldest: input.oldestLedger, latest: input.latestLedger },
    targets: input.targets,
  };
}

/** Pretty-printed JSON document ending in a newline (safe to pipe). */
export function formatScanJson(report: ScanJsonReport): string {
  return JSON.stringify(report, scanJsonReplacer, 2) + "\n";
}

/**
 * Run the operator audit report CLI. Exported so `src/audit-cli.ts` can be the
 * real entrypoint (`npm run audit`) while the chain scanner stays the default.
 */
export async function runAuditCli(): Promise<void> {
  const file = flag("file") ?? "./data/audit.jsonl";
  const tail = Math.max(0, Number(flag("tail") ?? 10));

  if (!existsSync(file)) {
    console.log(`No audit log at ${file} — nothing recorded yet (or AUDIT_FILE points elsewhere).`);
    return;
  }

  const summary = await readAuditFile(file);

  if (hasFlag("json")) {
    console.log(JSON.stringify(summarizeAudit(summary.entries), null, 2));
  } else {
    console.log(renderAuditReport(summary, { tail }));
  }

  if (summary.unreadableLines > 0) {
    console.warn(`[audit] ${summary.unreadableLines} unreadable line(s) were skipped`);
  }
}

function summarize(event: DecodedEvent): string {
  const p = event.payload;
  const money = (v: bigint) => `${formatUsdc(v)} USDC`;
  switch (p.name) {
    case "claim_created":
      return `claim #${p.claimId} created by ${p.creator} [${p.category}]`;
    case "claim_challenged":
      return `claim #${p.claimId} challenged by ${p.challenger} for ${money(p.stake)}`;
    case "claim_resolved":
      return `claim #${p.claimId} resolved winner_side=${p.winnerSide} confidence=${p.confidence}`;
    case "market_settled":
      return `claim #${p.claimId} settled paid=${money(p.totalPaid)} fees=${money(p.totalFees)}`;
    case "challenger_paid":
      return `claim #${p.claimId} paid ${p.challenger} net=${money(p.net)}`;
    case "market_created":
      return `squad market #${p.marketId} by ${p.captain}: ${p.question}`;
    case "deposited":
      return `squad #${p.marketId} side=${p.side} ${p.participant} deposited ${money(p.amount)}`;
    case "resolved":
      return `squad #${p.marketId} resolved result=${p.result}`;
    case "claimed":
      return `squad #${p.marketId} ${p.participant} claimed net=${money(p.net)}`;
    case "oracle_changed":
      return `oracle changed to ${p.newOracle ?? "unknown"}`;
    case "ownership_transferred":
      return `ownership transferred to ${p.newOwner ?? "unknown"}`;
    case "agent_attributed":
      return `agent attributed ${p.agent ?? "unknown"}`;
    case "fee_accrued":
      return `fee accrued ${p.amount !== undefined ? money(p.amount) : ""} to ${p.recipient ?? "unknown"}`;
    case "admin":
      return `admin event ${p.action}`;
    case "unknown":
      return `unknown "${p.eventName}"${p.reason ? ` (${p.reason})` : ""}`;
    default:
      if (isAdminPayload(p)) return `admin event ${p.name}`;
      return p.name;
  }
}

function boundedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return typeof item === "bigint" ? item.toString() : item;
    const compact = item.replace(/\s+/g, " ").trim();
    return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
  });
}

async function main(): Promise<void> {
  // `--mock` opts into the local mock profile before config is read. An
  // explicit MIMIR_PROFILE in the environment still wins; blank counts as unset.
  if (process.argv.includes("--mock") && !process.env.MIMIR_PROFILE?.trim()) {
    process.env.MIMIR_PROFILE = "mock";
  }

  const config = loadStellarConfig();
  const server = createRpcServer(config);
  const pages = Number(flag("pages") ?? EVENT_MAX_PAGES);
  const show = Number(flag("show") ?? 3);
  const from = flag("from");
  const asJson = hasFlag("json");

  const health = await server.getHealth();
  const network = networkLabel(config);

  // When `--json` is set, stdout is reserved for one JSON document. Progress
  // goes to stderr so piping (`npm run scan -- --json | jq`) stays valid.
  const progress = asJson ? console.error.bind(console) : console.log.bind(console);

  if (!asJson) {
    console.log(`RPC        ${config.rpcUrl} (${network})`);
    console.log(`ledgers    oldest=${health.oldestLedger} latest=${health.latestLedger}`);
  } else {
    progress(
      `scanning ${network} ledgers oldest=${health.oldestLedger} latest=${health.latestLedger}`,
    );
  }

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const jsonTargets: ScanJsonTarget[] = [];

  for (const target of targets) {
    if (!asJson) {
      console.log(`\n=== ${target.source}  ${target.contractId} ===`);
    }

    const scan = await readContractEvents(server, target, {
      maxPages: pages,
      startLedger: from ? Number(from) : health.oldestLedger,
    });

    if (asJson) {
      jsonTargets.push(buildScanJsonTarget(scan, show));
      progress(
        `scanned ${target.source}: events=${scan.events.length} pages=${scan.pages} truncated=${scan.truncated}`,
      );
      continue;
    }

    const counts = eventHistogram(scan.events);

    console.log(
      `pages=${scan.pages} events=${scan.events.length} duplicates=${scan.duplicates} ` +
        `truncated=${scan.truncated} lastEventLedger=${scan.lastEventLedger} cursor=${scan.cursor} ` +
        `start=${scan.startLedger ?? "cursor"}${scan.startClamped ? " (clamped)" : ""}`,
    );
    for (const [name, count] of Object.entries(counts)) {
      console.log(`  ${count.toString().padStart(4)}  ${name}`);
    }

    for (const event of show > 0 ? scan.events.slice(-show) : []) {
      console.log(`\n  ledger ${event.ledger}  tx ${event.txHash}`);
      console.log(`  ${summarize(event)}`);
      console.log(
        `  ${boundedJson(event.payload)}`,
      );
    }
  }

  if (asJson) {
    const report = buildScanJsonReport({
      network,
      rpcUrl: config.rpcUrl,
      oldestLedger: health.oldestLedger,
      latestLedger: health.latestLedger,
      targets: jsonTargets,
    });
    process.stdout.write(formatScanJson(report));
  }
}

// Only when executed directly, not when imported by the poller. The audit
// report has its own entrypoint (src/audit-cli.ts) that calls runAuditCli().
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
