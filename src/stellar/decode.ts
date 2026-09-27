/**
 * Decode Mimir contract events into typed objects.
 *
 * ── Wire shape ───────────────────────────────────────────────────────────────
 *
 * Soroban's `#[contractevent]` macro lays an event out as:
 *
 *   topic[0]   the event name in snake_case ("claim_created", "market_settled")
 *   topic[1..] the `#[topic]`-annotated fields, in DECLARATION ORDER
 *   value      a MAP of the remaining (non-topic) fields, keyed by snake_case name
 *
 * So `ClaimChallenged { #[topic] id, #[topic] challenger, stake }` arrives as
 *   topics: "claim_challenged" | <u64 id> | <G… challenger>   value: { stake }
 *
 * Every field name below is taken from the deployed contracts' event
 * definitions (`contracts-soroban/mimir-market/src/events.rs` and
 * `contracts-soroban/mimir-squad/src/events.rs`), not inferred.
 *
 * ── Amounts ──────────────────────────────────────────────────────────────────
 *
 * All money is atomic USDC in `i128`. Stellar's USDC Stellar Asset Contract has
 * **7 decimals**, not the 6 of the ERC-20. Amounts stay `bigint` through
 * decoding and are only converted for display, at the formatting edge.
 */

import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";
import type { StellarConfig } from "../config.js";
import { txExplorerUrl } from "./client.js";

/** Which of the two Mimir contracts an event came from. */
export type ContractSource = "market" | "squad";

/** 1 USDC in atomic units. */
export const USDC_UNIT = 10_000_000n;

/** `WinnerSide` in `mimir-market/src/types.rs`. Unit enums decode to their u32. */
export const WINNER_SIDE: Record<number, string> = {
  0: "unresolved",
  1: "creator",
  2: "challengers",
  3: "draw",
  4: "unresolvable",
};

/** `SIDE_A` / `SIDE_B` / `RESULT_CANCELLED` in `mimir-squad/src/types.rs`. */
export const SQUAD_SIDE: Record<number, string> = {
  0: "pending",
  1: "Side A",
  2: "Side B",
  3: "cancelled",
};

export interface EventMeta {
  source: ContractSource;
  contractId: string;
  ledger: number;
  txHash: string;
  /** Ledger close time, unix seconds. */
  at: number;
  /** The RPC's own event id — unique and monotonic, handy for logs. */
  eventId: string;
  /**
   * Preserved ordering metadata (issue #48).
   *
   * Soroban RPC's `getEvents` returns each event with `ledger`,
   * `transactionIndex`, `operationIndex`, `txHash` and an opaque paging-token
   * `id` (`<TOID>-<order>`). All of it is carried here so events from the same
   * or different ledgers/transactions can be ordered deterministically without
   * relying on array order, arrival order, or local timestamps.
   *
   * `transactionIndex` / `operationIndex` are `null` when the chain response
   * does not provide them — never invented. Sorting treats `null` as
   * "unknown, order after known positions" and falls back to the paging token.
   */
  /** RPC `type` (`"contract"` | `"system"` | `"diagnostic"`), else `"unknown"`. */
  eventType: string;
  /** Position of the transaction inside its ledger, when the RPC provides it. */
  transactionIndex: number | null;
  /** Position of the operation inside its transaction, when provided. */
  operationIndex: number | null;
  /** Whether the emitting call succeeded, when the RPC provides it. */
  inSuccessfulContractCall: boolean | null;
}

export type MarketPayload =
  | { name: "claim_created"; claimId: number; creator: string; category: string }
  | { name: "claim_challenged"; claimId: number; challenger: string; stake: bigint }
  | {
      name: "claim_resolved";
      claimId: number;
      winnerSide: number;
      summary: string;
      confidence: number;
      evidenceHash: string;
    }
  | { name: "claim_cancelled"; claimId: number }
  | {
      name: "market_settled";
      claimId: number;
      totalPaid: bigint;
      totalFees: bigint;
      owedToChallengers: bigint;
      dust: bigint;
    }
  | {
      name: "challenger_paid";
      claimId: number;
      challenger: string;
      stake: bigint;
      gross: bigint;
      fee: bigint;
      net: bigint;
    }
  | { name: "fee_claimed"; recipient: string; amount: bigint }
  | { name: "withdrawal"; to: string; amount: bigint }
  | { name: "withdrawal_pending"; to: string; amount: bigint };

export type SquadMarketCreatedPayload = {
  name: "market_created";
  marketId: number;
  captain: string;
  deadline: number;
  feeBps: number;
  question: string;
};

export type SquadDepositedPayload = {
  name: "deposited";
  marketId: number;
  side: number;
  participant: string;
  amount: bigint;
  shares: bigint;
};

export type SquadWithdrawnPayload = {
  name: "withdrawn";
  marketId: number;
  side: number;
  participant: string;
  amount: bigint;
};

export type SquadResolvedPayload = {
  name: "resolved";
  marketId: number;
  result: number;
  poolA: bigint;
  poolB: bigint;
};

export type SquadClaimedPayload = {
  name: "claimed";
  marketId: number;
  participant: string;
  gross: bigint;
  fee: bigint;
  net: bigint;
};

export type SquadFeesClaimedPayload = {
  name: "fees_claimed";
  recipient: string;
  amount: bigint;
};

export type SquadPayload =
  | SquadMarketCreatedPayload
  | SquadDepositedPayload
  | SquadWithdrawnPayload
  | SquadResolvedPayload
  | SquadClaimedPayload
  | SquadFeesClaimedPayload;

export type OracleChangedPayload = {
  name: "oracle_changed";
  newOracle?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type OwnershipTransferredPayload = {
  name: "ownership_transferred";
  previousOwner?: string;
  newOwner?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type AgentAttributedPayload = {
  name: "agent_attributed";
  agent?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type FeeAccruedPayload = {
  name: "fee_accrued";
  recipient?: string;
  amount?: bigint;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type FeePolicyPayload = {
  name: "fee_policy_set" | "fee_policy_changed" | "fee_policy_updated" | "fee_policy_removed";
  feeBps?: number;
  category?: string;
  recipient?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type GenericAdminPayload = {
  name: "admin";
  action: string;
  admin?: string;
  details: Record<string, string | number | boolean>;
};

export type AdminPayload =
  | OracleChangedPayload
  | OwnershipTransferredPayload
  | AgentAttributedPayload
  | FeeAccruedPayload
  | FeePolicyPayload
  | GenericAdminPayload;

export interface AdminAuditRecord {
  type: string;
  ledger: number;
  at: number;
  transactionHash?: string;
  contractId?: string;
  admin?: string;
  details: Record<string, string | number | boolean>;
  explorerUrl?: string;
}

export type SquadEvent = EventMeta & {
  source: "squad";
  payload: SquadPayload | UnknownPayload;
};

/**
 * Anything this bot has no notification for or a shape it failed to decode.
 * Kept rather than dropped so the poller can log what it skipped instead of going quiet.
 */
export interface UnknownPayload {
  name: "unknown";
  eventName: string;
  reason?: string;
}

export type EventPayload = MarketPayload | SquadPayload | AdminPayload | UnknownPayload;

export type ClaimCreatedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_created" }> };
export type ClaimChallengedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_challenged" }> };
export type ClaimResolvedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_resolved" }> };
export type ClaimCancelledEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_cancelled" }> };
export type MarketSettledEvent = EventMeta & { payload: Extract<MarketPayload, { name: "market_settled" }> };
export type ChallengerPaidEvent = EventMeta & { payload: Extract<MarketPayload, { name: "challenger_paid" }> };
export type FeeClaimedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "fee_claimed" }> };
export type WithdrawalEvent = EventMeta & { payload: Extract<MarketPayload, { name: "withdrawal" }> };
export type WithdrawalPendingEvent = EventMeta & { payload: Extract<MarketPayload, { name: "withdrawal_pending" }> };

export type SquadMarketCreatedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "market_created" }> };
export type SquadDepositedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "deposited" }> };
export type SquadWithdrawnEvent = EventMeta & { payload: Extract<SquadPayload, { name: "withdrawn" }> };
export type SquadResolvedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "resolved" }> };
export type SquadClaimedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "claimed" }> };
export type SquadFeesClaimedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "fees_claimed" }> };

export type UnknownMarketEvent = EventMeta & { payload: UnknownPayload };

export type MarketEvent =
  | ClaimCreatedEvent
  | ClaimChallengedEvent
  | ClaimResolvedEvent
  | ClaimCancelledEvent
  | MarketSettledEvent
  | ChallengerPaidEvent
  | FeeClaimedEvent
  | WithdrawalEvent
  | WithdrawalPendingEvent
  | SquadMarketCreatedEvent
  | SquadDepositedEvent
  | SquadWithdrawnEvent
  | SquadResolvedEvent
  | SquadClaimedEvent
  | SquadFeesClaimedEvent
  | UnknownMarketEvent;

export type DecodedEvent = EventMeta & { payload: EventPayload };

/** Keep decoder diagnostics useful without copying an unbounded RPC payload. */
const MAX_DIAGNOSTIC_LENGTH = 200;

function diagnostic(value: unknown): string {
  const compact = String(value).replace(/\s+/g, " ").trim() || "unknown error";
  return compact.length <= MAX_DIAGNOSTIC_LENGTH
    ? compact
    : `${compact.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

// ── Scalar helpers ───────────────────────────────────────────────────────────

class DecodeError extends Error {}

function native(value: xdr.ScVal): unknown {
  return scValToNative(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function big(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DecodeError(`${what}: expected an integer, got ${typeof value}`);
}

/** Reject negative amounts, returning non-negative bigint. */
function amount(value: unknown, what: string): bigint {
  const b = big(value, what);
  if (b < 0n) {
    throw new DecodeError(`${what}: expected non-negative amount, got ${b}`);
  }
  return b;
}

/** For ids, deadlines and bps — small enough that `number` is honest. */
function num(value: unknown, what: string): number {
  const asBig = big(value, what);
  if (asBig < 0n) {
    throw new DecodeError(`${what}: expected non-negative integer, got ${asBig}`);
  }
  if (asBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DecodeError(`${what}: ${asBig} exceeds the safe integer range`);
  }
  return Number(asBig);
}

function str(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  // A contract `String` normally decodes to a JS string, but bytes-shaped
  // payloads show up as Buffer on some SDK paths.
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new DecodeError(`${what}: expected a string, got ${typeof value}`);
}

/** An `Address` decodes to its `G…`/`C…` strkey. */
function addr(value: unknown, what: string): string {
  const s = str(value, what);
  if (!/^[GC][A-Z2-7]{55}$/.test(s)) {
    throw new DecodeError(`${what}: expected a Stellar address strkey, got "${s}"`);
  }
  return s;
}

function hex(value: unknown, what: string): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "string") return value;
  throw new DecodeError(`${what}: expected bytes, got ${typeof value}`);
}

function topicAt(topics: unknown[], index: number, what: string): unknown {
  if (index >= topics.length) {
    throw new DecodeError(`${what}: missing topic[${index}] (event has ${topics.length} topics)`);
  }
  return topics[index];
}

// ── Per-contract decoders ────────────────────────────────────────────────────

function decodeMarket(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): MarketPayload | AdminPayload | null {
  switch (name) {
    case "claim_created":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_created.id"), "claim_created.id"),
        creator: addr(topicAt(topics, 2, "claim_created.creator"), "claim_created.creator"),
        category: str(fields.category, "claim_created.category"),
      };

    case "claim_challenged":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_challenged.id"), "claim_challenged.id"),
        challenger: addr(
          topicAt(topics, 2, "claim_challenged.challenger"),
          "claim_challenged.challenger",
        ),
        stake: amount(fields.stake, "claim_challenged.stake"),
      };

    case "claim_resolved":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_resolved.id"), "claim_resolved.id"),
        winnerSide: num(fields.winner_side, "claim_resolved.winner_side"),
        summary: str(fields.summary, "claim_resolved.summary"),
        confidence: num(fields.confidence, "claim_resolved.confidence"),
        evidenceHash: hex(fields.evidence_hash, "claim_resolved.evidence_hash"),
      };

    case "claim_cancelled":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_cancelled.id"), "claim_cancelled.id"),
      };

    case "market_settled":
      return {
        name,
        claimId: num(topicAt(topics, 1, "market_settled.id"), "market_settled.id"),
        totalPaid: amount(fields.total_paid, "market_settled.total_paid"),
        totalFees: amount(fields.total_fees, "market_settled.total_fees"),
        owedToChallengers: amount(fields.owed_to_challengers, "market_settled.owed_to_challengers"),
        dust: amount(fields.dust, "market_settled.dust"),
      };

    case "challenger_paid":
      return {
        name,
        claimId: num(topicAt(topics, 1, "challenger_paid.id"), "challenger_paid.id"),
        challenger: addr(
          topicAt(topics, 2, "challenger_paid.challenger"),
          "challenger_paid.challenger",
        ),
        stake: amount(fields.stake, "challenger_paid.stake"),
        gross: amount(fields.gross, "challenger_paid.gross"),
        fee: amount(fields.fee, "challenger_paid.fee"),
        net: amount(fields.net, "challenger_paid.net"),
      };

    case "fee_claimed":
      return {
        name,
        recipient: addr(topicAt(topics, 1, "fee_claimed.recipient"), "fee_claimed.recipient"),
        amount: amount(fields.amount, "fee_claimed.amount"),
      };

    case "withdrawal":
    case "withdrawal_pending":
      return {
        name,
        to: addr(topicAt(topics, 1, `${name}.to`), `${name}.to`),
        amount: amount(fields.amount, `${name}.amount`),
      };

    default:
      return decodeAdmin(name, topics, fields);
  }
}

function decodeAdmin(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): AdminPayload | null {
  switch (name) {
    case "oracle_changed": {
      let newOracle: string | undefined = undefined;
      if (topics.length > 1) {
        try {
          newOracle = addr(topics[1], "oracle_changed.new_oracle");
        } catch {
          // Ignore topic parse failure, check fields
        }
      }
      if (!newOracle && fields.new_oracle) {
        try {
          newOracle = addr(fields.new_oracle, "oracle_changed.new_oracle");
        } catch {
          // Ignore
        }
      }
      if (!newOracle && fields.oracle) {
        try {
          newOracle = addr(fields.oracle, "oracle_changed.oracle");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (newOracle) details.newOracle = newOracle;
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        } else if (typeof v === "bigint") {
          details[k] = v.toString();
        }
      }
      return {
        name: "oracle_changed",
        ...(newOracle ? { newOracle } : {}),
        details,
      };
    }

    case "ownership_transferred": {
      let previousOwner: string | undefined = undefined;
      let newOwner: string | undefined = undefined;

      if (topics.length > 1) {
        try {
          newOwner = addr(topics[1], "ownership_transferred.new_owner");
        } catch {
          // Ignore
        }
      }
      if (fields.previous_owner) {
        try {
          previousOwner = addr(fields.previous_owner, "ownership_transferred.previous_owner");
        } catch {
          // Ignore
        }
      }
      if (fields.new_owner) {
        try {
          newOwner = addr(fields.new_owner, "ownership_transferred.new_owner");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (previousOwner) details.previousOwner = previousOwner;
      if (newOwner) details.newOwner = newOwner;
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        } else if (typeof v === "bigint") {
          details[k] = v.toString();
        }
      }
      return {
        name: "ownership_transferred",
        ...(previousOwner ? { previousOwner } : {}),
        ...(newOwner ? { newOwner } : {}),
        details,
      };
    }

    case "agent_attributed": {
      let agent: string | undefined = undefined;
      if (topics.length > 1) {
        try {
          agent = addr(topics[1], "agent_attributed.agent");
        } catch {
          // Ignore
        }
      }
      if (!agent && fields.agent) {
        try {
          agent = addr(fields.agent, "agent_attributed.agent");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (agent) details.agent = agent;
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        } else if (typeof v === "bigint") {
          details[k] = v.toString();
        }
      }
      return {
        name: "agent_attributed",
        ...(agent ? { agent } : {}),
        details,
      };
    }

    case "fee_accrued": {
      let recipient: string | undefined = undefined;
      let amt: bigint | undefined = undefined;
      if (topics.length > 1) {
        try {
          recipient = addr(topics[1], "fee_accrued.recipient");
        } catch {
          // Ignore
        }
      }
      if (!recipient && fields.recipient) {
        try {
          recipient = addr(fields.recipient, "fee_accrued.recipient");
        } catch {
          // Ignore
        }
      }
      if (fields.amount !== undefined) {
        try {
          amt = amount(fields.amount, "fee_accrued.amount");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (recipient) details.recipient = recipient;
      if (amt !== undefined) details.amount = amt.toString();
      for (const [k, v] of Object.entries(fields)) {
        if (k !== "recipient" && k !== "amount") {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            details[k] = v;
          } else if (typeof v === "bigint") {
            details[k] = v.toString();
          }
        }
      }
      return {
        name: "fee_accrued",
        ...(recipient ? { recipient } : {}),
        ...(amt !== undefined ? { amount: amt } : {}),
        details,
      };
    }

    default: {
      if (
        name.startsWith("fee_policy_") ||
        name.startsWith("admin_") ||
        name === "fee_policy_set" ||
        name === "fee_policy_changed"
      ) {
        let feeBps: number | undefined = undefined;
        let category: string | undefined = undefined;
        let recipient: string | undefined = undefined;

        if (fields.fee_bps !== undefined) {
          try {
            feeBps = num(fields.fee_bps, "fee_policy.fee_bps");
          } catch {
            // Ignore
          }
        }
        if (fields.category !== undefined) {
          try {
            category = str(fields.category, "fee_policy.category");
          } catch {
            // Ignore
          }
        }
        if (fields.recipient !== undefined) {
          try {
            recipient = addr(fields.recipient, "fee_policy.recipient");
          } catch {
            // Ignore
          }
        }

        const details: Record<string, string | number | boolean> = {};
        if (feeBps !== undefined) details.feeBps = feeBps;
        if (category) details.category = category;
        if (recipient) details.recipient = recipient;
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            details[k] = v;
          } else if (typeof v === "bigint") {
            details[k] = v.toString();
          }
        }

        if (
          name === "fee_policy_set" ||
          name === "fee_policy_changed" ||
          name === "fee_policy_updated" ||
          name === "fee_policy_removed"
        ) {
          return {
            name,
            ...(feeBps !== undefined ? { feeBps } : {}),
            ...(category ? { category } : {}),
            ...(recipient ? { recipient } : {}),
            details,
          };
        }

        return {
          name: "admin",
          action: name,
          ...(recipient ? { admin: recipient } : {}),
          details,
        };
      }
      return null;
    }
  }
}

function decodeSquad(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): SquadPayload | AdminPayload | null {
  switch (name) {
    case "market_created":
      return {
        name,
        marketId: num(topicAt(topics, 1, "market_created.market_id"), "market_created.market_id"),
        captain: addr(topicAt(topics, 2, "market_created.captain"), "market_created.captain"),
        deadline: num(fields.deadline, "market_created.deadline"),
        feeBps: num(fields.fee_bps, "market_created.fee_bps"),
        question: str(fields.question, "market_created.question"),
      };

    case "deposited":
      return {
        name,
        marketId: num(topicAt(topics, 1, "deposited.market_id"), "deposited.market_id"),
        side: num(topicAt(topics, 2, "deposited.side"), "deposited.side"),
        participant: addr(topicAt(topics, 3, "deposited.participant"), "deposited.participant"),
        amount: amount(fields.amount, "deposited.amount"),
        shares: amount(fields.shares, "deposited.shares"),
      };

    case "withdrawn":
      return {
        name,
        marketId: num(topicAt(topics, 1, "withdrawn.market_id"), "withdrawn.market_id"),
        side: num(topicAt(topics, 2, "withdrawn.side"), "withdrawn.side"),
        participant: addr(topicAt(topics, 3, "withdrawn.participant"), "withdrawn.participant"),
        amount: amount(fields.amount, "withdrawn.amount"),
      };

    case "resolved":
      return {
        name,
        marketId: num(topicAt(topics, 1, "resolved.market_id"), "resolved.market_id"),
        result: num(fields.result, "resolved.result"),
        poolA: amount(fields.pool_a, "resolved.pool_a"),
        poolB: amount(fields.pool_b, "resolved.pool_b"),
      };

    case "claimed":
      return {
        name,
        marketId: num(topicAt(topics, 1, "claimed.market_id"), "claimed.market_id"),
        participant: addr(topicAt(topics, 2, "claimed.participant"), "claimed.participant"),
        gross: amount(fields.gross, "claimed.gross"),
        fee: amount(fields.fee, "claimed.fee"),
        net: amount(fields.net, "claimed.net"),
      };

    case "fees_claimed":
      return {
        name,
        recipient: addr(topicAt(topics, 1, "fees_claimed.recipient"), "fees_claimed.recipient"),
        amount: amount(fields.amount, "fees_claimed.amount"),
      };

    default:
      return decodeAdmin(name, topics, fields);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** `event.contractId` is a `Contract` on some SDK paths and a string on others. */
function contractIdOf(event: rpc.Api.EventResponse): string {
  if (!event || typeof event !== "object") return "";
  const raw: unknown = (event as { contractId?: unknown }).contractId;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const maybe = raw as { contractId?: () => string; toString?: () => string };
    if (typeof maybe.contractId === "function") {
      try {
        return maybe.contractId();
      } catch {
        return "";
      }
    }
    if (typeof maybe.toString === "function") {
      try {
        const text = maybe.toString();
        // A default `[object Object]` string is not a contract id.
        if (typeof text === "string" && text !== "[object Object]") return text;
      } catch {
        // Fall through to "".
      }
    }
  }
  return "";
}

/**
 * Decode one RPC event.
 *
 * Never throws: an event this bot does not understand — a new contract event, a
 * shape change, malformed XDR, or missing ordering metadata — becomes an
 * `unknown` payload with the reason attached. A notifier must not die on an
 * event it was not taught. Malformed metadata falls back to safe defaults
 * (`ledger` 0, indexes `null`, `at` 0) rather than `NaN`, so a poisoned field
 * can neither crash the scanner nor corrupt ordering math.
 */
export function decodeEvent(source: ContractSource, event: rpc.Api.EventResponse): DecodedEvent {
  const meta: EventMeta = safeMeta(source, event);

  let eventName = "";
  try {
    if (!event || typeof event !== "object") {
      throw new DecodeError("invalid or missing event object");
    }

    const rawTopics = Array.isArray(event.topic) ? event.topic : [];
    const topics = rawTopics.map((t) => {
      try {
        return native(t as xdr.ScVal);
      } catch {
        return null;
      }
    });

    const first = topics[0];
    eventName = typeof first === "string" ? first : "";

    let decodedValue: unknown = undefined;
    if (event.value !== undefined && event.value !== null) {
      try {
        decodedValue = native(event.value);
      } catch (err) {
        throw new DecodeError(
          `malformed event value XDR: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const fields = isRecord(decodedValue) ? decodedValue : {};

    const payload =
      source === "market"
        ? decodeMarket(eventName, topics, fields)
        : decodeSquad(eventName, topics, fields);

    if (payload) return { ...meta, payload } as DecodedEvent;
    return { ...meta, payload: { name: "unknown", eventName, reason: "no decoder" } };
  } catch (err) {
    return {
      ...meta,
      payload: {
        name: "unknown",
        eventName,
        reason: diagnostic(err instanceof Error ? err.message : err),
      },
    };
  }
}

// ── Ordering metadata (issue #48) ────────────────────────────────────────────

/** Ledger sequence: a finite non-negative integer, else 0. Never `NaN`. */
function toLedger(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  return floored >= 0 ? floored : 0;
}

/**
 * Transaction/operation position: a non-negative integer when the RPC provides
 * one (number or numeric string), else `null`. `null` means "the chain did not
 * say" — sorting orders it after known positions instead of inventing one.
 */
function toPosition(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Trimmed transaction hash, or `""` when absent. Kept verbatim, not dropped. */
function toTxHash(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** RPC event `type`, or `"unknown"` when missing/unexpected. */
function toEventType(value: unknown): string {
  return value === "contract" || value === "system" || value === "diagnostic"
    ? value
    : "unknown";
}

function toSuccessFlag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Unix seconds for `ledgerClosedAt`, or 0 when unparseable. Never `NaN`. */
function toAt(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const ms = new Date(value as string).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Build the ordering-safe metadata for one RPC event. Never throws, even for
 * `null`/partially-shaped input: every field is coerced with a safe default.
 */
function safeMeta(source: ContractSource, event: rpc.Api.EventResponse): EventMeta {
  try {
    const raw = (event ?? {}) as Partial<rpc.Api.EventResponse> & Record<string, unknown>;
    const id = raw.id;
    return {
      source,
      contractId: contractIdOf(event),
      ledger: toLedger(raw.ledger),
      txHash: toTxHash(raw.txHash),
      at: toAt(raw.ledgerClosedAt),
      eventId: typeof id === "string" ? id : "",
      eventType: toEventType(raw.type),
      transactionIndex: toPosition(raw.transactionIndex),
      operationIndex: toPosition(raw.operationIndex),
      inSuccessfulContractCall: toSuccessFlag(raw.inSuccessfulContractCall),
    };
  } catch {
    return {
      source,
      contractId: "",
      ledger: 0,
      txHash: "",
      at: 0,
      eventId: "",
      eventType: "unknown",
      transactionIndex: null,
      operationIndex: null,
      inSuccessfulContractCall: null,
    };
  }
}

/**
 * A transaction hash is usable for ordering display and explorer links only
 * when it is a 64-character hex string (32-byte Stellar transaction hash).
 * Anything else stays on the event but is never turned into a link.
 */
export function isUsableTxHash(txHash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test((txHash ?? "").trim());
}

/** Rank a position for ordering: known indexes first (ascending), `null` last. */
function rankPosition(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Deterministic ordering over chain-provided metadata only:
 * ledger → transaction index → operation index → paging token → tx hash.
 *
 * Returns 0 only when every compared field is equal. No wall-clock time, no
 * array position, and no JS object iteration order are consulted, so the same
 * set of events always sorts the same way regardless of RPC page splits or
 * poll-cycle boundaries.
 */
export function compareEvents(a: EventMeta, b: EventMeta): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  const txA = rankPosition(a.transactionIndex);
  const txB = rankPosition(b.transactionIndex);
  if (txA !== txB) return txA - txB;
  const opA = rankPosition(a.operationIndex);
  const opB = rankPosition(b.operationIndex);
  if (opA !== opB) return opA - opB;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
  return 0;
}

/**
 * A stable, deterministic sort. Returns a new array; the input is untouched.
 * Elements with identical ordering keys keep their input relative order.
 */
export function sortEvents<T extends EventMeta>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((x, y) => compareEvents(x.event, y.event) || x.index - y.index)
    .map((entry) => entry.event);
}

/**
 * Drop within-scan duplicates by paging token (`eventId`). The RPC may repeat
 * the boundary event across pages; the first occurrence wins and input order
 * is preserved. Events with no paging token cannot be identified and are all
 * kept — identity is never invented.
 */
export function dedupeEvents<T extends EventMeta>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const event of events) {
    const id = event.eventId;
    if (!id) {
      out.push(event);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(event);
  }
  return out;
}

// ── Display helpers (shared by formatting and the CLI) ───────────────────────

/**
 * Atomic USDC -> an explicit 7-decimal string.
 *
 * Soroban amounts are integer atomic units, so keeping all seven fractional
 * digits makes the display unit unambiguous (`20000000n` -> `"2.0000000"`)
 * without ever converting through a floating-point number.
 */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** `GABCD…WXYZ` — full strkeys are unreadable in a chat message. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 5)}…${address.slice(-4)}`;
}

export function winnerSideLabel(side: number): string {
  return WINNER_SIDE[side] ?? `side ${side}`;
}

export function squadSideLabel(side: number): string {
  return SQUAD_SIDE[side] ?? `side ${side}`;
}

/** Check if a payload represents a decoded admin event. */
export function isAdminPayload(payload: EventPayload): payload is AdminPayload {
  if (!payload || typeof payload !== "object") return false;
  if (payload.name === "admin") return true;
  if (
    payload.name === "oracle_changed" ||
    payload.name === "ownership_transferred" ||
    payload.name === "agent_attributed" ||
    payload.name === "fee_accrued" ||
    payload.name === "fee_policy_set" ||
    payload.name === "fee_policy_changed" ||
    payload.name === "fee_policy_updated" ||
    payload.name === "fee_policy_removed"
  ) {
    return true;
  }
  if (
    typeof payload.name === "string" &&
    (payload.name.startsWith("fee_policy_") || payload.name.startsWith("admin_"))
  ) {
    return true;
  }
  return false;
}

/**
 * Transform a decoded event into a structured admin audit record, or null if it
 * is not an admin event.
 */
export function toAdminAuditRecord(
  event: DecodedEvent,
  config?: StellarConfig,
): AdminAuditRecord | null {
  if (!isAdminPayload(event.payload)) return null;

  const p = event.payload;
  let adminAddr: string | undefined = undefined;
  const details: Record<string, string | number | boolean> = {};

  if (p.name === "oracle_changed") {
    if (p.newOracle) adminAddr = p.newOracle;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "ownership_transferred") {
    if (p.newOwner) adminAddr = p.newOwner;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.previousOwner) details.previousOwner = p.previousOwner;
    if (p.newOwner) details.newOwner = p.newOwner;
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "agent_attributed") {
    if (p.agent) adminAddr = p.agent;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "fee_accrued") {
    if (p.recipient) adminAddr = p.recipient;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.amount !== undefined) details.amount = p.amount.toString();
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "admin") {
    if (p.admin) adminAddr = p.admin;
    if (p.details) Object.assign(details, p.details);
  } else {
    if ("admin" in p && typeof p.admin === "string") adminAddr = p.admin;
    if ("recipient" in p && typeof p.recipient === "string" && !adminAddr) adminAddr = p.recipient;
    if ("feeBps" in p && p.feeBps !== undefined) details.feeBps = p.feeBps;
    if ("category" in p && typeof p.category === "string") details.category = p.category;
    if ("details" in p && isRecord(p.details)) {
      for (const [k, v] of Object.entries(p.details as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        }
      }
    }
  }

  let explorerUrl: string | undefined = undefined;
  if (config && event.txHash && isUsableTxHash(event.txHash)) {
    try {
      explorerUrl = txExplorerUrl(config, event.txHash) || undefined;
    } catch {
      // Ignore
    }
  }

  return {
    type: p.name === "admin" ? (p as GenericAdminPayload).action : p.name,
    ledger: event.ledger,
    at: event.at,
    transactionHash: event.txHash || undefined,
    contractId: event.contractId || undefined,
    admin: adminAddr,
    details,
    explorerUrl,
  };
}
