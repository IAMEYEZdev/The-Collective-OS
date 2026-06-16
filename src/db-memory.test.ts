import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  ACTIVE_EMBEDDING_MODEL: 'nomic-embed-text',
  DB_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STORE_DIR: 'unused-test-store',
}));

vi.mock('./cognee-bridge.js', () => ({
  bridgeHiveLog: vi.fn(),
  bridgeMemory: vi.fn(),
  bridgeMissionTask: vi.fn(),
  bridgeBoardAudit: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  _initTestDatabase,
  getMemoriesWithEmbeddings,
  saveMemoryEmbedding,
  saveStructuredMemory,
  searchMemories,
} from './db.js';

describe('memory embedding storage', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('writes embeddings under the active embedding model and returns them for vector search', () => {
    const memoryId = saveStructuredMemory(
      'chat-1',
      'raw detail about pipeline health',
      'Pipeline health is stable',
      ['pipeline'],
      ['health'],
      0.9,
    );

    saveMemoryEmbedding(memoryId, [1, 0, 0]);

    expect(getMemoriesWithEmbeddings('chat-1')).toEqual([
      { id: memoryId, embedding: [1, 0, 0], summary: 'Pipeline health is stable', importance: 0.9 },
    ]);
    expect(searchMemories('chat-1', 'health', 5, [1, 0, 0]).map((m) => m.id)).toEqual([memoryId]);
  });
});
