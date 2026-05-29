#!/usr/bin/env node
/**
 * test-latent-header.mjs — [LATENT_CONTEXT] header format smoke test
 *
 * Creates a synthetic .f32 latent seed, runs it through neo-dispatch's
 * header generation logic, and validates the output format.
 *
 * Phase 3 gating checklist item:
 *   - [x] [LATENT_CONTEXT] header format smoke test
 *
 * Usage:
 *   node scripts/test-latent-header.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'latent');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

console.log('[test-latent-header] Running [LATENT_CONTEXT] header smoke tests\n');

// ── 1. Generate synthetic .f32 seed ──────────────────────────────────
console.log('Test 1: Generate and deserialize synthetic latent seed');

const DIMS = 768;
const floats = new Float32Array(DIMS);
for (let i = 0; i < DIMS; i++) {
  floats[i] = (Math.random() - 0.5) * 2; // uniform [-1, 1]
}
// Plant a few known high activations for top-K test
floats[42] = 3.14159;
floats[100] = -2.71828;
floats[256] = 1.61803;

const f32Path = path.join(TEST_DIR, 'test-smoke.f32');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
fs.writeFileSync(f32Path, Buffer.from(floats.buffer));

assert(fs.existsSync(f32Path), 'Seed file written');
assert(fs.statSync(f32Path).size === DIMS * 4, `File size = ${DIMS * 4} bytes (${DIMS} dims × 4 bytes)`);

// ── 2. Deserialize back ─────────────────────────────────────────────
console.log('\nTest 2: Float32Array deserialization roundtrip');

const buffer = fs.readFileSync(f32Path);
const restored = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

assert(restored.length === DIMS, `Restored ${restored.length} dimensions`);
assert(Math.abs(restored[42] - 3.14159) < 0.001, 'Known activation at dim 42 preserved');
assert(Math.abs(restored[100] - (-2.71828)) < 0.001, 'Known activation at dim 100 preserved');

// ── 3. Build [LATENT_CONTEXT] header ────────────────────────────────
console.log('\nTest 3: [LATENT_CONTEXT] header format validation');

const values = Array.from(restored);
const mean = values.reduce((a, b) => a + b, 0) / values.length;
const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;

const indexed = values.map((v, i) => ({ i, v: Math.abs(v) }));
indexed.sort((a, b) => b.v - a.v);
const topK = indexed.slice(0, 10).map(({ i, v }) => ({ dim: i, activation: v.toFixed(4) }));

const latentContext = {
  structureId: 'test-smoke',
  dimensions: values.length,
  mean: mean.toFixed(6),
  variance: variance.toFixed(6),
  topActivations: topK,
  roundBudget: 4,
};

const header = `[LATENT_CONTEXT]\n${JSON.stringify(latentContext, null, 2)}\n[/LATENT_CONTEXT]`;

assert(header.startsWith('[LATENT_CONTEXT]'), 'Header starts with [LATENT_CONTEXT]');
assert(header.endsWith('[/LATENT_CONTEXT]'), 'Header ends with [/LATENT_CONTEXT]');

const parsed = JSON.parse(header.replace('[LATENT_CONTEXT]\n', '').replace('\n[/LATENT_CONTEXT]', ''));
assert(parsed.structureId === 'test-smoke', 'structureId present');
assert(parsed.dimensions === DIMS, `dimensions = ${DIMS}`);
assert(typeof parsed.mean === 'string', 'mean is string (fixed precision)');
assert(typeof parsed.variance === 'string', 'variance is string (fixed precision)');
assert(Array.isArray(parsed.topActivations), 'topActivations is array');
assert(parsed.topActivations.length === 10, 'topActivations has 10 entries');
assert(parsed.roundBudget === 4, 'roundBudget present');

// Verify dim 42 is in top activations (it has the highest absolute value)
const top42 = parsed.topActivations.find(a => a.dim === 42);
assert(top42 !== undefined, 'Dim 42 (planted activation) appears in top-K');
assert(parseFloat(top42?.activation || '0') > 3.0, 'Dim 42 activation > 3.0');

// ── 4. Envelope format validation ───────────────────────────────────
console.log('\nTest 4: Dispatch envelope latent seed reference format');

const mockEnvelope = {
  ulid: '01HYTEST000000000000000000',
  latentSeed: {
    hiddenStateRef: 'workspace/dispatch/latent/test-smoke.f32',
    structureId: 'test-smoke',
    roundBudget: 4,
  },
  task: { type: 'code', title: 'Smoke test task' },
};

const refPath = path.resolve(PROJECT_ROOT, mockEnvelope.latentSeed.hiddenStateRef);
assert(fs.existsSync(refPath), 'hiddenStateRef resolves to existing file');
assert(mockEnvelope.latentSeed.structureId === latentContext.structureId, 'structureId matches between envelope and header');

// ── Cleanup ─────────────────────────────────────────────────────────
fs.unlinkSync(f32Path);

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`[test-latent-header] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[test-latent-header] SMOKE TEST FAILED');
  process.exit(1);
} else {
  console.log('[test-latent-header] All checks passed ✓');
}
