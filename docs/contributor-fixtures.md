# Contributor fixture guide

This guide explains how to add **credential-free fixtures** for the Mimir
Telegram notifier. Automated tests must stay deterministic: no Soroban RPC
calls, no Telegram API calls, no bot tokens, and no signing keys.

The chain is the source of truth. This bot is a read-only notifier — fixtures
model decoded events and cursor files, never private material.

## Quick start (clean checkout)

```bash
npm ci
npm run typecheck
npm test
```

`npm test` builds `src/` → `dist/`, then runs every `tests/*.test.mjs` file with
Node's built-in test runner (the same path CI uses). To run only the local-mock
suites: `npm run test:mock`.

Live Testnet scanning is **manual and separate**:

```bash
npm run scan -- --pages 5 --show 5
```

Do not wire `npm run scan` into automated tests.

## Where fixtures live

| Path | Purpose |
| --- | --- |
| `tests/fixtures/events.json` | Decoded event cases for `formatEvent` / notifier fakes |
| `tests/fixtures/cursor-valid.json` | Well-formed `data/cursor.json` shape for restart docs |
| `tests/fixtures/cursor-corrupt.txt` | Unreadable cursor sample (cold-start path) |
| `tests/fixtures.test.mjs` | Loads the fixture catalog and asserts notify / skip / boundary behaviour |
| `tests/format.test.mjs` | Inline event-formatting units (MarkdownV2, USDC, Telegram send failures) |
| `tests/dedup.test.mjs` | Inline unit cases for the bounded dedup window (`src/dedup.ts`) |
| `tests/page-dedup.test.mjs` | Fake-RPC overlapping-page walk + fake-Telegram poller/restart cases |
| `tests/bot.test.mjs` | Mocked grammy operator-command routing and exact reply payloads |
| `tests/poller.test.mjs` | Cursor load/advance, RPC and Telegram failure, send cap, stop semantics, graceful-shutdown flush, drain deadline, shutdown notification drop |
| `tests/poller-controls.test.mjs` | Pause/resume boundaries, restart cursor compatibility, RPC failure redaction |
| `tests/cursor-restart.test.mjs` | Stale cursors, unwritable data dir, restart round-trip |
| `tests/ledger-window.test.mjs` | Ledger-window bounds: clamping, out-of-window cursors, malformed-XDR scanner safety, restart |
| `tests/helpers/temp-data.mjs` | Ephemeral data directory helper shared by persistence tests |
| `tests/soak.test.mjs` | Long-run memory/timer/log boundedness under scripted RPC and Telegram failures (mock timers, forced GC, leak control) |
| `tests/mock-rpc.test.mjs` | Live mock RPC: scanner walks, poller failure drills, cursor safety, log bounds |
| `tests/mock-profile.test.mjs` | `MIMIR_PROFILE=mock` defaults, explicit-env precedence, unknown-profile failure |
| `tests/config.test.mjs` | Env loading and validation, including the `SHUTDOWN_TIMEOUT_MS` drain budget |

## Event fixture schema

`events.json` is a catalog:

```json
{
  "config": {
    "chatId": "-1001234567890",
    "marketContractId": "CFIXTUREMARKET00000000000000000000000000000000000000000",
    "squadContractId": "CFIXTURESQUAD0000000000000000000000000000000000000000000",
    "rpcUrl": "https://example.invalid/rpc",
    "horizonUrl": "https://example.invalid/horizon",
    "networkPassphrase": "Test SDF Network ; September 2015"
  },
  "cases": [
    {
      "id": "claim_challenged_happy",
      "kind": "positive",
      "expect": "notify",
      "messageIncludes": ["challenged", "2\\.0000000 USDC"],
      "event": { "...": "DecodedEvent shape; money fields are decimal strings" }
    }
  ]
}
```

Rules:

1. **Money fields are decimal strings** (`"20000000"`), never live JSON numbers
   for large `i128` values. The fixture loader converts known money keys to
   `bigint` before calling `formatEvent`.
2. **Contract ids, addresses, tx hashes, and cursors are stable fakes.** Prefer
   `CFIXTURE…` / `GFIXTURE…` prefixes so grepping the suite never looks like
   production secrets.
3. **RPC / Horizon URLs must be non-routable** (`example.invalid`) so a buggy
   test cannot accidentally hit Testnet.
4. **Never put `BOT_TOKEN`, payment proofs, or private keys in fixtures or
   assertions.** Logs and error messages under test must stay free of those.

### Case kinds (what to cover)

| `kind` | Intent | Typical `expect` |
| --- | --- | --- |
| `positive` | Happy-path notification for a known market/squad event | `notify` |
| `negative` | Malformed / unknown / admin-shaped payload → no chat message | `skip` |
| `boundary` | Clipping, reserved MarkdownV2 chars, zero/max amounts | `notify` or `skip` |
| `restart` | Documents cursor resume / corrupt-file cold start (see cursor fixtures) | n/a in format suite |

`expect: "notify"` requires a non-null MarkdownV2 string from `formatEvent`.
`expect: "skip"` requires `null` (or an `unknown` payload that the poller would
log and not post).

## Cursor fixtures and restart safety

- **Valid cursor** (`cursor-valid.json`): version `1`, per-target opaque
  `cursor` string + `lastEventLedger`. Matches what the poller write-then-renames
  under `CURSOR_FILE` (default `./data/cursor.json`). New files also carry an
  additive, bounded `recentEventIds` dedup window; a file without it is still
  valid and loads with an empty window.
- **Corrupt cursor** (`cursor-corrupt.txt`): not JSON. The poller must treat this
  as a **cold start**, not a crash — leave the in-memory cursor null and begin
  `START_LOOKBACK_LEDGERS` behind tip.

When you add persistence tests, use the **ephemeral data directory** helper in
`tests/helpers/temp-data.mjs` instead of hand-rolled `/tmp` paths:

```js
import { createTempDataDir, withTempDataDir } from "./helpers/temp-data.mjs";

test("resumes", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json"); // fresh dir under os.tmpdir()
    // ...write fixtures, start a poller with { cursorFile }, assert...
  })); // directory is removed even if an assertion throws
```

- `createTempDataDir(prefix)` returns `{ root, file(name), cleanup() }`; for a
  whole file, create one at module level and call `test.after(() => dir.cleanup())`.
- Never point tests at the repo `data/` directory or at fixed `/tmp/...` names:
  they collide across runs and leak state into later ones.
- Let a poller finish its cycle (wait for its cursor save) before cleanup, or a
  late write can recreate the directory.
- Never commit a real runtime `data/cursor.json` from a live bot.

## Failure-mode expectations (keep fixtures aligned)

| Failure | Cursor | Notification | Fixture tip |
| --- | --- | --- | --- |
| RPC error for one contract | **unchanged** for that target | none that cycle | Fake rejected `readContractEvents`; assert cursor string identical |
| Ledger-window violation (start ledger or cursor **above** the tip) | **unchanged** | none that cycle | Fake `getHealth` window plus an out-of-window value; assert a bounded `LedgerWindowError` and that no `getEvents` request is sent |
| Cursor **below** the retained floor (stale) | **unchanged** | none that cycle | Fake `getHealth` window plus a stale cursor; assert the cursor is forwarded and the RPC's bounded stale rejection is surfaced |
| Telegram send error | **commits after partial delivery** | counted as failed | Fake `sendMessage` reject; assert cursor advances and no token appears in the Error message |
| Corrupt cursor file | cold start | n/a | Use `cursor-corrupt.txt` contents |
| Burst over cap | advances | extras skipped | Cap `MAX_NOTIFICATIONS_PER_CYCLE` in the fake config |
| Graceful shutdown mid-cycle | **flushed** if the cycle advanced it, untouched otherwise | the in-flight send finishes; the rest are dropped and counted | Fake a second target that blocks after the first advanced; assert the file the restarted poller loads |
| Shutdown deadline expires | whatever was already on disk — never clobbered | the abandoned cycle may lose its remaining sends | Fake a server that never resolves; assert the file is byte-identical and no `.tmp` is left behind |
| Unauthorized `/pause` or `/resume` | untouched | no command reply | Mock grammy with a different Telegram user id |
| Operator pause → restart | version-1 cursor unchanged | no replay | Reload a valid cursor fixture; pause must not persist |
| Overlapping page / resumed cursor | advances | duplicate suppressed, counted | Fake RPC returns the same event id twice; assert one send |
| Restart with a saved window | resumed | boundary event suppressed | Point two pollers at one temp `CURSOR_FILE` |

## Failure drills against the local mock

The table above is enforced against fakes in unit tests **and** against a real
HTTP server: `src/stellar/mock-rpc.ts` implements the Soroban JSON-RPC surface
(cursor pagination, empty pages, retained floor, mutual exclusion) plus
injected failures, so the same expectations can be rehearsed end to end with
the `MIMIR_PROFILE=mock` profile — loopback only, no credentials, isolated
`data/cursor.mock.json`:

```bash
npm run mock:rpc -- --fail-events error   # every scan fails until the process restarts
npm run mock:poll -- --stale-cursor       # cursors rejected once the poller has one
npm run mock:poll -- --malformed          # undecodable event must skip, not crash
npm run scan:mock                         # scanner --mock against a running mock:rpc
```

`tests/mock-rpc.test.mjs` drives the real `createPoller` against
`startMockRpc()` on an ephemeral port and asserts the failure-mode table above:
cursor unchanged across RPC failures and stale-cursor rejections, cursor
advancing past Telegram failures, skipped events, and cap drops, restart
without replay, bounded redacted logs, and the version-1 cursor file shape.

## Adding a new fixture case

1. Pick the contract event from `src/stellar/decode.ts` (topic order + value map).
2. Append a case to `tests/fixtures/events.json` with a unique `id`.
3. Run `npm test` and extend assertions in `tests/fixtures.test.mjs` only if the
   catalog runner needs a new expect mode.
4. If behaviour changes ops (env vars, cursor shape), update this guide and the
   README "Development checks" link in the same PR.

## Out of scope for fixtures

- Signing transactions or holding keys
- Real `@BotFather` tokens or production chat ids
- Changing Mimir contract semantics
- Making CI depend on live RPC or Telegram
