/**
 * Hermes Layer 4 - Transport + Registry + Trace Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerAgent,
  clearRegistry,
  checkRoute,
  validateDimensions,
  createTextMessage,
  createLatentMessage,
  createDualMessage,
  sendMessage,
  receiveMessage,
  cosineSimilarity,
  checkConvergence,
  serializeLatent,
  deserializeLatent,
  ConvergenceTracker,
  encodeFloat32,
  decodeFloat32,
  serializeTrace,
  deserializeTrace,
  LATENT_DIM,
  ROUND_BUDGETS,
} from './index.js';

import type { LatentPayload, TraceEntry } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeLatent(dim = LATENT_DIM, numVectors = 1): LatentPayload {
  const data = new Float32Array(dim * numVectors);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() - 0.5;
  return { data, numVectors, dim, adapterKey: 'test_adapter', sourceHiddenSize: dim };
}

function makeUnitVector(dim: number, index: number): Float32Array {
  const v = new Float32Array(dim);
  v[index % dim] = 1.0;
  return v;
}

// ── Registry Tests ──────────────────────────────────────────────────

describe('Hermes Registry', () => {
  beforeEach(() => clearRegistry());

  it('registers agent with text always in accepts', () => {
    registerAgent({ agentId: 'a', accepts: ['latent'], produces: ['latent'] });
    const route = checkRoute('a', 'a');
    expect(route.compatible).toBe(true);
  });

  it('unregistered agents default to text routing', () => {
    const route = checkRoute('unknown1', 'unknown2');
    expect(route.compatible).toBe(true);
    expect(route.recommendedMode).toBe('text');
  });

  it('prefers latent when both support it', () => {
    registerAgent({ agentId: 'src', accepts: ['text', 'latent'], produces: ['latent'] });
    registerAgent({ agentId: 'dst', accepts: ['text', 'latent'], produces: ['text'] });
    const route = checkRoute('src', 'dst');
    expect(route.recommendedMode).toBe('latent');
  });

  it('falls back to text when target is text-only', () => {
    registerAgent({ agentId: 'src', accepts: ['text'], produces: ['text', 'latent'] });
    registerAgent({ agentId: 'dst', accepts: ['text'], produces: ['text'] });
    const route = checkRoute('src', 'dst');
    expect(route.recommendedMode).toBe('text');
  });

  it('validates dimension compatibility', () => {
    registerAgent({ agentId: 'a', accepts: ['text'], produces: ['text'], hiddenSize: 768 });
    registerAgent({ agentId: 'b', accepts: ['text'], produces: ['text'], hiddenSize: 1024 });

    const ok = validateDimensions('a', 'b', 768, 1024);
    expect(ok.valid).toBe(true);

    const bad = validateDimensions('a', 'b', 512, 1024);
    expect(bad.valid).toBe(false);
    expect(bad.reason).toContain('768');
  });
});

// ── Transport Tests ─────────────────────────────────────────────────

describe('Hermes Transport', () => {
  beforeEach(() => clearRegistry());

  it('creates text message with correct fields', () => {
    const msg = createTextMessage({
      fromAgent: 'main',
      toAgent: 'ops',
      chatId: '123',
      text: 'hello',
      taskId: 'task1',
    });
    expect(msg.mode).toBe('text');
    expect(msg.text).toBe('hello');
    expect(msg.latent).toBeUndefined();
    expect(msg.round).toBe(0);
    expect(msg.id).toBeTruthy();
  });

  it('creates latent message with payload', () => {
    const latent = makeLatent();
    const msg = createLatentMessage({
      fromAgent: 'planner',
      toAgent: 'critic',
      chatId: '123',
      latent,
      taskId: 'task2',
      round: 1,
      convergenceDelta: 0.15,
    });
    expect(msg.mode).toBe('latent');
    expect(msg.latent).toBeDefined();
    expect(msg.latent!.dim).toBe(LATENT_DIM);
  });

  it('creates dual message with both payloads', () => {
    const latent = makeLatent();
    const msg = createDualMessage({
      fromAgent: 'a',
      toAgent: 'b',
      chatId: '123',
      text: 'context',
      latent,
      taskId: 'task3',
      round: 2,
      convergenceDelta: 0.05,
    });
    expect(msg.mode).toBe('dual');
    expect(msg.text).toBe('context');
    expect(msg.latent).toBeDefined();
  });

  it('sendMessage passes through text messages unchanged', () => {
    const msg = createTextMessage({
      fromAgent: 'main',
      toAgent: 'ops',
      chatId: '123',
      text: 'do the thing',
      taskId: 'task4',
    });
    const delivered = sendMessage(msg);
    expect(delivered.mode).toBe('text');
    expect(delivered.text).toBe('do the thing');
  });

  it('sendMessage downgrades latent to text when target is text-only', () => {
    registerAgent({ agentId: 'sender', accepts: ['text', 'latent'], produces: ['latent'] });
    registerAgent({ agentId: 'receiver', accepts: ['text'], produces: ['text'] });

    const latent = makeLatent();
    const msg = createLatentMessage({
      fromAgent: 'sender',
      toAgent: 'receiver',
      chatId: '123',
      latent,
      taskId: 'task5',
      round: 1,
      convergenceDelta: 0.1,
    });
    const delivered = sendMessage(msg);
    expect(delivered.mode).toBe('text');
    expect(delivered.latent).toBeUndefined();
  });

  it('receiveMessage validates latent dimensions', () => {
    const msg = createLatentMessage({
      fromAgent: 'a',
      toAgent: 'b',
      chatId: '123',
      latent: { data: new Float32Array(10), numVectors: 1, dim: 768, adapterKey: 'x', sourceHiddenSize: 768 },
      taskId: 'task6',
      round: 0,
      convergenceDelta: null,
    });
    // data.length (10) != dim * numVectors (768) -- should strip latent or throw
    expect(() => receiveMessage(msg)).toThrow();
  });
});

// ── Convergence Tests ───────────────────────────────────────────────

describe('Convergence', () => {
  it('identical vectors have similarity 1, delta 0', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    const { converged, delta } = checkConvergence(v, v);
    expect(converged).toBe(true);
    expect(delta).toBeCloseTo(0);
  });

  it('orthogonal vectors have similarity 0, delta 1', () => {
    const a = makeUnitVector(4, 0);
    const b = makeUnitVector(4, 1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
    const { converged, delta } = checkConvergence(a, b);
    expect(converged).toBe(false);
    expect(delta).toBeCloseTo(1.0);
  });

  it('throws on dimension mismatch', () => {
    const a = new Float32Array(3);
    const b = new Float32Array(5);
    expect(() => cosineSimilarity(a, b)).toThrow('Dimension mismatch');
  });
});

describe('ConvergenceTracker', () => {
  it('first update returns delta null', () => {
    const tracker = new ConvergenceTracker();
    const result = tracker.update('agent1', new Float32Array([1, 2, 3]));
    expect(result.delta).toBeNull();
    expect(result.converged).toBe(false);
  });

  it('identical updates converge', () => {
    const tracker = new ConvergenceTracker();
    const v = new Float32Array([1, 2, 3]);
    tracker.update('agent1', v);
    const result = tracker.update('agent1', v);
    expect(result.converged).toBe(true);
    expect(result.delta).toBeCloseTo(0);
  });
});

// ── Serialization Tests ─────────────────────────────────────────────

describe('Serialization', () => {
  it('Float32 round-trips through base64', () => {
    const original = new Float32Array([1.5, -2.3, 0, 999.99]);
    const encoded = encodeFloat32(original);
    const decoded = decodeFloat32(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 4);
    }
  });

  it('LatentPayload round-trips', () => {
    const payload = makeLatent(16, 2);
    const serialized = serializeLatent(payload);
    expect(typeof serialized.data).toBe('string'); // base64
    const deserialized = deserializeLatent(serialized);
    expect(deserialized.dim).toBe(16);
    expect(deserialized.numVectors).toBe(2);
    expect(deserialized.data.length).toBe(32);
  });

  it('TraceEntry round-trips', () => {
    const entry: TraceEntry = {
      agentId: 'planner',
      layer: 'L4',
      round: 2,
      hiddenState: new Float32Array([1, 2, 3]),
      convergenceDelta: 0.015,
      metadata: { dim: 3, timestamp: new Date().toISOString(), taskId: 'test' },
    };
    const serialized = serializeTrace(entry);
    expect(typeof serialized.hiddenState).toBe('string');
    const deserialized = deserializeTrace(serialized);
    expect(deserialized.agentId).toBe('planner');
    expect(deserialized.hiddenState.length).toBe(3);
    expect(deserialized.convergenceDelta).toBe(0.015);
  });
});

// ── Constants Tests ─────────────────────────────────────────────────

describe('Constants', () => {
  it('LATENT_DIM is 768 (locked)', () => {
    expect(LATENT_DIM).toBe(768);
  });

  it('ROUND_BUDGETS has all 6 layers', () => {
    expect(Object.keys(ROUND_BUDGETS)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(ROUND_BUDGETS.L4).toBe(3);
  });
});
