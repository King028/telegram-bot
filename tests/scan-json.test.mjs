import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScanJsonReport,
  buildScanJsonTarget,
  eventHistogram,
  formatScanJson,
  hasFlag,
  scanJsonReplacer,
} from "../dist/stellar/events.js";

function sampleEvent(overrides = {}) {
  return {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 42,
    txHash: "abcd",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GABCD",
      stake: 20_000_000n,
    },
    ...overrides,
  };
}

function sampleScan(overrides = {}) {
  const events = overrides.events ?? [sampleEvent()];
  return {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    events,
    cursor: "0018276211125911551-4294967295",
    latestLedger: 50,
    oldestLedger: 1,
    truncated: false,
    pages: 3,
    lastEventLedger: 42,
    ...overrides,
  };
}

test("scanJsonReplacer turns bigint into a decimal string", () => {
  assert.equal(JSON.stringify({ stake: 20_000_000n }, scanJsonReplacer), '{"stake":"20000000"}');
});

test("eventHistogram counts known and unknown names", () => {
  const hist = eventHistogram([
    sampleEvent(),
    sampleEvent({
      payload: { name: "unknown", eventName: "some_unrecognized_event", reason: "skipped" },
    }),
    sampleEvent({ payload: { name: "claim_created", claimId: 1, creator: "G", category: "crypto" } }),
    sampleEvent({ payload: { name: "oracle_changed", newOracle: "GABCD", details: {} } }),
    sampleEvent(),
  ]);
  assert.equal(hist.claim_challenged, 2);
  assert.equal(hist.claim_created, 1);
  assert.equal(hist.oracle_changed, 1);
  assert.equal(hist["unknown:some_unrecognized_event"], 1);
});

test("buildScanJsonTarget respects --show limit and serializes safely", () => {
  const events = [
    sampleEvent({ ledger: 40, eventId: "40-0" }),
    sampleEvent({ ledger: 41, eventId: "41-0" }),
    sampleEvent({ ledger: 42, eventId: "42-0" }),
  ];
  const target = buildScanJsonTarget(sampleScan({ events }), 2);
  assert.equal(target.eventCount, 3);
  assert.equal(target.events.length, 2);
  assert.equal(target.events[0].ledger, 41);
  assert.equal(target.events[1].ledger, 42);
  assert.match(target.events[1].summary, /challenged/);

  const report = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban.example.invalid",
    oldestLedger: 1,
    latestLedger: 50,
    targets: [target],
  });
  const text = formatScanJson(report);
  assert.equal(text.endsWith("\n"), true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, "mimir-scan-v1");
  assert.equal(parsed.targets[0].events[1].payload.stake, "20000000");
  assert.doesNotMatch(text, /BOT_TOKEN|ghp_|private.?key/i);
});

test("buildScanJsonTarget with show=0 emits histogram only", () => {
  const target = buildScanJsonTarget(sampleScan(), 0);
  assert.equal(target.events.length, 0);
  assert.equal(target.histogram.claim_challenged, 1);
});

test("malformed unknown events never crash JSON serialization", () => {
  const target = buildScanJsonTarget(
    sampleScan({
      events: [
        sampleEvent({
          payload: {
            name: "unknown",
            eventName: "claim_challenged",
            reason: "malformed XDR",
          },
        }),
      ],
    }),
    5,
  );
  const text = formatScanJson(
    buildScanJsonReport({
      network: "testnet",
      rpcUrl: "https://soroban.example.invalid",
      oldestLedger: 1,
      latestLedger: 2,
      targets: [target],
    }),
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.targets[0].events[0].payload.name, "unknown");
  assert.match(parsed.targets[0].events[0].summary, /malformed XDR/);
});

test("hasFlag detects boolean --json without consuming a value", () => {
  const original = process.argv.slice();
  try {
    process.argv = ["node", "events.ts", "--json", "--show", "5"];
    assert.equal(hasFlag("json"), true);
    assert.equal(hasFlag("pages"), false);
    process.argv = ["node", "events.ts", "--show", "5"];
    assert.equal(hasFlag("json"), false);
  } finally {
    process.argv = original;
  }
});

test("JSON report never embeds a bot token even if present on argv noise", () => {
  const report = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban.example.invalid",
    oldestLedger: 1,
    latestLedger: 2,
    targets: [buildScanJsonTarget(sampleScan(), 1)],
  });
  const blob = formatScanJson(report);
  assert.doesNotMatch(blob, /0000000000:SECRET/);
  assert.doesNotMatch(blob, /BOT_TOKEN/);
});
