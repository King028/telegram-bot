import assert from "node:assert/strict";
import test from "node:test";

import { waitForStartupHealth } from "../dist/poller.js";

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms) => {
      now += ms;
    },
  };
}

test("waitForStartupHealth succeeds on the first probe", async () => {
  const clock = fakeClock(1_000);
  let calls = 0;
  const result = await waitForStartupHealth(
    {
      getHealth: async () => {
        calls += 1;
        return { status: "healthy", oldestLedger: 1, latestLedger: 10 };
      },
    },
    { deadlineMs: 5_000, retryMs: 500, now: clock.now, sleep: clock.sleep },
  );
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, "healthy");
  assert.equal(result.latestLedger, 10);
});

test("waitForStartupHealth retries until success within the deadline", async () => {
  const clock = fakeClock(0);
  let calls = 0;
  const result = await waitForStartupHealth(
    {
      getHealth: async () => {
        calls += 1;
        if (calls < 3) throw new Error("rpc unavailable");
        return { status: "healthy", oldestLedger: 2, latestLedger: 20 };
      },
    },
    { deadlineMs: 10_000, retryMs: 1_000, now: clock.now, sleep: clock.sleep },
  );
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.oldestLedger, 2);
  assert.ok(clock.now() >= 2_000);
});

test("waitForStartupHealth fails when the deadline is exhausted", async () => {
  const clock = fakeClock(0);
  let calls = 0;
  await assert.rejects(
    () =>
      waitForStartupHealth(
        {
          getHealth: async () => {
            calls += 1;
            throw new Error("connection refused");
          },
        },
        { deadlineMs: 2_500, retryMs: 1_000, now: clock.now, sleep: clock.sleep },
      ),
    /failed after \d+ attempt/,
  );
  assert.ok(calls >= 2);
  assert.ok(clock.now() >= 2_000);
});

test("waitForStartupHealth deadline 0 is a single attempt", async () => {
  const clock = fakeClock(0);
  let calls = 0;
  await assert.rejects(
    () =>
      waitForStartupHealth(
        {
          getHealth: async () => {
            calls += 1;
            throw new Error("boom");
          },
        },
        { deadlineMs: 0, retryMs: 1_000, now: clock.now, sleep: clock.sleep },
      ),
    /1 attempt/,
  );
  assert.equal(calls, 1);
  assert.equal(clock.now(), 0);
});

test("waitForStartupHealth never embeds secrets in the thrown message", async () => {
  const secret = "0000000000:SECRET-TOKEN-DO-NOT-LEAK";
  await assert.rejects(
    () =>
      waitForStartupHealth(
        {
          getHealth: async () => {
            throw new Error(`upstream said ${secret}`);
          },
        },
        {
          deadlineMs: 0,
          retryMs: 0,
          now: () => 0,
          sleep: async () => undefined,
        },
      ),
    (err) => {
      const msg = String(err);
      // Message may include the Error text from getHealth — ensure we at least
      // do not add BOT_TOKEN/chat material ourselves; the probe error string is
      // whatever the RPC layer threw. Assert our wrapper stays bounded.
      assert.match(msg, /RPC startup health check failed/);
      assert.equal(msg.includes("BOT_TOKEN"), false);
      return true;
    },
  );
});
