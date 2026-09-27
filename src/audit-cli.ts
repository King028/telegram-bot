/**
 * Entrypoint for the operator audit report CLI (`npm run audit`).
 *
 * The renderer lives next to the chain scanner in `src/stellar/events.ts`;
 * this file only marks which mode was entered, so importing this module never
 * touches the RPC and importing the scanner never renders a report.
 *
 * Needs no Telegram or RPC credentials: it reads a local JSONL file and exits.
 */

import { pathToFileURL } from "node:url";

import { runAuditCli } from "./stellar/events.js";

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runAuditCli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
