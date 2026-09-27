/**
 * Dry-run runner for the local Soroban mock profile (`MIMIR_PROFILE=mock`).
 *
 * Boots the in-process mock RPC, the REAL poller against it, and the local
 * health HTTP endpoint — with a log-only notifier instead of Telegram. This is
 * how failure modes (RPC errors, stale cursors, rate limits, restarts,
 * malformed events) are rehearsed end-to-end with no network, no bot token,
 * and no signing keys anywhere in the process.
 *
 *   npm run mock:poll                            # healthy mock, log-only sends
 *   npm run mock:poll -- --fail-events error     # every scan fails until cleared
 *   npm run mock:poll -- --stale-cursor          # reject cursors once one exists
 *   npm run mock:poll -- --malformed             # include an undecodable event
 *   npm run mock:poll -- --port 0                # ephemeral mock port
 *
 * Watch it from a second terminal:
 *
 *   curl -s http://127.0.0.1:8787/health | jq .status
 *
 * Credentials: none required. The mock profile supplies placeholder Telegram
 * values purely so `loadConfig()` validates; nothing here constructs a
 * Telegram client, and `data/cursor.mock.json` keeps the drill's cursor apart
 * from any real bot's `data/cursor.json`.
 */

import {
  ConfigError,
  activeProfileName,
  configProvenance,
  formatProvenanceSummary,
  loadConfig,
  networkLabel,
} from "./config.js";
import { startHealthServer } from "./health.js";
import { safeErrorMessage } from "./notifications/format.js";
import { createPoller } from "./poller.js";
import { createRpcServer } from "./stellar/client.js";
import { defaultMockScenario, malformedMockEvent, parseMockCli, startMockRpc } from "./stellar/mock-rpc.js";

/** Longest would-be Telegram message preview the log will print. */
const PREVIEW_CHARS = 160;

function preview(text: string): { chars: number; shown: string } {
  const compact = text.replace(/\s+/g, " ").trim();
  const shown =
    compact.length <= PREVIEW_CHARS ? compact : `${compact.slice(0, PREVIEW_CHARS - 1)}…`;
  return { chars: compact.length, shown };
}

async function main(): Promise<void> {
  // The profile must be selected before `loadConfig()` reads it. An explicit
  // MIMIR_PROFILE from the environment (or .env) still wins; blank counts as unset.
  if (!process.env.MIMIR_PROFILE?.trim()) process.env.MIMIR_PROFILE = "mock";

  const parsed = parseMockCli(process.argv);
  if (!parsed.ok) {
    console.error(`[dry-run] ${parsed.error}`);
    process.exit(2);
  }
  const { port, malformed, ...failures } = parsed.options;

  const scenario = defaultMockScenario();
  if (malformed) {
    scenario.events.push(malformedMockEvent(scenario.latestLedger));
    console.log("[dry-run] appending one malformed event (must be skipped, not crash)");
  }

  const mock = await startMockRpc({ port, scenario, failures });

  // Profile defaults may name the default port; the bound port is authoritative.
  const config = { ...loadConfig(), rpcUrl: mock.url };

  console.log(`[dry-run] Mimir notifier dry run — Telegram sends are logged, not delivered`);
  console.log(`[dry-run] profile   ${activeProfileName() ?? "none"}`);
  console.log(`[dry-run] network   ${networkLabel(config)} · rpc ${config.rpcUrl}`);
  console.log(`[dry-run] market    ${config.marketContractId}`);
  console.log(`[dry-run] squad     ${config.squadContractId}`);
  console.log(`[dry-run] cursor    ${config.cursorFile}`);
  console.log(
    `[dry-run] poll      every ${config.pollIntervalMs}ms · cap ${config.maxNotificationsPerCycle} notification(s)/cycle`,
  );
  console.log(`[dry-run] config    ${formatProvenanceSummary(configProvenance())}`);

  const server = createRpcServer(config);

  // Log-only send path: bounded preview, no Telegram client, no token.
  const send = async (text: string): Promise<void> => {
    const { chars, shown } = preview(text);
    console.log(`[dry-run] would send ${chars} chars: ${shown}`);
  };

  const poller = createPoller({ config, server, send });
  const health = startHealthServer({ config, status: () => poller.status() });
  console.log(`[dry-run] health    ${health.url ?? "disabled"} (GET /health, GET /health/live)`);

  await poller.start();

  const shutdown = (signal: string): void => {
    console.log(`[dry-run] ${signal} received, stopping`);
    void Promise.allSettled([poller.stop(), health.close(), mock.close()]).finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  console.error(`[dry-run] startup failed: ${safeErrorMessage(err)}`);
  process.exit(1);
});
