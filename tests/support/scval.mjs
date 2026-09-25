/**
 * Build genuine XDR-encoded event topics/values, the same shapes the real
 * Soroban RPC returns over the wire (base64 XDR strings in JSON).
 *
 * This intentionally does NOT use `nativeToScVal`'s object-shape heuristics
 * for maps — event `value` maps are keyed by ScSymbol (the `#[topic]`-free
 * field names, snake_case), and getting that wrong would make the fixtures
 * decode into something `decode.ts` was never built to read. Every ScVal
 * below is constructed explicitly so the wire shape is unambiguous and
 * matches `contracts-soroban/mimir-{market,squad}/src/events.rs`.
 */
import { Address, xdr, nativeToScVal } from "@stellar/stellar-sdk";

export function scSymbol(name) {
  return xdr.ScVal.scvSymbol(name);
}

export function scString(text) {
  return xdr.ScVal.scvString(text);
}

export function scU32(n) {
  return xdr.ScVal.scvU32(n);
}

/** i128, used for every atomic-USDC amount field. */
export function scI128(value) {
  return nativeToScVal(BigInt(value), { type: "i128" });
}

export function scAddress(strkey) {
  return new Address(strkey).toScVal();
}

export function scBytes(hex) {
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
}

/** An ScMap keyed by ScSymbol, entries sorted by key (the wire convention). */
export function scMap(fields) {
  const entries = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => new xdr.ScMapEntry({ key: scSymbol(key), val }));
  return xdr.ScVal.scvMap(entries);
}

export function toBase64(scVal) {
  return scVal.toXDR("base64");
}

/**
 * One realistic fixture: topics (name + `#[topic]` fields, in declaration
 * order) and the value map (remaining fields), both already base64 XDR —
 * exactly what a `getEvents` JSON response carries on the wire.
 */
export function buildEvent({ topics, fields = {} }) {
  return {
    topicB64: topics.map(toBase64),
    valueB64: toBase64(scMap(fields)),
  };
}

// ── Known-good market/squad event builders ──────────────────────────────────
// Mirrors decode.ts's field expectations exactly, so a fixture built here
// round-trips through the real, unmodified decodeEvent().

export const marketEvent = {
  claimCreated: ({ claimId, creator, category }) =>
    buildEvent({
      topics: [scSymbol("claim_created"), scU32(claimId), scAddress(creator)],
      fields: { category: scString(category) },
    }),
  claimChallenged: ({ claimId, challenger, stake }) =>
    buildEvent({
      topics: [scSymbol("claim_challenged"), scU32(claimId), scAddress(challenger)],
      fields: { stake: scI128(stake) },
    }),
  claimResolved: ({ claimId, winnerSide, summary, confidence, evidenceHash }) =>
    buildEvent({
      topics: [scSymbol("claim_resolved"), scU32(claimId)],
      fields: {
        winner_side: scU32(winnerSide),
        summary: scString(summary),
        confidence: scU32(confidence),
        evidence_hash: scBytes(evidenceHash),
      },
    }),
  claimCancelled: ({ claimId }) =>
    buildEvent({ topics: [scSymbol("claim_cancelled"), scU32(claimId)] }),
  marketSettled: ({ claimId, totalPaid, totalFees, owedToChallengers, dust }) =>
    buildEvent({
      topics: [scSymbol("market_settled"), scU32(claimId)],
      fields: {
        total_paid: scI128(totalPaid),
        total_fees: scI128(totalFees),
        owed_to_challengers: scI128(owedToChallengers),
        dust: scI128(dust),
      },
    }),
  challengerPaid: ({ claimId, challenger, stake, gross, fee, net }) =>
    buildEvent({
      topics: [scSymbol("challenger_paid"), scU32(claimId), scAddress(challenger)],
      fields: { stake: scI128(stake), gross: scI128(gross), fee: scI128(fee), net: scI128(net) },
    }),
  // Deliberately no decoder in decode.ts — used to exercise the "real event,
  // no notification" path (returns null from decodeMarket/decodeSquad).
  oracleChanged: () =>
    buildEvent({ topics: [scSymbol("oracle_changed")], fields: { new_oracle: scString("x") } }),
};

export const squadEvent = {
  marketCreated: ({ marketId, captain, deadline, feeBps, question }) =>
    buildEvent({
      topics: [scSymbol("market_created"), scU32(marketId), scAddress(captain)],
      fields: { deadline: scU32(deadline), fee_bps: scU32(feeBps), question: scString(question) },
    }),
  deposited: ({ marketId, side, participant, amount, shares }) =>
    buildEvent({
      topics: [scSymbol("deposited"), scU32(marketId), scU32(side), scAddress(participant)],
      fields: { amount: scI128(amount), shares: scI128(shares) },
    }),
  resolved: ({ marketId, result, poolA, poolB }) =>
    buildEvent({
      topics: [scSymbol("resolved"), scU32(marketId)],
      fields: { result: scU32(result), pool_a: scI128(poolA), pool_b: scI128(poolB) },
    }),
  claimed: ({ marketId, participant, gross, fee, net }) =>
    buildEvent({
      topics: [scSymbol("claimed"), scU32(marketId), scAddress(participant)],
      fields: { gross: scI128(gross), fee: scI128(fee), net: scI128(net) },
    }),
};

/** A syntactically valid but field-incomplete event: missing `stake`. */
export function malformedClaimChallenged({ claimId, challenger }) {
  return buildEvent({
    topics: [scSymbol("claim_challenged"), scU32(claimId), scAddress(challenger)],
    fields: {}, // no `stake` — big() must throw, caught by decodeEvent's try/catch
  });
}

/** A syntactically valid event whose contract has no decoder for this name. */
export function unknownNamedEvent(name) {
  return buildEvent({ topics: [scSymbol(name)], fields: { x: scString("y") } });
}
