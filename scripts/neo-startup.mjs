#!/usr/bin/env node
/**
 * neo-startup.mjs — Phase 3 startup sequence
 *
 * Run at QM (Melanie) session start to initialize Neo infrastructure:
 *   1. Register Neo agent in Hermes L4 registry
 *   2. Start neo-poll.mjs in watch mode (60s polling)
 *   3. Verify dispatch directories exist
 *
 * Usage:
 *   node scripts/neo-startup.mjs           — register + verify only
 *   node scripts/neo-startup.mjs --poll    — register + start poller
 *
 * Phase 3 gating checklist items covered:
 *   - [x] `neo` agent registered in Hermes registry at QM session start
 *   - [x] Cron entry registered (60s poll via --watch)
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const startPoll = process.argv.includes('--poll');

console.log('[neo-startup] Phase 3 infrastructure init');
console.log('─'.repeat(50));

// ── 1. Verify dispatch directories ──────────────────────────────────
const requiredDirs = [
  'workspace/dispatch/outbound',
  'workspace/dispatch/inbound',
  'workspace/dispatch/artifacts',
  'workspace/dispatch/latent',
  'workspace/dispatch/progress',
];

let dirsOk = true;
for (const dir of requiredDirs) {
  const fullPath = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`[neo-startup] Created: ${dir}`);
  }
}
console.log('[neo-startup] Dispatch directories: OK');

// ── 2. Register Neo in Hermes L4 ────────────────────────────────────
try {
  execSync('node scripts/register-neo-agent.mjs', {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    timeout: 15000,
  });
} catch (err) {
  console.error(`[neo-startup] WARNING: Neo registration failed (non-fatal): ${err.message}`);
  console.error('[neo-startup] Dispatch will still work in text-only mode');
}

// ── 3. Start poller (if --poll) ─────────────────────────────────────
if (startPoll) {
  console.log('[neo-startup] Starting neo-poll.mjs in watch mode...');

  const poller = spawn('node', ['scripts/neo-poll.mjs', '--watch'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    detached: true,
  });

  poller.unref();
  console.log(`[neo-startup] Poller started (PID: ${poller.pid})`);
} else {
  console.log('[neo-startup] Poller not started (use --poll to enable)');
}

// ── 4. Summary ──────────────────────────────────────────────────────
console.log('─'.repeat(50));
console.log('[neo-startup] Phase 3 infrastructure ready');
console.log(`  Dispatch dirs:  ✓`);
console.log(`  Hermes Neo:     ✓ (or degraded)`);
console.log(`  Poller:         ${startPoll ? '✓ running' : '○ manual'}`);
console.log(`  Dispatch CLI:   node scripts/neo-dispatch.mjs <ulid>`);
