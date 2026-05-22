import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  searchMemories: vi.fn(),
  getRecentHighImportanceMemories: vi.fn(),
  getOtherAgentActivity: vi.fn(() => []),
  getConsolidationsWithEmbeddings: vi.fn(() => []),
  touchMemory: vi.fn(),
  penalizeMemory: vi.fn(),
  batchUpdateMemoryRelevance: vi.fn(),
  decayMemories: vi.fn(),
  logConversationTurn: vi.fn(),
  pruneConversationLog: vi.fn(),
  pruneWaMessages: vi.fn(() => ({ messages: 0, outbox: 0, map: 0 })),
  pruneSlackMessages: vi.fn(() => 0),
  searchConsolidations: vi.fn(),
  getRecentConsolidations: vi.fn(),
}));

vi.mock('./memory-ingest.js', () => ({
  ingestConversationTurn: vi.fn(() => Promise.resolve(false)),
  queueForIngestion: vi.fn(),
}));

vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(() => Promise.resolve([])),
  cosineSimilarity: vi.fn(() => 0),
}));

vi.mock('./gemini.js', () => ({
  generateContent: vi.fn(() => Promise.resolve('[]')),
  parseJsonResponse: vi.fn(() => []),
}));

import {
  buildMemoryContext,
  saveConversationTurn,
  runDecaySweep,
} from './memory.js';

import {
  searchMemories,
  getRecentHighImportanceMemories,
  touchMemory,
  decayMemories,
  logConversationTurn,
  searchConsolidations,
  getRecentConsolidations,
} from './db.js';

import { queueForIngestion } from './memory-ingest.js';

const mockSearchMemories = vi.mocked(searchMemories);
const mockGetRecentHighImportance = vi.mocked(getRecentHighImportanceMemories);
const mockTouchMemory = vi.mocked(touchMemory);
const mockDecayMemories = vi.mocked(decayMemories);
const mockLogConversationTurn = vi.mocked(logConversationTurn);
const mockSearchConsolidations = vi.mocked(searchConsolidations);
const mockGetRecentConsolidations = vi.mocked(getRecentConsolidations);
const mockQueueForIngestion = vi.mocked(queueForIngestion);

function makeMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    chat_id: 'chat1',
    source: 'conversation',
    agent_id: 'main',
    raw_text: 'raw text',
    summary: 'A test memory',
    entities: '[]',
    topics: '[]',
    connections: '[]',
    importance: 0.7,
    salience: 1.0,
    consolidated: 0,
    pinned: 0,
    embedding: null,
    created_at: 100,
    accessed_at: 100,
    ...overrides,
  };
}

describe('buildMemoryContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);
  });

  it('returns empty string when no memories found', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'hello');
    expect(contextText).toBe('');
  });

  it('returns formatted string when FTS results exist', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'User enjoys pizza', topics: '["food"]', importance: 0.8 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'pizza');
    expect(contextText).toContain('[Memory context]');
    expect(contextText).toContain('User enjoys pizza');
    expect(contextText).toContain('food');
    expect(contextText).toContain('[0.8]');
    expect(contextText).toContain('[End memory context]');
  });

  it('deduplicates between FTS and recent results', async () => {
    const mem = makeMemory({ summary: 'shared memory' });
    mockSearchMemories.mockReturnValue([mem]);
    mockGetRecentHighImportance.mockReturnValue([mem]);

    const { contextText } = await buildMemoryContext('chat1', 'shared');
    const occurrences = contextText.split('shared memory').length - 1;
    expect(occurrences).toBe(1);
  });

  it('does NOT touch memories at retrieval (feedback loop handles this)', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ id: 10 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([
      makeMemory({ id: 20 }),
    ]);

    const { surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext('chat1', 'test');
    expect(mockTouchMemory).not.toHaveBeenCalled();
    expect(surfacedMemoryIds).toContain(10);
    expect(surfacedMemoryIds).toContain(20);
    expect(surfacedMemorySummaries.get(10)).toBe('A test memory');
  });
});

describe('saveConversationTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs both user and assistant messages to conversation log', () => {
    saveConversationTurn('chat1', 'hello world from the user!!!', 'Noted.');
    expect(mockLogConversationTurn).toHaveBeenCalledWith('chat1', 'user', 'hello world from the user!!!', undefined, 'main');
    expect(mockLogConversationTurn).toHaveBeenCalledWith('chat1', 'assistant', 'Noted.', undefined, 'main');
  });

  it('fires async ingestion', () => {
    saveConversationTurn('chat1', 'I prefer TypeScript over JavaScript always and forever', 'Noted.');
    expect(mockQueueForIngestion).toHaveBeenCalledWith('chat1', 'I prefer TypeScript over JavaScript always and forever', 'Noted.', 'main');
  });
});

describe('buildMemoryContext with consolidations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);
  });

  it('includes consolidation insights when searchConsolidations returns results', async () => {
    mockSearchConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1,2]', summary: 'Morning routine synthesis', insight: 'User has structured morning workflow', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'morning routine');
    expect(contextText).toContain('Insights:');
    expect(contextText).toContain('User has structured morning workflow');
  });

  it('falls back to recent consolidations when search returns empty', async () => {
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1]', summary: 'General insight', insight: 'User values productivity', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'unrelated query');
    expect(contextText).toContain('User values productivity');
  });

  it('returns empty when no memories and no insights exist', async () => {
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'anything');
    expect(contextText).toBe('');
  });

  it('includes both memories and insights when both exist', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Prefers dark mode', importance: 0.8, topics: '["UI"]' }),
    ]);
    mockSearchConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1]', summary: 'UI summary', insight: 'User cares deeply about UI aesthetics', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'UI preferences');
    expect(contextText).toContain('Prefers dark mode');
    expect(contextText).toContain('User cares deeply about UI aesthetics');
    expect(contextText).toContain('Relevant memories:');
    expect(contextText).toContain('Insights:');
  });
});

describe('buildMemoryContext topic formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);
  });

  it('includes parsed topics in the formatted output', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Likes hiking', topics: '["outdoor", "fitness"]', importance: 0.7 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'hiking');
    expect(contextText).toContain('outdoor');
    expect(contextText).toContain('fitness');
  });

  it('handles empty topics gracefully', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'No topics memory', topics: '[]', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('No topics memory');
    // Should not have trailing topic parentheses
    expect(contextText).not.toContain('()');
  });

  it('handles malformed topics JSON gracefully', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Bad topics', topics: 'not-json', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Bad topics');
    // Should not crash
  });

  it('survives topics that parse to null', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Null topics', topics: 'null', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Null topics');
    expect(contextText).not.toContain('()');
  });

  it('survives topics that parse to a string', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'String topics', topics: '"just a string"', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('String topics');
    expect(contextText).not.toContain('()');
  });

  it('survives topics that parse to a number', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Number topics', topics: '42', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Number topics');
  });

  it('survives topics that parse to an object', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Object topics', topics: '{"key": "value"}', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Object topics');
  });

  it('survives topics with mixed array types', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Mixed array', topics: '["valid", 42, null, "also valid"]', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Mixed array');
    expect(contextText).toContain('valid');
    expect(contextText).toContain('also valid');
    // Non-string items filtered out
    expect(contextText).not.toContain('42');
  });

  it('survives topics as undefined or empty string', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Empty topics', topics: '', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Empty topics');
  });

  it('survives both layers having corrupted topics simultaneously', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ id: 1, summary: 'Layer1 bad', topics: 'null', importance: 0.8 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([
      makeMemory({ id: 2, summary: 'Layer2 bad', topics: '{"broken": true}', importance: 0.9 }),
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Layer1 bad');
    expect(contextText).toContain('Layer2 bad');
  });
});

describe('runDecaySweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls decayMemories once', () => {
    runDecaySweep();
    expect(mockDecayMemories).toHaveBeenCalledOnce();
  });
});
