import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

/**
 * Neo dispatch (async, file-bus).
 *
 * Writes a dispatch envelope to workspace/dispatch/outbound/<ulid>-telegram.dispatch.json
 * and returns immediately. It does NOT run Codex/Neo inline — the existing
 * background poller + dispatch runner pick the envelope up. This keeps the
 * Telegram bot responsive (no synchronous 5-minute freeze).
 *
 * The originating Telegram chat id is recorded at callback.telegram.chatId so
 * neo-poll.mjs can route Neo's reply back to the right chat by ULID.
 */

const OUTBOUND_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'outbound');

/** Monotonic-ish ULID-style id: time prefix + random suffix, lexically sortable. */
export function generateDispatchUlid(): string {
  const time = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `${time}${rand}`;
}

export interface NeoDispatchResult {
  ulid: string;
  envelopePath: string;
}

/**
 * Create and write a Neo dispatch envelope.
 * @param text     The user's message (the task for Neo).
 * @param chatId   Originating Telegram chat id (string), recorded for reply routing.
 */
export function dispatchToNeo(text: string, chatId: string): NeoDispatchResult {
  const ulid = generateDispatchUlid();

  if (!fs.existsSync(OUTBOUND_DIR)) {
    fs.mkdirSync(OUTBOUND_DIR, { recursive: true });
  }

  const title = text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Neo task';

  const envelope = {
    version: 1,
    ulid,
    issuedAt: new Date().toISOString(),
    source: 'telegram-neo-bot',
    task: {
      title,
      description: text,
      type: 'general',
      complexity: 'unknown',
      priority: 'normal',
    },
    context: {
      repoRoot: PROJECT_ROOT,
    },
    callback: {
      resultPath: `workspace/dispatch/inbound/${ulid}.result.json`,
      // Reply routing: neo-poll.mjs reads this to send Neo's result back.
      telegram: {
        chatId,
      },
    },
  };

  const fileName = `${ulid}-telegram.dispatch.json`;
  const envelopePath = path.join(OUTBOUND_DIR, fileName);

  // Atomic write: temp file then rename, so the dispatch runner never reads a
  // half-written envelope.
  const tmpPath = envelopePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
  fs.renameSync(tmpPath, envelopePath);

  logger.info({ ulid, chatId, title }, 'Neo dispatch envelope written');

  return { ulid, envelopePath };
}
