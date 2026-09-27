/**
 * Tests for src/stellar/decode.ts
 *
 * Exercises the full decode pipeline — scValToNative → typed payload — using
 * synthetic fixtures built from real @stellar/stellar-sdk ScVal objects.
 * These are the same shapes the RPC returns; no live network calls are needed.
 *
 * Coverage:
 *   - Positive: every mimir-market and mimir-squad event type
 *   - Negative: admin/unknown events, missing topics, wrong types, empty topics
 *   - Boundary: unknown winner_side enum value, MAX_SAFE_INTEGER+1 amount,
 *               negative amounts, very long string fields
 *   - Regression: decodeEvent never throws; malformed XDR always yields
 *                 an `unknown` payload with a `reason`
 */

import assert from "node:assert/strict";
import test   from "node:test";

import { xdr as xdrSdk } from "@stellar/stellar-sdk";
import { decodeEvent } from "../dist/stellar/decode.js";
import { eventCursorLedger } from "../dist/stellar/events.js";

import {
  CREATOR, CHALL, CAPTAIN, FEE_ADDR,
  MARKET_CONTRACT, SQUAD_CONTRACT,
  claimCreatedEvent,
  claimChallengedEvent,
  claimResolvedEvent,
  claimCancelledEvent,
  marketSettledEvent,
  challengerPaidEvent,
  feeClaimedEvent,
  withdrawalEvent,
  withdrawalPendingEvent,
  squadMarketCreatedEvent,
  squadDepositedEvent,
  squadWithdrawnEvent,
  squadResolvedEvent,
  squadClaimedEvent,
  squadFeesClaimedEvent,
  oracleChangedEvent,
  feePolicySetEvent,
  ownershipTransferredEvent,
  agentAttributedEvent,
  feeAccruedEvent,
  emptyTopicsEvent,
  truncatedTopicsEvent,
  wrongValueTypeEvent,
  invalidAddressTopic,
  wrongFieldTypeEvent,
  unknownWinnerSideEvent,
  longCategoryEvent,
  longQuestionEvent,
  largeAmountEvent,
  negativeAmountEvent,
} from "./fixtures/events.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Assert that an event decoded without throwing and has the expected name. */
function assertName(decoded, expectedName) {
  assert.equal(decoded.payload.name, expectedName,
    `expected payload name "${expectedName}", got "${decoded.payload.name}"`);
}

/** Assert that a decoded event has an `unknown` payload and a reason string. */
function assertUnknown(decoded, context = "") {
  assert.equal(
    decoded.payload.name,
    "unknown",
    `${context}: expected unknown payload, got "${decoded.payload.name}"`,
  );
  // reason should always be a string, even if empty
  if (decoded.payload.name === "unknown") {
    assert.equal(typeof decoded.payload.reason, "string",
      `${context}: reason must be a string`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Meta fields ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("decodeEvent populates meta fields from the RPC event shape", () => {
  const raw = claimCreatedEvent({ ledger: 4226691, txHash: "abcd1234" });
  const decoded = decodeEvent("market", raw);

  assert.equal(decoded.source,     "market");
  assert.equal(decoded.contractId, MARKET_CONTRACT);
  assert.equal(decoded.ledger,     4226691);
  assert.equal(decoded.txHash,     "abcd1234");
  assert.equal(typeof decoded.at,  "number");
  assert.equal(typeof decoded.eventId, "string");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── mimir-market positive cases ───────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("decodes claim_created with correct fields", () => {
  const raw     = claimCreatedEvent({ claimId: 7, category: "crypto" });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "claim_created");
  const p = decoded.payload;
  assert.equal(p.name,     "claim_created");
  assert.equal(p.claimId,  7);
  assert.equal(p.creator,  CREATOR);
  assert.equal(p.category, "crypto");
});

test("decodes claim_challenged with bigint stake", () => {
  const raw     = claimChallengedEvent({ claimId: 7, stake: 20_000_000n });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "claim_challenged");
  const p = decoded.payload;
  assert.equal(p.name,       "claim_challenged");
  assert.equal(p.claimId,    7);
  assert.equal(p.challenger, CHALL);
  assert.equal(p.stake,      20_000_000n);
});

test("decodes claim_resolved with all fields", () => {
  const evidenceHex = "deadbeefcafebabe00112233445566778899aabbccddeeff0011223344556677";
  const raw     = claimResolvedEvent({ claimId: 7, winnerSide: 2, confidence: 100 });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "claim_resolved");
  const p = decoded.payload;
  assert.equal(p.name,       "claim_resolved");
  assert.equal(p.claimId,    7);
  assert.equal(p.winnerSide, 2);
  assert.equal(p.confidence, 100);
  assert.equal(typeof p.summary, "string");
  assert.equal(p.evidenceHash, evidenceHex);
});

test("decodes claim_cancelled", () => {
  const raw     = claimCancelledEvent({ claimId: 7 });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "claim_cancelled");
  assert.equal(decoded.payload.claimId, 7);
});

test("decodes market_settled with all amount fields", () => {
  const raw = marketSettledEvent({
    claimId: 7,
    totalPaid: 40_000_000n,
    totalFees: 2_000_000n,
    owedToChallengers: 38_000_000n,
    dust: 0n,
  });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "market_settled");
  const p = decoded.payload;
  assert.equal(p.totalPaid,          40_000_000n);
  assert.equal(p.totalFees,           2_000_000n);
  assert.equal(p.owedToChallengers,  38_000_000n);
  assert.equal(p.dust,                        0n);
});

test("decodes challenger_paid with stake/gross/fee/net", () => {
  const raw = challengerPaidEvent({
    claimId: 7,
    stake: 20_000_000n,
    gross: 38_000_000n,
    fee:    1_900_000n,
    net:   36_100_000n,
  });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "challenger_paid");
  const p = decoded.payload;
  assert.equal(p.challenger, CHALL);
  assert.equal(p.stake,  20_000_000n);
  assert.equal(p.gross,  38_000_000n);
  assert.equal(p.fee,     1_900_000n);
  assert.equal(p.net,    36_100_000n);
});

test("decodes fee_claimed with recipient and amount", () => {
  const raw     = feeClaimedEvent({ amount: 2_000_000n });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "fee_claimed");
  const p = decoded.payload;
  assert.equal(p.recipient, FEE_ADDR);
  assert.equal(p.amount,    2_000_000n);
});

test("decodes withdrawal", () => {
  const raw     = withdrawalEvent({ amount: 10_000_000n });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "withdrawal");
  const p = decoded.payload;
  assert.equal(p.to,     CREATOR);
  assert.equal(p.amount, 10_000_000n);
});

test("decodes withdrawal_pending", () => {
  const raw     = withdrawalPendingEvent({ amount: 10_000_000n });
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "withdrawal_pending");
  const p = decoded.payload;
  assert.equal(p.to,     CREATOR);
  assert.equal(p.amount, 10_000_000n);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── mimir-squad positive cases ────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("decodes squad market_created with all fields", () => {
  const raw = squadMarketCreatedEvent({
    marketId: 1,
    feeBps: 200,
    question: "Will BTC exceed $100k by end of 2026?",
  });
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "market_created");
  const p = decoded.payload;
  assert.equal(p.marketId, 1);
  assert.equal(p.captain,  CAPTAIN);
  assert.equal(p.feeBps,   200);
  assert.equal(p.question, "Will BTC exceed $100k by end of 2026?");
  assert.equal(typeof p.deadline, "number");
});

test("decodes squad deposited on side A", () => {
  const raw = squadDepositedEvent({ marketId: 1, side: 1, amount: 50_000_000n, shares: 50_000_000n });
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "deposited");
  const p = decoded.payload;
  assert.equal(p.marketId, 1);
  assert.equal(p.side,     1);
  assert.equal(p.participant, CREATOR);
  assert.equal(p.amount,  50_000_000n);
  assert.equal(p.shares,  50_000_000n);
});

test("decodes squad withdrawn", () => {
  const raw     = squadWithdrawnEvent({ marketId: 1, side: 2, amount: 25_000_000n });
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "withdrawn");
  const p = decoded.payload;
  assert.equal(p.marketId, 1);
  assert.equal(p.side,     2);
  assert.equal(p.amount,  25_000_000n);
});

test("decodes squad resolved with pool amounts", () => {
  const raw = squadResolvedEvent({
    marketId: 1,
    result: 1,
    poolA: 50_000_000n,
    poolB: 30_000_000n,
  });
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "resolved");
  const p = decoded.payload;
  assert.equal(p.result,   1);
  assert.equal(p.poolA,   50_000_000n);
  assert.equal(p.poolB,   30_000_000n);
});

test("decodes squad claimed with gross/fee/net", () => {
  const raw = squadClaimedEvent({
    marketId: 1,
    gross: 80_000_000n,
    fee:    1_600_000n,
    net:   78_400_000n,
  });
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "claimed");
  const p = decoded.payload;
  assert.equal(p.participant, CREATOR);
  assert.equal(p.gross,  80_000_000n);
  assert.equal(p.fee,     1_600_000n);
  assert.equal(p.net,    78_400_000n);
});

test("decodes squad fees_claimed", () => {
  const raw     = squadFeesClaimedEvent({ amount: 3_600_000n });
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "fees_claimed");
  const p = decoded.payload;
  assert.equal(p.recipient, FEE_ADDR);
  assert.equal(p.amount,    3_600_000n);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Admin / no-notification events ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("oracle_changed decodes into structured admin payload", () => {
  const raw     = oracleChangedEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "oracle_changed");
  assert.equal(decoded.payload.newOracle, FEE_ADDR);
});

test("fee_policy_set decodes into structured admin payload", () => {
  const raw     = feePolicySetEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "fee_policy_set");
  assert.equal(decoded.payload.feeBps, 500);
});

test("ownership_transferred decodes into structured admin payload", () => {
  const raw     = ownershipTransferredEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "ownership_transferred");
  assert.equal(decoded.payload.previousOwner, CREATOR);
  assert.equal(decoded.payload.newOwner, FEE_ADDR);
});

test("agent_attributed decodes into structured admin payload", () => {
  const raw     = agentAttributedEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "agent_attributed");
  assert.equal(decoded.payload.agent, CAPTAIN);
});

test("fee_accrued decodes into structured admin payload", () => {
  const raw     = feeAccruedEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "fee_accrued");
  assert.equal(decoded.payload.recipient, FEE_ADDR);
  assert.equal(decoded.payload.amount, 5_000_000n);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Malformed / negative cases — decodeEvent must NEVER throw ─────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("empty topics event returns unknown payload without throwing", () => {
  const raw     = emptyTopicsEvent();
  const decoded = decodeEvent("market", raw);

  // payload.name must be "unknown" — the eventName may be "" or undefined
  assert.equal(decoded.payload.name, "unknown");
});

test("truncated topics (missing claimId and creator) returns unknown with reason", () => {
  const raw     = truncatedTopicsEvent();
  const decoded = decodeEvent("market", raw);

  assertUnknown(decoded, "truncated topics");
  // The reason must mention the missing topic
  assert.match(decoded.payload.reason ?? "", /topic\[/i);
});

test("wrong value type (scvBool instead of map) returns unknown with reason", () => {
  const raw     = wrongValueTypeEvent();
  const decoded = decodeEvent("market", raw);

  assertUnknown(decoded, "wrong value type");
});

test("invalid address in topic returns unknown with reason", () => {
  const raw     = invalidAddressTopic();
  const decoded = decodeEvent("market", raw);

  assertUnknown(decoded, "invalid address topic");
  // The decoder tries to coerce the boolean topic to a string/address, fails,
  // and stores the reason.  The exact wording depends on which type check fails
  // first (string coercion or strkey regex), but a reason is always present.
  assert.ok(
    (decoded.payload.reason ?? "").length > 0,
    "reason should be non-empty for an invalid address topic",
  );
});

test("wrong field type in value map returns unknown with reason", () => {
  const raw     = wrongFieldTypeEvent();
  const decoded = decodeEvent("market", raw);

  assertUnknown(decoded, "wrong field type");
});

test("completely unknown event name returns unknown payload", () => {
  const raw = {
    id: "x",
    type: "contract",
    ledger: 1,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    txHash: "",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    contractId: MARKET_CONTRACT,
    topic: [xdrSdk.ScVal.scvSymbol("totally_unknown_event_name")],
    value: xdrSdk.ScVal.scvMap([]),
  };
  const decoded = decodeEvent("market", raw);

  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "totally_unknown_event_name");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Boundary cases ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("unknown winner_side enum value decodes without crashing", () => {
  const raw     = unknownWinnerSideEvent();
  const decoded = decodeEvent("market", raw);

  // The decoder accepts any u32 for winner_side; display logic handles unknown.
  assertName(decoded, "claim_resolved");
  if (decoded.payload.name === "claim_resolved") {
    assert.equal(decoded.payload.winnerSide, 99);
  }
});

test("amount at MAX_SAFE_INTEGER + 1 decodes as bigint without loss", () => {
  const huge    = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const raw     = largeAmountEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "withdrawal");
  if (decoded.payload.name === "withdrawal") {
    assert.equal(decoded.payload.amount, huge);
  }
});

test("negative i128 amount is rejected as an unknown payload", () => {
  const raw     = negativeAmountEvent();
  const decoded = decodeEvent("market", raw);

  // Amounts are validated as non-negative; a negative i128 never reaches formatting.
  assertUnknown(decoded, "negative amount");
});

test("very long category string decodes in full (no truncation in decoder)", () => {
  const raw     = longCategoryEvent();
  const decoded = decodeEvent("market", raw);

  assertName(decoded, "claim_created");
  if (decoded.payload.name === "claim_created") {
    assert.equal(decoded.payload.category.length, 500);
  }
});

test("very long question string decodes in full (truncation is formatter's job)", () => {
  const raw     = longQuestionEvent();
  const decoded = decodeEvent("squad", raw);

  assertName(decoded, "market_created");
  if (decoded.payload.name === "market_created") {
    assert.equal(decoded.payload.question.length, 1000);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── No-throw regression: a for-each over every fixture must not throw ─────────
// ─────────────────────────────────────────────────────────────────────────────

test("decodeEvent never throws on any fixture, including all malformed ones", () => {
  const marketFixtures = [
    claimCreatedEvent(),
    claimChallengedEvent(),
    claimResolvedEvent(),
    claimCancelledEvent(),
    marketSettledEvent(),
    challengerPaidEvent(),
    feeClaimedEvent(),
    withdrawalEvent(),
    withdrawalPendingEvent(),
    oracleChangedEvent(),
    feePolicySetEvent(),
    emptyTopicsEvent(),
    truncatedTopicsEvent(),
    wrongValueTypeEvent(),
    invalidAddressTopic(),
    wrongFieldTypeEvent(),
    unknownWinnerSideEvent(),
    longCategoryEvent(),
    largeAmountEvent(),
    negativeAmountEvent(),
  ];

  const squadFixtures = [
    squadMarketCreatedEvent(),
    squadDepositedEvent(),
    squadWithdrawnEvent(),
    squadResolvedEvent(),
    squadClaimedEvent(),
    squadFeesClaimedEvent(),
    emptyTopicsEvent({ contractId: SQUAD_CONTRACT }),
    truncatedTopicsEvent({ contractId: SQUAD_CONTRACT }),
  ];

  let count = 0;
  for (const fixture of marketFixtures) {
    assert.doesNotThrow(() => {
      decodeEvent("market", fixture);
    }, `market fixture ${count} threw`);
    count++;
  }
  for (const fixture of squadFixtures) {
    assert.doesNotThrow(() => {
      decodeEvent("squad", fixture);
    }, `squad fixture ${count} threw`);
    count++;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Cross-contract source mismatch ───────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("a market event decoded as squad source yields unknown (no decoder overlap)", () => {
  // claim_created is a market-only event; decoding it as squad should give unknown.
  const raw     = claimCreatedEvent();
  const decoded = decodeEvent("squad", raw);

  // The squad decoder has no "claim_created" case → unknown with no decoder reason.
  assert.equal(decoded.payload.name, "unknown");
});

test("a squad event decoded as market source yields unknown", () => {
  const raw     = squadMarketCreatedEvent();
  const decoded = decodeEvent("market", raw);

  assert.equal(decoded.payload.name, "unknown");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── eventCursorLedger helper ──────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("eventCursorLedger extracts the ledger from a valid cursor", () => {
  // A TOID of (ledger << 32) | index — use ledger 4226728
  const ledger = 4226728;
  const toid   = (BigInt(ledger) << 32n).toString();
  const cursor = `${toid}-0`;

  assert.equal(eventCursorLedger(cursor), ledger);
});

test("eventCursorLedger returns null for malformed cursors", () => {
  assert.equal(eventCursorLedger(""),              null);
  assert.equal(eventCursorLedger("not-a-toid"),    null);
  assert.equal(eventCursorLedger("-1"),             null);
});
