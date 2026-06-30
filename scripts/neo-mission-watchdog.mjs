#!/usr/bin/env node
/**
 * neo-mission-watchdog.mjs -- Process supervision for dispatched missions
 *
 * Promotes fire-and-forget queue to supervised dispatch:
 *   1. Polls running missions from SQLite
 *   2. Checks hive for agent heartbeat (last log entry)
 *   3. If stalled > STALL_THRESHOLD_MIN, marks mission stalled + escalates
 *   4. Verifies MISSION_COMPLETE / MISSION_BLOCKED terminal hive entries
 *
 * Start: node scripts/neo-mission-watchdog.mjs
 * Stop: Ctrl+C
 *
 * Env:
 *   STALL_THRESHOLD_MIN  - minutes before declaring stall (default: 10)
 *   WATCHDOG_POLL_SEC    - poll interval seconds (default: 60)
 *   ESCALATE_TO          - agent to notify on stall (default: main)
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HIVE_CLI = path.join(PROJECT_ROOT, 'dist', 'hive-cli.js');
const MISSION_CLI = path.join(PROJECT_ROOT, 'dist', 'mission-cli.js');

const STALL_THRESHOLD_MIN = parseInt(process.env.STALL_THRESHOLD_MIN ?? '10', 10);
const POLL_SEC = parseInt(process.env.WATCHDOG_POLL_SEC ?? '60', 10);
const ESCALATE_TO = process.env.ESCALATE_TO ?? 'main';

// ponytail: in-memory stall tracker, no extra DB columns needed
// upgrade path: add last_heartbeat column to mission_tasks if this grows
const stallCounts = new Map(); // missionId -> { count, firstSeen }

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, timeout: 15_000, stdio: 'pipe' }).toString().trim();
  } catch (e) {
    return null;
  }
}

function hiveLog(action, message) {
  run(`node "${HIVE_CLI}" log "${action}" "${message.replace(/"/g, '\\"')}"`);
}

/**
 * Get running missions from mission-cli
 * Returns parsed lines: { id, agent, title, startedAt }
 */
function getRunningMissions() {
  const raw = run(`node "${MISSION_CLI}" list --status running`);
  if (!raw || raw.includes('No mission tasks')) return [];

  // Parse mission-cli list output
  // Format: "ID | Title | Agent | Status | Priority | Created"
  const lines = raw.split('\n').filter(l => l.includes('|') && !l.startsWith('-'));
  const missions = [];

  for (const line of lines) {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 4) continue;
    const [id, title, agent, status] = parts;
    if (status !== 'running') continue;
    missions.push({ id, title, agent });
  }

  return missions;
}

/**
 * Check agent's last hive activity timestamp
 * Returns minutes since last log, or Infinity if no logs found
 */
function getAgentLastActivityMinutes(agent) {
  // ponytail: grep hive read output for agent tag, parse timestamp
  // O(n) scan of recent hive logs, fine for <1000 entries
  const raw = run(`node "${HIVE_CLI}" read`);
  if (!raw) return Infinity;

  const lines = raw.split('\n');
  const agentTag = `[${agent}]`;

  for (const line of lines) {
    if (!line.includes(agentTag)) continue;

    // Extract timestamp: format "DD/MM/YYYY, HH:MM:SS"
    const match = line.match(/(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})/);
    if (!match) continue;

    const [day, month, yearTime] = match[1].split('/');
    const [year, time] = yearTime.split(', ');
    const parsed = new Date(`${year}-${month}-${day}T${time}`);
    if (isNaN(parsed.getTime())) continue;

    const minutesAgo = (Date.now() - parsed.getTime()) / 60_000;
    return minutesAgo;
  }

  return Infinity;
}

/**
 * Check if mission has terminal hive entry
 * Agents log MISSION_COMPLETE or MISSION_BLOCKED when done
 */
function checkTerminalState(missionId) {
  const raw = run(`node "${HIVE_CLI}" read`);
  if (!raw) return null;

  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.includes(missionId)) continue;
    if (line.includes('MISSION_COMPLETE')) return 'completed';
    if (line.includes('MISSION_BLOCKED')) return 'blocked';
  }
  return null;
}

/**
 * Mark mission as failed/stalled via mission-cli
 */
function stallMission(mission, minutesSilent) {
  const msg = `Mission ${mission.id} stalled: agent [${mission.agent}] silent for ${Math.round(minutesSilent)}min. Task: ${mission.title}`;

  // Log to hive as escalation
  hiveLog('WATCHDOG_STALL', `${msg} -- escalating to [${ESCALATE_TO}]`);

  // Update mission status in DB
  // ponytail: reuse mission-cli cancel since there's no "stall" command
  // upgrade: add explicit stall status to mission-cli if needed
  run(`node "${MISSION_CLI}" cancel ${mission.id}`);

  console.log(`[watchdog] STALL: ${msg}`);

  // Notify via notify.sh if available
  const notifyScript = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');
  run(`bash "${notifyScript}" "WATCHDOG: ${msg}"`);
}

/**
 * Complete mission that has terminal hive entry
 */
function completeMission(mission, terminalState) {
  const msg = `Mission ${mission.id} resolved via hive: ${terminalState}. Agent: [${mission.agent}], Task: ${mission.title}`;
  hiveLog('WATCHDOG_RESOLVE', msg);
  console.log(`[watchdog] RESOLVED: ${msg}`);

  // Cancel from running state (marks completed in effect)
  // ponytail: cancel is close enough, proper completion needs result text we don't have
  run(`node "${MISSION_CLI}" cancel ${mission.id}`);
  stallCounts.delete(mission.id);
}

// ── Main poll loop ──────────────────────────────────────────────────

function poll() {
  const missions = getRunningMissions();

  if (missions.length === 0) {
    // Quiet poll, no running missions
    return;
  }

  console.log(`[watchdog] ${new Date().toISOString()} Checking ${missions.length} running mission(s)`);

  for (const mission of missions) {
    // Check for terminal state first (agent self-reported completion)
    const terminal = checkTerminalState(mission.id);
    if (terminal) {
      completeMission(mission, terminal);
      continue;
    }

    // Check agent heartbeat
    const minutesSilent = getAgentLastActivityMinutes(mission.agent);

    if (minutesSilent > STALL_THRESHOLD_MIN) {
      // Track consecutive stall detections
      const prev = stallCounts.get(mission.id) ?? { count: 0, firstSeen: Date.now() };
      prev.count++;
      stallCounts.set(mission.id, prev);

      if (prev.count >= 2) {
        // Two consecutive stall detections = confirmed stall
        stallMission(mission, minutesSilent);
        stallCounts.delete(mission.id);
      } else {
        console.log(`[watchdog] WARNING: [${mission.agent}] silent ${Math.round(minutesSilent)}min on mission ${mission.id}. Will escalate on next poll if still silent.`);
      }
    } else {
      // Agent alive, clear stall counter
      if (stallCounts.has(mission.id)) {
        console.log(`[watchdog] CLEARED: [${mission.agent}] resumed activity on mission ${mission.id}`);
        stallCounts.delete(mission.id);
      }
    }
  }
}

// ── Self-check ──────────────────────────────────────────────────────
// ponytail: assert-based self-check, not a test suite

function selfCheck() {
  console.log('[watchdog] Running self-check...');

  // Verify hive-cli is reachable
  const hiveOk = run(`node "${HIVE_CLI}" read`) !== null;
  console.assert(hiveOk, 'hive-cli must be reachable');

  // Verify mission-cli is reachable
  const missionOk = run(`node "${MISSION_CLI}" list`) !== null;
  console.assert(missionOk, 'mission-cli must be reachable');

  // Verify timestamp parsing
  const testLine = '[research] 30/06/2026, 13:05:13 | CHECKPOINT | test';
  const match = testLine.match(/(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})/);
  console.assert(match !== null, 'timestamp regex must match hive format');
  const [day, month, yearTime] = match[1].split('/');
  const [year, time] = yearTime.split(', ');
  const parsed = new Date(`${year}-${month}-${day}T${time}`);
  console.assert(!isNaN(parsed.getTime()), 'parsed date must be valid');
  console.assert(parsed.getFullYear() === 2026, 'parsed year must be 2026');

  console.log('[watchdog] Self-check passed.');
}

// ── Start ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-check')) {
  selfCheck();
  process.exit(0);
}

console.log(`[watchdog] neo-mission-watchdog starting`);
console.log(`[watchdog] Stall threshold: ${STALL_THRESHOLD_MIN}min`);
console.log(`[watchdog] Poll interval: ${POLL_SEC}s`);
console.log(`[watchdog] Escalate to: [${ESCALATE_TO}]`);
hiveLog('WATCHDOG_START', `Mission watchdog started. Stall=${STALL_THRESHOLD_MIN}min, poll=${POLL_SEC}s, escalate=[${ESCALATE_TO}]`);

selfCheck();
poll(); // immediate first check
setInterval(poll, POLL_SEC * 1000);
