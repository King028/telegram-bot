import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendAuditFile,
  auditEntry,
  createAuditLog,
  errorText,
  isErrorKind,
  redact,
  readAuditFile,
  renderAuditLine,
  renderAuditReport,
  summarizeAudit,
  AUDIT_KINDS,
  AUDIT_MAX_BUFFERED,
  AUDIT_MAX_DETAIL,
} from "../dist/audit.js";
import { createPoller } from "../dist/poller.js";

// ── Redaction ────────────────────────────────────────────────────────────────

test("redact removes bot tokens in every common shape", () => {
  const secret = "123456789:AAFFS_Dt-EXAMPLE_TOKEN_abcdef0123456789";
  for (const text of [
    `getMe failed for bot${secret}`,
    `token ${secret} rejected`,
    `401 on /bot${secret}/sendMessage`,
    `${secret} is invalid`,
    `BOT_TOKEN=${secret}`,
  ]) {
    const out = redact(text);
    assert.ok(!out.includes(secret), `token leaked via ${text}`);
    assert.ok(out.includes("[redacted:bot token]"), `no redaction marker in ${out}`);
  }
});

test("redact removes seed and other secret strkeys but keeps contract ids", () => {
  const seed = "S" + "A".repeat(55);
  const contract = "C" + "B".repeat(55);

  const out = redact(`signer ${seed} saw ${contract}`);
  assert.ok(!out.includes(seed), "seed key leaked");
  assert.ok(out.includes("[redacted:secret key]"));
  assert.ok(out.includes(contract), "public contract id should survive redaction");
});

test("redact strips urls and key=value secrets from error text", () => {
  const out = redact("POST https://api.example.com/botTOK/sendMessage?secret=hush failed");
  assert.ok(!out.includes("https://"), `url leaked: ${out}`);
  assert.ok(!out.includes("hush"), `query secret leaked: ${out}`);
  assert.ok(out.includes("[redacted:url]"));
});

test("redact clamps unbounded detail to the audit cap", () => {
  // Word-per-token text so no single token trips the long-token rule; the
  // length clamp is what has to hold here.
  const big = "word ".repeat(3000);
  const out = redact(big);
  assert.ok(out.length <= AUDIT_MAX_DETAIL, `len ${out.length}`);
  assert.ok(out.endsWith("…"));

  // One gigantic token is replaced outright rather than clamped.
  const token = redact("x".repeat(10_000));
  assert.ok(token.length < AUDIT_MAX_DETAIL);
  assert.ok(token.includes("[redacted:long token]"));
});

test("redact preserves short human-readable messages untouched", () => {
  const msg = "scan failed: getEvents request timed out";
  assert.equal(redact(msg), msg);
});

test("errorText extracts a message from SDK-style thrown objects", () => {
  // The Stellar SDK's JSON-RPC layer throws raw response objects, not Errors.
  const thrown = { code: -32603, message: "Internal error", data: "x" };
  assert.equal(errorText(thrown), "Internal error");
  assert.equal(errorText(new Error("plain")), "plain");
  assert.equal(errorText("string error"), "string error");
  assert.equal(errorText(42), "42");
  assert.ok(errorText(undefined).length > 0);
});

// ── Entries ──────────────────────────────────────────────────────────────────

test("auditEntry redacts and clamps detail at record time", () => {
  const entry = auditEntry("send_failed", {
    detail: `sendMessage rejected bot123456:${"A".repeat(2000)} trailing`,
  });
  assert.ok(!entry.detail.includes("AAFFS"));
  assert.ok(entry.detail.length <= AUDIT_MAX_DETAIL + 40); // +40: the redaction marker itself
  assert.equal(entry.v, 1);
  assert.equal(typeof entry.t, "number");
});

test("auditEntry keeps the closed kind set closed", () => {
  assert.throws(() => auditEntry("not_a_kind"), TypeError);
  assert.equal(AUDIT_KINDS.length > 5, true);
  for (const kind of AUDIT_KINDS) assert.equal(isErrorKind(typeof kind), false);
});

test("auditEntry omits empty detail and honours source", () => {
  const bare = auditEntry("boot", { detail: "  " });
  assert.equal(bare.detail, undefined);
  const withSource = auditEntry("cycle_failed", { source: "market", detail: "rpc down" });
  assert.equal(withSource.source, "market");
  assert.equal(withSource.detail, "rpc down");
});

// ── In-memory log ────────────────────────────────────────────────────────────

test("createAuditLog buffers a bounded ring and reports counts", () => {
  const log = createAuditLog({ max: 3 });
  for (let i = 0; i < 5; i += 1) {
    log.record(auditEntry("cycle_failed", { detail: `failure ${i}` }));
  }
  const entries = log.entries();
  assert.equal(entries.length, 3, "ring is bounded");
  assert.equal(entries[0].detail, "failure 2", "oldest evicted");
  assert.equal(log.count("cycle_failed"), 3);
  assert.equal(log.count("send_failed"), 0);
  assert.equal(log.lastError().kind, "cycle_failed");
});

test("createAuditLog tail returns only the last n entries", () => {
  const log = createAuditLog();
  for (let i = 0; i < 12; i += 1) log.record(auditEntry("boot", { detail: String(i) }));
  const tail = log.tail(10);
  assert.equal(tail.length, 10);
  assert.equal(tail[0].detail, "2");
  assert.equal(tail[9].detail, "11");
});

test("createAuditLog flush returns and clears the pending increment", () => {
  const log = createAuditLog();
  log.record(auditEntry("boot", { detail: "one" }));
  log.record(auditEntry("boot", { detail: "two" }));
  assert.equal(log.flush().length, 2);
  assert.equal(log.flush().length, 0, "second flush is empty");
  assert.equal(log.entries().length, 2, "ring keeps history after flush");
});

test("createAuditLog default buffer size matches the documented cap", () => {
  const log = createAuditLog();
  for (let i = 0; i < AUDIT_MAX_BUFFERED + 50; i += 1) {
    log.record(auditEntry("event_skipped", {}));
  }
  assert.equal(log.entries().length, AUDIT_MAX_BUFFERED);
});

test("recordError prefixes context and redacts the message", () => {
  const log = createAuditLog();
  log.recordError(new Error(`request to bot123456:${"A".repeat(40)} failed`), "send_failed", {
    source: "squad",
    detail: "ledger 42",
  });
  const entry = log.lastError();
  assert.equal(entry.kind, "send_failed");
  assert.equal(entry.source, "squad");
  assert.ok(entry.detail.startsWith("ledger 42:"));
  assert.ok(entry.detail.includes("[redacted:bot token]"));
});

// ── JSONL persistence ────────────────────────────────────────────────────────

async function tempFile(name) {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-audit-"));
  const file = path.join(dir, name);
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("poller persists audit entries by default and honours explicit opt-out", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    const audit = createAuditLog();
    audit.record(auditEntry("boot", { at: 1, detail: "persisted by default" }));
    const poller = createPoller({
      config: { auditFile: file },
      server: {},
      send: async () => undefined,
      audit,
    });

    await poller.flushAuditFile();
    const summary = await readAuditFile(file);
    assert.equal(summary.entries[0].detail, "persisted by default");

    audit.record(auditEntry("shutdown", { at: 2, detail: "in-memory only" }));
    const optedOut = createPoller({
      config: { auditFile: file },
      server: {},
      send: async () => undefined,
      audit,
      persistAudit: false,
    });
    await optedOut.flushAuditFile();

    const afterOptOut = await readAuditFile(file);
    assert.equal(afterOptOut.entries.length, 1);
    assert.ok(!afterOptOut.entries.some((entry) => entry.kind === "shutdown"));
  } finally {
    await cleanup();
  }
});

test("appendAuditFile appends JSONL without clobbering prior content", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    await appendAuditFile(file, [auditEntry("boot", { at: 1, detail: "first" })]);
    await appendAuditFile(file, [auditEntry("boot", { at: 2, detail: "second" })]);

    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).detail, "first");
    assert.equal(JSON.parse(lines[1]).detail, "second");
  } finally {
    await cleanup();
  }
});

test("appendAuditFile creates parent directories on demand", async () => {
  const { file, cleanup } = await tempFile("nested/deeper/audit.jsonl");
  try {
    await appendAuditFile(file, [auditEntry("boot", { at: 1 })]);
    const info = await stat(file);
    assert.ok(info.isFile());
  } finally {
    await cleanup();
  }
});

test("appendAuditFile with no entries touches nothing", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    await appendAuditFile(file, []);
    await assert.rejects(stat(file));
  } finally {
    await cleanup();
  }
});

test("readAuditFile skips unreadable lines and counts them", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    const good1 = JSON.stringify({ v: 1, t: 1, kind: "boot", detail: "ok" });
    const bad = "not json at all {{{";
    const wrongShape = JSON.stringify({ v: 1, t: 2, kind: "boot", detail: 42 }); // detail not a string
    const good2 = JSON.stringify({ v: 1, t: 3, kind: "send_failed", detail: "later" });
    await writeFile(file, [good1, bad, wrongShape, good2, ""].join("\n"), "utf8");

    const summary = await readAuditFile(file);
    assert.equal(summary.entries.length, 2);
    assert.equal(summary.unreadableLines, 2);
    assert.equal(summary.entries[0].detail, "ok");
    assert.equal(summary.entries[1].kind, "send_failed");
  } finally {
    await cleanup();
  }
});

test("readAuditFile rejects entries from an unknown future version", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    const future = JSON.stringify({ v: 99, t: 1, kind: "boot" });
    await writeFile(file, `${future}\n`, "utf8");
    const summary = await readAuditFile(file);
    assert.equal(summary.entries.length, 0);
    assert.equal(summary.unreadableLines, 1);
  } finally {
    await cleanup();
  }
});

test("readAuditFile caps the report window and reports the overflow", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    const lines = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(JSON.stringify({ v: 1, t: i, kind: "boot", detail: `e${i}` }));
    }
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");

    const summary = await readAuditFile(file, { maxEntries: 10 });
    assert.equal(summary.entries.length, 10);
    assert.equal(summary.droppedFromReport, 30);
    assert.equal(summary.entries[0].detail, "e30", "keeps the most recent window");
    assert.equal(summary.entries[9].detail, "e39");
  } finally {
    await cleanup();
  }
});

test("readAuditFile on a missing file yields an empty, non-throwing summary", async () => {
  const summary = await readAuditFile(path.join(tmpdir(), "mimir-audit-does-not-exist.jsonl"));
  assert.equal(summary.entries.length, 0);
  assert.equal(summary.unreadableLines, 0);
  assert.equal(summary.droppedFromReport, 0);
});

test("readAuditFile rejects garbage JSON objects that are not audit entries", async () => {
  const { file, cleanup } = await tempFile("audit.jsonl");
  try {
    const lines = [
      JSON.stringify({ hello: "world" }),
      JSON.stringify([1, 2, 3]),
      "null",
      JSON.stringify({ v: 1, t: "not-a-number", kind: "boot" }),
      JSON.stringify({ v: 1, t: 1, kind: "mystery_kind" }),
      JSON.stringify({ v: 1, t: 1, kind: "boot", source: "not-a-source" }),
    ];
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    const summary = await readAuditFile(file);
    assert.equal(summary.entries.length, 0);
    assert.equal(summary.unreadableLines, lines.length);
  } finally {
    await cleanup();
  }
});

// ── Summary and rendering ────────────────────────────────────────────────────

test("summarizeAudit aggregates kinds, errors and boundaries", () => {
  const entries = [
    auditEntry("boot", { at: 1 }),
    auditEntry("cycle_failed", { at: 2, source: "market", detail: "rpc" }),
    auditEntry("send_failed", { at: 3, source: "market", detail: "tg" }),
    auditEntry("cycle_recovered", { at: 4, source: "market" }),
    auditEntry("event_skipped", { at: 5, source: "squad", detail: "admin" }),
  ];

  const stats = summarizeAudit(entries);
  assert.equal(stats.total, 5);
  assert.equal(stats.errorCount, 2);
  assert.equal(stats.scanFailures, 1);
  assert.equal(stats.sendFailures, 1);
  assert.equal(stats.skippedEvents, 1);
  assert.equal(stats.cappedDrops, 0);
  assert.equal(stats.firstAt, new Date(1).toISOString());
  assert.equal(stats.lastAt, new Date(5).toISOString());
  assert.equal(stats.lastError.kind, "send_failed");
});

test("summarizeAudit on an empty window is all zeros and null boundaries", () => {
  const stats = summarizeAudit([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.errorCount, 0);
  assert.equal(stats.lastError, null);
  assert.equal(stats.firstAt, null);
  assert.equal(stats.lastAt, null);
  assert.deepEqual(stats.byKind, []);
});

test("renderAuditLine never leaks a secret passed back in detail", () => {
  const token = `bot123456:${"A".repeat(40)}`;
  const line = renderAuditLine(auditEntry("send_failed", { at: 0, detail: `boom ${token}` }));
  assert.ok(!line.includes("A".repeat(40)));
  assert.match(line, /^\d{4}-\d{2}-\d{2}T.* \[send_failed\]/);
});

test("renderAuditReport empty state names the file and is actionable", () => {
  const text = renderAuditReport({
    file: "data/audit.jsonl",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [],
    droppedFromReport: 0,
    unreadableLines: 0,
  });
  assert.ok(text.includes("data/audit.jsonl"));
  assert.ok(text.includes("No entries"));
});

test("renderAuditReport shows counts, last error and a bounded tail", () => {
  const entries = [
    auditEntry("boot", { at: 1, detail: "start" }),
    auditEntry("cycle_failed", { at: 2, source: "market", detail: "down" }),
    auditEntry("cycle_recovered", { at: 3, source: "market" }),
    auditEntry("send_failed", { at: 4, source: "squad", detail: "429" }),
    auditEntry("cap_reached", { at: 5, source: "squad", detail: "burst" }),
  ];
  const text = renderAuditReport(
    {
      file: "data/audit.jsonl",
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries,
      droppedFromReport: 7,
      unreadableLines: 2,
    },
    { tail: 3 },
  );

  assert.ok(text.includes("scan failures: 1"));
  assert.ok(text.includes("send failures: 1"));
  assert.ok(text.includes("cap drops: 1"));
  assert.ok(text.includes("7 older not shown"));
  assert.ok(text.includes("2 unreadable skipped"));
  assert.ok(text.includes("Last error:"));
  const recentLines = text.split("\n").filter((l) => l.includes("["));
  assert.ok(recentLines.length >= 3);
  assert.ok(text.includes("[cap_reached]"), "tail keeps the most recent entries");
  assert.ok(!text.includes("[cycle_failed]"), "older entries fall out of a short tail");
});

test("report renders recoveries and stale-cursor advisories with source context", () => {
  const entries = [
    auditEntry("stale_cursor", { at: 10, source: "market", detail: "cursor below retained floor 100" }),
    auditEntry("cycle_recovered", { at: 11, source: "market" }),
  ];
  const text = renderAuditReport({
    file: "a.jsonl",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries,
    droppedFromReport: 0,
    unreadableLines: 0,
  });
  assert.ok(text.includes("[stale_cursor] market:"));
  assert.ok(text.includes("[cycle_recovered] market:"));
});
