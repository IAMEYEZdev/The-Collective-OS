import { Bot } from 'grammy';

import { NEO_BOT_TOKEN, ALLOWED_CHAT_ID } from './config.js';
import { logger } from './logger.js';
import { isLocked, touchActivity, isSecurityEnabled } from './security.js';
import { dispatchToNeo } from './neo-dispatch-bridge.js';

// ── Shared Telegram network-error retry (ETIMEDOUT resilience) ─────────
// On a fresh reboot the network stack often isn't up yet, so the first
// Telegram API call throws ETIMEDOUT and (without this) crashes the process.
// grammy surfaces transport failures as HttpError with the original
// FetchError on `.error`, so we check the code there, on the error itself,
// and (fallback) in the message text.

const TELEGRAM_NETWORK_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
];

export function isTelegramNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; error?: { code?: string; message?: string } };
  const code = e.code ?? e.error?.code;
  if (code && TELEGRAM_NETWORK_ERROR_CODES.includes(code)) return true;
  const msg = `${e.message ?? ''} ${e.error?.message ?? ''}`;
  return TELEGRAM_NETWORK_ERROR_CODES.some((c) => msg.includes(c));
}

/**
 * Install bounded exponential-backoff retry on a bot's outbound API calls for
 * transient network errors. Shared by the main bot and the Neo bot.
 * 8 attempts, 1s → 30s cap.
 */
export function installTelegramRetry(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const maxAttempts = 8;
    let delay = 1000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await prev(method, payload, signal);
      } catch (err) {
        if (!isTelegramNetworkError(err) || attempt >= maxAttempts) throw err;
        logger.warn({ method, attempt, delay }, 'Telegram API network error, retrying');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }
  });
}

// ── Neo bot ────────────────────────────────────────────────────────────

/** True only for the single authorised chat. */
function isNeoAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) return false; // Neo bot requires an explicit allowed chat
  return chatId.toString() === ALLOWED_CHAT_ID;
}

/**
 * Create the dedicated Neo Telegram bot, or null if NEO_BOT_TOKEN is not set.
 *
 * Behaviour: an authorised, unlocked, private text message is turned into a
 * Neo dispatch envelope (async) and acknowledged immediately with its ULID.
 * Neo's actual reply is delivered later by neo-poll.mjs via the scheduler.
 *
 * This bot NEVER reuses TELEGRAM_BOT_TOKEN and never falls back to it.
 */
export function createNeoBot(): Bot | null {
  if (!NEO_BOT_TOKEN) {
    logger.info('NEO_BOT_TOKEN not set — Neo Telegram bot disabled');
    return null;
  }

  const bot = new Bot(NEO_BOT_TOKEN);
  installTelegramRetry(bot);

  // Reject non-private chats.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      logger.warn({ chatId: ctx.chat.id, type: ctx.chat.type }, 'Neo bot rejected non-private chat');
      await ctx.reply('This bot only works in private chats.').catch(() => {});
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    if (!isNeoAuthorised(ctx.chat!.id)) return;
    await ctx.reply('Neo bridge online. Send a message and I will dispatch it to Neo. Replies arrive when Neo finishes.').catch(() => {});
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat!.id;

    // 1. Authorisation: exact allowed chat only. Silently ignore others.
    if (!isNeoAuthorised(chatId)) {
      logger.warn({ chatId }, 'Neo bot rejected unauthorised chat');
      return;
    }

    // 2. Lock: if the session is locked, refuse and create no dispatch.
    if (isSecurityEnabled() && isLocked()) {
      await ctx.reply('🔒 Locked. Unlock the main bot first.').catch(() => {});
      return;
    }

    // 3. Authorised + unlocked → register activity.
    touchActivity();

    const text = ctx.message.text?.trim() ?? '';
    if (!text) return;

    // 4. Bound message size (defensive).
    if (text.length > 8000) {
      await ctx.reply('Message too long for a Neo dispatch (max 8000 chars).').catch(() => {});
      return;
    }

    // 5. Dispatch (async) and ack immediately. Never block on Neo.
    try {
      const { ulid } = dispatchToNeo(text, chatId.toString());
      await ctx.reply(`Dispatched to Neo. ULID ${ulid}. I'll send Neo's reply here when it's ready.`).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Neo dispatch failed');
      await ctx.reply(`Could not dispatch to Neo: ${msg}`).catch(() => {});
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Neo bot error');
  });

  return bot;
}
