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
 *   node dist/hive-cli.js log ... --hemisphere biz|eng|xhemi  — route via clawhip channel
 *   node dist/hive-cli.js log ... --verify-path <path>       — block log unless file exists on disk
 *   node dist/hive-cli.js read [N]                            — read last N hive mind entries (default 20)
 *   node dist/hive-cli.js convolife                           — context window stats
 *   node dist/hive-cli.js checkpoint "summary text"           — save checkpoint memory
 *   node dist/hive-cli.js search-memory "keyword"             — search conversation log
 *   node dist/hive-cli.js session-info                        — current session ID and chat ID
 *   node dist/hive-cli.js board-audit [--card <id>] [--limit N] — board mutation history
 *   node dist/hive-cli.js claw-health                          — claw-code integration health check
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
import { existsSync } from 'fs';
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

// Parse --verify-path flag: path that MUST exist on disk before hive log succeeds
const verifyFlagIdx = process.argv.indexOf('--verify-path');
const VERIFY_PATH = verifyFlagIdx !== -1 && process.argv[verifyFlagIdx + 1]
  ? process.argv[verifyFlagIdx + 1]!
  : undefined;

// Parse --hemisphere flag for clawhip channel routing (biz|eng|xhemi, default biz)
const hemiFlagIdx = process.argv.indexOf('--hemisphere');
const HEMISPHERE: 'biz' | 'eng' | 'xhemi' = (() => {
  const val = hemiFlagIdx !== -1 && process.argv[hemiFlagIdx + 1]
    ? process.argv[hemiFlagIdx + 1]!
    : process.env.CLAUDECLAW_HEMISPHERE || 'biz';
  if (val === 'eng' || val === 'xhemi') return val;
  return 'biz';
})();

// Clawhip daemon base URL — event routing via channel_template resolution
const CLAWHIP_URL = process.env.CLAWHIP_URL || 'http://127.0.0.1:25294';

/**
 * Fire event to clawhip daemon for channel-routed dispatch.
 * Best-effort: clawhip down = warning, not failure. Hive log is source of truth.
 */
async function emitClawhipEvent(
  agentId: string,
  hemisphere: string,
  action: string,
  summary: string,
  artifacts?: string,
): Promise<void> {
  const payload = {
    type: 'hive.log',
    payload: {
      agent_name: agentId,
      hemisphere,
      action,
      summary: summary.slice(0, 500),
      ...(artifacts ? { artifacts } : {}),
      timestamp: new Date().toISOString(),
    },
  };

  try {
    const resp = await fetch(`${CLAWHIP_URL}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log(`Clawhip routed: ${hemisphere}.${agentId}`);
    } else {
      console.error(`Clawhip rejected (${resp.status}): ${await resp.text().catch(() => 'no body')}`);
    }
  } catch (err) {
    // Clawhip down is non-fatal — hive log already persisted to SQLite
    console.error(`Clawhip unreachable: ${(err as Error).message}`);
  }
}

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

// Strip --agent, --chat, --limit, --board, and --hemisphere flags from argv to get positional args
const filteredArgs = process.argv.slice(2).filter((_, i, arr) => {
  if (arr[i] === '--agent' || arr[i] === '--chat' || arr[i] === '--limit' || arr[i] === '--hemisphere' || arr[i] === '--verify-path') return false;
  if (arr[i] === '--board') return false;
  if (i > 0 && (arr[i - 1] === '--agent' || arr[i - 1] === '--chat' || arr[i - 1] === '--limit' || arr[i - 1] === '--hemisphere' || arr[i - 1] === '--verify-path')) return false;
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

    // Hive Log Gate (Universal) — see docs/sops/ and quality-gate skill.
    // Reject empty / boilerplate / under-spec summaries. Force H1+H2+H3 discipline.
    // Bypass only via CLAUDECLAW_HIVE_BYPASS=1 (audit-visible).
    const bypass = process.env.CLAUDECLAW_HIVE_BYPASS === '1';
    if (!bypass) {
      const trimmed = summary.trim();
      const lowered = trimmed.toLowerCase();
      const rejectPatterns = [
        'no summary produced',
        '(no summary produced)',
        '(no summary)',
        'no summary',
        'n/a',
        'na',
        'tbd',
        'todo',
      ];
      const isRejectedExact = rejectPatterns.includes(lowered);
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
      const repeatsAction = lowered === action.trim().toLowerCase();

      let failReason: string | null = null;
      if (trimmed.length === 0) failReason = 'empty summary';
      else if (isRejectedExact) failReason = `boilerplate summary: "${trimmed}"`;
      else if (trimmed.length < 20) failReason = `summary too short (${trimmed.length} chars, min 20)`;
      else if (wordCount < 4) failReason = `summary too thin (${wordCount} words, min 4)`;
      else if (repeatsAction) failReason = 'summary repeats action verb with no detail';

      if (failReason) {
        console.error(`HIVE LOG REJECTED [${AGENT_ID}]: ${failReason}`);
        console.error('Required format: "Did <X>. Verified via <gate/check>. Open: <next/closed>."');
        console.error('See: docs/sops/ + quality-gate skill (Hive Log Gate H1+H2+H3).');
        console.error('Bypass (audit-visible): set CLAUDECLAW_HIVE_BYPASS=1');
        process.exit(2);
      }
    }

    // Post-write verification gate: verifies claimed files exist on disk before
    // allowing hive success log. Two modes:
    //   1. Explicit: --verify-path <path> (always checked)
    //   2. Automatic: when artifacts arg looks like a file path (conservative detection)
    // Escape hatch: prefix artifacts with "nopath:" to skip auto-detection.
    // Failed verification = visible error + exit(3), never silent skip.

    /**
     * Detect whether a string looks like a verifiable file path (conservative).
     * Returns the path to verify, or null if not path-like.
     */
    function detectVerifiablePath(s: string): string | null {
      const trimmed = s.trim();
      // Escape hatch: explicit opt-out
      if (trimmed.startsWith('nopath:')) return null;
      // URLs are not local paths
      if (/^https?:\/\//i.test(trimmed)) return null;
      // Template placeholders are not real paths
      if (/<[^>]+>/.test(trimmed) || /\{[^}]+\}/.test(trimmed)) return null;
      // Multiple space-separated tokens = probably a description, not a path
      if (trimmed.split(/\s+/).length > 2) return null;

      // Positive signals: absolute path, relative path prefix, or known project dirs
      const isAbsUnix = trimmed.startsWith('/');
      const isAbsWin = /^[A-Za-z]:[\\\/]/.test(trimmed);
      const isRelative = trimmed.startsWith('./') || trimmed.startsWith('../');
      const hasProjectDir = /(?:^|\/)(?:agents|workspace|output|tmp)\//.test(trimmed);

      if (isAbsUnix || isAbsWin || isRelative || hasProjectDir) return trimmed;
      return null;
    }

    // Determine path to verify: explicit flag takes priority, then auto-detect from artifacts
    const verifyTarget = VERIFY_PATH
      || (artifacts ? detectVerifiablePath(artifacts) : null);

    if (verifyTarget) {
      const resolvedPath = path.isAbsolute(verifyTarget)
        ? verifyTarget
        : path.resolve(PROJECT_ROOT, verifyTarget);
      if (!existsSync(resolvedPath)) {
        console.error(`HIVE LOG BLOCKED [${AGENT_ID}]: post-write verification FAILED`);
        console.error(`  path: "${resolvedPath}"`);
        console.error(`  source: ${VERIFY_PATH ? '--verify-path flag' : 'auto-detected from artifacts'}`);
        console.error('  File does NOT exist on disk. Hive success log suppressed.');
        console.error('  Fix: confirm the write landed, or prefix artifacts with "nopath:" if not a file.');
        process.exit(3);
      }
      console.log(`Verified on disk: ${resolvedPath}`);
    }

    const chatId = getChatId();
    logToHiveMind(AGENT_ID, chatId, action, summary, artifacts);
    console.log(`Logged to hive mind: [${AGENT_ID}] ${action} — ${summary.slice(0, 80)}`);

    // Best-effort: route through clawhip for channel-based dispatch
    // Event payload carries agent_name + hemisphere — clawhip's channel_template
    // resolves "{hemisphere}.{agent_name}" via channel_mapping to Discord channel ID
    await emitClawhipEvent(AGENT_ID, HEMISPHERE, action, summary, artifacts);

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

  case 'claw-health': {
    const ragUrl = process.env.CLAW_RAG_URL || 'http://localhost:8787';
    const binPath = process.env.CLAW_CODE_BIN || 'claw';

    // Check binary
    let binaryOk = false;
    let version = 'unknown';
    try {
      const { execSync } = await import('child_process');
      const out = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 5000 });
      binaryOk = true;
      version = out.trim();
    } catch { /* binary unavailable */ }

    // Check RAG
    let ragOk = false;
    let ragChunks = 0;
    try {
      const res = await fetch(`${ragUrl}/health`);
      ragOk = res.ok;
      if (ragOk) {
        const statsRes = await fetch(`${ragUrl}/v1/stats`);
        const stats = await statsRes.json() as Record<string, number>;
        ragChunks = stats.chunks || 0;
      }
    } catch { /* rag unavailable */ }

    console.log('Claw-Code Health Report');
    console.log(`  Binary: ${binaryOk ? 'OK' : 'MISSING'} (${version})`);
    console.log(`  RAG Service: ${ragOk ? 'OK' : 'DOWN'}`);
    console.log(`  RAG Chunks: ${ragChunks}`);
    console.log(`  Qdrant: ${ragOk ? 'OK (via RAG)' : 'UNKNOWN'}`);
    break;
  }

  case 'recall': {
    const recallQuery = filteredArgs[1];
    if (!recallQuery) {
      console.error('Usage: hive-cli.js recall "query" [--stores all|hive,goals,...] [--limit 10] [--since 7d]');
      process.exit(1);
    }
    // Forward to recall module
    const { recall } = await import('./recall.js');
    let stores: string[] = [];
    let limit = 10;
    let sinceMs: number | null = null;
    for (let i = 2; i < filteredArgs.length; i++) {
      if (filteredArgs[i] === '--stores' && filteredArgs[i + 1]) {
        const val = filteredArgs[i + 1]!;
        stores = val === 'all' ? [] : val.split(',');
        i++;
      } else if (filteredArgs[i] === '--limit' && filteredArgs[i + 1]) {
        limit = parseInt(filteredArgs[i + 1]!, 10) || 10;
        i++;
      } else if (filteredArgs[i] === '--since' && filteredArgs[i + 1]) {
        const match = filteredArgs[i + 1]!.match(/^(\d+)([dhm])$/);
        if (match) {
          const value = parseInt(match[1]!, 10);
          const mult: Record<string, number> = { d: 86400000, h: 3600000, m: 60000 };
          sinceMs = Date.now() - (value * (mult[match[2]!] || 86400000));
        }
        i++;
      }
    }
    const result = await recall({ query: recallQuery, stores, limit, sinceMs });
    if (result.stores_failed.length > 0) {
      console.error(`WARNING: ${result.stores_failed.length} store(s) degraded: ${result.stores_failed.join(', ')}`);
    }
    if (result.degradation_notice) {
      console.error(`DEGRADED: ${result.degradation_notice}`);
    }
    console.log(`\nRecall: "${result.query}" | ${result.total_results} results from ${result.stores_queried.length} stores\n`);
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i]!;
      const score = r.relevance_score.toFixed(3);
      const agentTag = r.agent ? ` [${r.agent}]` : '';
      console.log(`  ${i + 1}. [${r.store}/${r.source_type}] ${r.title}${agentTag}`);
      console.log(`     Score: ${score}`);
      console.log(`     ${r.snippet}`);
      if (r.full_path) console.log(`     Path: ${r.full_path}`);
      console.log('');
    }
    if (result.results.length === 0) console.log('No results found.');
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
    console.error('  claw-health                           — claw-code integration health check');
    console.error('  recall "query" [--stores ...] [--limit N] [--since 7d] — federated recall');
    process.exit(1);
}
})().catch(err => { console.error(err); process.exit(1); });
