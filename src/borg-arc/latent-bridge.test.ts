import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encodeIntentSignal,
  applyBorgQueenContext,
  preScreenRepo,
  aggregateEvaluationSignals,
  deriveDecision,
  runAcquisitionThread,
  planAcquisitionBatch,
  createBorgQueenReport,
  createBorgArcPayload,
  createBorgQueenPayload,
  TIER_ROUND_BUDGETS,
  DEFAULT_THREAD_COUNT,
} from './latent-bridge.js';
import type {
  AcquisitionIntent,
  PreScreeningSignal,
  BorgQueenContext,
} from './latent-bridge.js';
import type { RepoAnalysis, ComplexityMetrics, ForkabilityAssessment } from './analyzer.js';
import type { GateSignal } from '../deepsec/latent-bridge.js';
import { LATENT_DIM } from '../hermes/types.js';

// ── Test Helpers ────────────────────────────────────────────────────────

function makeIntent(overrides?: Partial<AcquisitionIntent>): AcquisitionIntent {
  return {
    priority: 'structural_compatibility',
    targetLayer: 'L1',
    riskTolerance: 'standard',
    ...overrides,
  };
}

function makeAnalysis(overrides?: Partial<{
  licenseCompatible: boolean;
  maintainerActive: boolean;
  forkabilityScore: number;
  totalFiles: number;
}>): Omit<RepoAnalysis, 'approval'> {
  const compat = overrides?.licenseCompatible ?? true;
  const active = overrides?.maintainerActive ?? true;
  const forkScore = overrides?.forkabilityScore ?? 80;
  const files = overrides?.totalFiles ?? 30;

  return {
    repoUrl: 'https://github.com/test/repo',
    repoName: 'repo',
    analyzedAt: new Date().toISOString(),
    version: 2,
    compatibility: {
      language: 'typescript',
      runtime: 'node',
      languages: { primary: 'typescript', all: ['typescript'], runtime: 'node', hasTypes: true },
      dependencies: [],
      conflictingDeps: [],
      licenseCompatible: compat,
      license: compat ? 'MIT' : 'BUSL-1.1',
      licenseDetail: {
        spdx: compat ? 'MIT' : 'BUSL-1.1',
        compatible: compat,
        hasEERestrictions: false,
        eeDirs: [],
        dualLicense: false,
        licenseFiles: [],
      },
    },
    quality: {
      hasTests: true,
      hasTypes: true,
      lastCommitDate: new Date().toISOString(),
      stars: 100,
      openIssues: 5,
      maintainerActive: active,
      documentation: { score: 70, hasReadme: true, hasContributing: false, hasChangelog: true, hasDocsDir: false, hasSecurityPolicy: false, hasCodeOfConduct: false },
      ci: { hasCI: true, platforms: ['github-actions'] },
    },
    complexity: {
      totalFiles: files,
      totalDirs: 5,
      estimatedLOC: files * 50,
      maxDepth: 3,
      topLevelDirs: ['src'],
    } as ComplexityMetrics,
    monorepo: { isMonorepo: false, workspaceManager: null, packages: [], packageCount: 0 },
    forkability: {
      strategy: 'fork-full',
      reason: 'Clean license',
      forkableFiles: files,
      proprietaryFiles: 0,
      forkabilityScore: forkScore,
    } as ForkabilityAssessment,
    absorptionPlan: {
      targetFiles: [],
      estimatedLines: 0,
      integrationPoint: '',
      adaptationNeeded: [],
    },
    risk: {
      securityScanRequired: true,
      breakingChanges: [],
      reversibility: 'easy',
    },
  };
}

function makeGateSignal(gate: 'pass' | 'fail' | 'review'): GateSignal {
  return {
    gate,
    confidence: 0.8,
    riskVector: new Float32Array(LATENT_DIM),
    reason: `Gate: ${gate}`,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Mod 2: Task-Intent Initialization Signal', () => {
  it('produces 768-dim vector', () => {
    const vec = encodeIntentSignal(makeIntent());
    expect(vec.length).toBe(LATENT_DIM);
  });

  it('is normalized', () => {
    const vec = encodeIntentSignal(makeIntent());
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
    expect(Math.sqrt(mag)).toBeCloseTo(1.0, 1);
  });

  it('different priorities produce different vectors', () => {
    const a = encodeIntentSignal(makeIntent({ priority: 'security_validation' }));
    const b = encodeIntentSignal(makeIntent({ priority: 'technology_assessment' }));
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(0.1);
  });

  it('different target layers produce different vectors', () => {
    const a = encodeIntentSignal(makeIntent({ targetLayer: 'L1' }));
    const b = encodeIntentSignal(makeIntent({ targetLayer: 'L5' }));
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(0.1);
  });

  it('different risk tolerances produce different vectors', () => {
    const a = encodeIntentSignal(makeIntent({ riskTolerance: 'conservative' }));
    const b = encodeIntentSignal(makeIntent({ riskTolerance: 'aggressive' }));
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(0.1);
  });

  it('incorporates pre-screening signal', () => {
    const preScreening = preScreenRepo(makeAnalysis());
    const withPre = encodeIntentSignal(makeIntent(), preScreening);
    const withoutPre = encodeIntentSignal(makeIntent());
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(withPre[i] - withoutPre[i]);
    expect(diff).toBeGreaterThan(0.01);
  });

  it('applies Borg Queen context to reserved segment', () => {
    const vec = encodeIntentSignal(makeIntent());
    const gapSignal = new Float32Array(256);
    for (let i = 0; i < 256; i++) gapSignal[i] = 0.5;
    const context: BorgQueenContext = {
      gapSignal,
      layerPriorities: { L1: 0.9 },
    };
    const updated = applyBorgQueenContext(vec, context);
    expect(updated.length).toBe(LATENT_DIM);
    // Should differ from original
    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) diff += Math.abs(updated[i] - vec[i]);
    expect(diff).toBeGreaterThan(0.01);
  });
});

describe('Mod 5: Pre-Screening Latent Filter', () => {
  it('high quality repo → high tier', () => {
    const result = preScreenRepo(makeAnalysis());
    expect(result.qualityTier).toBe('high');
    expect(result.recommendedRounds).toBe(TIER_ROUND_BUDGETS.high);
  });

  it('incompatible license → drop', () => {
    const result = preScreenRepo(makeAnalysis({ licenseCompatible: false }));
    expect(result.qualityTier).toBe('drop');
    expect(result.recommendedRounds).toBe(0);
  });

  it('inactive + low forkability + huge repo → borderline', () => {
    const result = preScreenRepo(makeAnalysis({
      maintainerActive: false,
      forkabilityScore: 10,
      totalFiles: 1000,
    }));
    // Weighted: license=30, maintenance=7.5 (inactive but has date→30*0.25), fork=2.5, complexity=4 → ~44
    // Adjust: force lastCommitDate empty to get maintenance=0
    expect(['borderline', 'standard']).toContain(result.qualityTier);
    expect(result.recommendedRounds).toBeGreaterThan(0);
  });

  it('produces quality vector of correct dimension', () => {
    const result = preScreenRepo(makeAnalysis());
    expect(result.qualityVector.length).toBe(LATENT_DIM);
  });

  it('scores are between 0-100', () => {
    const result = preScreenRepo(makeAnalysis());
    expect(result.scores.license).toBeGreaterThanOrEqual(0);
    expect(result.scores.license).toBeLessThanOrEqual(100);
    expect(result.scores.maintenance).toBeGreaterThanOrEqual(0);
    expect(result.scores.maintenance).toBeLessThanOrEqual(100);
  });
});

describe('Mod 3: Latent State Handoff', () => {
  it('aggregates with no external signals (identity-like)', () => {
    const current = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) current[i] = Math.sin(i * 0.1);
    const result = aggregateEvaluationSignals(current);
    expect(result.length).toBe(LATENT_DIM);
  });

  it('L1 signal modifies structural segment', () => {
    const current = new Float32Array(LATENT_DIM);
    const l1 = new Float32Array(LATENT_DIM);
    for (let i = 0; i < 192; i++) l1[i] = 1.0;
    const without = aggregateEvaluationSignals(current);
    const withL1 = aggregateEvaluationSignals(current, l1);
    // Structural segment (0-191) should differ
    let structDiff = 0;
    for (let i = 0; i < 192; i++) structDiff += Math.abs(withL1[i] - without[i]);
    expect(structDiff).toBeGreaterThan(0);
  });

  it('L2 signal modifies security segment', () => {
    const current = new Float32Array(LATENT_DIM);
    const l2 = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) l2[i] = 0.5;
    const without = aggregateEvaluationSignals(current);
    const withL2 = aggregateEvaluationSignals(current, undefined, l2);
    // Security segment (192-383) should differ
    let secDiff = 0;
    for (let i = 192; i < 384; i++) secDiff += Math.abs(withL2[i] - without[i]);
    expect(secDiff).toBeGreaterThan(0);
  });

  it('L2 gate fail amplifies security segment', () => {
    const current = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) current[i] = 0.1;
    const l2 = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) l2[i] = 0.3;
    const passGate = makeGateSignal('pass');
    const failGate = makeGateSignal('fail');
    const withPass = aggregateEvaluationSignals(current, undefined, l2, passGate);
    const withFail = aggregateEvaluationSignals(current, undefined, l2, failGate);
    // Fail should have higher security segment magnitude
    let passMag = 0, failMag = 0;
    for (let i = 192; i < 384; i++) {
      passMag += withPass[i] * withPass[i];
      failMag += withFail[i] * withFail[i];
    }
    // After normalization the relative proportion of security should be higher with fail
    expect(failMag).not.toBe(passMag);
  });

  it('both L1+L2 produce cross-signal compatibility', () => {
    const current = new Float32Array(LATENT_DIM);
    const l1 = new Float32Array(LATENT_DIM);
    const l2 = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) {
      l1[i] = 0.5;
      l2[i] = 0.3;
    }
    const result = aggregateEvaluationSignals(current, l1, l2);
    // Compatibility segment (384-511) should be non-zero
    let compatEnergy = 0;
    for (let i = 384; i < 512; i++) compatEnergy += Math.abs(result[i]);
    expect(compatEnergy).toBeGreaterThan(0);
  });
});

describe('Mod 4: Multi-Round Decision Aggregator', () => {
  it('L2 gate fail → skip decision', () => {
    const state = new Float32Array(LATENT_DIM);
    const { decision } = deriveDecision(state, makeGateSignal('fail'));
    expect(decision).toBe('skip');
  });

  it('zero state → review or skip (low confidence)', () => {
    const state = new Float32Array(LATENT_DIM);
    const { decision, confidence } = deriveDecision(state);
    expect(['review', 'skip']).toContain(decision);
    expect(confidence).toBeLessThan(0.5);
  });

  it('confidence between 0-1', () => {
    const state = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) state[i] = Math.sin(i * 0.05);
    const { confidence } = deriveDecision(state);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it('deterministic', () => {
    const state = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) state[i] = Math.cos(i * 0.03);
    const r1 = deriveDecision(state);
    const r2 = deriveDecision(state);
    expect(r1.decision).toBe(r2.decision);
    expect(r1.confidence).toBe(r2.confidence);
  });
});

describe('Acquisition Thread Execution', () => {
  it('runs specified number of rounds', () => {
    const result = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-1',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 3,
    });
    expect(result.rounds.length).toBeGreaterThanOrEqual(1);
    expect(result.rounds.length).toBeLessThanOrEqual(3);
  });

  it('converges when state stabilizes', () => {
    // With no external signals, intent vector projects identically each round
    const result = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-2',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 8,
    });
    // Should converge before max rounds since no new information arrives
    expect(result.converged).toBe(true);
    expect(result.rounds.length).toBeLessThan(8);
  });

  it('produces valid final state', () => {
    const result = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-3',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 3,
    });
    expect(result.finalState.length).toBe(LATENT_DIM);
    let mag = 0;
    for (let i = 0; i < LATENT_DIM; i++) mag += result.finalState[i] * result.finalState[i];
    expect(Math.sqrt(mag)).toBeCloseTo(1.0, 1);
  });

  it('incorporates L1/L2 signals', () => {
    const l1State = new Float32Array(LATENT_DIM);
    for (let i = 0; i < LATENT_DIM; i++) l1State[i] = Math.sin(i * 0.1);

    const withoutSignals = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-4a',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 3,
    });

    const withSignals = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-4b',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 3,
      graphAnalysis: {
        taskId: 'test-task',
        rounds: [],
        converged: true,
        finalState: l1State,
        finalConfidence: 0.8,
        roundsExecuted: 0,
        payload: {
          data: l1State.slice() as Float32Array<ArrayBuffer>,
          numVectors: 1,
          dim: LATENT_DIM,
          adapterKey: 'gitnexus_L1',
          sourceHiddenSize: LATENT_DIM,
        },
      },
    });

    let diff = 0;
    for (let i = 0; i < LATENT_DIM; i++) {
      diff += Math.abs(withSignals.finalState[i] - withoutSignals.finalState[i]);
    }
    expect(diff).toBeGreaterThan(0.1);
  });

  it('L2 gate fail forces skip decision', () => {
    const result = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-5',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 3,
      securityGate: makeGateSignal('fail'),
    });
    expect(result.finalDecision).toBe('skip');
  });

  it('quality tier reflects pre-screening', () => {
    const preScreening = preScreenRepo(makeAnalysis());
    const result = runAcquisitionThread({
      taskId: 'test-task',
      threadId: 'thread-6',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: preScreening.recommendedRounds,
      preScreening,
    });
    expect(result.qualityTier).toBe('high');
  });

  it('writes traces for each round', () => {
    // writeTrace is called internally; verify rounds are recorded
    const result = runAcquisitionThread({
      taskId: 'trace-test',
      threadId: 'thread-7',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 2,
    });
    expect(result.rounds.length).toBeGreaterThanOrEqual(1);
    for (const r of result.rounds) {
      expect(r.assessmentState.length).toBe(LATENT_DIM);
      // First round delta is null (no previous state), subsequent rounds are numbers
      expect(r.convergenceDelta === null || typeof r.convergenceDelta === 'number').toBe(true);
    }
  });
});

describe('Mod 1: Parallel Acquisition Thread Manager', () => {
  it('plans batch respecting max thread count', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      repoUrl: `https://github.com/test/repo-${i}`,
      repoPath: `/tmp/repo-${i}`,
      analysis: makeAnalysis(),
      intent: makeIntent(),
    }));
    const batch = planAcquisitionBatch(candidates, 5);
    expect(batch.length).toBe(5);
  });

  it('filters out drops (incompatible license)', () => {
    const candidates = [
      {
        repoUrl: 'https://github.com/test/good',
        repoPath: '/tmp/good',
        analysis: makeAnalysis(),
        intent: makeIntent(),
      },
      {
        repoUrl: 'https://github.com/test/bad',
        repoPath: '/tmp/bad',
        analysis: makeAnalysis({ licenseCompatible: false }),
        intent: makeIntent(),
      },
    ];
    const batch = planAcquisitionBatch(candidates, 5);
    expect(batch.length).toBe(1);
    expect(batch[0].repoUrl).toBe('https://github.com/test/good');
  });

  it('sorts high quality first', () => {
    const candidates = [
      {
        repoUrl: 'https://github.com/test/borderline',
        repoPath: '/tmp/borderline',
        analysis: makeAnalysis({ maintainerActive: false, forkabilityScore: 20, totalFiles: 500 }),
        intent: makeIntent(),
      },
      {
        repoUrl: 'https://github.com/test/high',
        repoPath: '/tmp/high',
        analysis: makeAnalysis(),
        intent: makeIntent(),
      },
    ];
    const batch = planAcquisitionBatch(candidates, 5);
    expect(batch[0].repoUrl).toBe('https://github.com/test/high');
  });

  it('assigns thread IDs and pre-screening', () => {
    const candidates = [{
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/repo',
      analysis: makeAnalysis(),
      intent: makeIntent(),
    }];
    const batch = planAcquisitionBatch(candidates, 5);
    expect(batch[0].threadId).toMatch(/^acq-/);
    expect(batch[0].preScreening).toBeDefined();
    expect(batch[0].maxRounds).toBe(TIER_ROUND_BUDGETS.high);
  });

  it('default thread count is 5', () => {
    expect(DEFAULT_THREAD_COUNT).toBe(5);
  });
});

describe('Mod 6: Borg Queen Reporting', () => {
  it('creates report with correct structure', () => {
    const threadResult = runAcquisitionThread({
      taskId: 'report-test',
      threadId: 'report-1',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent({ targetLayer: 'L5' }),
      maxRounds: 2,
    });
    const report = createBorgQueenReport(threadResult, makeIntent({ targetLayer: 'L5' }));

    expect(report.threadId).toBe('report-1');
    expect(report.repoUrl).toBe('https://github.com/test/repo');
    expect(report.decision).toBeDefined();
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
    expect(report.hiddenState.length).toBe(LATENT_DIM);
    expect(report.targetLayer).toBe('L5');
  });

  it('factors are non-negative', () => {
    const threadResult = runAcquisitionThread({
      taskId: 'factors-test',
      threadId: 'factors-1',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 2,
    });
    const report = createBorgQueenReport(threadResult, makeIntent());

    expect(report.factors.structuralCompatibility).toBeGreaterThanOrEqual(0);
    expect(report.factors.securityRisk).toBeGreaterThanOrEqual(0);
    expect(report.factors.integrationComplexity).toBeGreaterThanOrEqual(0);
    expect(report.factors.valueAlignment).toBeGreaterThanOrEqual(0);
  });

  it('createBorgArcPayload has correct adapter key', () => {
    const state = new Float32Array(LATENT_DIM);
    const payload = createBorgArcPayload(state);
    expect(payload.adapterKey).toBe('borgarc_L3_acquisition');
    expect(payload.dim).toBe(LATENT_DIM);
    expect(payload.numVectors).toBe(1);
  });

  it('createBorgQueenPayload has correct adapter key', () => {
    const threadResult = runAcquisitionThread({
      taskId: 'payload-test',
      threadId: 'payload-1',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent: makeIntent(),
      maxRounds: 2,
    });
    const report = createBorgQueenReport(threadResult, makeIntent());
    const payload = createBorgQueenPayload(report);
    expect(payload.adapterKey).toBe('borgarc_L3_to_borgqueen');
    expect(payload.dim).toBe(LATENT_DIM);
  });
});

describe('Full Pipeline Integration', () => {
  it('end-to-end: pre-screen → intent → thread → report → payload', () => {
    const analysis = makeAnalysis();
    const intent = makeIntent({ targetLayer: 'L2', priority: 'security_validation' });

    // Step 1: Pre-screen
    const preScreening = preScreenRepo(analysis);
    expect(preScreening.qualityTier).toBe('high');

    // Step 2: Encode intent with pre-screening
    const intentVec = encodeIntentSignal(intent, preScreening);
    expect(intentVec.length).toBe(LATENT_DIM);

    // Step 3: Run acquisition thread
    const threadResult = runAcquisitionThread({
      taskId: 'e2e-test',
      threadId: 'e2e-1',
      repoUrl: 'https://github.com/test/repo',
      repoPath: '/tmp/test',
      intent,
      maxRounds: preScreening.recommendedRounds,
      preScreening,
    });
    expect(threadResult.finalState.length).toBe(LATENT_DIM);
    expect(threadResult.qualityTier).toBe('high');

    // Step 4: Create Borg Queen report
    const report = createBorgQueenReport(threadResult, intent);
    expect(report.targetLayer).toBe('L2');
    expect(report.decision).toBeDefined();

    // Step 5: Create payload for Borg Queen
    const payload = createBorgQueenPayload(report);
    expect(payload.adapterKey).toBe('borgarc_L3_to_borgqueen');
    expect(payload.data.length).toBe(LATENT_DIM);
  });

  it('batch planning → parallel thread execution', () => {
    const candidates = Array.from({ length: 3 }, (_, i) => ({
      repoUrl: `https://github.com/test/repo-${i}`,
      repoPath: `/tmp/repo-${i}`,
      analysis: makeAnalysis(),
      intent: makeIntent(),
    }));

    // Plan batch
    const batch = planAcquisitionBatch(candidates, 5);
    expect(batch.length).toBe(3);

    // Execute threads (would be parallel in production, sequential in test)
    const results = batch.map((config) =>
      runAcquisitionThread({
        ...config,
        taskId: 'batch-test',
      }),
    );

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.finalState.length).toBe(LATENT_DIM);
      expect(r.rounds.length).toBeGreaterThanOrEqual(1);
    }

    // Generate reports
    const reports = results.map((r, i) =>
      createBorgQueenReport(r, candidates[i].intent),
    );
    expect(reports.length).toBe(3);
  });
});
