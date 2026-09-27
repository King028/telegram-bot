/**
 * Synthetic Soroban event fixtures.
 *
 * Each fixture mirrors the wire shape that `rpc.Api.EventResponse` carries
 * after the SDK converts raw base64 XDR into typed objects:
 *   - `topic`  : xdr.ScVal[]  (first element is the event name as scvSymbol)
 *   - `value`  : xdr.ScVal    (a scvMap of non-topic fields)
 *
 * These were built to match the actual field layout documented in
 * `src/stellar/decode.ts`, which was cross-checked against the live Testnet
 * deployment via `npm run scan`.  The addresses are deterministic (derived from
 * fixed raw seeds) so tests never depend on randomness or network access.
 *
 * Providing real ScVal objects (not mocks or JSON stubs) means the decoder's
 * `scValToNative` path is exercised on every run, catching any SDK-shape
 * regressions as well as logic bugs.
 */

import { xdr, Address, Keypair } from "@stellar/stellar-sdk";

// ── Deterministic test identities ────────────────────────────────────────────

export const CREATOR_KP  = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x01));
export const CHALL_KP    = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x02));
export const CAPTAIN_KP  = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x03));
export const FEE_KP      = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x04));

export const CREATOR  = CREATOR_KP.publicKey();
export const CHALL    = CHALL_KP.publicKey();
export const CAPTAIN  = CAPTAIN_KP.publicKey();
export const FEE_ADDR = FEE_KP.publicKey();

export const MARKET_CONTRACT = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
export const SQUAD_CONTRACT  = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

// ── ScVal builders ────────────────────────────────────────────────────────────

function sym(s)  { return xdr.ScVal.scvSymbol(s); }
function str(s)  { return xdr.ScVal.scvString(s); }
function u32(n)  { return xdr.ScVal.scvU32(n); }
function u64(n)  { return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n))); }

/**
 * i128 from a BigInt.  All Mimir USDC amounts are i128 on-chain.
 * We split into hi/lo 64-bit halves.
 */
function i128(n) {
  const bn = BigInt(n);
  const isNeg = bn < 0n;
  const abs = isNeg ? -bn : bn;
  const lo = abs & 0xFFFF_FFFF_FFFF_FFFFn;
  let hi = abs >> 64n;
  if (isNeg) {
    // two's complement for i128 negative
    hi = (~hi + (lo === 0n ? 1n : 0n)) & 0xFFFF_FFFF_FFFF_FFFFn;
    const loVal = lo === 0n ? 0n : ((~lo + 1n) & 0xFFFF_FFFF_FFFF_FFFFn);
    return xdr.ScVal.scvI128(new xdr.Int128Parts({
      hi: xdr.Int64.fromString(String(BigInt.asIntN(64, hi))),
      lo: xdr.Uint64.fromString(String(loVal)),
    }));
  }
  return xdr.ScVal.scvI128(new xdr.Int128Parts({
    hi: xdr.Int64.fromString("0"),
    lo: xdr.Uint64.fromString(String(lo)),
  }));
}

function addrVal(strkey) {
  return new Address(strkey).toScVal();
}

function bytesVal(hexStr) {
  return xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}

/** Build a scvMap from an ordered array of [symbol-key, scVal] pairs. */
function scMap(pairs) {
  return xdr.ScVal.scvMap(
    pairs.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })),
  );
}

// ── Base event meta ───────────────────────────────────────────────────────────

function baseMeta(overrides = {}) {
  return {
    id:              overrides.id            ?? "0018276211125911551-4294967295",
    type:            "contract",
    ledger:          overrides.ledger        ?? 4226691,
    ledgerClosedAt:  overrides.ledgerClosedAt ?? "2026-09-01T00:00:00Z",
    txHash:          overrides.txHash        ?? "aabbcc0011223344556677889900aabbcc0011223344556677889900aabbcc001122",
    transactionIndex:  0,
    operationIndex:    0,
    inSuccessfulContractCall: true,
    contractId: overrides.contractId ?? MARKET_CONTRACT,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// mimir-market events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * claim_created
 *   topics: [sym("claim_created"), u64(claimId), address(creator)]
 *   value:  { category: str }
 */
export function claimCreatedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("claim_created"),
      u64(overrides.claimId    ?? 7),
      addrVal(overrides.creator ?? CREATOR),
    ],
    value: scMap([["category", str(overrides.category ?? "crypto")]]),
  };
}

/**
 * claim_challenged
 *   topics: [sym("claim_challenged"), u64(claimId), address(challenger)]
 *   value:  { stake: i128 }
 */
export function claimChallengedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("claim_challenged"),
      u64(overrides.claimId     ?? 7),
      addrVal(overrides.challenger ?? CHALL),
    ],
    value: scMap([["stake", i128(overrides.stake ?? 20_000_000n)]]),
  };
}

/**
 * claim_resolved
 *   topics: [sym("claim_resolved"), u64(claimId)]
 *   value:  { winner_side: u32, summary: str, confidence: u32, evidence_hash: bytes }
 */
export function claimResolvedEvent(overrides = {}) {
  const evidenceHex = overrides.evidenceHex ?? "deadbeefcafebabe00112233445566778899aabbccddeeff0011223344556677";
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("claim_resolved"),
      u64(overrides.claimId ?? 7),
    ],
    value: scMap([
      ["winner_side",    u32(overrides.winnerSide ?? 2)],
      ["summary",        str(overrides.summary    ?? "Onchain smoke — challengers awarded so the payout pull can be exercised")],
      ["confidence",     u32(overrides.confidence ?? 100)],
      ["evidence_hash",  bytesVal(evidenceHex)],
    ]),
  };
}

/**
 * claim_cancelled
 *   topics: [sym("claim_cancelled"), u64(claimId)]
 *   value:  {} (empty map)
 */
export function claimCancelledEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("claim_cancelled"),
      u64(overrides.claimId ?? 7),
    ],
    value: scMap([]),
  };
}

/**
 * market_settled
 *   topics: [sym("market_settled"), u64(claimId)]
 *   value:  { total_paid, total_fees, owed_to_challengers, dust }
 */
export function marketSettledEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("market_settled"),
      u64(overrides.claimId ?? 7),
    ],
    value: scMap([
      ["total_paid",          i128(overrides.totalPaid         ?? 40_000_000n)],
      ["total_fees",          i128(overrides.totalFees         ?? 2_000_000n)],
      ["owed_to_challengers", i128(overrides.owedToChallengers ?? 38_000_000n)],
      ["dust",                i128(overrides.dust              ?? 0n)],
    ]),
  };
}

/**
 * challenger_paid
 *   topics: [sym("challenger_paid"), u64(claimId), address(challenger)]
 *   value:  { stake, gross, fee, net }
 */
export function challengerPaidEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("challenger_paid"),
      u64(overrides.claimId     ?? 7),
      addrVal(overrides.challenger ?? CHALL),
    ],
    value: scMap([
      ["stake", i128(overrides.stake ?? 20_000_000n)],
      ["gross", i128(overrides.gross ?? 38_000_000n)],
      ["fee",   i128(overrides.fee   ??  1_900_000n)],
      ["net",   i128(overrides.net   ?? 36_100_000n)],
    ]),
  };
}

/**
 * fee_claimed
 *   topics: [sym("fee_claimed"), address(recipient)]
 *   value:  { amount: i128 }
 */
export function feeClaimedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("fee_claimed"),
      addrVal(overrides.recipient ?? FEE_ADDR),
    ],
    value: scMap([["amount", i128(overrides.amount ?? 2_000_000n)]]),
  };
}

/**
 * withdrawal
 *   topics: [sym("withdrawal"), address(to)]
 *   value:  { amount: i128 }
 */
export function withdrawalEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("withdrawal"),
      addrVal(overrides.to ?? CREATOR),
    ],
    value: scMap([["amount", i128(overrides.amount ?? 10_000_000n)]]),
  };
}

/**
 * withdrawal_pending
 *   topics: [sym("withdrawal_pending"), address(to)]
 *   value:  { amount: i128 }
 */
export function withdrawalPendingEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("withdrawal_pending"),
      addrVal(overrides.to ?? CREATOR),
    ],
    value: scMap([["amount", i128(overrides.amount ?? 10_000_000n)]]),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// mimir-squad events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * market_created
 *   topics: [sym("market_created"), u64(marketId), address(captain)]
 *   value:  { deadline, fee_bps, question }
 */
export function squadMarketCreatedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("market_created"),
      u64(overrides.marketId ?? 1),
      addrVal(overrides.captain ?? CAPTAIN),
    ],
    value: scMap([
      ["deadline", u64(overrides.deadline ?? 1_800_000_000)],
      ["fee_bps",  u32(overrides.feeBps   ?? 200)],
      ["question", str(overrides.question ?? "Will BTC exceed $100k by end of 2026?")],
    ]),
  };
}

/**
 * deposited
 *   topics: [sym("deposited"), u64(marketId), u32(side), address(participant)]
 *   value:  { amount: i128, shares: i128 }
 */
export function squadDepositedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("deposited"),
      u64(overrides.marketId    ?? 1),
      u32(overrides.side        ?? 1),
      addrVal(overrides.participant ?? CREATOR),
    ],
    value: scMap([
      ["amount", i128(overrides.amount ?? 50_000_000n)],
      ["shares", i128(overrides.shares ?? 50_000_000n)],
    ]),
  };
}

/**
 * withdrawn
 *   topics: [sym("withdrawn"), u64(marketId), u32(side), address(participant)]
 *   value:  { amount: i128 }
 */
export function squadWithdrawnEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("withdrawn"),
      u64(overrides.marketId    ?? 1),
      u32(overrides.side        ?? 1),
      addrVal(overrides.participant ?? CREATOR),
    ],
    value: scMap([["amount", i128(overrides.amount ?? 50_000_000n)]]),
  };
}

/**
 * resolved
 *   topics: [sym("resolved"), u64(marketId)]
 *   value:  { result: u32, pool_a: i128, pool_b: i128 }
 */
export function squadResolvedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("resolved"),
      u64(overrides.marketId ?? 1),
    ],
    value: scMap([
      ["result", u32(overrides.result ?? 1)],
      ["pool_a", i128(overrides.poolA ?? 50_000_000n)],
      ["pool_b", i128(overrides.poolB ?? 30_000_000n)],
    ]),
  };
}

/**
 * claimed
 *   topics: [sym("claimed"), u64(marketId), address(participant)]
 *   value:  { gross: i128, fee: i128, net: i128 }
 */
export function squadClaimedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("claimed"),
      u64(overrides.marketId    ?? 1),
      addrVal(overrides.participant ?? CREATOR),
    ],
    value: scMap([
      ["gross", i128(overrides.gross ?? 80_000_000n)],
      ["fee",   i128(overrides.fee   ??  1_600_000n)],
      ["net",   i128(overrides.net   ?? 78_400_000n)],
    ]),
  };
}

/**
 * fees_claimed
 *   topics: [sym("fees_claimed"), address(recipient)]
 *   value:  { amount: i128 }
 */
export function squadFeesClaimedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("fees_claimed"),
      addrVal(overrides.recipient ?? FEE_ADDR),
    ],
    value: scMap([["amount", i128(overrides.amount ?? 3_600_000n)]]),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Admin / unknown events (no notification expected)
// ═══════════════════════════════════════════════════════════════════════════════

/** oracle_changed — a real market event with no notification. */
export function oracleChangedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("oracle_changed"),
      addrVal(overrides.newOracle ?? FEE_ADDR),
    ],
    value: scMap([]),
  };
}

/** fee_policy_set — family of admin events with no notification. */
export function feePolicySetEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [sym("fee_policy_set")],
    value: scMap([["fee_bps", u32(overrides.feeBps ?? 500)]]),
  };
}

/** ownership_transferred — admin event. */
export function ownershipTransferredEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("ownership_transferred"),
      addrVal(overrides.newOwner ?? FEE_ADDR),
    ],
    value: scMap([
      ["previous_owner", addrVal(overrides.previousOwner ?? CREATOR)],
      ["new_owner", addrVal(overrides.newOwner ?? FEE_ADDR)],
    ]),
  };
}

/** agent_attributed — admin event. */
export function agentAttributedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("agent_attributed"),
      addrVal(overrides.agent ?? CAPTAIN),
    ],
    value: scMap([]),
  };
}

/** fee_accrued — admin event. */
export function feeAccruedEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("fee_accrued"),
      addrVal(overrides.recipient ?? FEE_ADDR),
    ],
    value: scMap([["amount", i128(overrides.amount ?? 5_000_000n)]]),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Malformed / boundary fixtures for negative-path tests
// ═══════════════════════════════════════════════════════════════════════════════

/** Event whose topic array is completely empty (no event name). */
export function emptyTopicsEvent(overrides = {}) {
  return {
    ...baseMeta(overrides),
    topic: [],
    value: scMap([]),
  };
}

/** Event with a valid name but missing required topics (truncated). */
export function truncatedTopicsEvent(overrides = {}) {
  return {
    ...baseMeta(overrides),
    topic: [sym("claim_created")],   // missing claimId and creator topics
    value: scMap([["category", str("crypto")]]),
  };
}

/** Event where the value ScVal is not a map (scvBool instead). */
export function wrongValueTypeEvent(overrides = {}) {
  return {
    ...baseMeta(overrides),
    topic: [
      sym("claim_challenged"),
      u64(1),
      addrVal(CHALL),
    ],
    value: xdr.ScVal.scvBool(true),  // should be a map
  };
}

/** Event where an address topic holds a non-address ScVal. */
export function invalidAddressTopic(overrides = {}) {
  return {
    ...baseMeta(overrides),
    topic: [
      sym("claim_created"),
      u64(1),
      xdr.ScVal.scvBool(false),   // invalid address
    ],
    value: scMap([["category", str("crypto")]]),
  };
}

/** Event where the i128 stake field is replaced by a string. */
export function wrongFieldTypeEvent(overrides = {}) {
  return {
    ...baseMeta(overrides),
    topic: [
      sym("claim_challenged"),
      u64(1),
      addrVal(CHALL),
    ],
    value: scMap([["stake", str("not-a-number")]]),
  };
}

/** claim_resolved where winner_side exceeds the known enum range. */
export function unknownWinnerSideEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("claim_resolved"),
      u64(overrides.claimId ?? 7),
    ],
    value: scMap([
      ["winner_side",   u32(99)],   // unknown side
      ["summary",       str("unknown side test")],
      ["confidence",    u32(50)],
      ["evidence_hash", bytesVal("aabbccdd")],
    ]),
  };
}

/** A claim_created with a very long category string (boundary: > 200 chars). */
export function longCategoryEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("claim_created"),
      u64(overrides.claimId ?? 99),
      addrVal(overrides.creator ?? CREATOR),
    ],
    value: scMap([["category", str("x".repeat(500))]]),
  };
}

/** market_created with a very long question string. */
export function longQuestionEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: SQUAD_CONTRACT }),
    topic: [
      sym("market_created"),
      u64(overrides.marketId ?? 42),
      addrVal(overrides.captain ?? CAPTAIN),
    ],
    value: scMap([
      ["deadline", u64(1_800_000_000)],
      ["fee_bps",  u32(100)],
      ["question", str("Q".repeat(1000))],
    ]),
  };
}

/** i128 value at the edge of JS safe integer range (MAX_SAFE_INTEGER + 1). */
export function largeAmountEvent(overrides = {}) {
  const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n; // 9007199254740992n
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("withdrawal"),
      addrVal(overrides.to ?? CREATOR),
    ],
    value: scMap([["amount", i128(huge)]]),
  };
}

/** Negative i128 amount (should decode cleanly to negative bigint). */
export function negativeAmountEvent(overrides = {}) {
  return {
    ...baseMeta({ ...overrides, contractId: MARKET_CONTRACT }),
    topic: [
      sym("withdrawal"),
      addrVal(overrides.to ?? CREATOR),
    ],
    value: scMap([["amount", i128(-1_000_000n)]]),
  };
}
