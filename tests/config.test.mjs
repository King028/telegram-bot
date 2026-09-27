import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  loadConfig,
} from "../dist/config.js";

const REQUIRED = {
  MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  BOT_TOKEN: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
  TELEGRAM_CHAT_ID: "-1001234567890",
};

/** Run `fn` with a clean env so a developer's `.env` cannot change the result. */
function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, REQUIRED, overrides);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

test("SHUTDOWN_TIMEOUT_MS defaults to the documented drain budget", () => {
  const config = withEnv({}, () => loadConfig());
  assert.equal(config.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
  assert.equal(config.shutdownTimeoutMs, 10_000);
});

test("SHUTDOWN_TIMEOUT_MS accepts an explicit budget and the 0 opt-out", () => {
  assert.equal(withEnv({ SHUTDOWN_TIMEOUT_MS: "250" }, () => loadConfig()).shutdownTimeoutMs, 250);
  assert.equal(withEnv({ SHUTDOWN_TIMEOUT_MS: "0" }, () => loadConfig()).shutdownTimeoutMs, 0);
});

test("SHUTDOWN_TIMEOUT_MS falls back to the default when set to nothing", () => {
  const config = withEnv({ SHUTDOWN_TIMEOUT_MS: "  " }, () => loadConfig());
  assert.equal(config.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
});

test("SHUTDOWN_TIMEOUT_MS rejects negative and non-numeric budgets at boot", () => {
  for (const value of ["-1", "2.5", "soon"]) {
    assert.throws(
      () => withEnv({ SHUTDOWN_TIMEOUT_MS: value }, () => loadConfig()),
      ConfigError,
      `SHUTDOWN_TIMEOUT_MS=${JSON.stringify(value)} must not boot`,
    );
  }
});

// Health-port resolution: Railway injects `PORT` and probes it for the deploy
// healthcheck, so the health endpoint falls back to it when `HEALTH_PORT` is
// unset — without changing the loopback default where `PORT` does not exist.
function healthPortWith(patch) {
  return withEnv(patch, () => loadConfig().healthPort);
}

test("explicit HEALTH_PORT wins over an injected PORT", () => {
  assert.equal(healthPortWith({ HEALTH_PORT: "9999", PORT: "8888" }), 9999);
});

test("falls back to the injected PORT when HEALTH_PORT is unset", () => {
  assert.equal(healthPortWith({ PORT: "8080" }), 8080);
});

test("keeps the loopback default when neither HEALTH_PORT nor PORT is set", () => {
  assert.equal(healthPortWith({}), 8787);
});

test("ignores a non-numeric injected PORT", () => {
  assert.equal(healthPortWith({ PORT: "not-a-port" }), 8787);
});

test("ignores a zero injected PORT (Railway disables it in some plans)", () => {
  assert.equal(healthPortWith({ PORT: "0" }), 8787);
});

test("HEALTH_PORT=0 still disables the listener on a platform with PORT", () => {
  assert.equal(healthPortWith({ HEALTH_PORT: "0", PORT: "8443" }), 0);
});
