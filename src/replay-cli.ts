/**
 * Entrypoint for the cursor-range replay CLI (`npm run replay`).
 *
 * Reads a ledger range from the chain and optionally delivers Telegram
 * notifications for the events found there. Replay is read-only with respect
 * to cursor files: it never writes a cursor, never touches the live poller's
 * state, and exits after the range is exhausted.
 *
 *   npm run replay -- --from 4226500
 *   npm run replay -- --from 4226500 --to 4226800
 *   npm run replay -- --from 4226500 --send        # actually post to Telegram
 *   npm run replay -- --from 4226500 --json        # machine-readable report
 *   npm run replay -- --from 4226500 --mock        # local mock profile
 *
 * Needs no Telegram credentials in dry-run mode (the default). Pass --send to
 * load a full bot config (BOT_TOKEN + TELEGRAM_CHAT_ID) and deliver events.
 *
 * Exit codes:
 *   0 — scan completed (even if some events were skipped or capped)
 *   1 — fatal runtime error (RPC failure, config error)
 *   2 — usage error (bad flags)
 */

import { pathToFileURL } from "node:url";

import { runReplayCli } from "./stellar/replay.js";

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void runReplayCli().then(({ exitCode }) => {
    if (exitCode !== 0) process.exit(exitCode);
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
