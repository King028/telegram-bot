/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers public status and contract
 * commands plus operator pause/resume controls. Operator controls only change
 * when the next polling cycle starts; they never edit cursors or touch chain
 * state. All chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import { escapeMd, previewMessage, safeErrorMessage, type ExplorerKeyboard } from "./notifications/format.js";
import { formatFeatureFlags } from "./notifications/featureFlags.js";
export { previewMessage } from "./notifications/format.js";
import { formatProvenanceSummary, networkLabel, type BotConfig } from "./config.js";
import { contractExplorerUrl } from "./stellar/client.js";
import type { ContractSource } from "./stellar/decode.js";
import { buildHealthReport, chainClockLabel } from "./health.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "./poller.js";
import {
  AUDIT_REPORT_MAX_ENTRIES,
  readAuditFile,
  renderAuditReport,
  type AuditFileSummary,
  type AuditLog,
} from "./audit.js";

const HELP_BASE = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/audit — the operator audit report, redacted and bounded (operator only)",
  "/contracts — the contract ids I watch and where to look them up",
  "/health — health assessment and operational readiness",
  "/preview — preview channel notification formatting",
  "/help — this message",
];

function helpMessage(config: BotConfig): string {
  if (config.operatorTelegramUserId === null) return HELP_BASE.join("\n");
  return [
    ...HELP_BASE.slice(0, -1),
    "/pause — operator only: pause scheduling new scans",
    "/resume — operator only: resume polling now",
    HELP_BASE.at(-1) as string,
  ].join("\n");
}

const TELEGRAM_OPTIONS = {
  parse_mode: "MarkdownV2" as const,
  link_preview_options: { is_disabled: true },
};

function ago(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

const AUDIT_COMMAND_HINT = "See `npm run audit -- --help` for the standalone report tool.";

/**
 * Render the audit report for Telegram. The report is plain text — audit lines
 * are arbitrary redacted strings and MarkdownV2 would mangle them — so nothing
 * here goes through MarkdownV2 escaping; this message is sent without a parse
 * mode. Bounded twice over: the file read is capped and only the tail renders.
 */
function renderAuditForTelegram(summary: AuditFileSummary, tail: number): string {
  const header = `*Audit* — ${summary.file}`;
  const report = renderAuditReport(summary, { tail });
  return `${header}\n\n${report}\n\n${AUDIT_COMMAND_HINT}`;
}

function cursorPreview(cursor: string | null): string {
  if (cursor === null) return "none (cold start)";
  const compact = cursor.replace(/\s+/g, " ").replace(/[`\\]/g, "?").trim() || "empty";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

function statusMessage(config: BotConfig, status: PollerStatus, nowMs: number = Date.now()): string {
  const lifecycle = status.stopping
    ? "stopping"
    : status.paused
      ? "paused"
      : status.running
        ? "running"
        : "stopped";

  const lines: string[] = [
    `*Status* — ${lifecycle} on Stellar ${networkLabel(config)}`,
    `Channel preview: ${config.channelPreviewMode ? "enabled" : "disabled"}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Chain clock skew: ${escapeMd(chainClockLabel(status.chainClockAt, nowMs))}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped}` +
      (status.notificationsDropped
        ? ` · dropped during shutdown ${status.notificationsDropped}`
        : ""),
    `Feature flags: ${escapeMd(formatFeatureFlags(config.featureFlags))}`,
    "",
    "*Watching*",
  ];

  // Only shown after an automatic recovery, so an ordinary /status is unchanged.
  if (status.cursorRewinds > 0) {
    lines.push(
      `Cursors rewound to the retained floor: ${status.cursorRewinds}`,
      "",
    );
  }

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${cursorPreview(target.cursor)}\``,
    );
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at, nowMs)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }

  if (status.stopping) {
    lines.push(
      "",
      "Graceful shutdown in progress: no new cycles, unsent notifications dropped" +
        (status.pendingFlush ? ", cursor flush still pending" : ", cursor flushed") +
        "\\.",
    );
  }

  return lines.join("\n");
}

/**
 * The `/contracts` message: which two contracts this bot watches, and where to
 * look each one up independently — deliberately static (config only, no
 * poller state), so it answers the same whether the poller is mid-cycle,
 * between restarts, or wedged on a run of RPC failures. `/status` is for
 * "is it working"; this is for "what is it even watching".
 */
export function healthMessage(
  config: BotConfig,
  status: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const report = buildHealthReport(config, status, nowMs);
  const statusLabel = report.status.toUpperCase();

  const lines: string[] = [
    `*Health* — ${escapeMd(statusLabel)} on Stellar ${networkLabel(config)}`,
    "",
    `Status: \`${report.status}\` \\(${report.ok ? "ok" : "action required"}\\)`,
    `Poller: ${report.poller.running ? "running" : "stopped"}`,
    `Uptime: ${report.uptimeMs > 0 ? ago(nowMs - report.uptimeMs, nowMs) : "0s"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Last successful poll: ${ago(status.lastSuccessAt, nowMs)}`,
    `Chain tip: ${report.poller.latestLedger ?? "unknown"}`,
    `Chain clock skew: ${escapeMd(chainClockLabel(status.chainClockAt, nowMs))}`,
    `Cycles: ${report.poller.cycles} · consecutive failures: ${report.poller.consecutiveFailures}`,
    `Notifications: sent ${report.poller.notificationsSent} · failed ${report.poller.notificationsFailed} · skipped ${report.poller.eventsSkipped}`,
    "",
    "*Watched Contracts*",
  ];

  for (const target of report.poller.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursorPreview ?? "none (cold start)"}\``,
    );
    if (target.cursorStale) {
      lines.push(
        target.rewindFromLedger === null
          ? "  ALERT: RPC rejected this cursor as stale; its position is unchanged"
          : `  ALERT: stale cursor recovery from ledger ${target.rewindFromLedger}`,
      );
    }
    if (target.hasError) {
      const targetState = status.targets.find((t) => t.source === target.source);
      if (targetState?.lastError) {
        lines.push(`  last error: ${escapeMd(targetState.lastError)}`);
      }
    }
  }

  if (report.poller.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError?.at ?? null, nowMs)}\\): ${escapeMd(report.poller.lastError.message)}`,
    );
  }

  // Origins, never values: an operator can confirm this process is reading the
  // intended .env / profile without a secret being typed into a chat. The
  // summary is interpolated into a code span unescaped on purpose — it is built
  // only from key names, source names, and counts (see config.ts), so it has no
  // MarkdownV2 reserved character to escape and stays copy-pasteable.
  lines.push("", `Config: \`${formatProvenanceSummary(report.config)}\``);
  if (report.config.warnings.length > 0) {
    lines.push(`Config notes: ${escapeMd(report.config.warnings.join("; "))}`);
  }

  return lines.join("\n");
}

export function contractsMessage(config: BotConfig): string {
  const targets: Array<{ label: string; contractId: string }> = [
    { label: "mimir\\-market", contractId: config.marketContractId },
    { label: "mimir\\-squad", contractId: config.squadContractId },
  ];

  const lines: string[] = [
    `*Contracts* — Mimir on Stellar ${escapeMd(networkLabel(config))}`,
    "",
    "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.",
  ];

  for (const target of targets) {
    lines.push(
      "",
      `*${target.label}*`,
      `\`${escapeMd(target.contractId)}\``,
      `[View on stellar\\.expert](${contractExplorerUrl(config, target.contractId)})`,
    );
  }

  return lines.join("\n");
}

/** Exact operator replies, exported for deterministic Telegram payload tests. */
export function pauseMessage(result: PollerPauseResult): string {
  switch (result) {
    case "paused":
      return "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.";
    case "already-paused":
      return "*Polling is already paused*";
    case "stopped":
      return "*Polling cannot pause* — the process is stopping\\.";
  }
}

export function resumeMessage(result: PollerResumeResult): string {
  switch (result) {
    case "resumed":
      return "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.";
    case "already-running":
      return "*Polling is already running*";
    case "stopped":
      return "*Polling cannot resume* — the process is stopping\\.";
  }
}

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /** Live in-memory audit window; renders immediately even before a flush. */
  audit?: AuditLog | undefined;
  /** Where the audit JSONL file lives, for the file-backed report. */
  auditFile?: string | undefined;
  /**
   * Pre-populated bot info. When provided (e.g. in tests) grammy skips the
   * getMe() call so `bot.handleUpdate()` works without a real Telegram token.
   */
  botInfo?: UserFromGetMe;
  pause: () => PollerPauseResult;
  resume: () => PollerResumeResult;
}

/**
 * Returns true when the chat is permitted to use restricted commands.
 *
 * Rules:
 * - If `allowedChatIds` is empty the list is open (any chat may use /status).
 * - Otherwise the incoming chat id must appear in the list. Both the numeric
 *   id (stored as a number in grammy's ctx.chat.id) and its string form are
 *   compared so that negative group ids such as -1001234567890 match correctly.
 */
function isChatAllowed(allowedChatIds: string[], chatId: number): boolean {
  if (allowedChatIds.length === 0) return true;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

function isOperator(ctx: Context, config: BotConfig): boolean {
  const operatorId = config.operatorTelegramUserId;
  return operatorId !== null && ctx.from?.id.toString() === operatorId;
}

/** How many recent audit lines `/audit` renders. A chat message is not a file. */
const AUDIT_TAIL = 10;

/** Register command handlers on a grammy-compatible bot (also useful in tests). */
export function registerCommandHandlers(bot: Bot, deps: BotDeps): void {
  const { config, status, pause, resume } = deps;

  bot.command("start", async (ctx) => {
    await ctx.reply(helpMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("status", async (ctx) => {
    if (!isChatAllowed(config.allowedChatIds, ctx.chat.id)) {
      // Silently ignore requests from unapproved chats. Responding with an
      // error would leak the existence of the restriction; not responding at
      // all is consistent with privacy-mode bots that simply never see most
      // messages. Log so operators can diagnose misconfigured chat ids.
      console.warn(
        `[bot] /status denied for chat ${ctx.chat.id} (not in ALLOWED_CHAT_IDS)`,
      );
      return;
    }
    await ctx.reply(statusMessage(config, status()), TELEGRAM_OPTIONS);
  });

  bot.command("audit", async (ctx) => {
    if (!isOperator(ctx, config)) {
      // Same authorization model as /pause and /resume: the report is only
      // meant for the operator, so other users get silence, not an error that
      // would confirm the command exists. The standalone `npm run audit` CLI
      // is the credential-free path for anyone with machine access.
      console.warn(`[bot] ignored unauthorized /audit on update ${ctx.update.update_id}`);
      return;
    }
    try {
      const file = deps.auditFile ?? config.auditFile;
      const summary = await readAuditFile(file);

      // The in-memory window also holds entries recorded since the last flush;
      // append any of those the file does not already contain (same entries
      // serialise identically) so the report is current without duplicates.
      const seen = new Set(summary.entries.map((e) => JSON.stringify(e)));
      const live = (deps.audit ? deps.audit.tail(AUDIT_TAIL) : []).filter(
        (e) => !seen.has(JSON.stringify(e)),
      );

      const merged: AuditFileSummary = {
        ...summary,
        entries: [...summary.entries, ...live].slice(-AUDIT_REPORT_MAX_ENTRIES),
      };
      await ctx.reply(renderAuditForTelegram(merged, AUDIT_TAIL), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      await ctx.reply(`Audit report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Config-only, so this never fails on account of poller or RPC state —
  // unlike /status, it has nothing to report failure on.
  bot.command("health", async (ctx) => {
    await ctx.reply(healthMessage(config, status()), TELEGRAM_OPTIONS);
  });

  bot.command("contracts", async (ctx) => {
    await ctx.reply(contractsMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("preview", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const spaceIndex = text.indexOf(" ");
    const arg = spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "";
    await ctx.reply(previewMessage(config, arg || "market"), TELEGRAM_OPTIONS);
  });

  bot.command("pause", async (ctx) => {
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /pause on update ${ctx.update.update_id}`);
      return;
    }
    await ctx.reply(pauseMessage(pause()), TELEGRAM_OPTIONS);
  });

  bot.command("resume", async (ctx) => {
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /resume on update ${ctx.update.update_id}`);
      return;
    }
    await ctx.reply(resumeMessage(resume()), TELEGRAM_OPTIONS);
  });
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.config.botToken, deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined);
  registerCommandHandlers(bot, deps);

  // grammy rethrows handler errors by default, which would take the process
  // with it. Keep Telegram/RPC error text bounded and redact known secrets.
  bot.catch((err) => {
    console.error(
      `[bot] handler error on update ${err.ctx.update.update_id}: ` +
        safeErrorMessage(err.error, [deps.config.botToken]),
    );
  });

  return bot;
}

/** Extra Telegram send options the poller may attach to a notification. */
export interface SendExtra {
  reply_markup?: ExplorerKeyboard | undefined;
  /**
   * Plain-text rendering of the same notification, sent without a `parse_mode`
   * when Telegram rejects the MarkdownV2 version for entity/parse reasons.
   * Optional: without it the notifier behaves exactly as before (parse errors
   * propagate, no second send).
   */
  plainText?: string | undefined;
  /**
   * Bounded identifiers for fallback logging only. Optional; never sent.
   */
  eventRef?: { eventId?: string | undefined; ledger?: number | undefined; source?: string | undefined } | undefined;
}

/**
 * True when a Telegram send failed because the message text could not be
 * parsed as MarkdownV2 entities.
 *
 * grammy (1.x) surfaces Bot API failures as `GrammyError` with `error_code`
 * and `description` straight from Telegram, e.g. error 400 with
 * `"Bad Request: can't parse entities: …"` or `"… can't find end of the
 * entity …"`. The classifier matches that shape — error 400 plus the
 * entity-parse phrasing — so rate limits (429), auth failures (401), chat
 * errors, and network `HttpError`s never qualify. Duck-typed errors carrying
 * the same Telegram description (mocks, wrapped rejections) match on the
 * phrasing alone when no numeric `error_code` is present.
 */
export function isMarkdownParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
  const text = [record.description, record.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  if (!/can't parse entities|can't find end of the entity/i.test(text)) return false;
  if (typeof record.error_code === "number") return record.error_code === 400;
  return true;
}

const PLAIN_TEXT_OPTIONS = {
  link_preview_options: { is_disabled: true },
};

/** Bounded log fragment identifying which event a fallback send belongs to. */
function eventRefLabel(eventRef: SendExtra["eventRef"]): string {
  if (!eventRef) return "";
  const parts: string[] = [];
  if (typeof eventRef.source === "string" && eventRef.source) parts.push(eventRef.source);
  if (typeof eventRef.ledger === "number" && Number.isFinite(eventRef.ledger)) {
    parts.push(`ledger ${eventRef.ledger}`);
  }
  if (typeof eventRef.eventId === "string" && eventRef.eventId) parts.push(eventRef.eventId);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/**
 * The poller's send path: route each contract's messages to its named chat,
 * with the event's explorer button when `extra.reply_markup` is set.
 *
 * MarkdownV2 first; exactly one plain-text retry when Telegram rejects the
 * entities *and* the caller supplied `extra.plainText`. The retry carries no
 * `parse_mode`, so it cannot fail the same way. Every other failure —
 * network, rate limit, auth, unknown chats, or a failed plain-text retry —
 * propagates unchanged, preserving the poller's existing error/cursor
 * accounting. At most two `sendMessage` calls per notification, never a loop.
 */
export function createNotifier(bot: Bot, config: BotConfig) {
  return async (text: string, source?: ContractSource, extra?: SendExtra): Promise<void> => {
    const chatId = source === "market"
      ? config.marketChatId ?? config.chatId
      : source === "squad"
        ? config.squadChatId ?? config.chatId
        : config.chatId;
    try {
      await bot.api.sendMessage(chatId, text, {
        ...TELEGRAM_OPTIONS,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
      });
      return;
    } catch (err) {
      const fallback = extra?.plainText;
      if (typeof fallback !== "string" || fallback === "" || !isMarkdownParseError(err)) {
        throw err;
      }
      // Only bounded metadata is logged: the fallback outcome, the safe error
      // category, and the caller-supplied event reference — never message
      // text, tokens, or remote payloads.
      console.warn(
        `[notifier] MarkdownV2 rejected${eventRefLabel(extra?.eventRef)}, ` +
          `retrying as plain text: ${safeErrorMessage(err)}`,
      );
      await bot.api.sendMessage(chatId, fallback, {
        ...PLAIN_TEXT_OPTIONS,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
      });
    }
  };
}

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "What this bot does" },
      { command: "help", description: "Show help" },
      { command: "status", description: "Last-seen ledger and watched contracts" },
      { command: "audit", description: "Operator audit report (redacted, bounded)" },
      { command: "contracts", description: "Contract ids and explorer links" },
      { command: "health", description: "Health assessment and operational readiness" },
      { command: "preview", description: "Preview channel notification formatting" },
      { command: "pause", description: "Operator only: pause new scans" },
      { command: "resume", description: "Operator only: resume polling now" },
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over, and never log an unbounded API error.
    console.warn(`[bot] setMyCommands failed: ${safeErrorMessage(err)}`);
  }
}

