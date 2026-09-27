/**
 * Entry point: config -> RPC client -> bot -> poller -> local health HTTP.
 *
 * Startup is fail-fast (a bad config exits non-zero with the reasons listed);
 * everything after startup is fail-soft, because the whole point of this process
 * is to still be running next week. Shutdown is the mirror image: one bounded
 * drain, one cursor flush, then exit.
 */

import { readFile } from "node:fs/promises";

import {
  ConfigError,
  activeProfileName,
  configProvenance,
  formatProvenanceSummary,
  loadConfig,
  networkLabel,
} from "./config.js";
import { formatFeatureFlags } from "./notifications/featureFlags.js";
import { auditEntry, createAuditLog } from "./audit.js";
import { InstanceLockError } from "./instanceLock.js";
import { createBot, createNotifier, registerCommands, type SendExtra } from "./bot.js";
import { startHealthServer } from "./health.js";
import { createPoller, waitForStartupHealth } from "./poller.js";
import type { ContractSource } from "./stellar/decode.js";
import { safeErrorMessage } from "./notifications/format.js";
import { createRpcServer } from "./stellar/client.js";
import { boundText } from "./status.js";

/**
 * Installed before anything else can throw, so a rejection during startup is
 * reported rather than printed by Node as a bare stack trace.
 */
function installProcessHandlers(): void {
  // A rejected promise nobody awaited is a bug, but not a reason to stop
  // notifying. Log it and let the poll loop carry on.
  process.on("unhandledRejection", (reason) => {
    console.error(`[error] unhandled rejection: ${safeErrorMessage(reason)}`);
  });

  // An uncaught exception means state is unknown; exit so the supervisor
  // restarts us. The persisted cursor is what makes that cheap.
  process.on("uncaughtException", (err) => {
    console.error(`[fatal] uncaught exception, exiting for restart: ${safeErrorMessage(err)}`);
    process.exit(1);
  });
}

/** Redacted shutdown marker: what stopped the process, and nothing else. */
function auditShutdownEntry(signal: string) {
  return auditEntry("shutdown", {
    detail: `stopped by ${signal === "SIGTERM" ? "SIGTERM" : "SIGINT"}`,
  });
}

/**
 * `--status` prints the last snapshot written by a running (or stopped) bot and
 * exits. It reads the file only — it never contacts Telegram or the RPC — so it
 * is safe to run from a health check, a cron job, or a shell on a box where the
 * bot is already running. Exit code 0 when a snapshot was read, 1 otherwise.
 */
async function printStatus(): Promise<void> {
  const config = loadConfig();
  let raw: string;
  try {
    raw = await readFile(config.statusFile, "utf8");
  } catch {
    console.error(
      `[status] no snapshot at ${config.statusFile}; is the bot running? ` +
        `(set STATUS_FILE to point at the running instance's file)`,
    );
    process.exit(1);
  }

  try {
    // Re-serialize rather than echoing the raw bytes: a corrupt or hand-edited
    // file must not be able to inject arbitrary text into a log or a pipe.
    const parsed = JSON.parse(raw) as unknown;
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error(`[status] snapshot is not valid JSON: ${boundText(String(err))}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  installProcessHandlers();

  if (process.argv.includes("--status")) {
    await printStatus();
    return;
  }

  const config = loadConfig();

  // The mock profile exists for the dry-run entry, not this one: warn loudly
  // so a profile left set in a deployment is noticed before Telegram rejects
  // the placeholder token.
  const profile = activeProfileName();
  if (profile !== null) {
    console.warn(
      `[boot] MIMIR_PROFILE=${profile} is set: this entry still talks to real Telegram; ` +
        `use "npm run mock:poll" for a credential-free dry run`,
    );
  }

  console.log(`[boot] Mimir Telegram notifier`);
  console.log(`[boot] network      ${networkLabel(config)} (${config.rpcUrl})`);
  console.log(`[boot] market       ${config.marketContractId}`);
  console.log(`[boot] squad        ${config.squadContractId}`);
  console.log(`[boot] cursor file  ${config.cursorFile}`);
  console.log(`[boot] flags        ${formatFeatureFlags(config.featureFlags)}`);
  console.log(`[boot] audit file   ${config.auditFile}`);
  console.log(`[boot] lock file    ${config.lockFile}`);
  console.log(`[boot] shutdown     ${config.shutdownTimeoutMs}ms drain budget`);
  console.log(
    `[boot] operator      ${config.operatorTelegramUserId === null ? "disabled" : "configured"}`,
  );
  console.log(
    `[boot] preview mode  ${config.channelPreviewMode ? "enabled" : "disabled"}`,
  );

  // Which setting came from where, then anything an operator can act on. Names
  // and origins only: a value never reaches this log, so a boot log can be
  // pasted into a ticket without redaction.
  const provenance = configProvenance();
  console.log(`[boot] config       ${formatProvenanceSummary(provenance)}`);
  for (const warning of provenance.warnings) {
    console.warn(`[boot] config       ${warning}`);
  }

  const server = createRpcServer(config);

  // Bounded retries before announcing readiness: a briefly unavailable RPC
  // (deploy race, Testnet blip) should not fail the whole boot, but a wrong
  // URL must still surface within STARTUP_HEALTH_DEADLINE_MS.
  const health = await waitForStartupHealth(server, {
    deadlineMs: config.startupHealthDeadlineMs,
    retryMs: config.startupHealthRetryMs,
  });
  console.log(
    `[boot] rpc ok (attempts=${health.attempts}), status=${health.status} ` +
      `ledgers ${health.oldestLedger}..${health.latestLedger}`,
  );

  // The bot needs the poller's status and the poller needs the bot's send path,
  // so one edge of the cycle is late-bound. This one, because it is the only
  // one that is a single function reference.
  let notify: (text: string, source?: ContractSource, extra?: SendExtra) => Promise<void> = async () => {
    throw new Error("telegram notifier not ready");
  };

  const audit = createAuditLog();
  audit.record(
    auditEntry("boot", {
      detail: `network=${networkLabel(config)} poll=${config.pollIntervalMs}ms`,
    }),
  );
  const poller = createPoller({
    config,
    server,
    send: (text, source, extra) => notify(text, source, extra),
    audit,
  });
  const bot = createBot({
    config,
    status: () => poller.status(),
    audit,
    pause: () => poller.pause(),
    resume: () => poller.resume(),
  });
  notify = createNotifier(bot, config);

  // Local-only health HTTP for supervisors. Starts before Telegram long-poll
  // so a deploy probe can see the process even while grammy is connecting.
  const healthServer = startHealthServer({ config, status: () => poller.status() });

  await registerCommands(bot);

  // Lock first: refuse a second live instance before Telegram long-polling starts.
  // That keeps a duplicate process from racing the cursor or fighting getUpdates.
  await poller.start();

  // grammy's `start` resolves only when the bot stops, so it is not awaited.
  // It retries transient network trouble internally; a rejection here means the
  // token itself cannot authenticate, which no amount of waiting fixes.
  void bot
    .start({
      onStart: (me) => console.log(`[boot] telegram ok, running as @${me.username}`),
    })
    .catch((err: unknown) => {
      console.error(
        `[fatal] telegram long-polling failed — check BOT_TOKEN: ` +
          safeErrorMessage(err, [config.botToken]),
      );
      void poller.stop().finally(() => process.exit(1));
    });

  let shuttingDown = false;

  /**
   * First signal: drain. The poller stops scheduling, drops what it has not
   * sent, waits a bounded time for the cycle in flight, and flushes its cursor
   * state — so the restart resumes where this process actually stopped.
   *
   * Second signal: the operator is out of patience. Exiting without the flush
   * is still safe for the file itself (write-then-rename), and the cost is a
   * cold-ish resume bounded by the last completed cycle.
   */
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      console.warn(`[shutdown] ${signal} received again during drain; forcing exit`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);

    // A clean-stop marker closes the audit window: anything after it belongs to
    // the next run, which is how an operator tells a crash from a restart.
    poller.audit.record(auditShutdownEntry(signal));

    // The drain is already bounded by SHUTDOWN_TIMEOUT_MS; this covers the
    // teardown after it (health socket, grammy stop) so a wedged close cannot
    // outlive the deploy. The cursor flush happens before either, so an exit
    // here has already persisted state. Unref'd: it never delays a clean exit.
    const teardownBudgetMs = config.shutdownTimeoutMs + 10_000;
    const watchdog: NodeJS.Timeout = setTimeout(() => {
      console.warn(
        `[shutdown] teardown still running after ${teardownBudgetMs}ms; exiting without it`,
      );
      process.exit(1);
    }, teardownBudgetMs);
    watchdog.unref();

    void (async () => {
      try {
        const result = await poller.shutdown();
        console.log(
          `[shutdown] poller ${result.drained ? "drained" : "hit the drain deadline"}; ` +
            `cursor ${result.flushed ? "flushed" : "flush failed"} after ${result.waitedMs}ms`,
        );
      } catch (err: unknown) {
        console.error(`[shutdown] poller drain failed: ${safeErrorMessage(err)}`);
      }

      try {
        await healthServer.close();
      } catch (err: unknown) {
        console.error(`[shutdown] health server close failed: ${safeErrorMessage(err)}`);
      }

      try {
        await bot.stop();
      } catch (err: unknown) {
        console.error(
          `[shutdown] telegram stop failed: ${safeErrorMessage(err, [config.botToken])}`,
        );
      }

      // Flush last so entries recorded while stopping are persisted.
      await poller.flushAuditFile().catch(() => undefined);
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof InstanceLockError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  console.error(`[boot] startup failed: ${safeErrorMessage(err)}`);
  process.exit(1);
});
