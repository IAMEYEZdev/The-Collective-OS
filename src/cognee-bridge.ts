/**
 * Cognee Bridge — dual-write layer for Hermes L4 graph memory
 *
 * Architecture:
 * - SQLite remains primary store (zero-risk migration)
 * - Cognee receives structured DataPoints via HTTP for graph enrichment
 * - All writes are fire-and-forget: cognee failure never blocks SQLite
 * - Recall queries merge SQLite FTS + cognee graph results
 *
 * Env:
 *   COGNEE_URL      - Base URL (default: http://localhost:8000)
 *   COGNEE_API_KEY  - Optional API key for auth
 *   COGNEE_ENABLED  - Set to "true" to activate (default: disabled)
 */

import { logger } from './logger.js';

// ── Config ──────────────────────────────────────────────────────────

const COGNEE_URL = process.env.COGNEE_URL ?? 'http://localhost:8000';
const COGNEE_API_KEY = process.env.COGNEE_API_KEY ?? '';
const COGNEE_ENABLED = process.env.COGNEE_ENABLED === 'true';
const COGNEE_TIMEOUT_MS = 5000;

// ── Types ───────────────────────────────────────────────────────────

export interface CogneeRememberEntry {
  type: 'trace' | 'qa' | 'feedback' | 'skill_run';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CogneeRecallResult {
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export type CogneeSearchType =
  | 'GRAPH_COMPLETION'
  | 'RAG_COMPLETION'
  | 'CHUNKS'
  | 'SUMMARIES'
  | 'CYPHER'
  | 'FEELING_LUCKY';

// ── HTTP Client ─────────────────────────────────────────────────────

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (COGNEE_API_KEY) {
    h['X-Api-Key'] = COGNEE_API_KEY;
  }
  return h;
}

async function cogneePost<T>(path: string, body: unknown): Promise<T | null> {
  if (!COGNEE_ENABLED) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COGNEE_TIMEOUT_MS);

    const res = await fetch(`${COGNEE_URL}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(`cognee-bridge POST ${path} failed: ${res.status} ${text}`);
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    // Fire-and-forget: log but never throw
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      logger.warn(`cognee-bridge POST ${path} timed out (${COGNEE_TIMEOUT_MS}ms)`);
    } else {
      logger.warn(`cognee-bridge POST ${path} error: ${msg}`);
    }
    return null;
  }
}

async function cogneeGet<T>(path: string): Promise<T | null> {
  if (!COGNEE_ENABLED) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COGNEE_TIMEOUT_MS);

    const res = await fetch(`${COGNEE_URL}${path}`, {
      method: 'GET',
      headers: headers(),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── Bridge Functions (called from db.ts hooks) ──────────────────────

/**
 * Mirror a hive_mind log entry to cognee as a structured trace.
 * Maps to: HiveEntry DataPoint in cognee_collective ontology
 */
export function bridgeHiveLog(
  agentId: string,
  action: string,
  summary: string,
  artifacts?: string,
): void {
  if (!COGNEE_ENABLED) return;

  const content = [
    `[Agent: ${agentId}] [Action: ${action}]`,
    summary,
    artifacts ? `Artifacts: ${artifacts}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Fire-and-forget: don't await
  cogneePost('/api/v1/remember/entry', {
    entry: {
      type: 'trace',
      content,
      metadata: {
        agent_id: agentId,
        action,
        source: 'hive_mind',
        timestamp: new Date().toISOString(),
      },
    },
    dataset_name: 'collective_hive',
  }).catch(() => {});
}

/**
 * Mirror a structured memory to cognee for graph embedding.
 * Maps to: cognee native knowledge with entity/topic extraction
 */
export function bridgeMemory(
  agentId: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  source: string,
): void {
  if (!COGNEE_ENABLED) return;

  const content = [
    summary,
    entities.length ? `Entities: ${entities.join(', ')}` : '',
    topics.length ? `Topics: ${topics.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  cogneePost('/api/v1/remember/entry', {
    entry: {
      type: 'trace',
      content,
      metadata: {
        agent_id: agentId,
        importance,
        source,
        entities,
        topics,
        timestamp: new Date().toISOString(),
      },
    },
    dataset_name: 'collective_memory',
  }).catch(() => {});
}

/**
 * Mirror a mission task to cognee for cross-agent graph linkage.
 * Maps to: Task DataPoint + agent assignment edges
 */
export function bridgeMissionTask(
  taskId: string,
  title: string,
  prompt: string,
  assignedAgent: string | null,
  priority: number,
): void {
  if (!COGNEE_ENABLED) return;

  const content = [
    `Task: ${title}`,
    `ID: ${taskId}`,
    `Priority: ${priority}`,
    assignedAgent ? `Assigned: ${assignedAgent}` : 'Unassigned',
    `Prompt: ${prompt}`,
  ].join('\n');

  cogneePost('/api/v1/remember/entry', {
    entry: {
      type: 'trace',
      content,
      metadata: {
        task_id: taskId,
        title,
        assigned_agent: assignedAgent,
        priority,
        source: 'mission_tasks',
        timestamp: new Date().toISOString(),
      },
    },
    dataset_name: 'collective_tasks',
  }).catch(() => {});
}

/**
 * Mirror board audit events for organizational graph tracking.
 * Maps to: AuditEntry DataPoint
 */
export function bridgeBoardAudit(
  cardId: string,
  cardTitle: string,
  agentId: string,
  action: string,
  field: string | null,
  oldValue: string | null,
  newValue: string | null,
): void {
  if (!COGNEE_ENABLED) return;

  const content = [
    `Board audit: ${action} on "${cardTitle}" (${cardId})`,
    `Agent: ${agentId}`,
    field ? `Field: ${field}` : '',
    oldValue ? `Old: ${oldValue}` : '',
    newValue ? `New: ${newValue}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  cogneePost('/api/v1/remember/entry', {
    entry: {
      type: 'trace',
      content,
      metadata: {
        card_id: cardId,
        card_title: cardTitle,
        agent_id: agentId,
        action,
        field,
        old_value: oldValue,
        new_value: newValue,
        source: 'board_audit',
        timestamp: new Date().toISOString(),
      },
    },
    dataset_name: 'collective_board',
  }).catch(() => {});
}

// ── Query Functions (graph-enhanced retrieval) ──────────────────────

/**
 * Query cognee graph for related knowledge.
 * Returns graph-enhanced results alongside SQLite FTS.
 */
export async function recallFromGraph(
  query: string,
  searchType: CogneeSearchType = 'GRAPH_COMPLETION',
  topK = 10,
  datasets?: string[],
): Promise<CogneeRecallResult[]> {
  if (!COGNEE_ENABLED) return [];

  const result = await cogneePost<{ results?: CogneeRecallResult[] }>(
    '/api/v1/recall',
    {
      query,
      search_type: searchType,
      top_k: topK,
      datasets: datasets ?? ['collective_hive', 'collective_memory', 'collective_tasks'],
    },
  );

  return result?.results ?? [];
}

/**
 * Trigger cognee's cognify pipeline on stored data.
 * This builds knowledge graph relationships from ingested entries.
 */
export async function triggerCognify(datasetName?: string): Promise<boolean> {
  if (!COGNEE_ENABLED) return false;

  const result = await cogneePost<{ status?: string }>('/api/v1/cognify', {
    dataset_name: datasetName ?? 'collective_hive',
  });

  return result?.status === 'ok' || result?.status === 'success';
}

// ── Health Check ────────────────────────────────────────────────────

export async function cogneeHealthCheck(): Promise<{
  enabled: boolean;
  reachable: boolean;
  url: string;
}> {
  if (!COGNEE_ENABLED) {
    return { enabled: false, reachable: false, url: COGNEE_URL };
  }

  const result = await cogneeGet<{ status?: string }>('/api/v1/health');
  return {
    enabled: true,
    reachable: result !== null,
    url: COGNEE_URL,
  };
}

// ── Status ──────────────────────────────────────────────────────────

export function isCogneeEnabled(): boolean {
  return COGNEE_ENABLED;
}

export function getCogneeUrl(): string {
  return COGNEE_URL;
}
