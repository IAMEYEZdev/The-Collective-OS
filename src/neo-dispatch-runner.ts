import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

/**
 * Neo dispatch runner.
 *
 * The Neo Telegram bot writes async dispatch envelopes to
 * workspace/dispatch/outbound/<ulid>-telegram.dispatch.json but does NOT run
 * Codex inline (that would freeze the bot for minutes). This runner watches for
 * those telegram-originated envelopes and fires scripts/neo-dispatch.mjs <ulid>
 * as a background child process — the same script Melanie uses — which runs
 * Codex and writes the result to workspace/dispatch/inbound. neo-poll then
 * ingests the result and queues the Telegram reply.
 *
 * Discipline:
 *  - Only ever fires for *-telegram.dispatch.json (never Melanie's own
 *    dispatches, which she runs herself).
 *  - One Codex run at a time (danger-full-access Codex is heavy).
 *  - A .started marker is written before spawning so an envelope is never
 *    fired twice, even across restarts. A broken Codex therefore does not
 *    cause an infinite respawn loop; re-run a specific ulid by hand if needed.
 */

const OUTBOUND_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'outbound');
const DISPATCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'neo-dispatch.mjs');
const STARTED_MARKER = '.started';
const TELEGRAM_SUFFIX = '-telegram.dispatch.json';

let running = false;

function ulidFromFile(file: string): string {
  return file.slice(0, file.length - TELEGRAM_SUFFIX.length);
}

function runOnce(): void {
  if (running) return;
  if (!fs.existsSync(OUTBOUND_DIR)) return;

  const pending = fs.readdirSync(OUTBOUND_DIR)
    .filter((f) => f.endsWith(TELEGRAM_SUFFIX))
    .filter((f) => !fs.existsSync(path.join(OUTBOUND_DIR, f + STARTED_MARKER)))
    .sort(); // ulid prefix is time-sortable -> oldest first

  if (pending.length === 0) return;

  const file = pending[0];
  const ulid = ulidFromFile(file);
  const markerPath = path.join(OUTBOUND_DIR, file + STARTED_MARKER);

  // Mark before spawning so we never double-fire.
  try {
    fs.writeFileSync(markerPath, new Date().toISOString());
  } catch (err) {
    logger.warn({ err, file }, 'Neo dispatch runner could not write started marker, skipping this tick');
    return;
  }

  running = true;
  logger.info({ ulid, file }, 'Neo dispatch runner firing neo-dispatch.mjs');

  const child = spawn('node', [DISPATCH_SCRIPT, ulid], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => logger.info({ ulid }, `[neo-dispatch] ${String(d).trim()}`));
  child.stderr.on('data', (d) => logger.warn({ ulid }, `[neo-dispatch] ${String(d).trim()}`));

  child.on('exit', (code) => {
    running = false;
    if (code === 0) {
      logger.info({ ulid }, 'Neo dispatch completed (result written; neo-poll will deliver the reply)');
    } else {
      logger.error({ ulid, code }, 'Neo dispatch exited non-zero (likely Codex sandbox). Reply will not arrive for this message; re-run by hand once Codex is healthy.');
    }
  });

  child.on('error', (err) => {
    running = false;
    logger.error({ err, ulid }, 'Neo dispatch failed to spawn');
  });
}

/** Start the dispatch runner on a 10s cadence. */
export function startNeoDispatchRunner(): void {
  logger.info('Neo dispatch runner active (10s cadence)');
  setInterval(runOnce, 10_000);
  runOnce();
}
