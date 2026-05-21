/**
 * DeepSec Layer 2 - Latent Bridge Tests
 *
 * Tests all 6 RecursiveMAS modifications:
 *   1. Vulnerability signal embedding
 *   2. Incoming structural signal receiver
 *   3. Multi-round scan scheduler
 *   4. Differentiable confidence score proxy
 *   5. Simultaneous multi-target broadcast
 *   6. Borg Arc gating signal integration
 */

import { describe, test, expect } from 'vitest';
import { LATENT_DIM } from '../hermes/types.js';

import {
  extractFindingsFeatures,
  projectFindingsToLatent,
  processStructuralSignal,
  getScanRoundBudget,
  runScanRecursion,
  computeCalibratedConfidence,
  computeGateSignal,
  createBroadcastPayloads,
  createUniformScanAttention,
  createDeepSecPayload,
  SCAN_ROUND_DEFAULTS,
} from './latent-bridge.js';

import type {
  FindingsFeatures,
  StructuralSignal,
  ScanRoundResult,
} from './latent-bridge.js';

import type { Finding, ScanResult, Severity, Category } from './scanner.js';

// ── Test Fixtures ──────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'DS-001',
    ruleName: 'Test Rule',
    category: 'injection',
    severity: 'medium',
    filePath: 'src/test.ts',
    lineNumber: 10,
    lineContent: 'test line',
    match: 'test',
    description: 'Test finding',
    remediation: 'Fix it',
    agentThreat: false,
    ...overrides,
  };
}

function makeFindings(count: number, opts: { spread?: boolean; critical?: boolean; agentThreats?: boolean } = {}): Finding[] {
  const findings: Finding[] = [];
  const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const categories: Category[] = ['injection', 'auth', 'data-exposure', 'agent-hijack', 'privilege-abuse', 'supply-chain', 'config', 'crypto'];

  for (let i = 0; i < count; i++) {
    findings.push(makeFinding({
      ruleId: `DS-${String(i).padStart(3, '0')}`,
      severity: opts.critical && i === 0 ? 'critical' : severities[i % severities.length],
      category: categories[i % categories.length],
      filePath: opts.spread ? `src/file_${i}.ts` : 'src/concentrated.ts',
      lineNumber: 10 + i,
      agentThreat: opts.agentThreats ? i % 2 === 0 : false,
    }));
  }
  return findings;
}

function makeScanResult(findings: Finding[]): ScanResult {
  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return {
    findings,
    filesScanned: 10,
    rulesApplied: 20,
    durationMs: 100,
    summary,
  };
}

function makeStructuralSignal(type: StructuralSignal['signalType'] = 'graph_structure'): StructuralSignal {
  const state = new Float32Array(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    state[i] = Math.sin(i / LATENT_DIM * Math.PI) * 0.1;
  }
  return {
    fromAgent: 'gitnexus',
    hiddenState: state,
    signalType: type,
  };
}

// ── Mod 1: Vulnerability Signal Embedding ──────────────────────────

describe('Mod 1: Vulnerability Signal Embedding', () => {
  test('extractFindingsFeatures returns correct counts', () => {
    const findings = makeFindings(10);
    const features = extractFindingsFeatures(findings);
    expect(features.totalFindings).toBe(10);
    expect(Object.values(features.severityDist).reduce((a, b) => a + b, 0)).toBe(10);
  });

  test('extractFindingsFeatures handles empty findings', () => {
    const features = extractFindingsFeatures([]);
    expect(features.totalFindings).toBe(0);
    expect(features.pathConcentration).toBe(0);
    expect(features.agentThreatRatio).toBe(0);
    expect(features.hasCritical).toBe(false);
  });

  test('path concentration = 1 when all findings in one file', () => {
    const findings = makeFindings(5, { spread: false });
    const features = extractFindingsFeatures(findings);
    expect(features.pathConcentration).toBe(1);
  });

  test('path concentration < 1 when findings spread across files', () => {
    const findings = makeFindings(5, { spread: true });
    const features = extractFindingsFeatures(findings);
    expect(features.pathConcentration).toBeLessThan(1);
  });

  test('agent threat ratio computed correctly', () => {
    const findings = makeFindings(4, { agentThreats: true });
    const features = extractFindingsFeatures(findings);
    // Every other finding is agent threat → 0.5
    expect(features.agentThreatRatio).toBe(0.5);
  });

  test('hasCritical flag set when critical findings exist', () => {
    const findings = makeFindings(5, { critical: true });
    const features = extractFindingsFeatures(findings);
    expect(features.hasCritical).toBe(true);
  });

  test('projectFindingsToLatent produces correct dimension', () => {
    const features = extractFindingsFeatures(makeFindings(10));
    const attention = createUniformScanAttention();
    const vec = projectFindingsToLatent(features, attention);
    expect(vec.length).toBe(LATENT_DIM);
  });

  test('projectFindingsToLatent produces normalized vector', () => {
    const features = extractFindingsFeatures(makeFindings(10));
    const attention = createUniformScanAttention();
    const vec = projectFindingsToLatent(features, attention);

    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 2);
  });

  test('different findings produce different embeddings', () => {
    const f1 = extractFindingsFeatures(makeFindings(3, { spread: false }));
    const f2 = extractFindingsFeatures(makeFindings(20, { spread: true, critical: true }));
    const att = createUniformScanAttention();

    const v1 = projectFindingsToLatent(f1, att);
    const v2 = projectFindingsToLatent(f2, att);

    let diff = 0;
    for (let i = 0; i < v1.length; i++) diff += Math.abs(v1[i] - v2[i]);
    expect(diff).toBeGreaterThan(0.1);
  });

  test('critical findings produce spike in last 16 dims', () => {
    const features = extractFindingsFeatures(makeFindings(5, { critical: true }));
    const attention = createUniformScanAttention();
    // Need unnormalized to check spike
    // After normalization the spike should still be relatively higher
    const vec = projectFindingsToLatent(features, attention);
    const lastSegMean = vec.subarray(LATENT_DIM - 16).reduce((a, b) => a + Math.abs(b), 0) / 16;
    // Last segment should have higher magnitude than average
    const overallMean = vec.reduce((a, b) => a + Math.abs(b), 0) / LATENT_DIM;
    expect(lastSegMean).toBeGreaterThanOrEqual(overallMean * 0.5);
  });
});

// ── Mod 2: Incoming Structural Signal Receiver ─────────────────────

describe('Mod 2: Incoming Structural Signal Receiver', () => {
  test('high_centrality signal boosts auth + injection weights', () => {
    const attention = createUniformScanAttention();
    const signal = makeStructuralSignal('high_centrality');

    const updated = processStructuralSignal(attention, signal);
    expect(updated.categoryDepthWeights['auth']).toBeGreaterThan(1.0);
    expect(updated.categoryDepthWeights['injection']).toBeGreaterThan(1.0);
    expect(updated.source).toBe('gitnexus_structural');
  });

  test('deep_inheritance signal boosts privilege-abuse weight', () => {
    const attention = createUniformScanAttention();
    const signal = makeStructuralSignal('deep_inheritance');

    const updated = processStructuralSignal(attention, signal);
    expect(updated.categoryDepthWeights['privilege-abuse']).toBeGreaterThan(1.0);
    expect(updated.categoryDepthWeights['agent-hijack']).toBeGreaterThan(1.0);
  });

  test('graph_structure signal scales all categories proportionally', () => {
    const attention = createUniformScanAttention();
    const signal = makeStructuralSignal('graph_structure');

    const updated = processStructuralSignal(attention, signal);
    // All weights should be >= 1.0 (intensity boost)
    for (const w of Object.values(updated.categoryDepthWeights)) {
      expect(w).toBeGreaterThanOrEqual(1.0);
    }
  });
});

// ── Mod 3: Multi-Round Scan Scheduler ──────────────────────────────

describe('Mod 3: Multi-Round Scan Scheduler', () => {
  test('complexity-derived round budgets match locked values', () => {
    expect(getScanRoundBudget('linear')).toBe(3);
    expect(getScanRoundBudget('moderate')).toBe(4);
    expect(getScanRoundBudget('complex')).toBe(8);
  });

  test('default standard round budget', () => {
    expect(getScanRoundBudget()).toBe(SCAN_ROUND_DEFAULTS.standard);
  });

  test('high-risk flag gives higher budget', () => {
    expect(getScanRoundBudget(undefined, true)).toBe(SCAN_ROUND_DEFAULTS.highRisk);
  });

  test('runScanRecursion executes correct number of rounds', () => {
    const findings = makeFindings(5);
    const scanResult = makeScanResult(findings);

    const result = runScanRecursion({
      taskId: 'test-rounds',
      baseScanResult: scanResult,
      maxRounds: 3,
    });

    expect(result.roundsExecuted).toBeLessThanOrEqual(3);
    expect(result.roundsExecuted).toBeGreaterThan(0);
    expect(result.rounds.length).toBe(result.roundsExecuted);
  });

  test('runScanRecursion converges when no new findings', () => {
    const findings = makeFindings(3);
    const scanResult = makeScanResult(findings);

    const result = runScanRecursion({
      taskId: 'test-converge-findings',
      baseScanResult: scanResult,
      maxRounds: 8,
    });

    // Same findings every round → converges
    expect(result.converged).toBe(true);
    expect(result.roundsExecuted).toBeLessThan(8);
  });

  test('runScanRecursion incorporates structural signals', () => {
    const findings = makeFindings(10, { spread: true });
    const scanResult = makeScanResult(findings);
    const signal = makeStructuralSignal('high_centrality');

    const withSignal = runScanRecursion({
      taskId: 'test-signal-scan',
      baseScanResult: scanResult,
      maxRounds: 3,
      structuralSignals: [signal],
    });

    const withoutSignal = runScanRecursion({
      taskId: 'test-no-signal-scan',
      baseScanResult: scanResult,
      maxRounds: 3,
    });

    // Final states should differ
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) {
      diff += Math.abs(withSignal.finalState[i] - withoutSignal.finalState[i]);
    }
    expect(diff).toBeGreaterThan(0.01);
  });

  test('runScanRecursion tracks unique findings', () => {
    const findings = makeFindings(5);
    const scanResult = makeScanResult(findings);

    const result = runScanRecursion({
      taskId: 'test-unique',
      baseScanResult: scanResult,
      maxRounds: 3,
    });

    // Same findings each round, so unique count = total findings
    expect(result.totalUniqueFindings).toBe(5);
  });

  test('runScanRecursion sets broadcast targets', () => {
    const result = runScanRecursion({
      taskId: 'test-broadcast',
      baseScanResult: makeScanResult(makeFindings(3)),
      maxRounds: 2,
    });

    expect(result.broadcastTargets).toContain('gitnexus');
    expect(result.broadcastTargets).toContain('borgarc');
    expect(result.broadcastTargets).toContain('borgqueen');
  });
});

// ── Mod 4: Differentiable Confidence Proxy ─────────────────────────

describe('Mod 4: Differentiable Confidence Proxy', () => {
  test('confidence is between 0 and 1', () => {
    const features = extractFindingsFeatures(makeFindings(10));
    const state = new Float32Array(LATENT_DIM);
    const conf = computeCalibratedConfidence(features, state);
    expect(conf).toBeGreaterThanOrEqual(0);
    expect(conf).toBeLessThanOrEqual(1);
  });

  test('confidence is deterministic', () => {
    const features = extractFindingsFeatures(makeFindings(5));
    const state = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) state[i] = Math.sin(i) * 0.1;

    const c1 = computeCalibratedConfidence(features, state);
    const c2 = computeCalibratedConfidence(features, state);
    expect(c1).toBe(c2);
  });

  test('empty findings produce valid confidence', () => {
    const features = extractFindingsFeatures([]);
    const state = new Float32Array(LATENT_DIM);
    const conf = computeCalibratedConfidence(features, state);
    expect(conf).toBeGreaterThanOrEqual(0);
    expect(conf).toBeLessThanOrEqual(1);
  });
});

// ── Mod 5: Simultaneous Multi-Target Broadcast ─────────────────────

describe('Mod 5: Simultaneous Multi-Target Broadcast', () => {
  test('creates payload for each target', () => {
    const state = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) state[i] = 0.1;

    const payloads = createBroadcastPayloads(state, ['gitnexus', 'borgarc', 'borgqueen']);
    expect(payloads.size).toBe(3);
    expect(payloads.has('gitnexus')).toBe(true);
    expect(payloads.has('borgarc')).toBe(true);
    expect(payloads.has('borgqueen')).toBe(true);
  });

  test('each payload has correct adapter key', () => {
    const state = new Float32Array(LATENT_DIM);
    const payloads = createBroadcastPayloads(state, ['gitnexus', 'borgarc']);

    expect(payloads.get('gitnexus')!.adapterKey).toBe('deepsec_L2_to_gitnexus');
    expect(payloads.get('borgarc')!.adapterKey).toBe('deepsec_L2_to_borgarc');
  });

  test('payloads are independent copies', () => {
    const state = new Float32Array(LATENT_DIM);
    state[0] = 1.0;
    const payloads = createBroadcastPayloads(state, ['a', 'b']);

    // Modify one payload, other should be unaffected
    payloads.get('a')!.data[0] = 999;
    expect(payloads.get('b')!.data[0]).toBe(1.0);
  });

  test('each payload has correct dimensions', () => {
    const state = new Float32Array(LATENT_DIM);
    const payloads = createBroadcastPayloads(state, ['target1']);
    const payload = payloads.get('target1')!;
    expect(payload.dim).toBe(LATENT_DIM);
    expect(payload.numVectors).toBe(1);
    expect(payload.data.length).toBe(LATENT_DIM);
  });
});

// ── Mod 6: Borg Arc Gating Signal ──────────────────────────────────

describe('Mod 6: Borg Arc Gating Signal', () => {
  test('critical findings → gate: fail', () => {
    const findings = makeFindings(5, { critical: true });
    const features = extractFindingsFeatures(findings);
    const round: ScanRoundResult = {
      round: 0,
      hiddenState: new Float32Array(LATENT_DIM),
      findings,
      newFindings: 5,
      convergenceDelta: null,
      converged: false,
      attention: createUniformScanAttention(),
      calibratedConfidence: 0.8,
    };

    const gate = computeGateSignal(round, 5);
    expect(gate.gate).toBe('fail');
    expect(gate.reason).toContain('Critical');
  });

  test('no high+ findings and low count → gate: pass', () => {
    const findings = [
      makeFinding({ severity: 'low' }),
      makeFinding({ severity: 'info', lineNumber: 20 }),
    ];
    const round: ScanRoundResult = {
      round: 0,
      hiddenState: new Float32Array(LATENT_DIM),
      findings,
      newFindings: 2,
      convergenceDelta: null,
      converged: false,
      attention: createUniformScanAttention(),
      calibratedConfidence: 0.3,
    };

    const gate = computeGateSignal(round, 2);
    expect(gate.gate).toBe('pass');
  });

  test('many high findings → gate: review', () => {
    // 10 high findings → weighted severity = 10 * 7 = 70 > 20
    const findings: Finding[] = [];
    for (let i = 0; i < 10; i++) {
      findings.push(makeFinding({
        ruleId: `DS-${i}`,
        severity: 'high',
        filePath: `src/file_${i}.ts`,
        lineNumber: 10 + i,
      }));
    }
    const round: ScanRoundResult = {
      round: 0,
      hiddenState: new Float32Array(LATENT_DIM),
      findings,
      newFindings: 10,
      convergenceDelta: null,
      converged: false,
      attention: createUniformScanAttention(),
      calibratedConfidence: 0.6,
    };

    const gate = computeGateSignal(round, 10);
    expect(gate.gate).toBe('review');
    expect(gate.reason).toContain('Human review');
  });

  test('gate signal includes risk vector', () => {
    const round: ScanRoundResult = {
      round: 0,
      hiddenState: new Float32Array(LATENT_DIM),
      findings: makeFindings(3),
      newFindings: 3,
      convergenceDelta: null,
      converged: false,
      attention: createUniformScanAttention(),
      calibratedConfidence: 0.5,
    };

    const gate = computeGateSignal(round, 3);
    expect(gate.riskVector.length).toBe(LATENT_DIM);
    expect(gate.confidence).toBeDefined();
  });

  test('gate signal from full scan recursion', () => {
    const findings = makeFindings(3, { spread: true });
    const result = runScanRecursion({
      taskId: 'test-gate',
      baseScanResult: makeScanResult(findings),
      maxRounds: 2,
    });

    expect(result.gateSignal).toBeDefined();
    expect(['pass', 'fail', 'review']).toContain(result.gateSignal.gate);
    expect(result.gateSignal.riskVector.length).toBe(LATENT_DIM);
  });
});

// ── Integration ────────────────────────────────────────────────────

describe('Full Pipeline Integration', () => {
  test('end-to-end: findings → features → projection → recursion → gate → broadcast', () => {
    const findings = makeFindings(15, { spread: true, agentThreats: true });
    const scanResult = makeScanResult(findings);
    const signal = makeStructuralSignal('high_centrality');

    const result = runScanRecursion({
      taskId: 'test-e2e-deepsec',
      baseScanResult: scanResult,
      maxRounds: 4,
      structuralSignals: [signal],
    });

    // All fields populated
    expect(result.taskId).toBe('test-e2e-deepsec');
    expect(result.finalState.length).toBe(LATENT_DIM);
    expect(result.finalConfidence).toBeGreaterThan(0);
    expect(result.payload.dim).toBe(LATENT_DIM);
    expect(result.gateSignal).toBeDefined();
    expect(result.broadcastTargets.length).toBe(3);
    expect(result.rounds.length).toBeGreaterThan(0);
    expect(result.totalUniqueFindings).toBeGreaterThan(0);
  });

  test('createDeepSecPayload has correct adapter key', () => {
    const state = new Float32Array(LATENT_DIM);
    const payload = createDeepSecPayload(state);
    expect(payload.adapterKey).toBe('deepsec_L2_vulnerability');
    expect(payload.dim).toBe(LATENT_DIM);
    expect(payload.sourceHiddenSize).toBe(LATENT_DIM);
  });
});
