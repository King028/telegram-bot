import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { formatProvenanceSummary } from "../dist/config.js";
import { MOCK_BOT_TOKEN, MOCK_CHAT_ID } from "../dist/stellar/mock-constants.js";

const run = promisify(execFile);
const dist = (name) => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
const DIST_CONFIG = new URL("../dist/config.js", import.meta.url).href;
const DIST_INDEX = dist("index.js");

const CANARY_TOKEN = "123456789:CANARY-TOKEN-MUST-NEVER-LEAK";
const CANARY_CHAT = "-1009999999999";
const FILE_TOKEN = "123456789:CANARY-FILE-TOKEN-MUST-NEVER-LEAK";

/**
 * Config provenance tests.
 *
 * Where a value came from is decided once, at import: the loader sees the
 * environment as it was before the `.env` merge, and the file discovery depends
 * on the working directory. Both are impossible to re-create inside a process
 * that has already imported the module, so every case here runs the real loader
 * in a child process with a directory and an environment it fully controls —
 * including the cases where a developer's own `.env` would change the answer.
 */
async function provenanceFrom({ files = {}, env = {}, args = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-provenance-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents);
    }

    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import(process.argv[1]);" +
          "process.stdout.write(JSON.stringify(m.configProvenance()));",
        DIST_CONFIG,
        ...args,
      ],
      {
        cwd: dir,
        // Minimal environment: nothing from the developer's shell can decide a
        // source, so a failing assertion is the code's fault and not theirs.
        env: { PATH: process.env.PATH, ...env },
        timeout: 30_000,
      },
    );

    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const REQUIRED = {
  MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  BOT_TOKEN: CANARY_TOKEN,
  TELEGRAM_CHAT_ID: CANARY_CHAT,
};

const ENV_FILE_BODY = Object.entries(REQUIRED)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n")
  .concat("\n");

function entry(provenance, key) {
  const found = provenance.entries.find((e) => e.key === key);
  assert.ok(found, `${key} must be reported`);
  return found;
}

/** No value may ever appear in a report, whatever its source. */
function assertNoValues(provenance, ...values) {
  const blob = JSON.stringify(provenance);
  for (const value of values) {
    assert.equal(blob.includes(value), false, `a report must never contain ${value.slice(0, 12)}…`);
  }
}

test("an env file supplies keys, and is reported as their source", async () => {
  const provenance = await provenanceFrom({ files: { ".env": ENV_FILE_BODY }, env: {} });

  assert.equal(provenance.envFile.present, true);
  assert.ok(provenance.envFile.suppliedKeys >= 4);
  assert.equal(entry(provenance, "BOT_TOKEN").source, "env-file");
  assert.equal(entry(provenance, "MARKET_CONTRACT_ID").source, "env-file");
  assert.equal(provenance.profile, null);
  assertNoValues(provenance, CANARY_TOKEN, CANARY_CHAT);
});

test("the real environment wins a tie and is reported as the source", async () => {
  const provenance = await provenanceFrom({
    files: { ".env": `BOT_TOKEN=${FILE_TOKEN}\n` },
    env: { ...REQUIRED, BOT_TOKEN: CANARY_TOKEN },
  });

  // dotenv does not overwrite what is already set, so the value in effect is
  // the environment's — and the report must say so rather than blaming the file.
  assert.equal(entry(provenance, "BOT_TOKEN").source, "process-env");
  assertNoValues(provenance, CANARY_TOKEN, FILE_TOKEN);
});

test("with no env file, keys are attributed to the process environment", async () => {
  const provenance = await provenanceFrom({ env: REQUIRED });

  assert.equal(provenance.envFile.present, false);
  assert.equal(provenance.envFile.suppliedKeys, 0);
  assert.equal(entry(provenance, "BOT_TOKEN").source, "process-env");
  assert.equal(entry(provenance, "TELEGRAM_CHAT_ID").source, "process-env");
  assertNoValues(provenance, CANARY_TOKEN, CANARY_CHAT);
});

test("an unset key is reported by the fallback that actually supplies it", async () => {
  const provenance = await provenanceFrom({ env: REQUIRED });

  assert.equal(entry(provenance, "HEALTH_STALE_MS").source, "built-in-default");
  assert.equal(entry(provenance, "SHUTDOWN_TIMEOUT_MS").source, "built-in-default");
  // Optional by design: absent means "no restriction", not "misconfigured".
  assert.equal(entry(provenance, "ALLOWED_CHAT_IDS").source, "unset");
  assert.equal(entry(provenance, "OPERATOR_TELEGRAM_USER_ID").source, "unset");
  // Per-contract destinations inherit the single chat id when they are absent.
  const market = entry(provenance, "TELEGRAM_MARKET_CHAT_ID");
  assert.equal(market.source, "derived");
  assert.equal(market.derivedFrom, "TELEGRAM_CHAT_ID");
  assertNoValues(provenance, CANARY_CHAT);
});

test("HEALTH_PORT reports the platform PORT it inherited, not the default", async () => {
  const inherited = await provenanceFrom({ env: { ...REQUIRED, PORT: "4567" } });
  assert.equal(entry(inherited, "HEALTH_PORT").source, "derived");
  assert.equal(entry(inherited, "HEALTH_PORT").derivedFrom, "PORT");

  // An unusable PORT is exactly when `defaultHealthPort()` refuses it too.
  const ignored = await provenanceFrom({ env: { ...REQUIRED, PORT: "not-a-port" } });
  assert.equal(entry(ignored, "HEALTH_PORT").source, "built-in-default");
});

test("every setting is reported exactly once and counted once", async () => {
  const provenance = await provenanceFrom({ env: REQUIRED });

  const keys = provenance.entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate keys");
  assert.ok(keys.includes("BOT_TOKEN"));
  assert.ok(keys.includes("CHANNEL_PREVIEW_MODE"));

  const counted = Object.values(provenance.counts).reduce((sum, n) => sum + n, 0);
  assert.equal(counted, provenance.entries.length, "counts must account for every entry");

  for (const source of Object.keys(provenance.counts)) {
    const actual = provenance.entries.filter((e) => e.source === source).length;
    assert.equal(provenance.counts[source], actual, `${source} count must match its entries`);
  }
});

test("secrets are marked as secrets, and public settings are not", async () => {
  const provenance = await provenanceFrom({ env: REQUIRED });

  for (const key of [
    "BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_MARKET_CHAT_ID",
    "TELEGRAM_SQUAD_CHAT_ID",
    "ALLOWED_CHAT_IDS",
    "OPERATOR_TELEGRAM_USER_ID",
  ]) {
    assert.equal(entry(provenance, key).secret, true, `${key} must be flagged secret`);
  }

  // A contract id and a cursor path are public; flagging them would make the
  // flag meaningless.
  assert.equal(entry(provenance, "MARKET_CONTRACT_ID").secret, false);
  assert.equal(entry(provenance, "CURSOR_FILE").secret, false);
});

test("the mock profile is reported, and nothing from it leaks", async () => {
  const provenance = await provenanceFrom({ env: { MIMIR_PROFILE: "mock", HEALTH_PORT: "0" } });

  assert.equal(provenance.profile, "mock");
  assert.equal(entry(provenance, "BOT_TOKEN").source, "profile-default");
  assert.equal(entry(provenance, "MARKET_CONTRACT_ID").source, "profile-default");
  assert.ok(
    provenance.warnings.some((w) => w.includes("MIMIR_PROFILE=mock")),
    "a deployment left on the mock profile must be warned about",
  );
  assertNoValues(provenance, MOCK_BOT_TOKEN, MOCK_CHAT_ID);
});

test("a variable that is set but empty is reported instead of silently ignored", async () => {
  const provenance = await provenanceFrom({
    files: { ".env": `BOT_TOKEN=\nHEALTH_STALE_MS=\n` },
    // No BOT_TOKEN here: the file declares it and leaves it empty, which is the
    // case an operator reads as "configured" while the process sees nothing.
    env: {
      MARKET_CONTRACT_ID: REQUIRED.MARKET_CONTRACT_ID,
      SQUAD_CONTRACT_ID: REQUIRED.SQUAD_CONTRACT_ID,
      TELEGRAM_CHAT_ID: CANARY_CHAT,
    },
  });

  const token = entry(provenance, "BOT_TOKEN");
  assert.equal(token.emptyDeclaration, true);
  assert.equal(token.source, "unset");
  assert.equal(entry(provenance, "HEALTH_STALE_MS").emptyDeclaration, true);
  assert.equal(entry(provenance, "HEALTH_STALE_MS").source, "built-in-default");
  assert.ok(
    provenance.warnings.some((w) => w.includes("BOT_TOKEN is set but empty")),
    "an empty declaration must be named",
  );
  assertNoValues(provenance, CANARY_TOKEN, CANARY_CHAT);
});

test("an env file that supplies nothing is called out", async () => {
  const provenance = await provenanceFrom({
    files: { ".env": "# everything is exported by the platform\n" },
    env: REQUIRED,
  });

  assert.equal(provenance.envFile.present, true);
  assert.equal(provenance.envFile.suppliedKeys, 0);
  assert.ok(
    provenance.warnings.some((w) => w.includes("supplies none of these settings")),
    "a .env the process never uses is a working-directory bug worth naming",
  );
});

test("an unknown profile warns instead of throwing, and still reports", async () => {
  const provenance = await provenanceFrom({ env: { ...REQUIRED, MIMIR_PROFILE: "staging" } });

  assert.equal(provenance.profile, "staging");
  assert.equal(entry(provenance, "BOT_TOKEN").source, "process-env");
  assert.ok(
    provenance.warnings.some((w) => w.includes("not a known profile")),
    "the profile typo must be explained",
  );
  assertNoValues(provenance, CANARY_TOKEN, CANARY_CHAT);
});

test("the boot summary line is value-free and names the profile and sources", async () => {
  const provenance = await provenanceFrom({ files: { ".env": ENV_FILE_BODY }, env: {} });
  const line = formatProvenanceSummary(provenance);

  assert.match(line, /^profile=none env-file=present\(\d+ keys\) /);
  assert.match(line, /env-file=\d+/);
  assert.match(line, / built-in-default=\d+/);
  assert.match(line, /secret-keys=\d+\/\d+/);
  // `/status` renders this line inside a MarkdownV2 code span without escaping
  // it, so the character set is part of the contract, not an accident.
  assert.match(line, /^[A-Za-z0-9=(). _/-]+$/, "the summary must stay MarkdownV2-inert");

  for (const value of [CANARY_TOKEN, CANARY_CHAT]) {
    assert.equal(line.includes(value), false, "the summary must never carry a value");
  }
});

test("the summary reports a profile with no env file", async () => {
  const provenance = await provenanceFrom({ env: { MIMIR_PROFILE: "mock", HEALTH_PORT: "0" } });
  const line = formatProvenanceSummary(provenance);

  assert.match(line, /^profile=mock env-file=absent /);
  assert.match(line, /profile-default=\d+/);
  assert.equal(line.includes(MOCK_BOT_TOKEN), false);
});

test("a real boot logs where config came from and never a value", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-provenance-boot-"));
  try {
    // Mock profile: every credential is a known placeholder, so the token and
    // chat id are searchable in the output. The RPC is not running, so boot
    // fails right after the config lines are printed — which is the point: the
    // diagnostic must already be on the log when startup dies.
    const result = await run(
      process.execPath,
      [DIST_INDEX],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, MIMIR_PROFILE: "mock", HEALTH_PORT: "0" },
        timeout: 30_000,
      },
    ).then(
      (ok) => ok,
      (err) => err,
    );

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, /\[boot\] config\s+profile=mock env-file=absent /);
    assert.match(output, /\[boot\] config\s+MIMIR_PROFILE=mock: \d+ setting\(s\) come from the mock profile/);

    for (const secret of [MOCK_BOT_TOKEN, MOCK_CHAT_ID]) {
      assert.equal(
        output.includes(secret),
        false,
        "a boot log must never contain a value, even a placeholder one",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
