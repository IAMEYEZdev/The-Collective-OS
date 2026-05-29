import { CronExpressionParser } from 'cron-parser';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist } from './config.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { enrichPrompt } from './context-injector/index.js';
import { ClawCodeRAGClient } from './borg-arc/adapters/claw-code-rag.js';

type Sender = (text: string) => Promise<void>;

/** RAG client for claw-code context enrichment. Initialised only when CLAW_RAG_URL is set. */
const ragClient = process.env.CLAW_RAG_URL
  ? new ClawCodeRAGClient(process.env.CLAW_RAG_URL)
  : null;

/** Max time (ms) a scheduled/mission task can run before being killed. Configurable via TASK_TIMEOUT_MINUTES in .env. */
const TASK_TIMEOUT_MS = (parseInt(process.env.TASK_TIMEOUT_MINUTES || '25', 10)) * 60 * 1000;

let sender: Sender;

/**
 * Tracks whether tasks were recovered from a crash on this startup.
 * The bot checks this to inject a "confirm before resuming" hint
 * into the first user message after recovery (Fix 6).
 */
let _crashRecoveryCount = 0;
export function getCrashRecoveryCount(): number { return _crashRecoveryCount; }
export function clearCrashRecoveryFlag(): void { _crashRecoveryCount = 0; }

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
    _crashRecoveryCount += recovered;
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
    _crashRecoveryCount += recoveredMission;
  }

  setInterval(() => void runDueTasks(), 60_000);

  // Neo poll: ingest Neo→QM result envelopes on same 60s cadence
  initNeoPoll();

  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        await sender(`Scheduled task running: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`);

        // Enrich prompt with context (hive activity, operator directives, agent identity)
        const enrichment = await enrichPrompt(task.prompt, schedulerAgentId);
        if (enrichment.injection.injected) {
          logger.info({
            taskId: task.id,
            contextSources: enrichment.sources,
            entryCount: enrichment.injection.entryCount,
          }, 'Scheduled task prompt enriched with context');
        }

        // Enrich with claw-code RAG context if available
        if (ragClient) {
          try {
            const healthy = await ragClient.health();
            if (healthy) {
              const ragResults = await ragClient.query(enrichment.prompt, 3);
              if (ragResults.length > 0) {
                const ragContext = ragResults.map((r) => `[${r.source}]: ${r.text.slice(0, 300)}`).join('\n');
                enrichment.prompt = `[Claw-Code Context]\n${ragContext}\n\n${enrichment.prompt}`;
                logger.info({ taskId: task.id, ragHits: ragResults.length }, 'Prompt enriched with claw-code RAG context');
              }
            }
          } catch (ragErr) {
            logger.warn({ err: ragErr }, 'Claw-code RAG enrichment failed, continuing without');
          }
        }

        // Run as a fresh agent call (no session — scheduled tasks are autonomous)
        const result = await runAgent(enrichment.prompt, undefined, () => {}, undefined, undefined, abortController, undefined, agentMcpAllowlist);
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        const text = result.text?.trim() || 'Task completed with no output.';
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject task output into the active chat session so user replies have context
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        updateTaskAfterRun(task.id, nextRun, text, 'success');

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

    try {
      // Enrich prompt with context (hive activity, operator directives, agent identity)
      const enrichment = await enrichPrompt(mission.prompt, mission.assigned_agent ?? null);
      if (enrichment.injection.injected) {
        logger.info({
          missionId: mission.id,
          contextSources: enrichment.sources,
          entryCount: enrichment.injection.entryCount,
        }, 'Mission prompt enriched with context');
      }

      // Enrich with claw-code RAG context if available
      if (ragClient) {
        try {
          const healthy = await ragClient.health();
          if (healthy) {
            const ragResults = await ragClient.query(enrichment.prompt, 3);
            if (ragResults.length > 0) {
              const ragContext = ragResults.map((r) => `[${r.source}]: ${r.text.slice(0, 300)}`).join('\n');
              enrichment.prompt = `[Claw-Code Context]\n${ragContext}\n\n${enrichment.prompt}`;
              logger.info({ missionId: mission.id, ragHits: ragResults.length }, 'Prompt enriched with claw-code RAG context');
            }
          }
        } catch (ragErr) {
          logger.warn({ err: ragErr }, 'Claw-code RAG enrichment failed, continuing without');
        }
      }

      const result = await runAgent(enrichment.prompt, undefined, () => {}, undefined, undefined, abortController, undefined, agentMcpAllowlist);
      clearTimeout(timeout);

      if (result.aborted) {
        completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
        logger.warn({ missionId: mission.id }, 'Mission task timed out');
        try {
          await sender('Mission task timed out: "' + mission.title + '"');
        } catch (sendErr) {
          // Sender can fail for Telegram API blips or chat-not-found. We
          // still want to see it so the user isn't silently unnotified.
          logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
        }
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id }, 'Mission task completed');

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      const errMsg = err instanceof Error ? err.message : String(err);
      completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
      logger.error({ err, missionId: mission.id }, 'Mission task failed');
    } finally {
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}

// ── Neo Poll Integration ──────────────────────────────────────────────
// Runs neo-poll.mjs on the same 60s scheduler tick.
// Non-blocking: spawns as child process, logs results, never blocks scheduler.

let neoPollRunning = false;

function initNeoPoll(): void {
  const neoPollScript = path.resolve(__dirname, '..', 'scripts', 'neo-poll.mjs');
  if (!existsSync(neoPollScript)) {
    logger.info('Neo poll script not found, skipping neo-poll integration');
    return;
  }

  logger.info('Neo poll integration active (60s cadence, piggybacking scheduler tick)');
  setInterval(() => void runNeoPoll(neoPollScript), 60_000);
  // Run once immediately on startup
  void runNeoPoll(neoPollScript);
}

async function runNeoPoll(scriptPath: string): Promise<void> {
  if (neoPollRunning) return; // prevent overlap
  neoPollRunning = true;

  return new Promise<void>((resolve) => {
    execFile('node', [scriptPath], { timeout: 30_000 }, (err, stdout, stderr) => {
      neoPollRunning = false;
      if (err) {
        // Timeout or crash — log but don't block scheduler
        logger.warn({ err: err.message }, 'Neo poll cycle failed');
      } else {
        const output = stdout.trim();
        if (output && !output.includes('No new results')) {
          logger.info({ output: output.slice(0, 200) }, 'Neo poll processed results');
        }
      }
      resolve();
    });
  });
}
