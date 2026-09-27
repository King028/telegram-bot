# Mimir Telegram bot

A Telegram notifier for [Mimir](https://github.com/mimir-stellar), the AI-settled
prediction market on Stellar. It polls Mimir's two Soroban contracts for new
on-chain events and posts them, human-readable, into one or more named chats or channels:

```
🆕 New claim #7
Category: crypto
Creator: GBMGZ…IR2Y
ledger 4226691 · tx

⚔️ Claim #7 challenged
Stake: 2.0000000 USDC
Challenger: GDZCB…X4UH
ledger 4226692 · tx

⚖️ Claim #7 resolved — winner: challengers
Confidence: 100%
Onchain smoke — challengers awarded so the payout pull can be exercised
ledger 4226728 · tx
```

Built with [grammy](https://grammy.dev) and
[`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk). Reads only —
it holds no keys and signs nothing.

## What it watches

| Contract | Events it notifies on |
|---|---|
| `mimir-market` | `claim_created`, `claim_challenged`, `claim_resolved`, `claim_cancelled`, `market_settled`, `challenger_paid`, `fee_claimed`, `withdrawal`, `withdrawal_pending` |
| `mimir-squad` | `market_created`, `deposited`, `withdrawn`, `resolved`, `claimed`, `fees_claimed` |

Admin events (`oracle_changed`, `ownership_transferred`, `fee_policy_*`,
`fee_accrued`, `agent_attributed`) are decoded far enough to be recognised and
then skipped — they are logged, not posted.

## Setup

### 1. Get a bot token

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow
the prompts, and copy the token it gives you (`123456789:AA…`).

### 2. Get the chat id

- **Private chat:** message [@userinfobot](https://t.me/userinfobot); it replies
  with your numeric id.
- **Group:** add your bot to the group, send any message, then open
  `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and read
  `result[].message.chat.id`. Group and supergroup ids are negative
  (`-1001234567890`).
- **Channel:** add the bot as an administrator with "Post messages" permission.
  Either use the numeric id from `getUpdates` or, for a public channel, the
  `@channelusername`.

If your group has [privacy mode](https://core.telegram.org/bots/features#privacy-mode)
on (the default), the bot only sees messages that are commands or replies to it —
which covers `/status` and the operator controls below.

### 3. Choose an operator (optional)

Set `OPERATOR_TELEGRAM_USER_ID` to the numeric **user** id returned by
`@userinfobot` to enable `/audit`, `/pause`, and `/resume`. The notification
`TELEGRAM_CHAT_ID` is intentionally not accepted as authorization: in a group,
everyone can send messages from that chat. If this variable is omitted, existing
deployments continue unchanged and the operator commands are ignored.

### 4. Configure and run

```bash
cp .env.example .env     # then fill in BOT_TOKEN and TELEGRAM_CHAT_ID
npm install
npm run dev              # tsx, restarts on change
```

For production (Node):

```bash
npm run build
npm start
```

For production (Docker):

```bash
docker build -t mimir-telegram-bot .
docker run -d \
  --name mimir-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  mimir-telegram-bot
```

`.env.example` ships with the live Stellar Testnet contract ids, so the only two
values you must supply are `BOT_TOKEN` and `TELEGRAM_CHAT_ID`. To split traffic,
set `TELEGRAM_MARKET_CHAT_ID` and/or `TELEGRAM_SQUAD_CHAT_ID`; each overrides the
legacy destination for that contract, while an omitted override falls back to
`TELEGRAM_CHAT_ID`. Every other
variable is documented inline there. A missing or malformed value aborts startup
with all the problems listed at once — the bot never boots into a state where it
looks healthy but notifies nobody.

## Commands

| Command | What it does |
|---|---|
| `/start` | What the bot is |
| `/help` | Same, plus the command list |
| `/status` | Chain tip, the RPC's retained-history floor, the chain clock skew (newest chain close time the bot has seen, against its own clock), both watched contract ids, the last ledger an event was seen in per contract, the persisted cursor, poll/send/skip counters (plus messages dropped by a shutdown drain and cursors automatically rewound to the retained floor), and the last error |
| `/audit` | Operator only. The operator audit report: recent scan failures, send failures, skipped and cap-dropped events, cursor problems — redacted and bounded (see [Operator audit trail](#operator-audit-trail)) |
| `/contracts` | The two contract ids this bot watches (`mimir-market`, `mimir-squad`) and a [stellar.expert](https://stellar.expert) link for each. Reads only from config, so it answers the same during a cold start, a run of RPC failures, or between restarts — unlike `/status`, there is nothing here that can be "unhealthy" |
| `/preview` | Previews channel notification formatting for `mimir-market` or `mimir-squad` without affecting cursors or poller state |
| `/pause` | Operator only. Stops scheduling new poll cycles; a scan already in progress may finish and persist its normal cursor |
| `/resume` | Operator only. Schedules the next poll cycle immediately, without changing or replaying cursors |

Commands from a user other than `OPERATOR_TELEGRAM_USER_ID` receive no control
response and cannot mutate poller state — this includes `/audit`, whose report
is operator-only. Repeated `/pause` or `/resume` commands
are idempotent. Control state is process-local: a restart resumes polling and
loads the existing version-1 cursor file.

## Machine-readable status snapshot

`/status` is for a human in the chat. For a supervisor, a dashboard, or a shell
on the box, the poller also writes the same facts as JSON to `STATUS_FILE`
(default `data/status.json`) after every cycle, and on start and stop:

```bash
npm start -- --status          # or: node dist/index.js --status
```

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-21T10:00:00.000Z",
  "uptimeMs": 3600000,
  "running": true,
  "network": "testnet",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "chatId": "-…7890",
  "pollIntervalMs": 30000,
  "maxNotificationsPerCycle": 20,
  "cycles": 120,
  "lastPollAt": 1755770400000,
  "lastSuccessAt": 1755770400000,
  "latestLedger": 4226733,
  "oldestLedger": 4105773,
  "notificationsSent": 11,
  "notificationsFailed": 0,
  "eventsSkipped": 3,
  "cursorRewinds": 0,
  "consecutiveFailures": 0,
  "lastError": null,
  "targets": [
    {
      "source": "market",
      "contractId": "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      "cursor": "0018276211125911551-4294967295",
      "lastEventLedger": 4226729,
      "rewindFromLedger": null,
      "lastError": null
    }
  ]
}
```

`--status` reads the file only — it never contacts Telegram or the RPC — so it is
safe to run from a health check or a cron job while the bot is running. It exits
`0` when a snapshot was read and `1` when there is none or it is not valid JSON.

**What is deliberately not in it.** The snapshot is built from an allowlist of
fields, so nothing can leak by accident. It never contains the bot token, a
private key, or a payment proof. The chat id is redacted to its sign and last
four digits (`-…7890`), and every string that comes from outside the process —
RPC errors, Telegram errors, cursors — is whitespace-collapsed and truncated
(`MAX_ERROR_CHARS`, 300) so a hostile or chatty endpoint cannot write an
unbounded blob into the file or into a log line. The write is atomic
(write-then-rename), so a reader never sees a half-written document.

**Reading it in a health check.** `running: false` means the process stopped
deliberately (SIGINT/SIGTERM) or has not started; `consecutiveFailures > 0` with
a fresh `lastPollAt` means the RPC is failing but the loop is alive; a
`generatedAt` that stops advancing means the process is wedged or gone. The
chain remains the source of truth — this file reports on the reader, it is not a
substitute for reading the chain.

## Reading events without a bot token

The chain reader runs standalone. Testnet's Soroban RPC is public and
unauthenticated, so this needs nothing but the contract ids:

```bash
npm run scan                     # both contracts, from the RPC's retained floor
npm run scan -- --pages 40       # walk further
npm run scan -- --show 20        # print 20 decoded events per contract
npm run scan -- --from 4226500   # explicit start ledger
npm run scan -- --json           # one mimir-scan-v1 JSON document on stdout
npm run scan -- --json --show 20 # JSON including 20 decoded events per contract
```

Human mode prints the ledger window, an event-name histogram, and the decoded
payloads. With `--json`, stdout is a single `mimir-scan-v1` document (bigints as
decimal strings) and progress goes to stderr, so `npm run scan -- --json | jq`
stays valid. Each target reports its `startLedger` and `startClamped`, so it is
clear when a requested `--from` was moved up to the retained floor. Neither mode
prints bot tokens or signing keys — the scanner never holds them. This is how the
decoder was verified against the live deployment.

## Cursor-range replay

Replay reads a fixed ledger range from the chain and optionally re-posts the
events to Telegram. It is one-shot: it exits when the range is exhausted and
**never writes a cursor file** — the live poller's cursor state is untouched.

```bash
npm run replay -- --from 4226500                 # dry-run: decode only, no send
npm run replay -- --from 4226500 --to 4226800    # bounded range
npm run replay -- --from 4226500 --send          # send to Telegram (needs BOT_TOKEN)
npm run replay -- --from 4226500 --contract market  # one contract only
npm run replay -- --from 4226500 --json          # machine-readable mimir-replay-v1
npm run replay -- --from 4226500 --pages 5       # walk at most 5 pages per contract
npm run replay -- --from 4226500 --cap 10        # cap at 10 notifications per contract
npm run replay:mock -- --from 4226500            # local mock profile, no credentials
```

**Flags:**

| Flag | Default | Meaning |
|---|---|---|
| `--from <ledger\|cursor>` | (required) | Start of the range — a ledger number or an opaque RPC cursor |
| `--to <ledger>` | chain tip | End of the range (inclusive). Clamped to the tip when above it |
| `--send` | off | Actually post to Telegram; requires `BOT_TOKEN` and `TELEGRAM_CHAT_ID` |
| `--contract market\|squad` | both | Scan only the named contract |
| `--pages <n>` | 20 | Page budget per contract |
| `--cap <n>` | `MAX_NOTIFICATIONS_PER_CYCLE` | Maximum notifications per contract per run |
| `--show <n>` | 0 | Include the last *n* decoded events per target in the report |
| `--json` | off | Machine-readable `mimir-replay-v1` JSON on stdout; progress on stderr |
| `--mock` | off | `MIMIR_PROFILE=mock`: local RPC, fixture contracts, no credentials needed |

**Default mode is dry-run.** Events are decoded and counted; nothing is posted to
Telegram. Add `--send` to deliver notifications. The run always exits with code
`0` on completion, `1` on a fatal RPC or config error, and `2` on a bad flag.

**Cursor clamping.** `--from` below the RPC's retained floor is moved up to the
floor with a warning. `--to` above the chain tip is clamped to the tip. A `--to`
before `--from` is a usage error (exit 2). Neither clamp changes the live
poller's cursor.

**Bounded output.** Admin events (`oracle_changed`, `ownership_transferred`, …)
are logged at the progress level and not sent. Unknown or malformed events are
logged and skipped. Send failures are counted as skipped and do not abort the
run. No bot token or private key ever appears in progress output or the JSON
report.

**JSON report shape** (`--json` stdout, one document, ends with `\n`):

```json
{
  "format": "mimir-replay-v1",
  "network": "testnet",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "fromLedger": 4226500,
  "toLedger": 4226800,
  "dryRun": true,
  "targets": [
    {
      "source": "market",
      "contractId": "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      "fromLedger": 4226500,
      "toLedger": 4226800,
      "startLedger": 4226500,
      "startClamped": false,
      "pages": 3,
      "events": 2,
      "sent": 0,
      "skipped": 0,
      "capped": 0,
      "adminLogged": 0,
      "duplicates": 0,
      "truncated": false,
      "lastEventLedger": 4226729,
      "cursor": "0018276211125911551-4294967295",
      "eventLog": []
    }
  ],
  "totals": {
    "events": 2,
    "sent": 0,
    "skipped": 0,
    "capped": 0,
    "adminLogged": 0,
    "duplicates": 0
  }
}
```

`bigint` amounts are serialized as decimal strings (same convention as
`mimir-scan-v1`), so `npm run replay -- --json | jq` is valid. Progress and
warnings always go to stderr.

## Operator audit trail

`/status` says what the poller is doing *right now*. The audit trail answers the
question after a week of unattended running: **what actually happened** — scan
failures and recoveries, failed Telegram sends, skipped admin events, bursts
truncated by the per-cycle cap, cursor loads, stale cursors and cursor write
failures.

It is an append-only JSONL file (`data/audit.jsonl` by default; `AUDIT_FILE`
changes it, leaving the value empty disables it). The poller appends after every
cycle, so the trail survives restarts alongside the cursor. Read it two ways:

```bash
npm run audit                  # report from data/audit.jsonl
npm run audit -- --tail 50     # render the 50 most recent lines
npm run audit -- --json        # machine-readable stats only
npm run audit -- --file p.jsonl
```

or send `/audit` in the chat as the operator, which merges the live in-memory
window with the file so entries not yet flushed are still visible.

Everything in the trail is safe to paste into an issue, and this is enforced
when an entry is recorded, not by caller discipline:

- Free-text details pass redaction first: bot tokens, secret/seed strkeys, URLs
  and any unrecognized long token are replaced. Public `C…` contract ids and
  `G…` account ids stay readable — they are chain identifiers `/status` already
  prints.
- Details are length-clamped (240 chars). No payloads, payment amounts as log
  lines, or unbounded remote data are ever stored — the chain is the record.
- The in-memory window and the report are both bounded, and the report says so
  when older entries were not shown.
- Reading never throws on you: an unreadable or unknown-version line is skipped
  and counted, never fatal.

## Local mock profile

`MIMIR_PROFILE=mock` (or the scanner's `--mock` flag) fills in any config value
the environment leaves unset with a **local, loopback-only** Soroban mock:
fixture contract ids, `http://127.0.0.1:8420` RPC, and an isolated cursor file
at `data/cursor.mock.json` so a drill can never touch the real bot's position.
Explicit environment variables always win, any other profile name fails fast at
startup, and nothing here needs a bot token, Telegram credentials, or Testnet.

```bash
npm run mock:rpc                        # serve the fixture scenario on 127.0.0.1:8420
npm run scan:mock                       # scanner --mock: decode the scenario, no credentials
npm run mock:poll                       # dry run: mock RPC + real poller, sends are logged
npm run mock:poll -- --fail-events error  # inject in-band JSON-RPC failures
npm run mock:rpc -- --stale-cursor      # reject cursors once the poller has one
npm run mock:poll -- --malformed        # append an undecodable event (must skip, not crash)
npm run mock:poll -- --port 0           # ephemeral port (any entry point accepts it)
```

Failure kinds are `error`, `http-500`, `rate-limit`, and `stale-cursor`, with
the shorthands `--fail-rpc`, `--rate-limit`, `--stale-cursor` for `getEvents`
and `--fail-health <kind>` for `getHealth`. The mock enforces the real RPC's
request rules — mutually exclusive `startLedger`/`cursor`, the retained floor as
an error rather than an empty page, bounded error messages — and the dry run
exercises the poller's cursor-safety, restart, and bounded-log guarantees end to
end. `npm test` covers all of it (`tests/mock-*.test.mjs`); run just those with
`npm run test:mock`.

## How the polling works

Soroban's `getEvents` is **not** `eth_getLogs`, and the difference is the whole
design of `src/stellar/events.ts`:

- Paging is by **opaque cursor**, not block range, so the walk is inherently
  sequential — there is no chunk fan-out to parallelise.
- `startLedger`/`endLedger` and `cursor` are **mutually exclusive** in one
  request.
- The RPC keeps only a **rolling window** of events (~120,960 ledgers, roughly a
  week, on Testnet). A `startLedger` below the retained floor is an *error*, not
  an empty result, so the floor is clamped from `getHealth()` first.
- The window from `getHealth()` is **validated before the first request**: an
  inverted or malformed window fails with a bounded error, a start ledger below
  the floor is clamped up to it, and `npm run scan -- --from <future>` is refused
  rather than silently reading a different range.
- **An empty page does not mean the scan is finished.** One request covers a
  bounded slice of ledgers and returns whatever was in it — frequently nothing —
  plus a cursor to continue from. Terminating on a short page (the correct
  instinct for `eth_getLogs`) silently yields zero events. Verified against the
  live deployment: reading the market contract from the retained floor takes 13
  pages, 12 of which are empty, to reach the page holding all 11 of its events.

So the walk terminates on the cursor, never on the payload.

### Overlapping pages and duplicate events

A cursor is **inclusive** of the event it names: the same event can come back
from a later page of the same walk, and again from the next cycle that resumes
from the persisted cursor — including the first cycle after a restart. Left
unguarded, one on-chain event becomes two identical chat messages.

The reader and the poller therefore share a small, bounded **dedup window**
(`src/dedup.ts`): the ids of the most recently processed events per contract,
oldest evicted first. A redelivery inside that window is dropped and counted
instead of posted — visible as `duplicates=` in `npm run scan` output and as
`eventsDeduplicated` on `/health`. The window is seeded into every scan from the
cursor file, so the guard survives a restart, and it never grows with chain
history: an event older than the window can legitimately be announced again,
which is the accepted trade-off for O(1) memory and a cursor file that stays
small. Set `EVENT_DEDUP_WINDOW=0` to disable suppression.

This is suppression, not backfilling. A dropped duplicate does **not** hold the
cursor back — the chain remains the record and the walk still advances.

Events are also not a source of truth for current state — a claim's stakes and
status come from the contract's own getters. This bot is a timeline, not an
index.

### Recovering from a stale cursor

A rolling window means a cursor can outlive the RPC. If the bot is stopped long
enough (a multi-day outage, a wedged host, a long Telegram outage holding a
deploy), the persisted cursor can fall **below the retained floor** — everything
it points at is already gone. Soroban rejects such a read as stale, and holding
the cursor would fail that contract's scan forever.

The poller now recovers from exactly that case, without guessing:

- On a stale rejection it asks `getHealth()` for a **fresh** window and only acts
  when the cursor's own ledger places it strictly **below** `oldestLedger`.
- It then drops the doomed cursor and rescans from `oldestLedger` (a
  `startLedger` walk, since `cursor` and `startLedger` are mutually exclusive in
  one request). Everything below the floor was already unreadable, so nothing
  still retrievable is skipped, and the chain remains the record.
- The recovery is **bounded**: at most `MAX_FLOOR_REWINDS` (3) consecutive
  automatic rewinds per contract, then the poller stops and logs that operator
  action is required. A misbehaving RPC cannot make it thrash.
- It is **conservative**: an opaque cursor this build cannot place, a cursor
  ahead of the tip, or a window that cannot be read is left untouched and the
  bounded RPC error is surfaced. Nothing is rewritten on a hunch.
- A stale rejection immediately marks that target `cursorStale` in
  `status.json` and `GET /health`, and makes readiness return `503` until that
  target completes a successful scan. `/status` and `/health` identify whether
  the cursor is unchanged or a retained-floor recovery is underway. The alert
  is reconstructed after restart from the persisted rewind position or the
  next RPC rejection; the version-1 cursor schema does not change.
- Railway's configured `GET /health` deployment probe therefore remains
  unready while a stale cursor is unresolved. Recovery continues in-process;
  do not delete or replace the persistent cursor volume to force readiness.
  `GET /health/live` stays `200` for supervisors that need process liveness
  independently of readiness.
- The miss is logged as a bounded ledger count (`cursor is N ledger(s) below the
  retained floor`), never as a raw RPC payload, and `/status` and `GET /health`
  expose `cursorRewinds` plus the per-target `rewindFromLedger` while it lasts.

A recovery is observable: `/status` gains a `Cursors rewound to the retained
floor: N` line once `cursorRewinds > 0`, and `status.json` reports the same
counter and the active `rewindFromLedger`. The counter is per process, so it
resets on restart; the position itself is persisted so a restart mid-recovery
resumes from the same floor.

## Decoder compatibility contract

The decoder is deliberately forward-compatible at the event boundary:

- Soroban event topics are read in declaration order, and non-topic fields are
  read from the event value map using their deployed snake_case names.
- A known event with a malformed topic, value, address, integer, or XDR value
  becomes an `unknown` event. `decodeEvent` never throws into the poller, so one
  bad event cannot stop a scan or move a cursor based on a partial payload.
- Events that are valid on-chain but unknown to this version are retained as
  `unknown` for bounded logs and are skipped for Telegram. They are not
  invented, retried, or treated as current contract state.
- Amounts remain `bigint` atomic USDC values until formatting; no floating-point
  conversion is used. Contract strings are clipped at the notification and
  diagnostic boundaries, and scanner output is bounded.

The compatibility promise is for the deployed event wire shape and the public
decoded payload names above, not for arbitrary XDR or future contract fields.
Adding an optional field is safe when the existing fields retain their names
and types. Renaming a topic or changing a field type is a decoder compatibility
change and must be deployed together with a recorded fixture and an operational
note. The chain remains authoritative if the bot version cannot decode an event.

RPC configuration is read-only: `STELLAR_RPC_URL` must point to a Soroban RPC
endpoint, and `STELLAR_NETWORK_PASSPHRASE` controls network labeling for
explorer links. The client sends no signing material and creates no wallet.
Explorer path components are URL-encoded; custom `STELLAR_EXPLORER_BASE_URL`
values are supported without changing cursor or decoder compatibility.

## Cursor persistence

The poller writes its resume position to `data/cursor.json` (write-then-rename,
so a crash mid-write cannot truncate it). The on-disk document is a **versioned
schema** (`version: 1` today), and the poller appends audit entries to
`data/audit.jsonl`. Both must survive restarts, so give `data/` the same
treatment as the cursor:

```json
{
  "version": 1,
  "updatedAt": "2026-08-21T10:00:00.000Z",
  "targets": {
    "market": {
      "cursor": "0018276211125911551-4294967295",
      "lastEventLedger": 4226729,
      "recentEventIds": ["0018276211125911551-4294967295", "0018276211125911552-1"]
    },
    "squad": {
      "cursor": "0018276211125911551-4294967295",
      "lastEventLedger": 4226733,
      "recentEventIds": []
    }
  }
}
```

`recentEventIds` is the persisted **dedup window** (see
[Overlapping pages and duplicate events](#overlapping-pages-and-duplicate-events))
and is additive: it is bounded by `EVENT_DEDUP_WINDOW` (default `256`) and older
cursor files without the field load as an empty window. The `version` and the
`cursor` / `lastEventLedger` fields are unchanged, so the format stays
backward-compatible in both directions.

`rewindFromLedger` is a second additive field, written **only while a target is
recovering from a stale cursor** (see
[Recovering from a stale cursor](#recovering-from-a-stale-cursor)). It records
the retained floor the next scan resumes from, so a restart in the middle of a
recovery keeps reading from that floor instead of cold-starting. It is dropped
as soon as the floor walk returns a fresh resume cursor, so an ordinary cursor
file never contains it; files written before it existed load as "no rewind
pending", and older builds ignore it.

**Compatibility / migration**

- Current files (`version: 1`) load as-is.
- Legacy unversioned envelopes (`{ "targets": … }` without `version`) and flat
  maps (`{ "market": { "cursor": … }, "squad": … }` or string cursors) are
  migrated in-place to schema v1 on startup, then rewritten atomically.
- Unknown future `version` values are rejected: the file is quarantined and the
  bot cold-starts rather than guessing, so a downgrade cannot mis-read a newer
  file. Upgrade the bot before rolling forward again.
- Corrupt JSON or unrecognised shapes are also quarantined and cold-started (see
  failure behaviour below). Logs never include the raw file body.

On a cold start (no usable file) it begins `START_LOOKBACK_LEDGERS` behind the
chain tip rather than replaying the whole retained window into your chat.
`/pause` and `/resume` never edit this file; they only control scheduling, so the
cursor format remains version 1 and a restart does not preserve a pause. A
graceful shutdown flushes any cursor state that is still only in memory before
the process exits — see [Graceful shutdown](#graceful-shutdown).

Tests never use this directory: they run against an ephemeral data directory
created under the OS temp dir and removed afterwards (see
[docs/contributor-fixtures.md](docs/contributor-fixtures.md)).

For local restart and regression checks without Testnet or Telegram credentials,
seed that file with a deterministic fixture:

```bash
npm run seed:cursor                 # writes ./data/cursor.json (refuses overwrite)
npm run seed:cursor -- --force      # replace an existing file
npm run seed:cursor -- --empty      # null cursors (file present, cold resume)
npm run seed:cursor -- --out /tmp/cursor.json
```

The seeder uses the same write-then-rename discipline as the poller, never reads
bot tokens or signing keys, and refuses cursor values that look like secrets.

If the file exists but is corrupt (truncated JSON, wrong `version`, or a
non-object `targets` map), the poller renames it to
`CURSOR_FILE.corrupt.<ISO-timestamp>` and cold-starts. That keeps the bad file
for debugging and prevents the next `saveCursors` from silently overwriting
evidence of the failure.

**Deployment note:** a flat file is fine for v0 but it must survive restarts. On
an always-on host, put `data/` on a persistent volume (or point `CURSOR_FILE`
at one). On an ephemeral filesystem every restart is a cold start, and events
that happened while the bot was down are never posted. Swapping this for a real
KV store is a deliberate future step, not something this repo does today.

## Single-instance lock

The poller takes an exclusive file lock (`data/poller.lock` by default, overridable
with `INSTANCE_LOCK_FILE`) before it loads the cursor or starts Telegram long
polling. The lock records only `pid`, `hostname`, and `acquiredAt` — never the
bot token or any secret.

- A second live process against the same lock exits immediately with a clear
  error, so two notifiers cannot race the cursor or double-post events.
- If the previous process died without releasing the lock, the next start
  detects the dead pid, removes the stale file, and continues.
- Point `INSTANCE_LOCK_FILE` at the same persistent volume as `CURSOR_FILE` so
  the lock survives the same restarts the cursor does.

## Failure behaviour

This process is meant to stay up for weeks, so a single failure never ends it:

- **A failed RPC call** fails one contract's scan for one cycle. Its cursor is
  left untouched, so the next cycle resumes exactly where it stopped.
- **A partial notification batch** commits the opaque RPC cursor after the
  returned page has been processed. Unknown events, events beyond
  `MAX_NOTIFICATIONS_PER_CYCLE`, and sends that exhaust three bounded retries
  are counted as skipped or failed and are not replayed. Holding the cursor
  back would turn a revoked token or removed chat into an infinite replay, and
  recovery would flood the channel. A failed send is isolated to that routed
  chat and event; other events continue. Notifications are lossy on purpose —
  the chain is the record; the poller logs the sent/failed/skipped commit decision.
  A rejected inline keyboard (or a malformed MarkdownV2 payload) fails the same
  way as any other send. Events without a usable transaction hash are still
  sent, just without the explorer button.
- **A corrupt cursor file** (invalid JSON or wrong schema) is **quarantined**
  to `data/cursor.json.corrupt.<timestamp>` beside the live path, then treated as
  a cold start; the next successful cycle writes a fresh `cursor.json`, and the
  quarantined copy is kept for operators instead of being overwritten.
- **A valid but RPC-rejected stale cursor** (one below the retained floor) is
  rewound to that floor in bounded steps: the poller confirms the position
  against a fresh `getHealth()`, drops the unreachable cursor, rescans from
  `oldestLedger`, and records the recovery in `/status` and `status.json`. It
  never guesses — an opaque cursor, an ahead-of-tip cursor, or a window that
  cannot be read is left untouched and the bounded RPC error is surfaced. After
  `MAX_FLOOR_REWINDS` (3) consecutive rewinds for one contract the poller stops
  and asks for operator action. See
  [Recovering from a stale cursor](#recovering-from-a-stale-cursor).
- **A second concurrent instance** is refused at startup via the exclusive lock
  above. Stale locks from crashed processes are cleared automatically.
- **A request outside the retained window never reaches the RPC in one piece.**
  The window (`oldestLedger`…`latestLedger`) is validated from `getHealth()`; a
  resume cursor that the token itself places *above* the chain tip is refused
  before it is sent, with a bounded error in `/status` and logs and the stored
  cursor left unchanged. A cursor *below* the retained floor is still forwarded —
  retention is the RPC's call — and when the RPC rejects it the poller rewinds
  to the floor (see
  [Recovering from a stale cursor](#recovering-from-a-stale-cursor)). A cursor
  shape the bot cannot read is forwarded too, so an RPC cursor-format change
  cannot wedge it.
- **A burst** is capped at `MAX_NOTIFICATIONS_PER_CYCLE` messages per cycle,
  spaced out, so Telegram's rate limiter is never the thing that takes the bot

  down. RPC, Telegram, and poller error text shown in `/status` or logs is
  compact, bounded, and the configured bot token is redacted.
- **An unreadable audit line** (or a failed append) is logged and skipped; the
  audit trail never throws into the poll loop, and a bad line never takes the
  report down. An audit file that cannot be read at all reports as empty.
- **A duplicate event** — the same id from an overlapping page, a resumed
  cursor, or a restart — is suppressed and counted (`eventsDeduplicated`), never
  posted twice. It does not hold the cursor back. Bounded per contract by
  `EVENT_DEDUP_WINDOW` (default `256`; `0` disables).
- **A long Stellar outage** freezes the chain clock at the newest close time the
  RPC actually reported. `/status` and `GET /health` then show a growing skew
  rather than a clock that keeps time on its own, so a stalled chain and a
  wrong local clock stay distinguishable. The clock is saved with the cursors,
  so a restart resumes it instead of reporting `unknown`, and an event without
  a `ledgerClosedAt` never counts as a chain time.
- **An operator pause** prevents new cycles but cannot cancel a bounded scan or
  Telegram retry loop already in progress. That cycle follows the normal cursor
  rules above; `/resume` starts the next cycle immediately.
- **A status file that cannot be written** is logged and ignored; it is an
  observability signal, never a reason to stop notifying. A corrupt snapshot
  makes `--status` exit `1` rather than print garbage.
- **A shutdown** stops scheduling, drops what has not been sent yet, waits at
  most `SHUTDOWN_TIMEOUT_MS` for the cycle in progress, and flushes any cursor
  state that is still only in memory — see
  [Graceful shutdown](#graceful-shutdown).

## Graceful shutdown

`SIGINT`/`SIGTERM` starts a bounded drain rather than a hard stop:

1. The poller stops scheduling cycles and reports itself as `stopping`.
2. Notifications that have not been sent yet are **dropped**: counted in
   `/status`, logged once with a bounded line, and left to the chain. A send
   already in flight is allowed to finish, but it does not start another
   retry/backoff step.
3. The cycle in progress gets `SHUTDOWN_TIMEOUT_MS` (default `10000`, `0`
   skips the wait) to finish and write its cursors.
4. Any cursor state still only in memory is flushed to `CURSOR_FILE`, then the
   health endpoint and the Telegram long-poll are closed and the process exits
   `0`.

Cursors only ever advance after their events have been handed to Telegram, so
flushing at any point is safe: the file a restart resumes from never skips an
event the chain still has to show. What the drain gives up is *delivery* of the
messages it had not started — notifications are lossy by design and the chain
is the record, exactly as for a failed Telegram send.

Why drop rather than finish the burst? Finishing means up to
`MAX_NOTIFICATIONS_PER_CYCLE` messages × 1.5s spacing plus retry backoff —
minutes that would hold a deploy open. Worse, hitting the deadline halfway
would leave the cursor behind messages that were already sent, replaying them
on restart. Dropping keeps the drain bounded *and* the resume exact.

**A second `SIGINT`/`SIGTERM` exits immediately** (`130`/`143`) if a drain ever
gets stuck. That skips the flush but never corrupts the file: the cursor is
written to a temporary file and renamed, so the worst case is resuming from the
last completed cycle. The teardown after the flush is capped too —
`SHUTDOWN_TIMEOUT_MS + 10000` ms, then the process exits `1` with the cursor
file already written.

Where the drain is visible:

| Where | Field |
| --- | --- |
| `GET /health` | `poller.stopping`, `poller.pendingFlush`, `poller.lastFlushAt`, `poller.notificationsDropped`. A deliberate drain reports `ok`, not `degraded` |
| `/status` | `stopping` in the headline, `dropped during shutdown N` in the counters, and a drain line while it lasts |

Configuration is additive: `SHUTDOWN_TIMEOUT_MS` is optional (see
`.env.example`), no existing variable is renamed, and the version-1 cursor
format is unchanged — a deployment that omits the new key gets the `10000` ms
default.

## Long-running operation

The notifier is meant to run for weeks through Stellar RPC and Telegram outages.
Everything it keeps in memory is fixed-size or capped:

- Per-target state is one small fixed record (cursor, last event ledger, an
  optional pending floor-rewind ledger, last error).
- The chain clock is one timestamp (the newest observed close time) plus its
  derived skew; it never accumulates history.
- A scan walks at most 20 event pages, and each cycle sends at most
  `MAX_NOTIFICATIONS_PER_CYCLE` messages; the rest are counted as skipped.
- Error text is redacted (bot token) and clipped before it reaches `/status`,
  `/health`, or logs; unknown or malformed events are logged as one bounded line.
- At most one poll timer is pending, and `stop()` leaves none behind.

`tests/soak.test.mjs` enforces this offline: it drives about 1,700 poll cycles
through a scripted fake RPC (outages, stale-cursor rejections, malformed and
unknown events) with every Telegram send failing, under mocked timers. It asserts
that heap growth after a forced GC stays under 4 MB, that status and every log
line stay bounded and token-free, and that timers do not accumulate. A control
test deliberately leaks per send and must trip the same threshold, so the check
cannot silently stop working. It needs no Testnet, Telegram credentials, or keys.

**Deployment assumptions:** one process per chat and cursor file (two writers
would race on `CURSOR_FILE`), the cursor path on persistent storage, and a
supervisor that restarts the process and probes `GET /health`. If you suspect a
leak in production, watch the process RSS over days; a restart is always safe.

**Rollback:** deploy the previous build and start it against the same
`CURSOR_FILE`. The cursor format is unchanged (version 1): `chainClockAt` and
`rewindFromLedger` are optional additive fields that older builds ignore and
newer builds drop when absent or malformed, and the chain is the source of
truth, so nothing is replayed beyond the last saved cursor and nothing needs
migrating. An older build that meets a mid-recovery file simply cold-starts that
contract from `START_LOOKBACK_LEDGERS` rather than mis-reading it. Keep a copy of
the cursor file if you want an exact resume point.

## Health endpoint

Before the poller starts, boot calls Soroban RPC `getHealth()` with bounded
retries (`STARTUP_HEALTH_DEADLINE_MS` / `STARTUP_HEALTH_RETRY_MS`) so a brief
RPC outage does not abort startup, while a bad URL still fails within the
deadline.

The process exposes a **loopback HTTP** probe for supervisors and deploy
checks (default `http://127.0.0.1:8787`):

| Path | Meaning |
| --- | --- |
| `GET /health` (alias `/healthz`) | Readiness-style status. `200` when the poller is running and healthy, including an intentional operator pause; `503` when stopped or degraded (repeated RPC failures or a stale success window). The response includes `poller.paused`. |
| `GET /health/live` (alias `/livez`) | Liveness only — the process and HTTP server are up. Always `200` while listening. |

The JSON body is operational status only: poller counters, ledgers, truncated
cursors, whether a target has an error, automatic floor rewinds
(`poller.cursorRewinds` plus each target's `rewindFromLedger`), and the chain
clock (`poller.chainClockAt` plus `poller.chainClockSkewMs`, the signed difference
in milliseconds between the bot's clock and the newest chain close time it has
observed — positive while the bot is ahead). Each target's `cursorStale` boolean
indicates an unresolved RPC rejection; resolving it requires a successful scan,
not a health-probe retry or local cursor-age guess. It never includes
`BOT_TOKEN`, chat ids, private keys, or unbounded remote payloads.

### Configuration provenance

`GET /health` also answers *where each setting's value came from*, and never what
it is. That distinction is the difference between "the bot is configured" and
"the bot is configured the way I think it is": a placeholder token inherited from
a profile, a `.env` the process never found because it started from another
directory, and a variable exported empty all look identical from the outside.

```json
{
  "config": {
    "profile": null,
    "envFile": { "present": true, "suppliedKeys": 12 },
    "entries": [
      { "key": "BOT_TOKEN", "source": "env-file", "secret": true },
      { "key": "HEALTH_PORT", "source": "derived", "derivedFrom": "PORT", "secret": false }
    ],
    "counts": {
      "process-env": 3,
      "env-file": 12,
      "profile-default": 0,
      "built-in-default": 6,
      "derived": 1,
      "unset": 4
    },
    "warnings": []
  }
}
```

`source` is one of `process-env`, `env-file`, `profile-default`,
`built-in-default`, `derived` (another setting supplies it, named by
`derivedFrom`), or `unset` — absent and optional, which is the normal state for
`ALLOWED_CHAT_IDS` and `OPERATOR_TELEGRAM_USER_ID`. No value — token, chat id, or
anything else — is ever part of the report, so it can be pasted into a ticket
as-is; `secret: true` marks the settings that are sensitive for exactly that
reason. `warnings` names what is worth acting on: a variable set but empty, a
`.env` that supplies none of the known settings (usually a working-directory
bug), an unknown `MIMIR_PROFILE`, or the mock profile being active.

Boot logs the same information as one line, followed by any warnings:

```
[boot] config       profile=none env-file=present(12 keys) process-env=3 env-file=12 built-in-default=6 derived=1 unset=4 secret-keys=6/26
[boot] config       HEALTH_STALE_MS is set but empty; the built-in default supplies the value
```

`/status` ends with the same one-line summary, so an operator can confirm which
`.env` a deployment actually read without opening a shell.

Configuration (see `.env.example`):

- `HEALTH_HOST` — bind address (default `127.0.0.1`; set to `0.0.0.0` for Docker)
- `HEALTH_PORT` — TCP port (default `8787`; `0` disables)
- `HEALTH_STALE_MS` — degraded if no successful poll within this window after the first success (default `90000`; `0` disables)
- A stale cursor rejection independently makes `GET /health` return `503` until its target scans successfully; `HEALTH_STALE_MS` does not disable this cursor alert.
- `STARTUP_HEALTH_DEADLINE_MS` — wall-clock budget for retrying the boot RPC `getHealth()` probe (default `30000`; `0` = single attempt)
- `STARTUP_HEALTH_RETRY_MS` — delay between failed boot RPC health attempts (default `1000`)

**Rollback:** set `HEALTH_PORT=0` (or omit the new env keys to keep defaults) and
redeploy the previous image — the target alert is additive, does not change the
version-1 cursor format or Telegram delivery, and the previous build safely
ignores the new status field.

**Failure modes:** binding fails only if the port is already taken (process
exits via the listen error path after logging). Client disconnects and probe
errors are logged and ignored so they cannot stop the notifier.
- **Notification feature flags** (`NOTIFY_ENABLED`, `NOTIFY_MARKET`, `NOTIFY_SQUAD`) are coarse kill switches for Telegram posts. Disabled events are skip-logged and the cursor still advances; unset defaults keep prior always-on behavior.

## Layout

```
src/
  index.ts                 entry point: config -> RPC -> bot -> poller -> health HTTP
  mock-run.ts              dry run: in-process mock RPC + real poller, log-only sends
  health.ts                local loopback GET /health for supervisors
  config.ts                env loading and validation, fails fast (MIMIR_PROFILE profiles)
  bot.ts                   grammy setup: /start, /help, /status, /audit, /contracts, /health, /preview, operator pause/resume
  dedup.ts                 bounded event-id window (reader + poller dedup)
  poller.ts                the loop: scan, notify, persist the cursor, flush audit
  audit.ts                 redaction, bounded audit log, JSONL persistence, report renderer
  audit-cli.ts             entrypoint for `npm run audit`
  replay-cli.ts            entrypoint for `npm run replay` (cursor-range replay)
  instanceLock.ts          exclusive process lock for the cursor owner
  status.ts                machine-readable status snapshot (allowlisted, bounded)
  dev/
    seedCursor.ts          credential-free local cursor seeder (npm run seed:cursor)
  stellar/
    client.ts              Soroban RPC client + explorer links (tx + contract)
    events.ts              cursor-paginated getEvents (+ the standalone CLI)
    decode.ts              typed decoding of both contracts' events
    replay.ts              cursor-range replay engine + runReplayCli() (npm run replay)
    mock-rpc.ts            local Soroban mock: scenario, pagination, failure injection
    mock-constants.ts      mock profile fixture ids, ports, placeholder credentials
  notifications/
    format.ts              decoded event -> MarkdownV2 message
tests/
  format.test.mjs          notification formatting (incl. deterministic fuzz)
  audit.test.mjs           redaction, entries, persistence, report rendering
  replay.test.mjs          cursor-range replay: dry-run, send, clamp, security, cursor-safety
```

## Deploying on Railway

The repo ships `railway.json` — Railway's Config-as-Code — that wires the
deployment to the rest of this repo:

| Setting | Value | Why |
| --- | --- | --- |
| `build.buildCommand` | `npm run build` | `dist/` is gitignored; the image compiles it. |
| `deploy.startCommand` | `npm start` | Run the built poller. |
| `deploy.healthcheckPath` | `/health` | The same endpoint the local health module serves (`GET /health`). |
| `deploy.requiredMountPath` | `/app/data` | Refuse to start unless a volume is attached where the cursor lives. |
| `deploy.restartPolicyType` | `ON_FAILURE` | Restart on crash, bounded retries. |
| `deploy.numReplicas` | `1` | One poller owns the cursor; Railway volumes cannot be used with replicas. |

Volume is the one manual step — Railway never creates one from config:

```bash
railway volume add --mount-path /app/data   # or attach it from the dashboard
```

Set as Railway variables (secrets): `BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and
`HEALTH_HOST=0.0.0.0`. Everything else keeps its repo default:
`CURSOR_FILE=./data/cursor.json` resolves to `/app/data/cursor.json` in
Railway's `/app` working directory, and the health endpoint binds the `PORT`
that Railway injects (the `HEALTH_PORT` fallback, see `.env.example`). No public
domain is needed — healthchecks run from Railway's probe host on the container
network, which is why `HEALTH_HOST` must not stay loopback-only here.

On deployed failure:

- A crash restarts under `ON_FAILURE`; the volume keeps the cursor so there is
  no notification replay. A **stale or corrupt cursor** is already handled as a
  cold start, never a crash — see [Failure behaviour](#failure-behaviour).
- A redeploy of a volume-backed service has a short downtime window (Railway
  keeps only one active deployment per volume); roll back to the previous
  revision and the cursor is still there.

Config-as-Code is deprecated by Railway in favour of Infrastructure as Code
(`.railway/railway.ts` with the Railway CLI), with a hard cutoff of 2026-12-01.
This file captures the current, working behaviour and is the migration source of
truth for IaC; follow Railway's migration guide when the time comes.

## Development checks

Run `npm run typecheck` for a no-emit TypeScript check, `npm test` for the build plus the deterministic command, poller, format, fixture, mock-profile, config-provenance, health, lockfile and audit-trail suites (including deterministic fuzz cases; `npm run test:mock` for just the local-mock suites), or `npm run build` to produce the production output. CI runs typecheck, build, and all tests without network credentials.
Run `npm run seed:cursor` to write a local cursor fixture.

### Lockfile reproducibility

`package-lock.json` is the install of record: deployments rebuild with `npm ci`,
so the committed lockfile must stay in sync with `package.json` and pin exactly
what it claims. Two checks enforce that, and CI runs both after `npm ci`:

- `npm run lockfile:check` — offline. The lockfile is `lockfileVersion` 3, its
  root entry matches `package.json`'s dependency ranges exactly, every package
  resolves to a `registry.npmjs.org` tarball with a `sha512` integrity hash, and
  every direct dependency is pinned at the top level. Drift is reported by
  package name instead of being silently re-resolved.
- `npm run lockfile:reproduce` — asks npm to regenerate the lockfile from itself
  in a scratch directory and fails if the resolved package set changes, so a
  hand-edited or partially-resolved lockfile cannot land. The repository working
  tree is never written to.

The offline suite runs as part of `npm test` (`tests/lockfile.test.mjs`), so
drift is caught locally without network access. To change dependencies, edit
`package.json`, run `npm install` to regenerate the lockfile, and commit both
files together — a lockfile that no longer matches `package.json` fails
`npm ci`, `npm run lockfile:check`, and CI.
Run `npm run typecheck` for a no-emit TypeScript check, `npm test` for the build plus the deterministic command, poller, ledger-window, format, fixture, mock-profile, config-provenance, health, lockfile and audit-trail suites (including deterministic fuzz cases; `npm run test:mock` for just the local-mock suites), or `npm run build` to produce the production output. CI runs typecheck, build, and all tests without network credentials.

Contributor workflow for credential-free fixtures (event catalogs, cursor samples, failure-mode expectations) lives in [docs/contributor-fixtures.md](docs/contributor-fixtures.md).

## License

[AGPL-3.0-or-later](./LICENSE), matching the rest of Mimir.
