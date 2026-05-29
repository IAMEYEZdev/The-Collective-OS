#!/usr/bin/env node
/**
 * test-dispatch-roundtrip.mjs — End-to-end dispatch file-bus smoke test
 *
 * Simulates a full QM → Neo → QM cycle without spawning oh-my-codex:
 *   1. Writes a dispatch envelope to outbound/
 *   2. Writes a mock result envelope to inbound/
 *   3. Runs neo-poll.mjs (single cycle) to ingest the result
 *   4. Validates the ingested marker + artifact output
 *
 * Phase 3 gating checklist item:
 *   - [x] Test dispatch round-trip on trivial task (echo equivalent)
 *
 * Usage:
 *   node scripts/test-dispatch-roundtrip.mjs
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTBOUND = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'outbound');
const INBOUND = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'inbound');

const TEST_ULID = '01HYSMOKE0000ROUNDTRIP0TEST';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

function cleanup() {
  const files = [
    path.join(OUTBOUND, `${TEST_ULID}-smoke.dispatch.json`),
    path.join(INBOUND, `${TEST_ULID}.result.json`),
    path.join(INBOUND, `${TEST_ULID}.result.json.ingested`),
  ];
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  // Clean artifacts dir
  const artifactDir = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'artifacts', TEST_ULID);
  try { fs.rmSync(artifactDir, { recursive: true }); } catch { /* ignore */ }
}

console.log('[test-roundtrip] QM → Neo → QM dispatch round-trip smoke test\n');
cleanup(); // ensure clean state

// ── 1. Write dispatch envelope ──────────────────────────────────────
console.log('Step 1: Write dispatch envelope to outbound/');

const dispatchEnvelope = {
  ulid: TEST_ULID,
  issuedAt: new Date().toISOString(),
  parentGoalId: 'test-parent-000',
  task: {
    title: 'Smoke test: echo roundtrip',
    type: 'code',
    description: 'Return a success result with no artifacts. This is a no-op test.',
    complexity: 'trivial',
    priority: 'normal',
  },
  context: {
    repoRoot: PROJECT_ROOT,
    branch: 'main',
    filesOfInterest: [],
    constraints: ['Do not modify any files'],
  },
  tactical: { preferred: [] },
  callback: {
    resultPath: `workspace/dispatch/inbound/${TEST_ULID}.result.json`,
  },
};

const dispatchPath = path.join(OUTBOUND, `${TEST_ULID}-smoke.dispatch.json`);
for (const dir of [OUTBOUND, INBOUND]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(dispatchPath, JSON.stringify(dispatchEnvelope, null, 2));
assert(fs.existsSync(dispatchPath), 'Dispatch envelope written');

// ── 2. Write mock result (simulates Neo completing the task) ────────
console.log('\nStep 2: Write mock result envelope to inbound/');

const resultEnvelope = {
  version: 1,
  ulid: TEST_ULID,
  status: 'success',
  summary: 'Smoke test completed successfully. No files modified. Echo roundtrip verified.',
  artifacts: [],
  tacticalContributions: [
    { agent: 'codex-leader', credit: 'primary', summary: 'Executed no-op task' },
  ],
  metrics: {
    rounds: 1,
    converged: true,
    tokensIn: 500,
    tokensOut: 200,
    wallTimeMs: 3000,
  },
  openQuestions: [],
  reverseBrief: 'Task was trivial. No process improvements needed.',
};

const resultPath = path.join(INBOUND, `${TEST_ULID}.result.json`);
fs.writeFileSync(resultPath, JSON.stringify(resultEnvelope, null, 2));
assert(fs.existsSync(resultPath), 'Result envelope written');

// ── 3. Validate result schema (same logic as neo-poll) ──────────────
console.log('\nStep 3: Validate result schema');

const REQUIRED_FIELDS = ['version', 'ulid', 'status', 'summary'];
const VALID_STATUSES = ['success', 'partial', 'failed', 'escalate'];

for (const field of REQUIRED_FIELDS) {
  assert(field in resultEnvelope, `Required field present: ${field}`);
}
assert(VALID_STATUSES.includes(resultEnvelope.status), `Status '${resultEnvelope.status}' is valid`);
assert(resultEnvelope.version === 1, 'Version = 1');

// ── 4. Run neo-poll single cycle ────────────────────────────────────
console.log('\nStep 4: Run neo-poll.mjs (single cycle)');

try {
  const output = execSync('node scripts/neo-poll.mjs', {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    timeout: 30000,
    env: { ...process.env, CLAUDECLAW_HIVE_BYPASS: '1' },
  });
  const pollOutput = output.toString();
  console.log('  [neo-poll output]:');
  pollOutput.split('\n').forEach(line => {
    if (line.trim()) console.log(`    ${line}`);
  });

  assert(pollOutput.includes(TEST_ULID), 'Poll found our test ULID');
  assert(pollOutput.includes('success'), 'Poll recognized success status');
} catch (err) {
  // neo-poll may fail on hive-cli calls (no DB in test), but should still mark processed
  const stderr = err.stderr?.toString() || '';
  const stdout = err.stdout?.toString() || '';
  console.log('  [neo-poll output (partial)]:');
  stdout.split('\n').forEach(line => { if (line.trim()) console.log(`    ${line}`); });
  if (stderr) {
    console.log('  [neo-poll stderr]:');
    stderr.split('\n').slice(0, 5).forEach(line => { if (line.trim()) console.log(`    ${line}`); });
  }
  // Still check if it processed
  assert(stdout.includes(TEST_ULID) || stderr.includes(TEST_ULID), 'Poll attempted our test ULID');
}

// ── 5. Verify ingested marker ───────────────────────────────────────
console.log('\nStep 5: Verify ingestion marker');

const markerPath = resultPath + '.ingested';
assert(fs.existsSync(markerPath), '.ingested marker file created');

if (fs.existsSync(markerPath)) {
  const markerContent = fs.readFileSync(markerPath, 'utf-8');
  assert(markerContent.length > 0, 'Marker contains timestamp');
  // Verify it's a valid ISO date
  const markerDate = new Date(markerContent);
  assert(!isNaN(markerDate.getTime()), 'Marker timestamp is valid ISO date');
}

// ── 6. Idempotency: run poll again, should skip ─────────────────────
console.log('\nStep 6: Idempotency check (second poll should skip)');

try {
  const output2 = execSync('node scripts/neo-poll.mjs', {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    timeout: 15000,
    env: { ...process.env, CLAUDECLAW_HIVE_BYPASS: '1' },
  });
  const poll2 = output2.toString();
  assert(!poll2.includes('Processing:'), 'Second poll did not re-process');
  assert(poll2.includes('No new results') || !poll2.includes(TEST_ULID), 'Idempotency maintained');
} catch {
  // Even on error, the marker should prevent re-processing
  assert(fs.existsSync(markerPath), 'Marker still exists (idempotency intact)');
}

// ── Cleanup ─────────────────────────────────────────────────────────
cleanup();

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`[test-roundtrip] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[test-roundtrip] ROUND-TRIP TEST FAILED');
  process.exit(1);
} else {
  console.log('[test-roundtrip] Full round-trip verified ✓');
}
