/**
 * Local HTTP health endpoint for process supervisors and deploy checks.
 *
 * Bound to loopback by default so it is never an accidental public surface.
 * Responses are JSON-only operational status: no bot tokens, private keys,
 * chat ids, or raw remote payloads. The `config` section names each setting and
 * the source that supplied it — the one thing about configuration that is safe
 * to publish is where it came from.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { configProvenance, networkLabel, type BotConfig, type ConfigProvenance } from "./config.js";
import type { PollerStatus } from "./poller.js";

export interface HealthDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /**
   * Optional provenance reader for deterministic tests. Defaults to
   * {@link configProvenance}; either way only key names and origins are served.
   */
  provenance?: () => ConfigProvenance;
}

export interface HealthServer {
  /** Resolved listen URL, e.g. http://127.0.0.1:8787. Null when disabled. */
  url: string | null;
  /** Port actually bound (0 when disabled). */
  port: number;
  close(): Promise<void>;
}

/** Safe, redacted snapshot for HTTP clients. Never includes secrets. */
export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "stopped";
  service: "mimir-telegram-bot";
  network: string;
  uptimeMs: number;
  checkedAt: string;
  poller: {
    running: boolean;
    /** Intentional operator pause; process is ready but scheduling is stopped. */
    paused: boolean;
    /** A graceful shutdown is draining: no new cycles, unsent messages dropped. */
    stopping: boolean;
    channelPreviewMode: boolean;
    cycles: number;
    lastPollAt: string | null;
    lastSuccessAt: string | null;
    latestLedger: number | null;
    oldestLedger: number | null;
    /** Newest observed chain close time (ISO 8601); null until one is seen. */
    chainClockAt: string | null;
    /**
     * Chain clock skew in ms: `checkedAt - chainClockAt`. Positive while the
     * bot's clock is ahead of the newest chain time it has seen, negative when
     * it is behind, null when no chain time has been observed yet (cold start,
     * or a run of scans that returned no events).
     */
    chainClockSkewMs: number | null;
    notificationsSent: number;
    notificationsFailed: number;
    eventsSkipped: number;
    /** Events suppressed as already-seen across overlapping pages / resumes. */
    eventsDeduplicated: number;
    notificationsDropped: number;
    /** Cursors automatically rewound to the RPC's retained floor this run. */
    cursorRewinds: number;
    consecutiveFailures: number;
    lastError: { at: string; message: string } | null;
    /**
     * In-memory cursor state that is not on disk yet. False after a successful
     * flush, which is what a shutdown is for.
     */
    pendingFlush: boolean;
    lastFlushAt: string | null;
    targets: Array<{
      source: string;
      /** Public contract id (on-chain). */
      contractId: string;
      lastEventLedger: number | null;
      /** Opaque resume cursor; not a secret. Truncated for readability. */
      cursorPreview: string | null;
      /** Ledger a target is resuming from after a floor rewind, or null. */
      rewindFromLedger: number | null;
      hasError: boolean;
    }>;
  };
  /**
   * Where configuration came from: each setting's name and the source that
   * supplied it. No value — secret or not — is ever included, so an operator
   * can confirm *which* token and chat id this process is using without either
   * of them leaving the process.
   */
  config: ConfigProvenance;
}

const CURSOR_PREVIEW_LEN = 24;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function previewCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  if (cursor.length <= CURSOR_PREVIEW_LEN) return cursor;
  return `${cursor.slice(0, CURSOR_PREVIEW_LEN)}…`;
}

/** Bounded human duration for a skew: s, m, h, d, then years. */
function formatSkew(absMs: number): string {
  const dayMs = 86_400_000;
  if (absMs < 60_000) return `${(absMs / 1000).toFixed(1)}s`;
  if (absMs < 3_600_000) return `${Math.round(absMs / 60_000)}m`;
  if (absMs < 3_600_000 * 24) return `${Math.round(absMs / 3_600_000)}h`;
  if (absMs < dayMs * 365) return `${Math.round(absMs / dayMs)}d`;
  return `${Math.round(absMs / (dayMs * 365))}y`;
}

/**
 * Human rendering of the chain clock skew, shared by `/status` and `/health`.
 *
 * `chainClockAt` is the newest chain close time the poller observed; the skew
 * is `nowMs - chainClockAt`. The wording always names the side that is ahead,
 * because a bare "+3s" or "behind" is ambiguous about which clock is wrong.
 *
 * Returns plain text (no Markdown): pass it through `escapeMd` before putting
 * it in a Telegram message. `unknown` before the first observation, `in sync`
 * inside one second, otherwise a bounded `s`/`m`/`h`/`d`/`y` duration.
 */
export function chainClockLabel(chainClockAt: number | null | undefined, nowMs: number): string {
  if (typeof chainClockAt !== "number" || !Number.isFinite(chainClockAt)) return "unknown";
  const skewMs = nowMs - chainClockAt;
  const abs = Math.abs(skewMs);
  if (abs < 1_000) return "in sync";
  const human = formatSkew(abs);
  return skewMs >= 0
    ? `local clock ${human} ahead of chain`
    : `chain clock ${human} ahead of local`;
}

/**
 * Build a health report from poller status.
 *
 * - `ok` / HTTP 200 when the poller is running and has not exceeded the
 *   consecutive-failure budget (and, once it has succeeded at least once,
 *   a successful poll happened within `healthStaleMs`).
 * - `degraded` / HTTP 503 when running but stale or failing repeatedly.
 * - `stopped` / HTTP 503 when the poller is not running.
 */
export function buildHealthReport(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number = Date.now(),
  provenance: ConfigProvenance = configProvenance(),
): HealthReport {
  const uptimeMs = poller.startedAt > 0 ? Math.max(0, nowMs - poller.startedAt) : 0;
  // Tolerate a status snapshot that never learned about the chain clock (and
  // any non-finite value): the report must stay JSON-serialisable, never NaN.
  const chainClockAt =
    typeof poller.chainClockAt === "number" && Number.isFinite(poller.chainClockAt)
      ? poller.chainClockAt
      : null;

  let status: HealthReport["status"];
  if (!poller.running) {
    status = "stopped";
  } else if (poller.stopping === true) {
    // A deliberate drain is doing exactly what it was asked to do. It is not a
    // stale or failing poller, and `poller.stopping` is how clients tell the
    // difference from an operator pause.
    status = "ok";
  } else if (poller.paused) {
    // A deliberate operator pause is healthy, not a stale or failing poller.
    status = "ok";
  } else {
    const failureBudget = Math.max(3, Math.ceil(60_000 / Math.max(config.pollIntervalMs, 1)));
    const tooManyFailures = poller.consecutiveFailures >= failureBudget;
    const hasEverSucceeded = poller.lastSuccessAt !== null;
    const stale =
      hasEverSucceeded &&
      config.healthStaleMs > 0 &&
      nowMs - (poller.lastSuccessAt as number) > config.healthStaleMs;
    status = tooManyFailures || stale ? "degraded" : "ok";
  }

  return {
    ok: status === "ok",
    status,
    service: "mimir-telegram-bot",
    network: networkLabel(config),
    uptimeMs,
    checkedAt: new Date(nowMs).toISOString(),
    poller: {
      running: poller.running,
      paused: poller.paused === true,
      stopping: poller.stopping === true,
      channelPreviewMode: config.channelPreviewMode === true,
      cycles: poller.cycles,
      lastPollAt: iso(poller.lastPollAt),
      lastSuccessAt: iso(poller.lastSuccessAt),
      latestLedger: poller.latestLedger,
      oldestLedger: poller.oldestLedger,
      chainClockAt: iso(chainClockAt),
      chainClockSkewMs: chainClockAt === null ? null : nowMs - chainClockAt,
      notificationsSent: poller.notificationsSent,
      notificationsFailed: poller.notificationsFailed,
      eventsSkipped: poller.eventsSkipped,
      eventsDeduplicated: poller.eventsDeduplicated ?? 0,
      notificationsDropped: poller.notificationsDropped ?? 0,
      cursorRewinds: poller.cursorRewinds ?? 0,
      consecutiveFailures: poller.consecutiveFailures,
      lastError: poller.lastError
        ? { at: new Date(poller.lastError.at).toISOString(), message: poller.lastError.message }
        : null,
      pendingFlush: poller.pendingFlush === true,
      lastFlushAt: iso(poller.lastFlushAt ?? null),
      targets: poller.targets.map((t) => ({
        source: t.source,
        contractId: t.contractId,
        lastEventLedger: t.lastEventLedger,
        cursorPreview: previewCursor(t.cursor),
        rewindFromLedger: typeof t.rewindFromLedger === "number" ? t.rewindFromLedger : null,
        hasError: t.lastError !== null,
      })),
    },
    config: provenance,
  };
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Start the local health HTTP server.
 *
 * `HEALTH_PORT=0` (or a resolved port of 0) disables the listener entirely —
 * useful for unit tests and one-shot CLI runs that must not bind a port.
 */
export function startHealthServer(deps: HealthDeps): HealthServer {
  const { config, status } = deps;
  const now = deps.now ?? Date.now;
  const provenance = deps.provenance ?? configProvenance;

  if (config.healthPort === 0) {
    console.log("[health] disabled (HEALTH_PORT=0)");
    return { url: null, port: 0, close: async () => undefined };
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${config.healthHost}`);

    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      const report = buildHealthReport(config, status(), now(), provenance());
      sendJson(res, report.ok ? 200 : 503, report);
      return;
    }

    if (method === "GET" && (url.pathname === "/health/live" || url.pathname === "/livez")) {
      // Liveness: the process is up and the HTTP server can answer. Do not
      // reflect poller degradation here — supervisors use /health for that.
      sendJson(res, 200, {
        ok: true,
        status: "live",
        service: "mimir-telegram-bot",
        checkedAt: new Date(now()).toISOString(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        service: "mimir-telegram-bot",
        health: "/health",
        live: "/health/live",
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  // Failures after listen (e.g. client aborts) must not take down the notifier.
  server.on("error", (err) => {
    console.error(`[health] server error: ${err instanceof Error ? err.message : err}`);
  });

  server.listen(config.healthPort, config.healthHost);

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.healthPort;
  const url = `http://${config.healthHost}:${port}`;
  console.log(`[health] listening on ${url} (GET /health, GET /health/live)`);

  return {
    url,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
