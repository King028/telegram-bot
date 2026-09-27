/**
 * Turn a decoded contract event into a Telegram message.
 *
 * MarkdownV2, not legacy Markdown: legacy silently accepts malformed input and
 * renders garbage, while MarkdownV2 rejects it — a formatting bug should be a
 * failed send in the log, not a mangled message in the channel. Every
 * interpolated value therefore goes through {@link escapeMd}.
 *
 * One event, one message, one line of substance. A notification is read on a
 * phone lock screen.
 */

import { txExplorerUrl } from "../stellar/client.js";
import {
  formatUsdc,
  isUsableTxHash,
  shortAddress,
  squadSideLabel,
  winnerSideLabel,
  type DecodedEvent,
} from "../stellar/decode.js";
import type { StellarConfig } from "../config.js";

/** Telegram's MarkdownV2 reserved set. All of it must be escaped, everywhere. */
const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const MAX_EVENT_FIELD_LENGTH = 200;
const MAX_TX_HASH_LENGTH = 128;

export function escapeMd(text: string): string {
  return text.replace(MDV2_RESERVED, (ch) => `\\${ch}`);
}

/**
 * Best-effort text for an unknown thrown value, without assuming it is an
 * `Error`. The SDK throws Soroban JSON-RPC failures as plain
 * `{ code, message }` objects (js-stellar-sdk `rpc/jsonrpc.ts`), and
 * `String()` of those is the useless `"[object Object]"` — so object-shaped
 * errors are read field-wise and only then fall back to a bounded dump.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return "";
  if (typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const code =
      typeof record.code === "number" || typeof record.code === "string" ? record.code : null;
    if (typeof record.message === "string" && record.message !== "") {
      return code === null ? record.message : `${code}: ${record.message}`;
    }
    try {
      const json = JSON.stringify(error);
      if (typeof json === "string" && json !== "{}") return json;
    } catch {
      // Circular or exotic object; fall through to the generic label.
    }
    return code === null ? "error object" : `error code ${code}`;
  }
  return String(error);
}

/**
 * Keep operational errors actionable without copying remote payloads or the
 * bot token into logs and status messages.
 */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = describeError(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }

  // Also cover a Telegram token embedded in an upstream error when the
  // caller does not have the configured value (for example in a unit test).
  message = message.replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");

  const compact = message.replace(/\s+/g, " ").trim() || "unknown error";
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
}

function usdc(units: bigint): string {
  return escapeMd(`${formatUsdc(units)} USDC`);
}

function who(address: string): string {
  return `\`${escapeMd(shortAddress(address))}\``;
}

/** Truncate an unbounded contract String without splitting a Unicode code point. */
function clip(text: string, max = MAX_EVENT_FIELD_LENGTH): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  return characters.length <= max ? trimmed : `${characters.slice(0, max - 1).join("")}…`;
}

function footer(config: StellarConfig, event: DecodedEvent): string {
  const ledger = escapeMd(`ledger ${event.ledger}`);
  const url = eventExplorerUrl(config, event);
  if (!url) return `_${ledger}_`;
  return `_${ledger}_ · [tx](${url})`;
}

/**
 * A Stellar transaction hash as returned by the RPC: 64 lowercase or uppercase
 * hex characters (32 bytes). Anything else is treated as missing — the
 * notification is still sent, just without an explorer link/button.
 */
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** Explorer URL for an event's transaction, or null when it has none usable. */
export function eventExplorerUrl(config: StellarConfig, event: DecodedEvent): string | null {
  // Link only well-formed 64-hex transaction hashes. An externally-derived
  // identifier that is empty, oversized or malformed gets no link: a broken
  // explorer link is worse than no link, and the hash itself is never altered here.
  const raw = event.txHash ?? "";
  if (raw.length > MAX_TX_HASH_LENGTH || !isUsableTxHash(raw)) return null;
  const txHash = raw.trim();
  if (!TX_HASH_RE.test(txHash)) return null;
  try {
    const url = txExplorerUrl(config, txHash);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export interface ExplorerButton {
  text: string;
  url: string;
}

export interface ExplorerKeyboard {
  inline_keyboard: ExplorerButton[][];
}

/**
 * Telegram inline keyboard for an event notification.
 *
 * Returns undefined when the event carries no usable transaction hash, so the
 * caller sends the existing text-only message unchanged. The button reuses the
 * same canonical explorer URL as the `· [tx](…)` footer link — the footer stays
 * as the text fallback, the button is progressive enhancement in the same
 * Telegram request (no second message, no extra rate-limit cost).
 */
export function explorerKeyboard(
  config: StellarConfig,
  event: DecodedEvent,
): ExplorerKeyboard | undefined {
  const url = eventExplorerUrl(config, event);
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: "View on Explorer", url }]] };
}

/**
 * The headline for an event, or null when this bot has nothing to say about it.
 *
 * Note what is deliberately absent: the market contract's `claim_created`
 * carries only `id`, `creator` and `category` — the claim's question text lives
 * in contract state, not the event, so it is not invented here. The squad
 * contract's `market_created` does carry `question`, and that is shown.
 */
function headline(event: DecodedEvent): string | null {
  const p = event.payload;

  switch (p.name) {
    // ── mimir-market ────────────────────────────────────────────────────────
    case "claim_created":
      return (
        `🆕 *New claim* \\#${p.claimId}\n` +
        `Category: ${escapeMd(clip(p.category))}\n` +
        `Creator: ${who(p.creator)}`
      );

    case "claim_challenged":
      return (
        `⚔️ *Claim \\#${p.claimId} challenged*\n` +
        `Stake: *${usdc(p.stake)}*\n` +
        `Challenger: ${who(p.challenger)}`
      );

    case "claim_resolved":
      return (
        `⚖️ *Claim \\#${p.claimId} resolved* — winner: *${escapeMd(winnerSideLabel(p.winnerSide))}*\n` +
        `Confidence: ${escapeMd(String(p.confidence))}%\n` +
        (p.summary ? `_${escapeMd(clip(p.summary))}_` : "")
      ).trimEnd();

    case "claim_cancelled":
      return `🚫 *Claim \\#${p.claimId} cancelled* — stakes returned`;

    case "market_settled":
      return (
        `💰 *Claim \\#${p.claimId} settled*\n` +
        `Paid out: *${usdc(p.totalPaid)}* · fees ${usdc(p.totalFees)}\n` +
        `Owed to challengers: ${usdc(p.owedToChallengers)}`
      );

    case "challenger_paid":
      return (
        `🏆 *Challenger paid* on claim \\#${p.claimId}\n` +
        `${who(p.challenger)} staked ${usdc(p.stake)} → net *${usdc(p.net)}*\n` +
        `Gross ${usdc(p.gross)} · fee ${usdc(p.fee)}`
      );

    case "fee_claimed":
      return `🧾 *Fees claimed* — ${usdc(p.amount)} to ${who(p.recipient)}`;

    case "withdrawal":
      return `📤 *Withdrawal* — ${usdc(p.amount)} to ${who(p.to)}`;

    case "withdrawal_pending":
      return `⏳ *Withdrawal parked* — ${usdc(p.amount)} claimable by ${who(p.to)}`;

    // ── mimir-squad ─────────────────────────────────────────────────────────
    case "market_created":
      return (
        `🆕 *New squad market* \\#${p.marketId}\n` +
        `${escapeMd(clip(p.question))}\n` +
        `Captain: ${who(p.captain)} · fee ${escapeMd(String(p.feeBps))} bps · ` +
        `deadline ${escapeMd(new Date(p.deadline * 1000).toISOString())}`
      );

    case "deposited":
      return (
        `➕ *Squad \\#${p.marketId}* — ${usdc(p.amount)} on *${escapeMd(squadSideLabel(p.side))}*\n` +
        `Participant: ${who(p.participant)}`
      );

    case "withdrawn":
      return (
        `➖ *Squad \\#${p.marketId}* — ${who(p.participant)} pulled ${usdc(p.amount)} ` +
        `from ${escapeMd(squadSideLabel(p.side))}`
      );

    case "resolved":
      return (
        `🏁 *Squad \\#${p.marketId} resolved* — *${escapeMd(squadSideLabel(p.result))}*\n` +
        `Pools: A ${usdc(p.poolA)} · B ${usdc(p.poolB)}`
      );

    case "claimed":
      return (
        `💸 *Squad payout* on \\#${p.marketId}\n` +
        `${who(p.participant)} → net *${usdc(p.net)}* \\(gross ${usdc(p.gross)}, fee ${usdc(p.fee)}\\)`
      );

    case "fees_claimed":
      return `🧾 *Squad fees claimed* — ${usdc(p.amount)} to ${who(p.recipient)}`;

    // Admin events and undecodable shapes get no notification. The poller logs
    // them so a silent bot is distinguishable from an unteachable one.
    case "oracle_changed":
    case "ownership_transferred":
    case "agent_attributed":
    case "fee_accrued":
    case "fee_policy_set":
    case "fee_policy_changed":
    case "fee_policy_updated":
    case "fee_policy_removed":
    case "admin":
    case "unknown":
      return null;

    default:
      return null;
  }
}

/** The full message, or null when the event is not worth notifying. */
export function formatEvent(
  config: StellarConfig & { channelPreviewMode?: boolean },
  event: DecodedEvent,
): string | null {
  try {
    const head = headline(event);
    if (head === null) return null;
    const body = `${head}\n${footer(config, event)}`;
    if (config.channelPreviewMode) {
      return `🧪 *[PREVIEW MODE]*\n${body}`;
    }
    return body;
  } catch (err) {
    return formatFallbackEvent(config, event, safeErrorMessage(err));
  }
}

/** Telegram's hard caption/message ceiling; the plain text stays well under it. */
const MAX_PLAIN_TEXT_LENGTH = 4000;

function plainUsdc(units: bigint): string {
  return `${formatUsdc(units)} USDC`;
}

function plainWho(address: string): string {
  return shortAddress(address);
}

function plainFooter(config: StellarConfig, event: DecodedEvent): string {
  const url = eventExplorerUrl(config, event);
  const ledger = `ledger ${event.ledger}`;
  // Raw URL, not Markdown link syntax: with no parse_mode the brackets would
  // render literally, while a bare URL stays readable and copyable.
  return url ? `${ledger}\ntx: ${url}` : ledger;
}

/**
 * The plain-text headline for an event, or null when there is nothing to say.
 *
 * Dedicated formatter, not a Markdown stripper: each case mirrors {@link headline}
 * field-for-field (same identities, amounts, bounded clips) but emits no
 * MarkdownV2 syntax at all, so Telegram cannot reject it for entity parsing.
 */
function plainHeadline(event: DecodedEvent): string | null {
  const p = event.payload;

  switch (p.name) {
    // ── mimir-market ────────────────────────────────────────────────────────
    case "claim_created":
      return (
        `New claim #${p.claimId}\n` +
        `Category: ${clip(p.category)}\n` +
        `Creator: ${plainWho(p.creator)}`
      );

    case "claim_challenged":
      return (
        `Claim #${p.claimId} challenged\n` +
        `Stake: ${plainUsdc(p.stake)}\n` +
        `Challenger: ${plainWho(p.challenger)}`
      );

    case "claim_resolved":
      return (
        `Claim #${p.claimId} resolved — winner: ${winnerSideLabel(p.winnerSide)}\n` +
        `Confidence: ${String(p.confidence)}%` +
        (p.summary ? `\n${clip(p.summary)}` : "")
      );

    case "claim_cancelled":
      return `Claim #${p.claimId} cancelled — stakes returned`;

    case "market_settled":
      return (
        `Claim #${p.claimId} settled\n` +
        `Paid out: ${plainUsdc(p.totalPaid)} · fees ${plainUsdc(p.totalFees)}\n` +
        `Owed to challengers: ${plainUsdc(p.owedToChallengers)}`
      );

    case "challenger_paid":
      return (
        `Challenger paid on claim #${p.claimId}\n` +
        `${plainWho(p.challenger)} staked ${plainUsdc(p.stake)} → net ${plainUsdc(p.net)}\n` +
        `Gross ${plainUsdc(p.gross)} · fee ${plainUsdc(p.fee)}`
      );

    case "fee_claimed":
      return `Fees claimed — ${plainUsdc(p.amount)} to ${plainWho(p.recipient)}`;

    case "withdrawal":
      return `Withdrawal — ${plainUsdc(p.amount)} to ${plainWho(p.to)}`;

    case "withdrawal_pending":
      return `Withdrawal parked — ${plainUsdc(p.amount)} claimable by ${plainWho(p.to)}`;

    // ── mimir-squad ─────────────────────────────────────────────────────────
    case "market_created":
      return (
        `New squad market #${p.marketId}\n` +
        `${clip(p.question)}\n` +
        `Captain: ${plainWho(p.captain)} · fee ${String(p.feeBps)} bps · ` +
        `deadline ${new Date(p.deadline * 1000).toISOString()}`
      );

    case "deposited":
      return (
        `Squad #${p.marketId} — ${plainUsdc(p.amount)} on ${squadSideLabel(p.side)}\n` +
        `Participant: ${plainWho(p.participant)}`
      );

    case "withdrawn":
      return (
        `Squad #${p.marketId} — ${plainWho(p.participant)} pulled ${plainUsdc(p.amount)} ` +
        `from ${squadSideLabel(p.side)}`
      );

    case "resolved":
      return (
        `Squad #${p.marketId} resolved — ${squadSideLabel(p.result)}\n` +
        `Pools: A ${plainUsdc(p.poolA)} · B ${plainUsdc(p.poolB)}`
      );

    case "claimed":
      return (
        `Squad payout on #${p.marketId}\n` +
        `${plainWho(p.participant)} → net ${plainUsdc(p.net)} ` +
        `(gross ${plainUsdc(p.gross)}, fee ${plainUsdc(p.fee)})`
      );

    case "fees_claimed":
      return `Squad fees claimed — ${plainUsdc(p.amount)} to ${plainWho(p.recipient)}`;

    // Same set as `headline`: admin events and undecodable shapes get nothing.
    case "oracle_changed":
    case "ownership_transferred":
    case "agent_attributed":
    case "fee_accrued":
    case "fee_policy_set":
    case "fee_policy_changed":
    case "fee_policy_updated":
    case "fee_policy_removed":
    case "admin":
    case "unknown":
      return null;

    default:
      return null;
  }
}

/**
 * Clip a finished plain-text message without splitting a Unicode code point.
 */
function clipPlainText(text: string, max = MAX_PLAIN_TEXT_LENGTH): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
}

/**
 * The plain-text notification for an event, or null when it is not notifiable.
 *
 * Same information as {@link formatEvent} (identity, amounts, ledger, explorer
 * URL when valid) with no Markdown of any kind. Sent without a `parse_mode`,
 * so Telegram delivers it even when the MarkdownV2 rendering is rejected.
 * Never throws and never returns an empty string: malformed input degrades to
 * a minimal bounded line rather than crashing the notifier.
 */
export function formatPlainTextEvent(
  config: StellarConfig,
  event: DecodedEvent,
): string | null {
  try {
    const head = plainHeadline(event);
    if (head === null) return null;
    const body = `${head}\n${plainFooter(config, event)}`.trim();
    if (!body) return minimalPlainTextEvent(event);
    return clipPlainText(body);
  } catch {
    return minimalPlainTextEvent(event);
  }
}

/** Last-resort bounded line when even the plain-text formatter cannot render. */
function minimalPlainTextEvent(event: DecodedEvent): string {
  const source = typeof event?.source === "string" ? event.source : "unknown";
  const ledger =
    typeof event?.ledger === "number" && Number.isFinite(event.ledger)
      ? `ledger ${event.ledger}`
      : "ledger unknown";
  const eventId = typeof event?.eventId === "string" && event.eventId ? ` (${event.eventId})` : "";
  return clipPlainText(`Mimir event (${source}) — ${ledger}${eventId}`);
}

/**
 * Fallback message when an event payload is malformed or an error occurs during formatting.
 */
export function formatFallbackEvent(
  config: StellarConfig,
  event: DecodedEvent,
  reason = "malformed payload",
): string {
  const source = escapeMd(event.source ?? "unknown");
  const contract = escapeMd(shortAddress(event.contractId ?? "unknown"));
  const ledger = escapeMd(String(event.ledger ?? "unknown"));
  const safeReason = escapeMd(safeErrorMessage(reason));
  const txPart = event.txHash ? ` · [tx](${txExplorerUrl(config, event.txHash)})` : "";
  return (
    `⚠️ *Event Notification Fallback* \\(${source}\\)\n` +
    `Contract: \`${contract}\` · Ledger: ${ledger}${txPart}\n` +
    `Reason: _${safeReason}_`
  );
}

/**
 * Generate a channel preview message for on-demand preview commands.
 */
export function previewMessage(config: StellarConfig, target = "market"): string {
  const isSquad = target.trim().toLowerCase() === "squad";

  if (isSquad) {
    const sampleEvent: DecodedEvent = {
      source: "squad",
      contractId: config.squadContractId,
      ledger: 1000000,
      txHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      at: Math.floor(Date.now() / 1000),
      eventId: "1000000-1",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "market_created",
        marketId: 1,
        question: "Will Stellar process 1M Soroban operations in 24 hours?",
        captain: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        feeBps: 100,
        deadline: 1770000000,
      },
    };
    const formatted = formatEvent({ ...config, channelPreviewMode: false }, sampleEvent) ?? "";
    return `🧪 *Channel Preview — mimir\\-squad*\n\n${formatted}`;
  }

  const sampleEvent: DecodedEvent = {
    source: "market",
    contractId: config.marketContractId,
    ledger: 1000000,
    txHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    at: Math.floor(Date.now() / 1000),
    eventId: "1000000-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 1,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  };
  const formatted = formatEvent({ ...config, channelPreviewMode: false }, sampleEvent) ?? "";
  return `🧪 *Channel Preview — mimir\\-market*\n\n${formatted}`;
}

