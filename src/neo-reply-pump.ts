import fs from 'fs';
import path from 'path';

import type { Bot } from 'grammy';

import { PROJECT_ROOT, ALLOWED_CHAT_ID } from './config.js';
import { logger } from './logger.js';

/**
 * Neo reply pump.
 *
 * neo-poll.mjs writes reply records to workspace/dispatch/replies/<ulid>.reply.json
 * when a Neo result corresponds to a Telegram-originated dispatch. This pump
 * polls that folder and delivers each reply via the Neo bot.
 *
 * Delivery state is separate from ingestion: a record is marked .delivered only
 * after sendMessage resolves. A failed send leaves the record pending so the
 * next tick retries. The destination chat id is re-validated against
 * ALLOWED_CHAT_ID before every send (defence in depth).
 */

const REPLIES_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'replies');
const DELIVERED_MARKER = '.delivered';
const TELEGRAM_MAX = 4096;

function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX) {
    chunks.push(rest.slice(0, TELEGRAM_MAX));
    rest = rest.slice(TELEGRAM_MAX);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function deliverOnce(bot: Bot): Promise<void> {
  if (!fs.existsSync(REPLIES_DIR)) return;

  const files = fs.readdirSync(REPLIES_DIR)
    .filter((f) => f.endsWith('.reply.json'))
    .filter((f) => !fs.existsSync(path.join(REPLIES_DIR, f + DELIVERED_MARKER)));

  for (const file of files) {
    const full = path.join(REPLIES_DIR, file);
    let record: { ulid?: string; chatId?: string; text?: string };
    try {
      record = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch (err) {
      logger.warn({ err, file }, 'Neo reply record malformed, marking delivered to avoid loop');
      fs.writeFileSync(full + DELIVERED_MARKER, new Date().toISOString());
      continue;
    }

    const chatId = record.chatId ?? '';
    const text = record.text ?? '';

    // Re-validate destination. Only ever deliver to the one allowed chat.
    if (!ALLOWED_CHAT_ID || chatId !== ALLOWED_CHAT_ID) {
      logger.warn({ chatId, ulid: record.ulid }, 'Neo reply chatId not allowed, dropping');
      fs.writeFileSync(full + DELIVERED_MARKER, new Date().toISOString());
      continue;
    }

    if (!text.trim()) {
      fs.writeFileSync(full + DELIVERED_MARKER, new Date().toISOString());
      continue;
    }

    try {
      for (const chunk of splitForTelegram(text)) {
        await bot.api.sendMessage(chatId, chunk);
      }
      // Mark delivered only after a successful send.
      fs.writeFileSync(full + DELIVERED_MARKER, new Date().toISOString());
      logger.info({ ulid: record.ulid, chatId }, 'Neo reply delivered to Telegram');
    } catch (err) {
      // Leave pending; next tick retries.
      logger.warn({ err, ulid: record.ulid }, 'Neo reply send failed, will retry next tick');
    }
  }
}

/** Start the reply pump on a 15s cadence. */
export function startNeoReplyPump(bot: Bot): void {
  logger.info('Neo reply pump active (15s cadence)');
  setInterval(() => { void deliverOnce(bot); }, 15_000);
  void deliverOnce(bot);
}
