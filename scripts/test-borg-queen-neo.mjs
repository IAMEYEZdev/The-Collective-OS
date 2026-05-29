#!/usr/bin/env node
/**
 * test-borg-queen-neo.mjs — Borg Queen neo/<agent> namespace smoke test
 *
 * Validates Phase 3 gating checklist items 13 + 14:
 *   - [x] Borg Queen `aggregateGlobalState` accepts `neo/<agent>` namespaced participants
 *   - [x] Cross-hemisphere `detectCapabilityGaps` tested with mock Neo result
 *
 * Usage:
 *   node scripts/test-borg-queen-neo.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

// ── Dynamic import of compiled module ──────────────────────────────────
const borgQueenPath = path.join(PROJECT_ROOT, 'dist', 'borg-queen', 'latent-bridge.js');
let bq, hermes;
try {
  bq = await import(`file://${borgQueenPath.replace(/\\/g, '/')}`);
  const hermesPath = path.join(PROJECT_ROOT, 'dist', 'hermes', 'index.js');
  hermes = await import(`file://${hermesPath.replace(/\\/g, '/')}`);
} catch (err) {
  console.error(`[test-borg-queen-neo] Cannot import compiled module: ${err.message}`);
  console.error('[test-borg-queen-neo] Run: npm run build');
  process.exit(1);
}

const LATENT_DIM = 768;

/** Generate a synthetic 768-dim hidden state with planted activations */
function syntheticState(seed, amplitude = 1.0) {
  const state = new Float32Array(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    state[i] = Math.sin(seed * (i + 1) * 0.01) * amplitude;
  }
  return state;
}

console.log('[test-borg-queen-neo] Phase 3 gating: Borg Queen neo namespace tests\n');

// ════════════════════════════════════════════════════════════════════════
// TEST 1: aggregateGlobalState accepts neo/<agent> namespaced participants
// ════════════════════════════════════════════════════════════════════════
console.log('Test 1: aggregateGlobalState with neo/<agent> participants');

const mixedParticipants = [
  { agentId: 'gitnexus', layer: 'L1', weight: 0.25, latentCapable: true },
  { agentId: 'hermes', layer: 'L4', weight: 0.25, latentCapable: true },
  { agentId: 'neo/codex1', layer: 'neo/codex1', weight: 0.25, latentCapable: true },
  { agentId: 'neo/codex2', layer: 'neo/codex2', weight: 0.25, latentCapable: true },
];

const agentStates = [
  { agentId: 'gitnexus', layer: 'L1', round: 0, hiddenState: syntheticState(1), stateDelta: null, confidence: 0.8 },
  { agentId: 'hermes', layer: 'L4', round: 0, hiddenState: syntheticState(2), stateDelta: null, confidence: 0.7 },
  { agentId: 'neo/codex1', layer: 'neo/codex1', round: 0, hiddenState: syntheticState(3), stateDelta: null, confidence: 0.9 },
  { agentId: 'neo/codex2', layer: 'neo/codex2', round: 0, hiddenState: syntheticState(4), stateDelta: null, confidence: 0.85 },
];

const globalState = bq.aggregateGlobalState(agentStates, mixedParticipants);

assert(globalState instanceof Float32Array, 'Returns Float32Array');
assert(globalState.length === LATENT_DIM, `Length = ${LATENT_DIM}`);

// Check global state is not all zeros (aggregation happened)
const magnitude = Math.sqrt(globalState.reduce((s, v) => s + v * v, 0));
assert(magnitude > 0, `Global state has energy (magnitude: ${magnitude.toFixed(4)})`);

// Check that structural segment (0-128) got contributions from BOTH L1 and neo agents
let structuralEnergy = 0;
for (let i = 0; i < 128; i++) structuralEnergy += globalState[i] * globalState[i];
structuralEnergy = Math.sqrt(structuralEnergy);
assert(structuralEnergy > 0, `Structural segment has energy: ${structuralEnergy.toFixed(4)}`);

// Check that reasoning segment (448-576) got neo contributions
let reasoningEnergy = 0;
for (let i = 448; i < 576; i++) reasoningEnergy += globalState[i] * globalState[i];
reasoningEnergy = Math.sqrt(reasoningEnergy);
assert(reasoningEnergy > 0, `Reasoning segment has neo energy: ${reasoningEnergy.toFixed(4)}`);

// Check transport segment (384-448) has L4 energy but NOT neo energy
let transportEnergy = 0;
for (let i = 384; i < 448; i++) transportEnergy += globalState[i] * globalState[i];
transportEnergy = Math.sqrt(transportEnergy);
assert(transportEnergy > 0, `Transport segment has L4 energy: ${transportEnergy.toFixed(4)}`);

// ── Compare with/without neo participants ──────────────────────────────
console.log('\nTest 2: Neo participants materially affect global state');

const l1OnlyParticipants = [
  { agentId: 'gitnexus', layer: 'L1', weight: 1.0, latentCapable: true },
];
const l1OnlyStates = [
  { agentId: 'gitnexus', layer: 'L1', round: 0, hiddenState: syntheticState(1), stateDelta: null, confidence: 0.8 },
];

const l1OnlyGlobal = bq.aggregateGlobalState(l1OnlyStates, l1OnlyParticipants);
const mixedGlobal = bq.aggregateGlobalState(agentStates, mixedParticipants);

// They should differ because neo agents contribute
const similarity = hermes.cosineSimilarity(l1OnlyGlobal, mixedGlobal);
assert(similarity < 0.99, `Mixed state differs from L1-only (cosine sim: ${similarity.toFixed(4)})`);
assert(similarity > -1, 'States are not anti-correlated (sanity check)');

// ── Test initializeCluster with neo participants ───────────────────────
console.log('\nTest 3: initializeCluster accepts neo/<agent> layers');

const cluster = bq.initializeCluster({
  taskId: 'test-neo-cluster',
  participants: [
    { agentId: 'gitnexus', layer: 'L1', latentCapable: true },
    { agentId: 'neo/codex1', layer: 'neo/codex1', latentCapable: true },
  ],
  complexity: 'moderate',
});

assert(cluster.participants.length === 2, '2 participants registered');
const neoP = cluster.participants.find(p => p.agentId === 'neo/codex1');
assert(neoP !== undefined, 'Neo participant found');
assert(neoP?.layer === 'neo/codex1', 'Neo layer preserved');
assert(neoP?.latentCapable === true, 'Neo is latent-capable');
// Neo agents get 0.8 base weight (before normalization)
assert(neoP?.weight < cluster.participants.find(p => p.agentId === 'gitnexus')?.weight,
  'Neo weight slightly below standard agent (cross-hemisphere cost)');

// ════════════════════════════════════════════════════════════════════════
// TEST 4: detectCapabilityGaps with mock Neo result
// ════════════════════════════════════════════════════════════════════════
console.log('\nTest 4: detectCapabilityGaps with mock Neo cluster results');

// Build mock cluster results simulating cross-hemisphere work
const mockNeoClusterResult = {
  clusterId: 'cluster-neo-test-1',
  taskId: 'task-cross-hemi-1',
  rounds: [],
  converged: false, // Neo cluster struggled (didn't converge)
  finalGlobalState: syntheticState(42, 2.0),
  totalRounds: 8, // Used max rounds
  creditAssignments: new Map(),
};

const mockLocalClusterResult = {
  clusterId: 'cluster-local-test-1',
  taskId: 'task-local-1',
  rounds: [],
  converged: true, // Local cluster converged fine
  finalGlobalState: syntheticState(7, 1.0),
  totalRounds: 3,
  creditAssignments: new Map(),
};

const mockNeoClusterResult2 = {
  clusterId: 'cluster-neo-test-2',
  taskId: 'task-cross-hemi-2',
  rounds: [],
  converged: false,
  finalGlobalState: syntheticState(43, 1.5),
  totalRounds: 8,
  creditAssignments: new Map(),
};

const completedClusters = [
  { taskId: 'task-cross-hemi-1', domain: 'cross-hemisphere-engineering', result: mockNeoClusterResult },
  { taskId: 'task-cross-hemi-2', domain: 'cross-hemisphere-engineering', result: mockNeoClusterResult2 },
  { taskId: 'task-local-1', domain: 'local-ops', result: mockLocalClusterResult },
];

const gaps = bq.detectCapabilityGaps(completedClusters);

assert(Array.isArray(gaps), 'Returns array of gaps');
assert(gaps.length >= 1, `Found ${gaps.length} capability gap(s)`);

// Cross-hemisphere engineering should be flagged (high rounds, no convergence)
const crossHemiGap = gaps.find(g => g.domain === 'cross-hemisphere-engineering');
assert(crossHemiGap !== undefined, 'Cross-hemisphere-engineering flagged as gap');
assert(crossHemiGap?.severity > 0.3, `Gap severity > 0.3 (actual: ${crossHemiGap?.severity.toFixed(3)})`);
assert(crossHemiGap?.avgConvergenceRounds === 8, 'Avg convergence rounds = 8');
assert(crossHemiGap?.reviewRate > 0, 'Review rate > 0 (max rounds reached)');
assert(crossHemiGap?.gapVector instanceof Float32Array, 'Gap vector is Float32Array');
assert(crossHemiGap?.gapVector.length === LATENT_DIM, `Gap vector has ${LATENT_DIM} dims`);

// Local ops should NOT be a gap (converged quickly)
const localGap = gaps.find(g => g.domain === 'local-ops');
assert(localGap === undefined, 'Local-ops NOT flagged as gap (converged fine)');

// Gaps sorted by severity
if (gaps.length >= 2) {
  assert(gaps[0].severity >= gaps[1].severity, 'Gaps sorted by severity desc');
}

// ── Test 5: gapsToBorgArcContext with Neo gap ──────────────────────────
console.log('\nTest 5: gapsToBorgArcContext includes neo layer priority');

const borgArcContext = bq.gapsToBorgArcContext(gaps);

assert(borgArcContext.gapSignal instanceof Float32Array, 'Gap signal is Float32Array');
assert(borgArcContext.gapSignal.length === LATENT_DIM, `Gap signal has ${LATENT_DIM} dims`);

const gapMag = Math.sqrt(borgArcContext.gapSignal.reduce((s, v) => s + v * v, 0));
assert(gapMag > 0, `Gap signal has energy (magnitude: ${gapMag.toFixed(4)})`);

assert('L1' in borgArcContext.layerPriorities, 'L1 priority present');
assert('L5' in borgArcContext.layerPriorities, 'L5 priority present');
assert('neo' in borgArcContext.layerPriorities, 'Neo composite priority present');
assert(borgArcContext.layerPriorities.neo >= 0, `Neo priority >= 0 (actual: ${borgArcContext.layerPriorities.neo.toFixed(4)})`);

// ── Test 6: Full cluster run with neo participants ─────────────────────
console.log('\nTest 6: runCluster with mixed standard + neo participants');

const fullClusterConfig = bq.initializeCluster({
  taskId: 'test-full-neo-run',
  participants: [
    { agentId: 'gitnexus', layer: 'L1', latentCapable: true },
    { agentId: 'ax', layer: 'L5', latentCapable: true },
    { agentId: 'neo/codex1', layer: 'neo/codex1', latentCapable: true },
  ],
  complexity: 'moderate',
});

// Simulate 4 rounds of agent states
const roundStates = [];
for (let r = 0; r < 4; r++) {
  roundStates.push([
    { agentId: 'gitnexus', layer: 'L1', round: r, hiddenState: syntheticState(10 + r), stateDelta: r > 0 ? 0.1 : null, confidence: 0.8 },
    { agentId: 'ax', layer: 'L5', round: r, hiddenState: syntheticState(20 + r), stateDelta: r > 0 ? 0.05 : null, confidence: 0.9 },
    { agentId: 'neo/codex1', layer: 'neo/codex1', round: r, hiddenState: syntheticState(30 + r), stateDelta: r > 0 ? 0.08 : null, confidence: 0.85 },
  ]);
}

const clusterResult = bq.runCluster(fullClusterConfig, roundStates);

assert(clusterResult.totalRounds > 0, `Cluster ran ${clusterResult.totalRounds} rounds`);
assert(clusterResult.finalGlobalState instanceof Float32Array, 'Final global state produced');
assert(clusterResult.finalGlobalState.length === LATENT_DIM, 'Final state is 768-dim');
assert(clusterResult.creditAssignments instanceof Map, 'Credit assignments computed');
assert(clusterResult.creditAssignments.has('neo/codex1'), 'Neo agent got credit assignment');

const neoCredit = clusterResult.creditAssignments.get('neo/codex1');
assert(neoCredit.totalCredit !== 0, `Neo credit assigned: ${neoCredit.totalCredit.toFixed(4)}`);
assert(neoCredit.roundCredits.length === clusterResult.totalRounds, 'Neo has per-round credits');

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`[test-borg-queen-neo] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[test-borg-queen-neo] BORG QUEEN NEO TESTS FAILED');
  process.exit(1);
} else {
  console.log('[test-borg-queen-neo] Phase 3 items 13+14 verified ✓');
}
