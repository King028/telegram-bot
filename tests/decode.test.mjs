/**
 * Tests for src/stellar/decode.ts
 *
 * decodeEvent must NEVER throw, regardless of input shape.
 * Any event it does not understand becomes { name: "unknown", reason: "..." }.
 *
 * Covered:
 *   - Missing topics
 *   - Wrong-type fields
 *   - Oversized strings (clip() in formatEvent)
 *   - Unknown event names (no decoder)
 *   - Admin events that are decoded into structured audit records
 *   - Both market and squad sources
 *   - Helpers: formatUsdc, shortAddress, winnerSideLabel, squadSideLabel
 */

import assert from "node:assert/strict";
import test from "node:test";

import { nativeToScVal, Address, Keypair } from "@stellar/stellar-sdk";
import {
  decodeEvent,
  formatUsdc,
  shortAddress,
  winnerSideLabel,
  squadSideLabel,
  isAdminPayload,
  toAdminAuditRecord,
  USDC_UNIT,
  WINNER_SIDE,
  SQUAD_SIDE,
} from "../dist/stellar/decode.js";
import { formatEvent, escapeMd } from "../dist/notifications/format.js";

// ── Deterministic test address ────────────────────────────────────────────────

// A deterministic keypair derived from a fixed seed, giving a stable G-address.
const TEST_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
const ADDR = TEST_KP.publicKey(); // predictable G... strkey, 56 chars

// ── ScVal builders ────────────────────────────────────────────────────────────

function scStr(s) {
  return nativeToScVal(s, { type: "string" });
}
function scU64(n) {
  return nativeToScVal(BigInt(n), { type: "u64" });
}
function scI128(n) {
  return nativeToScVal(BigInt(n), { type: "i128" });
}
/** Build an Address ScVal from a G-address strkey. */
function scAddress(gAddr) {
  const kp = Keypair.fromPublicKey(gAddr);
  return Address.account(Buffer.from(kp.rawPublicKey())).toScVal();
}
function scU32(n) {
  return nativeToScVal(n, { type: "u32" });
}
function scBytes(hex) {
  const buf = Buffer.from(hex, "hex");
  return nativeToScVal(buf, { type: "bytes" });
}

// ── formatUsdc ────────────────────────────────────────────────────────────────

test("formatUsdc: 0 renders as 0.0000000", () => {
  assert.equal(formatUsdc(0n), "0.0000000");
});

test("formatUsdc: 1 atomic unit renders as 0.0000001", () => {
  assert.equal(formatUsdc(1n), "0.0000001");
});

test("formatUsdc: USDC_UNIT renders as 1.0000000", () => {
  assert.equal(formatUsdc(USDC_UNIT), "1.0000000");
});

test("formatUsdc: negative amounts render with leading minus", () => {
  assert.equal(formatUsdc(-USDC_UNIT), "-1.0000000");
});

test("formatUsdc: large integer keeps all 7 fractional digits", () => {
  assert.equal(formatUsdc(123_456_789_012_345_678_901_234_567n), "12345678901234567890.1234567");
});

// ── shortAddress ──────────────────────────────────────────────────────────────

test("shortAddress: long address is truncated to head…tail form", () => {
  // shortAddress returns `${addr.slice(0, 5)}…${addr.slice(-4)}` for > 12 chars
  const short = shortAddress(ADDR);
  const expected = `${ADDR.slice(0, 5)}…${ADDR.slice(-4)}`;
  assert.equal(short, expected);
  assert.ok(short.length < ADDR.length);
});

test("shortAddress: exactly 12 chars is returned as-is (boundary)", () => {
  const twelve = "GABCDEFGHIJKL".slice(0, 12);
  assert.equal(shortAddress(twelve), twelve);
});

test("shortAddress: 5-char address is returned as-is", () => {
  assert.equal(shortAddress("GABCD"), "GABCD");
});

test("shortAddress: 13-char address is truncated", () => {
  const thirteen = "G" + "A".repeat(12); // 13 chars
  const result = shortAddress(thirteen);
  assert.ok(result.includes("…"), "truncated address must contain ellipsis");
  assert.ok(result.length < thirteen.length);
});

// ── winnerSideLabel / squadSideLabel ─────────────────────────────────────────

test("winnerSideLabel: known codes return their label", () => {
  for (const [code, label] of Object.entries(WINNER_SIDE)) {
    assert.equal(winnerSideLabel(Number(code)), label);
  }
});

test("winnerSideLabel: unknown code returns a fallback string", () => {
  const label = winnerSideLabel(99);
  assert.match(label, /side 99/i);
});

test("squadSideLabel: known codes return their label", () => {
  for (const [code, label] of Object.entries(SQUAD_SIDE)) {
    assert.equal(squadSideLabel(Number(code)), label);
  }
});

test("squadSideLabel: unknown code returns a fallback string", () => {
  const label = squadSideLabel(77);
  assert.match(label, /side 77/i);
});

// ── decodeEvent: never throws ─────────────────────────────────────────────────

test("decodeEvent: completely empty event produces unknown payload without throwing", () => {
  const raw = {
    id: "1-0",
    contractId: "C1",
    ledger: 1,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [],
    value: null,
  };
  let result;
  assert.doesNotThrow(() => { result = decodeEvent("market", raw); });
  assert.equal(result.payload.name, "unknown");
  assert.ok(result.payload.eventName !== undefined);
});

test("decodeEvent: null value field does not throw", () => {
  const raw = {
    id: "2-0",
    contractId: "C1",
    ledger: 2,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created")],
    value: null,
  };
  let result;
  assert.doesNotThrow(() => { result = decodeEvent("market", raw); });
  assert.equal(result.payload.name, "unknown");
});

test("decodeEvent: unknown event name yields unknown payload with reason=no decoder", () => {
  const raw = {
    id: "3-0",
    contractId: "C1",
    ledger: 3,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("totally_unknown_event"), scStr("something")],
    value: nativeToScVal({}),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "unknown");
  assert.equal(result.payload.eventName, "totally_unknown_event");
  assert.equal(result.payload.reason, "no decoder");
});

test("decodeEvent: missing required topic produces unknown with a reason", () => {
  // claim_created expects topics[1] = claimId, topics[2] = creator.
  // Providing only the name topic should produce an unknown with a reason.
  const raw = {
    id: "4-0",
    contractId: "C1",
    ledger: 4,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created")], // missing topics[1] and topics[2]
    value: nativeToScVal({ category: "crypto" }),
  };
  let result;
  assert.doesNotThrow(() => { result = decodeEvent("market", raw); });
  assert.equal(result.payload.name, "unknown");
  assert.ok(result.payload.reason, "reason should be populated");
});

test("decodeEvent: wrong type for required topic produces unknown — never throws", () => {
  // Pass a string where claimId (u64) is expected. The str value
  // "not-a-number" will be passed to num(), which calls big() — but
  // big() tries BigInt("not-a-number") which throws a SyntaxError inside
  // decodeEvent. decodeEvent must catch it and return unknown.
  const raw = {
    id: "5-0",
    contractId: "C1",
    ledger: 5,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created"), scStr("not-a-number"), scAddress(ADDR)],
    value: nativeToScVal({ category: "crypto" }),
  };
  let result;
  assert.doesNotThrow(() => { result = decodeEvent("market", raw); });
  // Either a decode error (unknown) or a successful parse — but no throw.
  assert.ok(result.payload.name === "claim_created" || result.payload.name === "unknown");
});

test("decodeEvent: claim_created decodes correctly", () => {
  const raw = {
    id: "10-0",
    contractId: "C1",
    ledger: 10,
    txHash: "deadbeef",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created"), scU64(42), scAddress(ADDR)],
    value: nativeToScVal({ category: "sports" }),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "claim_created");
  assert.equal(result.payload.claimId, 42);
  assert.equal(result.payload.creator, ADDR);
  assert.equal(result.payload.category, "sports");
  assert.equal(result.ledger, 10);
  assert.equal(result.txHash, "deadbeef");
});

test("decodeEvent: claim_challenged decodes stake as bigint", () => {
  const stake = 20_000_000n;
  const raw = {
    id: "11-0",
    contractId: "C1",
    ledger: 11,
    txHash: "abc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_challenged"), scU64(7), scAddress(ADDR)],
    value: nativeToScVal({ stake: scI128(stake) }),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "claim_challenged");
  assert.equal(result.payload.stake, stake);
});

test("decodeEvent: claim_resolved decodes all fields", () => {
  const evidenceHex = "deadbeefcafe0123";
  const raw = {
    id: "12-0",
    contractId: "C1",
    ledger: 12,
    txHash: "abc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_resolved"), scU64(3)],
    value: nativeToScVal({
      winner_side: scU32(2),
      summary: "challengers win",
      confidence: scU32(95),
      evidence_hash: scBytes(evidenceHex),
    }),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "claim_resolved");
  assert.equal(result.payload.claimId, 3);
  assert.equal(result.payload.winnerSide, 2);
  assert.equal(result.payload.summary, "challengers win");
  assert.equal(result.payload.confidence, 95);
  assert.equal(result.payload.evidenceHash, evidenceHex);
});

test("decodeEvent: squad market_created decodes correctly", () => {
  const raw = {
    id: "20-0",
    contractId: "C2",
    ledger: 20,
    txHash: "def",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("market_created"), scU64(5), scAddress(ADDR)],
    value: nativeToScVal({
      deadline: scU64(1_700_000_000),
      fee_bps: scU32(100),
      question: "Will it rain?",
    }),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "market_created");
  assert.equal(result.payload.marketId, 5);
  assert.equal(result.payload.captain, ADDR);
  assert.equal(result.payload.question, "Will it rain?");
  assert.equal(result.payload.feeBps, 100);
});

test("decodeEvent: squad deposited decodes side and amount", () => {
  const amount = 50_000_000n; // 5 USDC
  const raw = {
    id: "21-0",
    contractId: "C2",
    ledger: 21,
    txHash: "ghi",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("deposited"), scU64(5), scU32(1), scAddress(ADDR)],
    value: nativeToScVal({ amount: scI128(amount), shares: scI128(50n) }),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "deposited");
  assert.equal(result.payload.amount, amount);
  assert.equal(result.payload.side, 1);
});

test("decodeEvent: squad withdrawn decodes correctly", () => {
  const amount = 20_000_000n;
  const raw = {
    id: "22-0",
    contractId: "C2",
    ledger: 22,
    txHash: "jkl",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("withdrawn"), scU64(5), scU32(2), scAddress(ADDR)],
    value: nativeToScVal({ amount: scI128(amount) }),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "withdrawn");
  assert.equal(result.payload.marketId, 5);
  assert.equal(result.payload.side, 2);
  assert.equal(result.payload.participant, ADDR);
  assert.equal(result.payload.amount, amount);
});

test("decodeEvent: squad resolved decodes pools and result", () => {
  const poolA = 100_000_000n;
  const poolB = 200_000_000n;
  const raw = {
    id: "23-0",
    contractId: "C2",
    ledger: 23,
    txHash: "mno",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("resolved"), scU64(5)],
    value: nativeToScVal({ result: scU32(1), pool_a: scI128(poolA), pool_b: scI128(poolB) }),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "resolved");
  assert.equal(result.payload.marketId, 5);
  assert.equal(result.payload.result, 1);
  assert.equal(result.payload.poolA, poolA);
  assert.equal(result.payload.poolB, poolB);
});

test("decodeEvent: squad claimed decodes gross, fee, and net", () => {
  const gross = 100_000_000n;
  const fee = 5_000_000n;
  const net = 95_000_000n;
  const raw = {
    id: "24-0",
    contractId: "C2",
    ledger: 24,
    txHash: "pqr",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claimed"), scU64(5), scAddress(ADDR)],
    value: nativeToScVal({ gross: scI128(gross), fee: scI128(fee), net: scI128(net) }),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "claimed");
  assert.equal(result.payload.marketId, 5);
  assert.equal(result.payload.participant, ADDR);
  assert.equal(result.payload.gross, gross);
  assert.equal(result.payload.fee, fee);
  assert.equal(result.payload.net, net);
});

test("decodeEvent: squad fees_claimed decodes recipient and amount", () => {
  const amount = 10_000_000n;
  const raw = {
    id: "25-0",
    contractId: "C2",
    ledger: 25,
    txHash: "stu",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("fees_claimed"), scAddress(ADDR)],
    value: nativeToScVal({ amount: scI128(amount) }),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "fees_claimed");
  assert.equal(result.payload.recipient, ADDR);
  assert.equal(result.payload.amount, amount);
});

test("decodeEvent: squad event with negative amount yields unknown without throwing", () => {
  const raw = {
    id: "26-0",
    contractId: "C2",
    ledger: 26,
    txHash: "vwx",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("deposited"), scU64(5), scU32(1), scAddress(ADDR)],
    value: nativeToScVal({ amount: scI128(-50n), shares: scI128(50n) }),
  };
  let result;
  assert.doesNotThrow(() => { result = decodeEvent("squad", raw); });
  assert.equal(result.payload.name, "unknown");
  assert.match(result.payload.reason, /expected non-negative amount/);
});

test("decodeEvent: admin market event (oracle_changed) decodes into admin payload", () => {
  const raw = {
    id: "30-0",
    contractId: "C1",
    ledger: 30,
    txHash: "aabbcc0011223344556677889900aabbcc0011223344556677889900aabbcc00",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("oracle_changed"), scAddress(ADDR)],
    value: nativeToScVal({}),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "oracle_changed");
  assert.equal(result.payload.newOracle, ADDR);
  assert.equal(isAdminPayload(result.payload), true);

  const config = {
    chatId: "-1",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const audit = toAdminAuditRecord(result, config);
  assert.ok(audit !== null);
  assert.equal(audit.type, "oracle_changed");
  assert.equal(audit.ledger, 30);
  assert.equal(audit.admin, ADDR);
  assert.ok(audit.explorerUrl?.includes("aabbcc0011223344556677889900aabbcc0011223344556677889900aabbcc00"));
});

test("decodeEvent: fee_policy_changed decodes into admin payload", () => {
  const raw = {
    id: "31-0",
    contractId: "C1",
    ledger: 31,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("fee_policy_changed")],
    value: nativeToScVal({ fee_bps: scU32(500) }),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "fee_policy_changed");
  assert.equal(result.payload.feeBps, 500);
  assert.equal(isAdminPayload(result.payload), true);

  const audit = toAdminAuditRecord(result);
  assert.ok(audit !== null);
  assert.equal(audit.type, "fee_policy_changed");
  assert.equal(audit.details.feeBps, 500);
});

test("malformed XDR in admin event returns unknown payload with bounded reason without throwing", () => {
  const malformedAdminEvent = {
    id: "99-0",
    contractId: "C1",
    ledger: 99,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("oracle_changed")],
    value: "not-an-scval-map",
  };

  let decoded;
  assert.doesNotThrow(() => {
    decoded = decodeEvent("market", malformedAdminEvent);
  });
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "oracle_changed");
  assert.ok(typeof decoded.payload.reason === "string");
  assert.ok(decoded.payload.reason.length <= 200);

  const validEvent = {
    id: "100-0",
    contractId: "C1",
    ledger: 100,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("oracle_changed"), scAddress(ADDR)],
    value: nativeToScVal({}),
  };
  const validDecoded = decodeEvent("market", validEvent);
  assert.equal(validDecoded.payload.name, "oracle_changed");
});

test("toAdminAuditRecord returns null for user events", () => {
  const raw = {
    id: "10-0",
    contractId: "C1",
    ledger: 10,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created"), scU64(42), scAddress(ADDR)],
    value: nativeToScVal({ category: "sports" }),
  };
  const result = decodeEvent("market", raw);
  assert.equal(toAdminAuditRecord(result), null);
});

test("decodeEvent: squad unknown event yields unknown/no decoder", () => {
  const raw = {
    id: "40-0",
    contractId: "C2",
    ledger: 40,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("future_event_not_yet_defined")],
    value: nativeToScVal({}),
  };
  const result = decodeEvent("squad", raw);
  assert.equal(result.payload.name, "unknown");
  assert.equal(result.payload.reason, "no decoder");
});

// ── Oversized strings / clip() in formatEvent ────────────────────────────────

test("formatEvent: long category in claim_created is clipped to the field limit", () => {
  // claim_created renders the category directly; there is no clip() call there,
  // but it should still not throw or produce bad markdown.
  const config = {
    chatId: "-1",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longCategory = "a".repeat(500);
  const event = {
    source: "market",
    contractId: "market",
    ledger: 1,
    txHash: "",
    at: 0,
    eventId: "1-0",
    payload: { name: "claim_created", claimId: 1, creator: "GABCD", category: longCategory },
  };
  let msg;
  assert.doesNotThrow(() => { msg = formatEvent(config, event); });
  assert.ok(msg !== null, "should produce a message");
  // #250 clips oversized fields at 200 chars; the full 500-char category must not appear
  assert.equal(msg.includes(escapeMd(longCategory)), false);
  assert.ok(msg.includes(escapeMd("a".repeat(150))));
});

test("formatEvent: claim_resolved summary is clipped at 200 characters", () => {
  const config = {
    chatId: "-1",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longSummary = "x".repeat(400);
  const event = {
    source: "market",
    contractId: "market",
    ledger: 1,
    txHash: "",
    at: 0,
    eventId: "1-0",
    payload: {
      name: "claim_resolved",
      claimId: 1,
      winnerSide: 2,
      summary: longSummary,
      confidence: 80,
      evidenceHash: "aa",
    },
  };
  const msg = formatEvent(config, event);
  assert.ok(msg !== null);
  // The raw summary (400 chars) must not appear verbatim; the clipped version does
  assert.ok(!msg.includes(escapeMd(longSummary)), "raw long summary must not appear");
  assert.ok(msg.includes("…"), "clipped summary must end with ellipsis");
});

test("formatEvent: market_created question is clipped at 200 characters", () => {
  const config = {
    chatId: "-1",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const longQuestion = "q".repeat(400);
  const event = {
    source: "squad",
    contractId: "squad",
    ledger: 2,
    txHash: "",
    at: 0,
    eventId: "2-0",
    payload: {
      name: "market_created",
      marketId: 1,
      captain: "GCAPT",
      deadline: 1_700_000_000,
      feeBps: 50,
      question: longQuestion,
    },
  };
  const msg = formatEvent(config, event);
  assert.ok(msg !== null);
  assert.ok(!msg.includes(escapeMd(longQuestion)), "raw long question must not appear");
  assert.ok(msg.includes("…"), "clipped question must end with ellipsis");
});

test("formatEvent: unknown payload returns null", () => {
  const config = {
    chatId: "-1",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 1,
    txHash: "",
    at: 0,
    eventId: "1-0",
    payload: { name: "unknown", eventName: "oracle_changed", reason: "no decoder" },
  };
  assert.equal(formatEvent(config, event), null);
});

// ── EventMeta fields ──────────────────────────────────────────────────────────

test("decodeEvent: meta fields are populated from the raw event", () => {
  const raw = {
    id: "99-1",
    contractId: "CABC",
    ledger: 99,
    txHash: "cafecafe",
    ledgerClosedAt: "2026-06-15T12:00:00Z",
    topic: [scStr("claim_cancelled"), scU64(5)],
    value: nativeToScVal({}),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.eventId, "99-1");
  assert.equal(result.ledger, 99);
  assert.equal(result.txHash, "cafecafe");
  assert.equal(result.at, Math.floor(new Date("2026-06-15T12:00:00Z").getTime() / 1000));
});

test("decodeEvent: missing ledger and txHash default to 0 and empty string", () => {
  const raw = {
    id: "",
    contractId: "",
    topic: [],
    value: null,
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.ledger, 0);
  assert.equal(result.txHash, "");
});

// ── claim_cancelled (value-less event) ───────────────────────────────────────

test("decodeEvent: claim_cancelled has no value fields and still decodes", () => {
  const raw = {
    id: "50-0",
    contractId: "C1",
    ledger: 50,
    txHash: "ff",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_cancelled"), scU64(9)],
    value: nativeToScVal({}),
  };
  const result = decodeEvent("market", raw);
  assert.equal(result.payload.name, "claim_cancelled");
  assert.equal(result.payload.claimId, 9);
});
