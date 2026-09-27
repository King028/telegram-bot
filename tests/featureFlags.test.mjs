import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FEATURE_FLAGS,
  formatFeatureFlags,
  isNotificationAllowed,
  parseBoolFlag,
  parseNotificationFeatureFlags,
} from "../dist/notifications/featureFlags.js";

test("parseBoolFlag: unset and blank yield the default (positive)", () => {
  for (const raw of [undefined, "", "   ", "\t"]) {
    const parsed = parseBoolFlag("NOTIFY_ENABLED", raw, true);
    assert.equal(parsed.value, true, String(raw));
    assert.deepEqual(parsed.problems, []);
  }
  assert.equal(parseBoolFlag("NOTIFY_ENABLED", undefined, false).value, false);
});

test("parseBoolFlag: accepts truthy and falsy tokens case-insensitively (positive)", () => {
  for (const raw of ["true", "TRUE", "1", "yes", "On", " YES "]) {
    const parsed = parseBoolFlag("NOTIFY_MARKET", raw, false);
    assert.equal(parsed.value, true, raw);
    assert.deepEqual(parsed.problems, []);
  }
  for (const raw of ["false", "FALSE", "0", "no", "Off", " NO "]) {
    const parsed = parseBoolFlag("NOTIFY_SQUAD", raw, true);
    assert.equal(parsed.value, false, raw);
    assert.deepEqual(parsed.problems, []);
  }
});

test("parseBoolFlag: unknown tokens are problems, not silent flips (negative)", () => {
  const parsed = parseBoolFlag("NOTIFY_ENABLED", "maybe", true);
  assert.equal(parsed.value, true); // fallback preserved
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /NOTIFY_ENABLED/);
  assert.match(parsed.problems[0], /maybe/);
});

test("parseNotificationFeatureFlags: defaults match DEFAULT_FEATURE_FLAGS (boundary)", () => {
  const parsed = parseNotificationFeatureFlags({});
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.flags, DEFAULT_FEATURE_FLAGS);
  assert.equal(isNotificationAllowed(parsed.flags, "market", "claim_created"), true);
  assert.equal(isNotificationAllowed(parsed.flags, "squad", "deposited"), true);
});

test("parseNotificationFeatureFlags: master kill switch disables every source (positive)", () => {
  const parsed = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "false",
    NOTIFY_MARKET: "true",
    NOTIFY_SQUAD: "true",
  });
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.flags.enabled, false);
  assert.equal(isNotificationAllowed(parsed.flags, "market", "claim_created"), false);
  assert.equal(isNotificationAllowed(parsed.flags, "squad", "resolved"), false);
});

test("parseNotificationFeatureFlags: source gates work independently (positive)", () => {
  const marketOnly = parseNotificationFeatureFlags({
    NOTIFY_MARKET: "yes",
    NOTIFY_SQUAD: "no",
  });
  assert.deepEqual(marketOnly.problems, []);
  assert.equal(isNotificationAllowed(marketOnly.flags, "market", "withdrawal"), true);
  assert.equal(isNotificationAllowed(marketOnly.flags, "squad", "withdrawn"), false);

  const squadOnly = parseNotificationFeatureFlags({
    NOTIFY_MARKET: "0",
    NOTIFY_SQUAD: "1",
  });
  assert.deepEqual(squadOnly.problems, []);
  assert.equal(isNotificationAllowed(squadOnly.flags, "market", "fee_claimed"), false);
  assert.equal(isNotificationAllowed(squadOnly.flags, "squad", "fees_claimed"), true);
});

test("parseNotificationFeatureFlags: collects problems from every bad flag (negative)", () => {
  const parsed = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: "nah",
    NOTIFY_MARKET: "yep",
    NOTIFY_SQUAD: "false",
  });
  assert.equal(parsed.flags.squad, false);
  assert.equal(parsed.problems.length, 2);
  assert.match(parsed.problems[0], /NOTIFY_ENABLED/);
  assert.match(parsed.problems[1], /NOTIFY_MARKET/);
});

test("parseNotificationFeatureFlags: identical input is stable across restarts (restart)", () => {
  const env = { NOTIFY_ENABLED: "on", NOTIFY_MARKET: "Off", NOTIFY_SQUAD: "TRUE" };
  const first = parseNotificationFeatureFlags(env);
  const second = parseNotificationFeatureFlags(env);
  assert.deepEqual(first.flags, second.flags);
  assert.deepEqual(first.problems, second.problems);
  assert.equal(
    formatFeatureFlags(first.flags),
    "enabled=true market=false squad=true",
  );
});

test("isNotificationAllowed: never posts when every gate is off (boundary)", () => {
  const flags = { enabled: false, market: false, squad: false };
  assert.equal(isNotificationAllowed(flags, "market", "claim_created"), false);
  assert.equal(isNotificationAllowed(flags, "squad", "market_created"), false);
});

test("formatFeatureFlags: never includes secrets or unbounded payloads (regression)", () => {
  const text = formatFeatureFlags({ enabled: true, market: false, squad: true });
  assert.equal(text, "enabled=true market=false squad=true");
  assert.doesNotMatch(text, /token|key|ghp_|BOT_/i);
});
