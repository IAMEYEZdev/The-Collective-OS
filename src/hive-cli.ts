#!/usr/bin/env node
/**
 * ClaudeClaw Hive Mind & DB CLI
 *
 * Provides shell-accessible DB operations for sub-agents that don't have
 * sqlite3 on PATH. Replaces all raw `sqlite3` commands in CLAUDE.md files.
 *
 * Usage:
 *   node dist/hive-cli.js log "action" "summary"              — write to hive mind
 *   node dist/hive-cli.js log "action" "summary" "artifacts"  — write with artifacts
 *   node dist/hive-cli.js read [N]                            — read last N hive mind entries (default 20)
 *   node dist/hive-cli.js convolife                           — context window stats
 *   node dist/hive-cli.js checkpoint "summary text"           — save checkpoint memory
 *   node dist/hive-cli.js search-memory "keyword"             — search conversation log
 *   node dist/hive-cli.js session-info                        — current session ID and chat ID
 *   node dist/hive-cli.js board-audit [--card <id>] [--limit N] — board mutation history
 */

import {
  initDatabase,
  logToHiveMind,
  getOtherAgentActivity,
  saveTokenUsage,
  getBoardAuditLog,
  getBoardAuditCount,
} from './db.js';
import Database from 'better-sqlite3';
import path from 'path';
import { getClient, type AgentName } from './collectiveboard/index.js';

// Resolve project root: use CLAUDECLAW_PROJECT_ROOT env var (set by the Node process),
// fall back to the directory containing this compiled JS file (dist/ -> parent).
const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');

const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

initDatabase();

// Open a direct DB handle for queries not exposed via db.ts exports
function getDb(): Database.Database {
  return new Database(DB_PATH);
}

// Parse --agent flag from anywhere in argv, fall back to CLAUDECLAW_AGENT_ID env var
const agentFlagIdx = process.argv.indexOf('--agent');
const AGENT_ID = agentFlagIdx !== -1 && process.argv[agentFlagIdx + 1]
  ? process.argv[agentFlagIdx + 1]!
  : process.env.CLAUDECLAW_AGENT_ID || 'main';

// Parse --chat flag for explicit chat ID override
const chatFlagIdx = process.argv.indexOf('--chat');
const CHAT_ID_OVERRIDE = chatFlagIdx !== -1 && process.argv[chatFlagIdx + 1]
  ? process.argv[chatFlagIdx + 1]!
  : undefined;

// Parse --limit flag for entry count override
const limitFlagIdx = process.argv.indexOf('--limit');
const LIMIT_OVERRIDE = limitFlagIdx !== -1 && process.argv[limitFlagIdx + 1]
  ? parseInt(process.argv[limitFlagIdx + 1]!, 10)
  : undefined;

// Parse --board flag (boolean, no value) to push log entry to CollectiveBoard
const BOARD_SYNC = process.argv.includes('--board');

// Get chat ID from DB if not provided
function getChatId(): string {
  if (CHAT_ID_OVERRIDE) return CHAT_ID_OVERRIDE;
  try {
    const db = getDb();
    const row = db.prepare('SELECT chat_id FROM sessions LIMIT 1').get() as { chat_id: string } | undefined;
    db.close();
    return row?.chat_id || 'unknown';
  } catch {
    return process.env.ALLOWED_CHAT_ID || 'unknown';
  }
}

// Strip --agent, --chat, --limit, and --board flags from argv to get positional args
const filteredArgs = process.argv.slice(2).filter((_, i, arr) => {
  if (arr[i] === '--agent' || arr[i] === '--chat' || arr[i] === '--limit') return false;
  if (arr[i] === '--board') return false;
  if (i > 0 && (arr[i - 1] === '--agent' || arr[i - 1] === '--chat' || arr[i - 1] === '--limit')) return false;
  return true;
});

const command = filteredArgs[0];

(async () => {
switch (command) {
  case 'log': {
    const action = filteredArgs[1];
    const summary = filteredArgs[2];
    const artifacts = filteredArgs[3];

    if (!action || !summary) {
      console.error('Usage: hive-cli.js log "action" "summary" ["artifacts"]');
      process.exit(1);
    }

    const chatId = getChatId();
    logToHiveMind(AGENT_ID, chatId, action, summary, artifacts);
    console.log(`Logged to hive mind: [${AGENT_ID}] ${action} — ${summary.slice(0, 80)}`);

    // Best-effort: push to CollectiveBoard when --board flag present
    if (BOARD_SYNC) {
      const validAgents = ['melanie', 'james', 'annika', 'sean', 'melissa', 'jackson'];
      const agentName = validAgents.includes(AGENT_ID) ? AGENT_ID as AgentName : 'melanie';
      try {
        const board = getClient();
        const card = await board.createTask({
          title: `[${action}] ${summary.slice(0, 80)}`,
          agent: agentName,
          status: 'active',
          priority: 'normal',
          track: 'internal',
        });
        console.log(`Board synced: card ${card.id}`);
      } catch (err) {
        console.error(`Board sync failed: ${(err as Error).message}`);
      }
    }
    break;
  }

  case 'read': {
    const limit = LIMIT_OVERRIDE ?? parseInt(filteredArgs[1] || '20', 10);
    const db = getDb();
    const rows = db.prepare(
      `SELECT agent_id, action, summary, created_at
       FROM hive_mind ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Array<{ agent_id: string; action: string; summary: string; created_at: number }>;
    db.close();

    if (rows.length === 0) {
      console.log('No hive mind entries found.');
    } else {
      for (const row of rows) {
        const time = new Date(row.created_at * 1000).toLocaleString();
        console.log(`[${row.agent_id}] ${time} | ${row.action} | ${row.summary}`);
      }
    }
    break;
  }

  case 'convolife': {
    const db = getDb();
    const session = db.prepare('SELECT session_id FROM sessions WHERE agent_id = ? LIMIT 1').get(AGENT_ID) as { session_id: string } | undefined;

    if (!session) {
      console.log('No active session found.');
      db.close();
      break;
    }

    const stats = db.prepare(`
      SELECT
        COUNT(*) as turns,
        MAX(context_tokens) as last_context,
        SUM(output_tokens) as total_output,
        SUM(cost_usd) as total_cost,
        SUM(did_compact) as compactions
      FROM token_usage WHERE session_id = ?
    `).get(session.session_id) as {
      turns: number; last_context: number; total_output: number;
      total_cost: number; compactions: number;
    } | undefined;

    const baseline = db.prepare(`
      SELECT context_tokens as baseline FROM token_usage
      WHERE session_id = ? ORDER BY created_at ASC LIMIT 1
    `).get(session.session_id) as { baseline: number } | undefined;

    db.close();

    if (!stats || !baseline) {
      console.log('No token usage data for this session.');
      break;
    }

    const contextLimit = parseInt(process.env.CONTEXT_LIMIT || '1000000', 10);
    const available = contextLimit - (baseline.baseline || 0);
    const conversationUsed = (stats.last_context || 0) - (baseline.baseline || 0);
    const pctUsed = available > 0 ? Math.round((conversationUsed / available) * 100) : 0;

    console.log(`Context: ${pctUsed}% (~${Math.round(conversationUsed / 1000)}k / ${Math.round(available / 1000)}k available)`);
    console.log(`Turns: ${stats.turns} | Compactions: ${stats.compactions || 0} | Cost: $${(stats.total_cost || 0).toFixed(2)}`);
    break;
  }

  case 'checkpoint': {
    const summary = filteredArgs[1];
    if (!summary) {
      console.error('Usage: hive-cli.js checkpoint "3-5 bullet summary"');
      process.exit(1);
    }

    const chatId = getChatId();
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO memories (chat_id, source, raw_text, summary, entities, topics, importance, salience, created_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(chatId, 'checkpoint', summary, summary, '[]', '["checkpoint"]', 1.0, 5.0, now, now);
    db.close();

    console.log('Checkpoint saved. Safe to /newchat.');
    break;
  }

  case 'search-memory': {
    const keyword = filteredArgs[1];
    if (!keyword) {
      console.error('Usage: hive-cli.js search-memory "keyword"');
      process.exit(1);
    }

    const db = getDb();
    const rows = db.prepare(
      `SELECT role, substr(content, 1, 200) as content, created_at
       FROM conversation_log
       WHERE agent_id = ? AND content LIKE ?
       ORDER BY created_at DESC LIMIT 10`,
    ).all(AGENT_ID, `%${keyword}%`) as Array<{ role: string; content: string; created_at: number }>;
    db.close();

    if (rows.length === 0) {
      console.log(`No matches for "${keyword}" in conversation history.`);
    } else {
      for (const row of rows) {
        const time = new Date(row.created_at * 1000).toLocaleString();
        console.log(`[${row.role}] ${time}: ${row.content}`);
      }
    }
    break;
  }

  case 'session-info': {
    const db = getDb();
    const session = db.prepare('SELECT session_id, chat_id FROM sessions WHERE agent_id = ? LIMIT 1').get(AGENT_ID) as { session_id: string; chat_id: string } | undefined;
    db.close();

    if (session) {
      console.log(`Session: ${session.session_id}`);
      console.log(`Chat ID: ${session.chat_id}`);
    } else {
      console.log('No active session.');
    }
    break;
  }

  case 'board-audit': {
    const cardFilter = filteredArgs[1] === '--card' ? filteredArgs[2] : undefined;
    const agentFilter = filteredArgs[1] === '--agent-filter' ? filteredArgs[2] : undefined;
    const limit = LIMIT_OVERRIDE ?? 20;

    const entries = getBoardAuditLog(limit, cardFilter, agentFilter);
    const total = getBoardAuditCount(cardFilter);

    if (entries.length === 0) {
      console.log('No board audit entries found.');
      break;
    }

    console.log(`Board audit log (${entries.length} of ${total} total):\n`);
    for (const e of entries) {
      const time = new Date(e.created_at * 1000).toLocaleString();
      const detail = e.field
        ? `${e.field}: "${e.old_value}" -> "${e.new_value}"`
        : '';
      console.log(`${time} | ${e.action} | @${e.agent_id} | ${e.card_title.slice(0, 50)}`);
      if (detail) console.log(`  ${detail}`);
      console.log(`  card: ${e.card_id}`);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command || '(none)'}`);
    console.error('');
    console.error('Available commands:');
    console.error('  log "action" "summary" ["artifacts"]  — write to hive mind');
    console.error('  read [N]                              — read last N entries (default 20)');
    console.error('  convolife                             — context window stats');
    console.error('  checkpoint "summary"                  — save checkpoint memory');
    console.error('  search-memory "keyword"               — search conversation log');
    console.error('  session-info                          — show session and chat ID');
    console.error('  board-audit [--card <id>] [--limit N] — board mutation history');
    process.exit(1);
}
})().catch(err => { console.error(err); process.exit(1); });
