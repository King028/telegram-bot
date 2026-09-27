# Incident Runbook

Operational guidance for recovering the Mimir Telegram notifier from missed notifications, without treating Telegram as the source of truth.

## Operating principles

* Stellar chain state is the source of truth.
* The notifier is read-only and never holds signing keys or private keys.
* A notification failure must not alter on-chain state.
* Cursors must only move according to the poller's existing persistence rules.
* A shutdown flush may only persist cursors the poller already advanced; it never invents a resume position.
* Logs and status output must not expose bot tokens, private keys, payment proofs, or unbounded remote payloads.

Notification text from contract String fields is bounded to 200 Unicode code
points before MarkdownV2 escaping. An oversized or malformed transaction hash
does not receive an explorer link. The original event is still decoded and the
cursor follows the normal poller rules; truncation affects only the Telegram
presentation, not chain data or persisted cursor state.

## Quick health check

Run:

```bash
/health
```

Or for full poller state details:

```bash
/status
```

Check:

* overall readiness and status (`ok`, `degraded`, `stopped`)
* current chain tip
* RPC retained-history floor
* chain clock skew (newest observed chain close time against this host's clock)
* watched contract IDs
* configuration provenance (`/health` -> `.config`, or the boot `[boot] config` line): which source supplied each setting, with no values
* last event ledger per contract
* persisted cursor
* poll/send counters, including automatic floor rewinds (`cursorRewinds`)
* any target resuming from a floor rewind (`rewindFromLedger`)
* last error and consecutive failure count

For a read-only chain diagnostic without a Telegram token:

```bash
npm run scan
```

Use `--from`, `--pages`, or `--show` when a narrower or deeper scan is needed.

## Chain clock skew

`/status` and `GET /health` show how far this host's clock is from the newest
chain close time the poller has actually observed. `/health` exposes the same
numbers as `poller.chainClockAt` and `poller.chainClockSkewMs`.

* `in sync` — within one second of the observed chain time.
* `local clock … ahead of chain` — the usual reading: the observed chain time is
  older than this host by roughly the poll interval plus ledger close latency.
* `chain clock … ahead of local` — the observed chain time is in the future
  relative to this host. Check the host clock (NTP) before anything else.
* `unknown` — nothing observed yet: a cold start, or every scan so far returned
  no events for the watched contracts.

The clock only advances from a `ledgerClosedAt` the RPC actually returned, so it
freezes during RPC failures, an open circuit breaker, an operator pause, or a
stretch with no events, and the skew then grows on its own. It is saved with the
cursors, so a restart resumes it instead of reporting `unknown`.

Reading it: growing skew while the cursor still advances, `consecutiveFailures`
stays at `0`, and the last event ledger is unchanged means the watched contracts
are quiet, not broken. Growing skew alongside `consecutiveFailures` points at the
RPC. `chain clock … ahead of local` points at this host's clock.

## Operator pause and resume

`/pause` and `/resume` require the numeric user id configured in
`OPERATOR_TELEGRAM_USER_ID`. A notification chat id is not authorization because
all members of a group can send commands there. Unauthorized attempts receive no
reply and do not change polling.

`/pause` cancels the next scheduled cycle. A cycle already reading events or
retrying Telegram may finish under its existing bounded limits and normal cursor
rules. `/resume` is idempotent and schedules the next cycle immediately; it does
not rewind, reset, or replay cursors and cannot recover messages already dropped
after Telegram failures.

Pause state is process-local. A restart always begins polling while loading the
existing version-1 cursor file, preventing a stale pause from surviving a deploy.
An operator pause is reported as healthy by `/health` with `poller.paused=true`.

## RPC failures

### Symptoms

* `/status` reports a recent RPC error.
* One contract stops advancing while the other continues.
* Notifications from one contract are missing.

### Recovery

1. Confirm the RPC endpoint is reachable.
2. Run `npm run scan` to verify that the chain reader can access retained events.
3. Check the retained-history floor reported by the RPC.
4. Restart the process only if the underlying RPC problem has been resolved.

The affected contract's cursor is left unchanged after a failed scan, so the next polling cycle can retry from the same position. If the operator intentionally used `/pause`, use `/resume` only after the RPC is healthy; otherwise normal polling already retries on schedule.

Do not manually advance the cursor to skip an RPC failure.

## Telegram failures

### Symptoms

* Event scanning continues but sends fail.
* `/status` shows send errors or an increasing scan/send difference.
* The bot was removed from the chat or its token was revoked.

### Recovery

1. Confirm the bot token and chat configuration are valid.
2. Confirm the bot is still present in the target chat and has permission to post.
3. Use `/status` to confirm the process is still running and not intentionally paused.
4. Restart only when configuration has been corrected. If polling was deliberately paused, use `/resume` after the token/chat is healthy.

Telegram delivery is intentionally lossy. The poller commits the opaque cursor
after processing the returned page, even when sends are partial. A failed send
does not hold the cursor back because replaying every missed notification could
create an unbounded backlog or flood a recovered chat. The log reports the
sent/failed/skipped counts for that commit.

The Stellar chain remains the authoritative record.

## Stale or corrupt cursor

### Symptoms

* The cursor cannot be parsed.
* The stored cursor is incompatible with the current cursor format.
* The process reports a cursor-loading problem.
* `/status` reports `Cursors rewound to the retained floor: N`, or `status.json`
  / `GET /health` show a non-null `rewindFromLedger`, after a long outage.

### Recovery

A corrupt cursor is quarantined beside the live path and treated as a cold start;
preserve the quarantined copy for investigation.

A syntactically valid cursor that Soroban rejects as stale is first checked
against a fresh `getHealth()`:

* If the cursor's ledger is **strictly below** `oldestLedger`, the position it
  points at is already unrecoverable, so the poller drops it and rescans from
  `oldestLedger`. This is bounded to `MAX_FLOOR_REWINDS` (3) consecutive
  automatic rewinds per contract. The count is visible in `/status` and
  `GET /health` as `cursorRewinds`, and an active recovery is the target's
  `rewindFromLedger` (also in `status.json` and `GET /health`).
* If the cursor cannot be placed (an opaque token), sits **inside** the window,
  or the window cannot be read, it is **kept unchanged** and the bounded RPC
  error is surfaced. `/resume` never changes a cursor.

A floor rewind loses nothing that is still readable — everything below the floor
has already left the RPC. It can, however, skip events that expired while the bot
was down, which the chain still records.

A cursor the token itself places **ahead of the chain tip** is refused locally
with a bounded `ahead of the chain tip` error instead of being sent, and the
stored cursor is kept unchanged. That can be a transient RPC-lag condition and
clears as the tip advances; if it persists it means the cursor came from a
different chain (for example a network reset), so treat it as incompatible:
preserve the file and perform a deliberate cold start.

If the automatic rewind budget is spent (the process logs that operator action is
required) or the cursor cannot be placed, treat it as permanently stale: stop
the notifier, preserve the cursor file for investigation, and deliberately
cold-start with the configured `START_LOOKBACK_LEDGERS` after checking the
retained-history floor. A cold start may produce duplicate notifications, but it
does not replay all retained history.

Before changing `CURSOR_FILE` or deleting persisted state, preserve the existing file for investigation if possible.

If the stored cursor is confirmed incompatible or permanently outside RPC retention, stop the notifier, preserve the cursor file for investigation, and deliberately perform a cold start with the configured `START_LOOKBACK_LEDGERS` after checking the retained-history floor. This may produce duplicate notifications, but it does not skip or replay all retained history.

On a cold start, the poller begins from its configured lookback rather than replaying the entire retained RPC history.

Never replace a cursor with an arbitrary ledger or cursor value unless the repository's cursor format and retained-history requirements have been verified. `/pause` and `/resume` are safe alternatives because they leave the version-1 cursor file untouched.

## Process restart

### Stopping the process

`SIGTERM`/`SIGINT` starts a bounded drain instead of killing the loop:

1. New poll cycles stop being scheduled and `/status` reports `stopping`.
2. Notifications not yet sent are dropped and counted
   (`dropped during shutdown`), with one bounded log line. The chain, not
   Telegram, remains the record.
3. The cycle in progress is given `SHUTDOWN_TIMEOUT_MS` (default `10000`) to
   finish and write its cursors.
4. Any cursor state still only in memory is flushed to `CURSOR_FILE`, then the
   health endpoint and the Telegram long-poll are closed and the process exits
   `0`.
5. If that teardown itself wedges, the process exits `1` after
   `SHUTDOWN_TIMEOUT_MS + 10000` ms. The flush has already happened by then.

Send a second `SIGTERM`/`SIGINT` only if the drain is genuinely stuck: it exits
immediately (`130`/`143`) and skips the flush. The cursor file itself cannot be
truncated by that, because it is written to a temporary file and renamed.

After a drain, `GET /health` reports `poller.stopping` and `poller.pendingFlush`.
`pendingFlush: true` after the process should have exited means the flush did
not land — check disk permissions and the persistent volume before restarting.

### Persistent deployment

Ensure `data/` or the path configured by `CURSOR_FILE` is on persistent storage.

After a restart:

1. Check `/status`.
2. Confirm the persisted cursor is present.
3. Confirm polling resumes normally.
4. Check that counters and last-event ledgers begin advancing again.

### Ephemeral deployment

If the filesystem is ephemeral, every restart behaves like a cold start. Events that occurred while the process was down may not be posted.

Use persistent storage for long-running deployments.

## Railway deployment

The Railway deployment (`railway.json`) mounts a persistent volume at `/app/data` and requires it via `requiredMountPath` — Railway refuses to start the service until a volume exists at that path.

A redeploy of a volume-backed service has a short downtime window: Railway allows only one active deployment per volume at a time. Rollback redeploys the previous revision; the volume is preserved and the cursor survives.

Verify after deployment and during incidents:

1. Confirm the volume is attached at `/app/data` (injected as `RAILWAY_VOLUME_MOUNT_PATH`).
2. Confirm `HEALTH_HOST=0.0.0.0` is set — Railway's healthcheck probe crosses the container network and cannot reach a loopback-only `/health` listener. The health port follows the injected `PORT` when `HEALTH_PORT` is unset.
3. Confirm the persisted cursor lives at `/app/data/cursor.json` and `/status` shows a non-empty cursor.
4. Confirm `/health` responds `200` in the Rails health tab after the first successful poll.

Do not delete `/app/data` cursor state as part of a normal rollback.

## Rate limiting

Notification bursts are bounded by `MAX_NOTIFICATIONS_PER_CYCLE` and spaced out.

If Telegram rate limits are observed:

1. Confirm the process remains alive.
2. Check `/status` for send errors.
3. Do not disable the notification cap to compensate.
4. Allow subsequent polling cycles to continue normally.

Do not manually replay large event ranges into Telegram.

## Malformed or unexpected events

A malformed event must not crash the long-running process.

`decodeEvent` converts malformed XDR and events introduced by a newer contract
deployment into a bounded `unknown` record. The poller logs only the contract,
event name, ledger, and a clipped reason, skips Telegram delivery for that
event, and continues with the RPC cursor returned by the scan. This protects
the long-running reader while preserving the chain as the source of truth.

When investigating:

1. Use `npm run scan` to inspect the affected event range.
2. Confirm the contract and ledger involved.
3. Check the decoded event output without copying unrestricted remote payloads into logs or tickets.
4. Preserve the existing cursor behavior.

Do not modify on-chain state or attempt to repair an event by writing to the Mimir contracts.

## Configuration looks applied but is not

### Symptoms

* Telegram answers `401 Unauthorized` for a token that is set in `.env`.
* Notifications arrive in a chat nobody configured, or in none at all.
* A value edited in `.env` has no effect after a restart.

### Recovery

Ask the running process where its configuration came from. The report contains
key names and origins only — never a value — so it is safe to attach to a ticket:

```bash
curl -s http://127.0.0.1:8787/health | jq .config
```

* `envFile.present: false` — the process never found `.env`. The file resolves
  against the working directory, so a supervisor that starts the bot elsewhere
  silently runs on defaults; start it from the directory holding the file.
* `envFile.suppliedKeys: 0` with `present: true` — the file was read but supplied
  none of the known settings. Check for a typo'd key name.
* `entries[].source: "profile-default"` for `BOT_TOKEN` — `MIMIR_PROFILE=mock` is
  active and placeholder credentials are in use.
* `emptyDeclaration: true` — the variable is declared with no value, so a profile
  or built-in default wins. This is the most common "I set it and nothing
  changed".
* `source: "process-env"` where a file value was expected — a variable already
  set by the platform, systemd, or the shell wins over `.env`; the file is never
  allowed to overwrite it.

Fix the source, not the symptom: restart only once the report names the source
you intended for that setting.

## Safe rollback

For a deployment containing only documentation or operational changes:

1. Stop the affected deployment according to its hosting platform's procedure.
   A `SIGTERM` drains: cursors are flushed and unsent notifications are dropped
   and counted. Use `/pause` only to stop scheduling while leaving the process
   available.
2. Revert to the previously known-good application revision.
3. Preserve the persistent `data/` volume.
4. Restart the known-good revision.
5. Check `/status`.
6. Verify that the persisted cursor is still present and polling resumes.

Do not delete cursor state as part of a normal rollback.

## Deployment checklist

Before deployment:

* `.env` contains valid configuration without exposing secrets in source control.
* `BOT_TOKEN` and `TELEGRAM_CHAT_ID` are supplied through the deployment secret/configuration mechanism.
* `data/` or `CURSOR_FILE` is persistent — on Railway, a volume attached at `/app/data` (see `railway.json`).
* The deployed revision passes typecheck and build checks.
* No production credentials are committed.

After deployment:

* Confirm the process starts successfully.
* Run `/status`.
* Confirm the `[boot] config` line (or `/health` `.config`) shows the sources you
  intended — for a deployment with a `.env`, `envFile.present: true` and the
  bot token's source reported as `env-file`, not `profile-default`.
* Confirm the expected contract IDs and cursor are shown.
* Confirm the last event ledger advances after new events.
* Monitor RPC and Telegram errors.

## Security and logging

Never log:

* Telegram bot tokens
* private keys or signing material
* payment proofs
* unrestricted remote API responses
* sensitive authentication data

Configuration provenance reports are the exception that proves the rule: the
boot `[boot] config` line and the `/health` `config` section name settings and
their sources, so they can be shared verbatim. They are built so that a value —
token, chat id, or otherwise — cannot appear in them.

When reporting an incident, include only the minimum information needed to identify the failure, such as contract, ledger, cursor state, error category, and timestamp.

## Rehearsing locally (mock profile)

Every failure mode in this runbook can be drilled on a laptop against the
local mock profile — loopback only, no bot token, no Testnet, and an isolated
`data/cursor.mock.json` that never overlaps a real bot's cursor:

```bash
npm run mock:poll -- --fail-events error   # RPC failure drill (see "RPC failures")
npm run mock:poll -- --stale-cursor        # stale cursor drill (see "Stale or corrupt cursor")
npm run mock:poll -- --malformed           # undecodable event drill
npm run mock:poll                          # healthy dry run; sends are logged, not delivered
curl -s http://127.0.0.1:8787/health | jq .status
```

Injected failures last until the process stops, so recovery is "restart without
the flag": the cursor must resume exactly where it was, log lines stay bounded,
and no token-shaped secret appears anywhere in the output. `--stale-cursor`
rejects any resume cursor the mock has handed out; because that cursor is inside
the retained window, the poller keeps it (a rewind happens only when a fresh
`getHealth()` proves the cursor is *below* the floor). The same guarantees are
asserted by `tests/mock-rpc.test.mjs` (`npm run test:mock`), and the bounded
rewind path is covered by `tests/cursor-rewind.test.mjs`.

## Verification

Before merging operational changes, run the repository's documented checks:

```bash
npm run typecheck
npm run build
npm test
```

Also verify the command-level diagnostic path where applicable:

```bash
npm run scan
```

The notifier should remain read-only throughout incident recovery. The chain remains the source of truth even when Telegram delivery is unavailable.

## Corrupt cursor file

### Symptoms

* Startup logs show a quarantined cursor path (`*.corrupt.<timestamp>`).
* `/status` shows null/cold cursors after a restart that previously had resume positions.
* A brief lookback replay of recent events may appear in the chat (bounded by `START_LOOKBACK_LEDGERS`).

### Recovery

1. Confirm the live `CURSOR_FILE` path (default `data/cursor.json`) was removed or renamed.
2. Inspect the quarantined sibling file for truncation or unexpected shape — do not paste bot tokens or secrets into tickets.
3. Leave the quarantine file in place for forensics; the poller will write a fresh cursor on the next successful cycle.
4. Do not manually invent cursor strings. If you must force a lookback window, delete only the live cursor file and restart (or rely on the automatic quarantine path).

The chain remains the source of truth; quarantining never signs transactions or skips retained events beyond the configured lookback.
