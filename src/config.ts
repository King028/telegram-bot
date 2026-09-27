/**
 * Environment loading and validation.
 *
 * Fails fast and LOUDLY: a notifier that boots with a missing chat id or a
 * typo'd contract id looks healthy while silently notifying nobody, which is
 * worse than not starting. Every problem found is collected and reported in one
 * error rather than one-at-a-time across restarts.
 *
 * Split into two loaders on purpose:
 *   - {@link loadStellarConfig} needs no Telegram credentials, so the chain
 *     reader (`src/stellar/events.ts`) can be run standalone against Testnet.
 *   - {@link loadConfig} is the full bot config.
 *
 * ── Profiles ─────────────────────────────────────────────────────────────────
 *
 * `MIMIR_PROFILE=mock` selects the local Soroban mock profile: it supplies
 * defaults for values the environment does NOT set (loopback RPC, fixture
 * contract ids, an isolated cursor file, placeholder credentials). Explicit
 * environment variables always win, so a profile can never change an existing
 * deployment's configuration. Any other profile name fails fast.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 *
 * {@link configProvenance} reports which source supplied each setting — the
 * environment, the `.env` file, the active profile, a built-in default, or
 * another setting. It reports names and origins only: a value, secret or not,
 * never enters the result, so it is safe in boot logs and in `/health`. The
 * `.env` file is loaded here rather than by `dotenv/config` for exactly that
 * reason: the loader has to see the environment *before* the merge to tell a
 * value the machine provided from one the file provided.
 */

import path from "node:path";

import { config as loadDotenv, type DotenvConfigOptions } from "dotenv";

import {
  MOCK_BOT_TOKEN,
  MOCK_CHAT_ID,
  MOCK_CURSOR_FILE,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_PROFILE_NAME,
  MOCK_RPC_DEFAULT_PORT,
  MOCK_SQUAD_CONTRACT_ID,
} from "./stellar/mock-constants.js";

import {
  parseNotificationFeatureFlags,
  type NotificationFeatureFlags,
} from "./notifications/featureFlags.js";
/**
 * The environment as it was before the `.env` file was merged in.
 *
 * dotenv never overwrites a variable that is already set (unless
 * `DOTENV_CONFIG_OVERRIDE` asks it to), so this snapshot is what separates a
 * value the machine supplied from one the file supplied, without ever comparing
 * the values themselves.
 */
const ENV_BEFORE_FILE = new Set(Object.keys(process.env));

/** What the `.env` file declared, captured once at import. Names only. */
const ENV_FILE = loadEnvFile();

interface EnvFileState {
  /** True when a `.env` file was found and parsed. */
  present: boolean;
  /** Every name the file declares, including the ones it leaves empty. */
  declared: ReadonlySet<string>;
  /** Names whose effective value the file supplied (it can lose a tie). */
  supplied: ReadonlySet<string>;
}

function dotenvConfigOptions(): DotenvConfigOptions {
  // `dotenv/config` is no longer the loader: this module loads the file so it
  // can record where each value came from. Honour the same DOTENV_CONFIG_*
  // variables the CLI loader honours, so existing deployments are unaffected.
  const options: DotenvConfigOptions = {};
  const file = process.env.DOTENV_CONFIG_PATH;
  if (file !== undefined && file.trim() !== "") {
    options.path = path.resolve(process.cwd(), file.trim());
  }
  const encoding = process.env.DOTENV_CONFIG_ENCODING;
  if (encoding !== undefined && encoding.trim() !== "") options.encoding = encoding;
  options.override = process.env.DOTENV_CONFIG_OVERRIDE === "true";
  options.debug = process.env.DOTENV_CONFIG_DEBUG === "true";
  return options;
}

/**
 * Loads `.env` and records which names it supplied. Only the parsed output's
 * *keys* are kept — the values themselves are dropped on the floor here, which
 * is what makes every provenance report below safe to publish.
 */
function loadEnvFile(): EnvFileState {
  try {
    const options = dotenvConfigOptions();
    const result = loadDotenv(options);
    const declared = new Set(Object.keys(result.parsed ?? {}));
    const supplied = new Set(
      [...declared].filter((key) => options.override === true || !ENV_BEFORE_FILE.has(key)),
    );
    // dotenv always returns `parsed` (an empty object when the file is missing)
    // and reports a missing file through `error`, so that is the presence test.
    return { present: result.error === undefined, declared, supplied };
  } catch {
    // An unreadable file is not an error: `read()` already falls back to the
    // real environment, the active profile, then the built-in defaults.
    return { present: false, declared: new Set(), supplied: new Set() };
  }
}

export interface StellarConfig {
  marketContractId: string;
  squadContractId: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  /** Optional override for stellar.expert (or compatible) explorer origin. */
  explorerBaseUrl: string;
}

export interface BotConfig extends StellarConfig {
  botToken: string;
  chatId: string;
  /** Optional per-contract destinations; absent values use `chatId`. */
  marketChatId?: string;
  squadChatId?: string;
  /** Chats allowed to use /status. Empty array means no restriction. */
  allowedChatIds: string[];
  /** Telegram user id allowed to run operator-only commands. Null disables them. */
  operatorTelegramUserId: string | null;
  pollIntervalMs: number;
  startLookbackLedgers: number;
  cursorFile: string;
  /** Exclusive lock so only one process owns the cursor. */
  lockFile: string;
  statusFile: string;
  maxNotificationsPerCycle: number;
  /** Coarse notification feature flags (see NOTIFY_* env vars). */
  featureFlags: NotificationFeatureFlags;
  /** Append-only JSONL audit trail (see src/audit.ts). Empty disables it. */
  auditFile: string;
  /**
   * Number of recent event ids retained per contract to suppress redelivery
   * across overlapping pages, resumed cursors, and restarts. `0` disables it.
   */
  dedupWindow: number;
  /** Loopback host for the local HTTP health endpoint. */
  healthHost: string;
  /** TCP port for the health endpoint. `0` disables the listener. */
  healthPort: number;
  /**
   * After the first successful poll, treat the process as degraded if no
   * successful cycle lands within this window. `0` disables the stale check.
   */
  healthStaleMs: number;
  /**
   * Wall-clock budget for retrying the startup RPC `getHealth()` probe.
   * `0` means a single attempt with no retries.
   */
  startupHealthDeadlineMs: number;
  /**
   * Delay between failed startup RPC health attempts (capped by remaining
   * deadline). Ignored when `startupHealthDeadlineMs` is `0`.
   */
  startupHealthRetryMs: number;
  /**
   * How long a graceful shutdown waits for an in-flight cycle before flushing
   * cursor state and giving up on it. `0` skips the wait entirely.
   */
  shutdownTimeoutMs: number;
  /** When true, notifications sent to Telegram are formatted in preview mode. */
  channelPreviewMode: boolean;
}

/** Fallback drain budget when a config object predates `SHUTDOWN_TIMEOUT_MS`. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[], hint?: string) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\n${hint ?? "Copy .env.example to .env and fill in the missing values."}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULTS = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  pollIntervalMs: 30_000,
  minPollIntervalMs: 5_000,
  startLookbackLedgers: 60,
  cursorFile: "./data/cursor.json",
  lockFile: "./data/poller.lock",
  statusFile: "./data/status.json",
  maxNotificationsPerCycle: 20,
  auditFile: "./data/audit.jsonl",
  dedupWindow: 256,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  // 3× default poll interval — one missed cycle is fine; three is not.
  healthStaleMs: 90_000,
  // Retry RPC getHealth at boot for up to 30s (Testnet blips / deploy races).
  startupHealthDeadlineMs: 30_000,
  startupHealthRetryMs: 1_000,
  // Long enough for an in-flight read to finish and its cursors to land, short
  // enough that a deploy is never held open by a wedged RPC.
  shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  channelPreviewMode: false,
} as const;

/**
 * Platform deployers (Railway among them) inject a `PORT` variable and probe it
 * for the deploy healthcheck. When `HEALTH_PORT` is unset we fall back to it,
 * so the `/health` listener is reachable without a manual override. `PORT` is
 * not a default local dev value, so the loopback port still wins on a desktop.
 */
function defaultHealthPort(): number {
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0) return port;
  return DEFAULTS.healthPort;
}

/** Strkey for a contract: `C` + 55 base32 characters. */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/**
 * Defaults each profile supplies for values the environment leaves unset.
 * Profile values never override explicit environment variables.
 */
const PROFILE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [MOCK_PROFILE_NAME]: {
    MARKET_CONTRACT_ID: MOCK_MARKET_CONTRACT_ID,
    SQUAD_CONTRACT_ID: MOCK_SQUAD_CONTRACT_ID,
    STELLAR_RPC_URL: `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}`,
    STELLAR_HORIZON_URL: `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}/horizon`,
    STELLAR_NETWORK_PASSPHRASE: MOCK_NETWORK_PASSPHRASE,
    CURSOR_FILE: MOCK_CURSOR_FILE,
    BOT_TOKEN: MOCK_BOT_TOKEN,
    TELEGRAM_CHAT_ID: MOCK_CHAT_ID,
  },
};

/** The profile selected by `MIMIR_PROFILE`, or null when unset. Display/boot use. */
export function activeProfileName(): string | null {
  return read("MIMIR_PROFILE") ?? null;
}

/** Profile defaults for the active profile. Unknown names fail fast. */
function resolveProfileDefaults(): Record<string, string> {
  const name = read("MIMIR_PROFILE");
  if (name === undefined) return {};
  const defaults = PROFILE_DEFAULTS[name];
  if (!defaults) {
    throw new ConfigError(
      [`MIMIR_PROFILE must be "${MOCK_PROFILE_NAME}" when set; got "${name}"`],
      `Unset MIMIR_PROFILE, or set MIMIR_PROFILE=${MOCK_PROFILE_NAME} for the local mock.`,
    );
  }
  return { ...defaults };
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function collector(profile: Record<string, string>) {
  const problems: string[] = [];
  /** Environment first, then the active profile's defaults. */
  const get = (name: string): string | undefined => read(name) ?? profile[name];

  return {
    problems,

    get,

    required(name: string): string {
      const value = get(name);
      if (value === undefined) {
        problems.push(`${name} is required but not set`);
        return "";
      }
      return value;
    },

    contractId(name: string): string {
      const value = this.required(name);
      if (value !== "" && !CONTRACT_ID_RE.test(value)) {
        problems.push(
          `${name} is not a Soroban contract id (expected C… strkey, 56 chars); got "${value}"`,
        );
      }
      return value;
    },

    url(name: string, fallback: string): string {
      const value = get(name) ?? fallback;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          problems.push(`${name} must be an http(s) URL; got "${value}"`);
        }
      } catch {
        problems.push(`${name} is not a valid URL; got "${value}"`);
      }
      return value;
    },

    int(name: string, fallback: number, min: number): number {
      const raw = read(name);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        problems.push(`${name} must be an integer; got "${raw}"`);
        return fallback;
      }
      if (parsed < min) {
        problems.push(`${name} must be >= ${min}; got ${parsed}`);
        return fallback;
      }
      return parsed;
    },

    bool(name: string, fallback: boolean): boolean {
      const raw = read(name);
      if (raw === undefined) return fallback;
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return true;
      if (lower === "false" || lower === "0" || lower === "no") return false;
      problems.push(`${name} must be a boolean (true/false); got "${raw}"`);
      return fallback;
    },

    chatId(name: string): string {
      const value = this.required(name);
      // Telegram chat ids are integers (channels/supergroups are negative).
      // A @channelusername also works for public channels, so both are allowed.
      if (value !== "" && !/^-?\d+$/.test(value) && !/^@[A-Za-z0-9_]{4,}$/.test(value)) {
        problems.push(
          `${name} must be a numeric chat id (e.g. -1001234567890) or a @channelusername; got "${value}"`,
        );
      }
      return value;
    },

    optionalChatId(name: string, fallback: string): string {
      const value = read(name) ?? fallback;
      if (value === "") return value;
      if (!/^-?\d+$/.test(value) && !/^@[A-Za-z0-9_]{4,}$/.test(value)) {
        problems.push(
          `${name} must be a numeric chat id (e.g. -1001234567890) or a @channelusername; got "${value}"`,
        );
      }
      return value;
    },

    /**
     * Parses an optional comma-separated list of chat ids / @usernames.
     * Returns an empty array when the variable is absent or empty (= no
     * restriction). Each entry is validated with the same rules as chatId.
     */
    allowedChatIds(name: string): string[] {
      const raw = read(name);
      if (raw === undefined) return [];

      const entries = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const entry of entries) {
        if (!/^-?\d+$/.test(entry) && !/^@[A-Za-z0-9_]{4,}$/.test(entry)) {
          problems.push(
            `${name} contains an invalid entry "${entry}" — ` +
              `each value must be a numeric chat id or a @channelusername`,
          );
        }
      }

      return entries;
    },

    optionalUserId(name: string): string | null {
      const value = read(name);
      if (value === undefined) return null;
      if (!/^[1-9]\d*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
        problems.push(`${name} must be a positive Telegram user id; got "${value}"`);
        return null;
      }
      return value;
    },

    host(name: string, fallback: string): string {
      const value = read(name) ?? fallback;
      // Keep this a host, not a URL — the health server binds a TCP listener.
      if (/[\s/]/.test(value) || value.includes("://")) {
        problems.push(
          `${name} must be a hostname or IP (e.g. 127.0.0.1); got "${value}"`,
        );
      }
      return value;
    },
  };
}

function stellarFrom(c: ReturnType<typeof collector>): StellarConfig {
  return {
    marketContractId: c.contractId("MARKET_CONTRACT_ID"),
    squadContractId: c.contractId("SQUAD_CONTRACT_ID"),
    rpcUrl: c.url("STELLAR_RPC_URL", DEFAULTS.rpcUrl),
    horizonUrl: c.url("STELLAR_HORIZON_URL", DEFAULTS.horizonUrl),
    networkPassphrase: c.get("STELLAR_NETWORK_PASSPHRASE") ?? DEFAULTS.networkPassphrase,
    explorerBaseUrl: c.url(
      "STELLAR_EXPLORER_BASE_URL",
      "https://stellar.expert/explorer",
    ),
  };
}

/** Chain-only config. No Telegram credentials required. */
export function loadStellarConfig(): StellarConfig {
  const c = collector(resolveProfileDefaults());
  const config = stellarFrom(c);
  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return config;
}

/**
 * Resolve just the status snapshot path. Used by `--status`, which must work
 * without BOT_TOKEN: reading a status file is a read-only operation and should
 * not require the credentials of the process that wrote it.
 */
export function resolveStatusFile(): string {
  return path.resolve(process.cwd(), read("STATUS_FILE") ?? DEFAULTS.statusFile);
}

/** Full bot config: chain + Telegram + poller tuning. */
export function loadConfig(): BotConfig {
  const c = collector(resolveProfileDefaults());
  const stellar = stellarFrom(c);

  const featureFlagsParsed = parseNotificationFeatureFlags({
    NOTIFY_ENABLED: read("NOTIFY_ENABLED"),
    NOTIFY_MARKET: read("NOTIFY_MARKET"),
    NOTIFY_SQUAD: read("NOTIFY_SQUAD"),
  });
  for (const problem of featureFlagsParsed.problems) c.problems.push(problem);

  const config: BotConfig = {
    ...stellar,
    botToken: c.required("BOT_TOKEN"),
    chatId: c.chatId("TELEGRAM_CHAT_ID"),
    marketChatId: c.optionalChatId("TELEGRAM_MARKET_CHAT_ID", c.get("TELEGRAM_CHAT_ID") ?? ""),
    squadChatId: c.optionalChatId("TELEGRAM_SQUAD_CHAT_ID", c.get("TELEGRAM_CHAT_ID") ?? ""),
    allowedChatIds: c.allowedChatIds("ALLOWED_CHAT_IDS"),
    operatorTelegramUserId: c.optionalUserId("OPERATOR_TELEGRAM_USER_ID"),
    pollIntervalMs: c.int("POLL_INTERVAL_MS", DEFAULTS.pollIntervalMs, DEFAULTS.minPollIntervalMs),
    startLookbackLedgers: c.int("START_LOOKBACK_LEDGERS", DEFAULTS.startLookbackLedgers, 0),
    cursorFile: path.resolve(process.cwd(), c.get("CURSOR_FILE") ?? DEFAULTS.cursorFile),
    lockFile: path.resolve(process.cwd(), read("INSTANCE_LOCK_FILE") ?? DEFAULTS.lockFile),
    statusFile: path.resolve(process.cwd(), c.get("STATUS_FILE") ?? DEFAULTS.statusFile),
    maxNotificationsPerCycle: c.int(
      "MAX_NOTIFICATIONS_PER_CYCLE",
      DEFAULTS.maxNotificationsPerCycle,
      1,
    ),
    featureFlags: featureFlagsParsed.flags,
    // Resolved like the cursor file: relative paths anchor to the process cwd.
    auditFile: path.resolve(process.cwd(), read("AUDIT_FILE") ?? DEFAULTS.auditFile),
    // 0 is the documented escape hatch: no redelivery suppression.
    dedupWindow: c.int("EVENT_DEDUP_WINDOW", DEFAULTS.dedupWindow, 0),
    healthHost: c.host("HEALTH_HOST", DEFAULTS.healthHost),
    // Port 0 is the explicit disable switch (min 0).
    healthPort: c.int("HEALTH_PORT", defaultHealthPort(), 0),
    healthStaleMs: c.int("HEALTH_STALE_MS", DEFAULTS.healthStaleMs, 0),
    // 0 = single attempt (no retries) for the startup RPC probe.
    startupHealthDeadlineMs: c.int(
      "STARTUP_HEALTH_DEADLINE_MS",
      DEFAULTS.startupHealthDeadlineMs,
      0,
    ),
    startupHealthRetryMs: c.int(
      "STARTUP_HEALTH_RETRY_MS",
      DEFAULTS.startupHealthRetryMs,
      0,
    ),
    shutdownTimeoutMs: c.int("SHUTDOWN_TIMEOUT_MS", DEFAULTS.shutdownTimeoutMs, 0),
    channelPreviewMode: c.bool("CHANNEL_PREVIEW_MODE", DEFAULTS.channelPreviewMode),
  };

  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return config;
}

/** `mock` / `testnet` / `public` / `unknown`, derived from the passphrase. Display only. */
export function networkLabel(config: StellarConfig): string {
  if (config.networkPassphrase === MOCK_NETWORK_PASSPHRASE) return "mock";
  if (config.networkPassphrase === "Test SDF Network ; September 2015") return "testnet";
  if (config.networkPassphrase === "Public Global Stellar Network ; September 2015") return "public";
  return "custom";
}

/* ── Configuration provenance ────────────────────────────────────────────────
 *
 * "The bot is configured" and "the bot is configured the way I think it is" are
 * different claims. A placeholder token inherited from a profile, a `.env` the
 * process never found because it was started from another directory, or a
 * variable someone exported empty all look identical from the outside. These
 * reports answer *where a value came from* — never *what it is* — so a boot log
 * or a `/health` response can be pasted into a ticket or a chat safely.
 */

/** Where the value in effect for a setting came from. */
export type ConfigSource =
  | "process-env"
  | "env-file"
  | "profile-default"
  | "built-in-default"
  | "derived"
  | "unset";

/** One setting's origin. Deliberately value-free, including for secrets. */
export interface ConfigKeyProvenance {
  /** The variable name, e.g. `BOT_TOKEN`. A name is not a value. */
  key: string;
  source: ConfigSource;
  /** True when the value must never be printed, logged, or sent anywhere. */
  secret: boolean;
  /** The setting this one inherited from when `source` is `derived`. */
  derivedFrom?: string;
  /**
   * The variable is set (by the file or the shell) but empty, so a fallback
   * won. Usually a typo, and the reason a deployed value looks "ignored".
   */
  emptyDeclaration?: boolean;
}

/** Where the whole configuration came from. Safe to log and to serve. */
export interface ConfigProvenance {
  /** Active `MIMIR_PROFILE`, or null when unset. */
  profile: string | null;
  envFile: {
    present: boolean;
    /** Known settings whose effective value the file supplied. */
    suppliedKeys: number;
  };
  /** Every setting this module reads, in a stable order. */
  entries: ConfigKeyProvenance[];
  /** How many settings each source supplied. */
  counts: Record<ConfigSource, number>;
  /** Actionable, value-free notes for boot logs and health checks. */
  warnings: string[];
}

interface ConfigKeySpec {
  key: string;
  /** The value must never reach a log line, a health response, or an error. */
  secret: boolean;
  /** `DEFAULTS` supplies a value when nothing else does. */
  hasBuiltInDefault?: boolean;
  /** Another setting supplies this one's value while it is unset. */
  derivedFrom?: { key: string; applies?: (value: string) => boolean };
}

/**
 * Every variable `loadConfig` / `loadStellarConfig` reads, and nothing else: a
 * report that lists keys the process never reads would be noise, and one that
 * omits a key it does read would be a lie.
 */
const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  { key: "MIMIR_PROFILE", secret: false },
  { key: "MARKET_CONTRACT_ID", secret: false },
  { key: "SQUAD_CONTRACT_ID", secret: false },
  { key: "STELLAR_RPC_URL", secret: false, hasBuiltInDefault: true },
  { key: "STELLAR_HORIZON_URL", secret: false, hasBuiltInDefault: true },
  { key: "STELLAR_NETWORK_PASSPHRASE", secret: false, hasBuiltInDefault: true },
  { key: "STELLAR_EXPLORER_BASE_URL", secret: false, hasBuiltInDefault: true },
  // Credentials and destinations: identifiers for a Telegram account, so they
  // are treated as secrets here even though a contract id is public.
  { key: "BOT_TOKEN", secret: true },
  { key: "TELEGRAM_CHAT_ID", secret: true },
  { key: "TELEGRAM_MARKET_CHAT_ID", secret: true, derivedFrom: { key: "TELEGRAM_CHAT_ID" } },
  { key: "TELEGRAM_SQUAD_CHAT_ID", secret: true, derivedFrom: { key: "TELEGRAM_CHAT_ID" } },
  { key: "ALLOWED_CHAT_IDS", secret: true },
  { key: "OPERATOR_TELEGRAM_USER_ID", secret: true },
  { key: "POLL_INTERVAL_MS", secret: false, hasBuiltInDefault: true },
  { key: "START_LOOKBACK_LEDGERS", secret: false, hasBuiltInDefault: true },
  { key: "CURSOR_FILE", secret: false, hasBuiltInDefault: true },
  { key: "INSTANCE_LOCK_FILE", secret: false, hasBuiltInDefault: true },
  { key: "STATUS_FILE", secret: false, hasBuiltInDefault: true },
  { key: "MAX_NOTIFICATIONS_PER_CYCLE", secret: false, hasBuiltInDefault: true },
  { key: "AUDIT_FILE", secret: false, hasBuiltInDefault: true },
  { key: "EVENT_DEDUP_WINDOW", secret: false, hasBuiltInDefault: true },
  { key: "HEALTH_HOST", secret: false, hasBuiltInDefault: true },
  {
    key: "HEALTH_PORT",
    secret: false,
    hasBuiltInDefault: true,
    // Matches `defaultHealthPort()`: a usable platform PORT wins, and only a
    // non-positive or non-integer one falls through to the built-in 8787.
    derivedFrom: {
      key: "PORT",
      applies: (value) => {
        const port = Number(value);
        return Number.isInteger(port) && port > 0;
      },
    },
  },
  { key: "HEALTH_STALE_MS", secret: false, hasBuiltInDefault: true },
  { key: "SHUTDOWN_TIMEOUT_MS", secret: false, hasBuiltInDefault: true },
  { key: "CHANNEL_PREVIEW_MODE", secret: false, hasBuiltInDefault: true },
  // Injected by a platform, never set by an operator: read only as the
  // HEALTH_PORT fallback, so it is reported for the same reason.
  { key: "PORT", secret: false },
];

/** Report order for counts, so two runs of the same config read identically. */
const SOURCE_ORDER: readonly ConfigSource[] = [
  "process-env",
  "env-file",
  "profile-default",
  "built-in-default",
  "derived",
  "unset",
];

function classifyKey(
  spec: ConfigKeySpec,
  profileDefaults: Record<string, string>,
): ConfigKeyProvenance {
  /** What a setting resolves to, wherever it comes from. */
  const resolved = (key: string): string | undefined => read(key) ?? profileDefaults[key];

  if (read(spec.key) !== undefined) {
    // A value won. Which side supplied it is the whole question: the file
    // writes into process.env, so only the captured `supplied` set can tell.
    return {
      key: spec.key,
      source: ENV_FILE.supplied.has(spec.key) ? "env-file" : "process-env",
      secret: spec.secret,
    };
  }

  const entry: ConfigKeyProvenance = { key: spec.key, source: "unset", secret: spec.secret };
  // Set but blank: declared by the file, or exported empty by the shell. Marking
  // it is what turns "why is my value ignored" into a one-line answer.
  if (process.env[spec.key] !== undefined || ENV_FILE.declared.has(spec.key)) {
    entry.emptyDeclaration = true;
  }

  if (profileDefaults[spec.key] !== undefined) {
    entry.source = "profile-default";
    return entry;
  }

  const derived = spec.derivedFrom;
  if (derived !== undefined) {
    const source = resolved(derived.key);
    if (source !== undefined && (derived.applies?.(source) ?? true)) {
      entry.source = "derived";
      entry.derivedFrom = derived.key;
      return entry;
    }
  }

  if (spec.hasBuiltInDefault === true) entry.source = "built-in-default";
  return entry;
}

function describeSource(entry: ConfigKeyProvenance): string {
  switch (entry.source) {
    case "process-env":
      return "the environment";
    case "env-file":
      return "the .env file";
    case "profile-default":
      return "the active profile";
    case "built-in-default":
      return "the built-in default";
    case "derived":
      return `${entry.derivedFrom} (inherited)`;
    default:
      return "nothing";
  }
}

/**
 * Where every known setting's value came from: names and origins only, never a
 * value — not even for a setting that is not a secret. Cheap and side-effect
 * free, so boot logging and `/health` can both call it.
 */
export function configProvenance(): ConfigProvenance {
  const profile = activeProfileName();
  const warnings: string[] = [];

  let profileDefaults: Record<string, string> = {};
  try {
    profileDefaults = resolveProfileDefaults();
  } catch {
    // An unknown profile fails boot, but a running process asking for a health
    // report must still get one instead of an exception.
    warnings.push(
      `MIMIR_PROFILE=${profile ?? "(unset)"} is not a known profile; no profile defaults apply`,
    );
  }

  const entries = CONFIG_KEYS.map((spec) => classifyKey(spec, profileDefaults));

  const counts = Object.fromEntries(SOURCE_ORDER.map((source) => [source, 0])) as Record<
    ConfigSource,
    number
  >;
  for (const entry of entries) counts[entry.source] += 1;

  const suppliedKeys = entries.filter((entry) => entry.source === "env-file").length;
  if (ENV_FILE.present && suppliedKeys === 0) {
    // The classic deployment bug: the file exists, the process starts somewhere
    // else, and every value silently comes from defaults.
    warnings.push(
      ".env was read but supplies none of these settings — check the working directory",
    );
  }

  for (const entry of entries) {
    if (entry.emptyDeclaration === true) {
      warnings.push(
        `${entry.key} is set but empty; ${describeSource(entry)} supplies the value`,
      );
    }
  }

  if (profile === MOCK_PROFILE_NAME) {
    const fromProfile = counts["profile-default"];
    warnings.push(
      `MIMIR_PROFILE=${MOCK_PROFILE_NAME}: ${fromProfile} setting(s) come from the mock profile`,
    );
  }

  return {
    profile,
    envFile: { present: ENV_FILE.present, suppliedKeys },
    entries,
    counts,
    warnings,
  };
}

/**
 * One value-free line for boot logs: the profile, whether the `.env` file was
 * read at all, and how many settings each source supplied.
 */
export function formatProvenanceSummary(provenance: ConfigProvenance): string {
  const counts = SOURCE_ORDER.filter((source) => provenance.counts[source] > 0).map(
    (source) => `${source}=${provenance.counts[source]}`,
  );
  const secrets = provenance.entries.filter((entry) => entry.secret).length;
  const file = provenance.envFile.present
    ? `present(${provenance.envFile.suppliedKeys} keys)`
    : "absent";
  // `secret-keys=6/26` is a property of the report, not of the values: it says
  // six of the settings named here are sensitive and are still reported as
  // origins only. No character in this line is MarkdownV2-reserved, which is
  // what lets `/status` put it in a code span unescaped.
  return (
    `profile=${provenance.profile ?? "none"} env-file=${file} ${counts.join(" ")} ` +
    `secret-keys=${secrets}/${provenance.entries.length}`
  );
}
