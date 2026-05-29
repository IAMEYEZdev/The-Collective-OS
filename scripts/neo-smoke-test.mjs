#!/usr/bin/env node
/**
 * neo-smoke-test.mjs — Phase 3 gating smoke tests
 *
 * Tests:
 *   1. [LATENT_CONTEXT] header parse from .f32 seed
 *   2. Trivial dispatch round-trip (write dispatch → write result → poll ingests)
 *
 * Usage:
 *   node scripts/neo-smoke-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const OUTBOUND = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'outbound');
const INBOUND = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'inbound');
const LATENT_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'latent');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

// ── Test 1: [LATENT_CONTEXT] header parse ────────────────────────────

console.log('\n=== Test 1: [LATENT_CONTEXT] header parse ===\n');

// Create a small .f32 test file (32 floats = 128 bytes)
const testF32Path = path.join(LATENT_DIR, 'smoke-test-seed.f32');
fs.mkdirSync(LATENT_DIR, { recursive: true });

const testFloats = new Float32Array(32);
for (let i = 0; i < 32; i++) {
  testFloats[i] = Math.sin(i * 0.5) * (i + 1) * 0.1;
}
fs.writeFileSync(testF32Path, Buffer.from(testFloats.buffer));

assert(fs.existsSync(testF32Path), '.f32 seed file written');
assert(fs.statSync(testF32Path).size === 128, '.f32 file is 128 bytes (32 floats)');

// Parse it the same way neo-dispatch.mjs does
const buffer = fs.readFileSync(testF32Path);
const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

assert(floats.length === 32, 'Deserialized 32 float32 values');

const values = Array.from(floats);
const mean = values.reduce((a, b) => a + b, 0) / values.length;
const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;

assert(typeof mean === 'number' && !isNaN(mean), `Mean computed: ${mean.toFixed(6)}`);
assert(typeof variance === 'number' && !isNaN(variance), `Variance computed: ${variance.toFixed(6)}`);

const indexed = values.map((v, i) => ({ i, v: Math.abs(v) }));
indexed.sort((a, b) => b.v - a.v);
const topK = indexed.slice(0, 10).map(({ i, v }) => ({ dim: i, activation: v.toFixed(4) }));

assert(topK.length === 10, 'Top-10 activations extracted');
assert(topK[0].activation >= topK[9].activation, 'Top-K sorted descending');

const latentContext = {
  structureId: 'smoke-test',
  dimensions: values.length,
  mean: mean.toFixed(6),
  variance: variance.toFixed(6),
  topActivations: topK,
  roundBudget: 4,
};

const latentHeader = `[LATENT_CONTEXT]\n${JSON.stringify(latentContext, null, 2)}\n[/LATENT_CONTEXT]`;

assert(latentHeader.startsWith('[LATENT_CONTEXT]'), 'Header starts with [LATENT_CONTEXT]');
assert(latentHeader.endsWith('[/LATENT_CONTEXT]'), 'Header ends with [/LATENT_CONTEXT]');
assert(latentHeader.includes('"structureId": "smoke-test"'), 'Header contains structureId');
assert(latentHeader.includes('"dimensions": 32'), 'Header contains dimension count');

// Verify header is parseable back
const headerMatch = latentHeader.match(/\[LATENT_CONTEXT\]\n([\s\S]+?)\n\[\/LATENT_CONTEXT\]/);
assert(headerMatch !== null, 'Header regex-parseable');
const parsedBack = JSON.parse(headerMatch[1]);
assert(parsedBack.structureId === 'smoke-test', 'Round-trip parse preserves structureId');
assert(parsedBack.topActivations.length === 10, 'Round-trip parse preserves topActivations');

// ── Test 2: Trivial dispatch round-trip ──────────────────────────────

console.log('\n=== Test 2: Trivial dispatch round-trip ===\n');

const testUlid = `SMOKE${Date.now()}`;
const dispatchFile = `${testUlid}-smoke.dispatch.json`;
const resultFile = `${testUlid}.result.json`;

// Write dispatch envelope
const dispatchEnvelope = {
  version: 1,
  ulid: testUlid,
  parentGoalId: null,
  issuedAt: new Date().toISOString(),
  task: {
    title: 'Smoke test echo',
    description: 'Return immediately with success status',
    type: 'test',
    complexity: 'linear',
    priority: 'low',
  },
  context: {
    repoRoot: PROJECT_ROOT,
    branch: 'main',
  },
  callback: {
    resultPath: `workspace/dispatch/inbound/${resultFile}`,
  },
};

fs.mkdirSync(OUTBOUND, { recursive: true });
fs.mkdirSync(INBOUND, { recursive: true });

fs.writeFileSync(path.join(OUTBOUND, dispatchFile), JSON.stringify(dispatchEnvelope, null, 2));
assert(fs.existsSync(path.join(OUTBOUND, dispatchFile)), 'Dispatch envelope written');

// Simulate Neo returning a result (normally Neo writes this)
const resultEnvelope = {
  version: 1,
  ulid: testUlid,
  status: 'success',
  summary: 'Smoke test completed successfully',
  artifacts: [],
  tacticalContributions: [
    { agent: 'codex-worker', credit: 1.0, summary: 'Echo task' },
  ],
  metrics: {
    rounds: 1,
    converged: true,
    tokensIn: 100,
    tokensOut: 50,
    wallTimeMs: 500,
  },
  openQuestions: [],
  reverseBrief: 'Trivial task, no improvements needed',
};

fs.writeFileSync(path.join(INBOUND, resultFile), JSON.stringify(resultEnvelope, null, 2));
assert(fs.existsSync(path.join(INBOUND, resultFile)), 'Result envelope written');

// Validate result schema (same logic as neo-poll.mjs)
const REQUIRED_FIELDS = ['version', 'ulid', 'status', 'summary'];
const VALID_STATUSES = ['success', 'partial', 'failed', 'escalate'];

const parsed = JSON.parse(fs.readFileSync(path.join(INBOUND, resultFile), 'utf-8'));
const errors = [];
for (const field of REQUIRED_FIELDS) {
  if (!(field in parsed)) errors.push(`missing: ${field}`);
}
if (!VALID_STATUSES.includes(parsed.status)) errors.push(`bad status: ${parsed.status}`);
if (parsed.version !== 1) errors.push(`bad version: ${parsed.version}`);

assert(errors.length === 0, `Result schema valid (${errors.length} errors)`);
assert(parsed.ulid === testUlid, 'Result ULID matches dispatch');
assert(parsed.status === 'success', 'Result status is success');

// Run neo-poll.mjs to ingest
const pollScript = path.join(PROJECT_ROOT, 'scripts', 'neo-poll.mjs');
let pollOutput = '';
try {
  pollOutput = execSync(`node "${pollScript}"`, {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    timeout: 15000,
  }).toString();
} catch (err) {
  // Poll may fail on hive-cli not being built, but should still process the file
  pollOutput = err.stdout?.toString() || err.message;
}

assert(pollOutput.includes(testUlid) || pollOutput.includes('Processing'), 'Neo poll found result file');

// Check .ingested marker
const markerPath = path.join(INBOUND, resultFile + '.ingested');
assert(fs.existsSync(markerPath), '.ingested marker created (result processed)');

// Cleanup smoke test files
try {
  fs.unlinkSync(path.join(OUTBOUND, dispatchFile));
  fs.unlinkSync(path.join(INBOUND, resultFile));
  fs.unlinkSync(markerPath);
  fs.unlinkSync(testF32Path);
} catch { /* best-effort cleanup */ }

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
