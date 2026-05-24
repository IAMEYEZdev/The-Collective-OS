/**
 * CollectiveBoard - Focalboard API Bridge
 * Connects agent task system to visual Kanban dashboard
 */

import { logBoardAudit, logStatusTransition, getStatusHistory, getCardCycleTime, getAgentHealth } from '../db.js';
import type { AgentHealthMetrics, StatusHistoryEntry } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────

export interface BoardConfig {
  baseUrl: string;
  username: string;
  password: string;
  teamId: string;
}

export interface AuthToken {
  token: string;
  expiresAt: number; // unix ms
}

export interface BoardProperty {
  id: string;
  name: string;
  type: string;
  options: Array<{ id: string; value: string; color: string }>;
}

export interface Board {
  id: string;
  title: string;
  teamId: string;
  type: string;
  cardProperties: BoardProperty[];
  description?: string;
}

export interface CardFields {
  icon?: string;
  contentOrder?: string[];
  properties: Record<string, string | string[]>;
}

export interface Card {
  id: string;
  title: string;
  boardId: string;
  type: 'card';
  fields: CardFields;
  createAt: number;
  updateAt: number;
  deleteAt: number;
  parentId?: string;
  createdBy?: string;
  modifiedBy?: string;
}

export type AgentName = 'melanie' | 'james' | 'annika' | 'sean' | 'melissa' | 'jackson';
export type TaskStatus = 'backlog' | 'active' | 'blocked' | 'review' | 'done';
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';
export type TaskTrack = 'authority' | 'delivery' | 'internal';

// ── Agent Icons ────────────────────────────────────────────────────

const AGENT_ICONS: Record<AgentName, string> = {
  melanie: '👑',
  james: '✍️',
  annika: '🔬',
  sean: '⚡',
  melissa: '🎨',
  jackson: '📊',
};

// ── Default Board Properties ───────────────────────────────────────

export const BOARD_PROPERTIES: BoardProperty[] = [
  {
    id: 'prop-status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'opt-backlog', value: 'Backlog', color: 'propColorGray' },
      { id: 'opt-active', value: 'Active', color: 'propColorBlue' },
      { id: 'opt-blocked', value: 'Blocked', color: 'propColorRed' },
      { id: 'opt-review', value: 'Review', color: 'propColorYellow' },
      { id: 'opt-done', value: 'Done', color: 'propColorGreen' },
    ],
  },
  {
    id: 'prop-agent',
    name: 'Agent',
    type: 'select',
    options: [
      { id: 'opt-melanie', value: 'Melanie', color: 'propColorPurple' },
      { id: 'opt-james', value: 'James', color: 'propColorBlue' },
      { id: 'opt-annika', value: 'Annika', color: 'propColorTeal' },
      { id: 'opt-sean', value: 'Sean', color: 'propColorOrange' },
      { id: 'opt-melissa', value: 'Melissa', color: 'propColorPink' },
      { id: 'opt-jackson', value: 'Jackson', color: 'propColorBrown' },
    ],
  },
  {
    id: 'prop-priority',
    name: 'Priority',
    type: 'select',
    options: [
      { id: 'opt-critical', value: 'Critical', color: 'propColorRed' },
      { id: 'opt-high', value: 'High', color: 'propColorOrange' },
      { id: 'opt-normal', value: 'Normal', color: 'propColorBlue' },
      { id: 'opt-low', value: 'Low', color: 'propColorGray' },
    ],
  },
  {
    id: 'prop-track',
    name: 'Track',
    type: 'select',
    options: [
      { id: 'opt-authority', value: 'Authority', color: 'propColorPurple' },
      { id: 'opt-delivery', value: 'Delivery', color: 'propColorGreen' },
      { id: 'opt-internal', value: 'Internal', color: 'propColorGray' },
    ],
  },
  {
    id: 'prop-goal-id',
    name: 'Goal ID',
    type: 'text',
    options: [],
  },
  {
    id: 'prop-mission-id',
    name: 'Mission ID',
    type: 'text',
    options: [],
  },
  {
    id: 'prop-layer',
    name: 'Layer',
    type: 'select',
    options: [
      { id: 'opt-l1', value: 'L1', color: 'propColorGray' },
      { id: 'opt-l2', value: 'L2', color: 'propColorBlue' },
      { id: 'opt-l3', value: 'L3', color: 'propColorGreen' },
      { id: 'opt-l4', value: 'L4', color: 'propColorYellow' },
      { id: 'opt-l5', value: 'L5', color: 'propColorOrange' },
      { id: 'opt-l6', value: 'L6', color: 'propColorRed' },
    ],
  },
  {
    id: 'prop-due-date',
    name: 'Due Date',
    type: 'date',
    options: [],
  },
  {
    id: 'prop-revenue',
    name: 'Revenue',
    type: 'number',
    options: [],
  },
  {
    id: 'prop-depends-on',
    name: 'Depends On',
    type: 'text',
    options: [],
  },
];

// ── Status/Agent/Priority option ID maps ───────────────────────────

const STATUS_MAP: Record<TaskStatus, string> = {
  backlog: 'opt-backlog',
  active: 'opt-active',
  blocked: 'opt-blocked',
  review: 'opt-review',
  done: 'opt-done',
};

const AGENT_MAP: Record<AgentName, string> = {
  melanie: 'opt-melanie',
  james: 'opt-james',
  annika: 'opt-annika',
  sean: 'opt-sean',
  melissa: 'opt-melissa',
  jackson: 'opt-jackson',
};

const PRIORITY_MAP: Record<TaskPriority, string> = {
  critical: 'opt-critical',
  high: 'opt-high',
  normal: 'opt-normal',
  low: 'opt-low',
};

const TRACK_MAP: Record<TaskTrack, string> = {
  authority: 'opt-authority',
  delivery: 'opt-delivery',
  internal: 'opt-internal',
};

const LAYER_MAP: Record<string, string> = {
  L1: 'opt-l1', L2: 'opt-l2', L3: 'opt-l3',
  L4: 'opt-l4', L5: 'opt-l5', L6: 'opt-l6',
};

// ── Webhook ───────────────────────────────────────────────────────

export interface WebhookPayload {
  event: string;      // create | status_change | reassign | delete | approved | gate_blocked
  cardId: string;
  cardTitle: string;
  agent: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  timestamp: number;
}

/**
 * Fire-and-forget webhook POST. 3s timeout. Never throws.
 * Configured via COLLECTIVEBOARD_WEBHOOK_URL env var (comma-separated for multiple).
 */
async function fireWebhook(payload: WebhookPayload): Promise<void> {
  const urls = (process.env.COLLECTIVEBOARD_WEBHOOK_URL || '').split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) return;

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch { /* fire-and-forget */ }
  }
}

// ── Client ─────────────────────────────────────────────────────────

export class CollectiveBoardClient {
  private config: BoardConfig;
  private auth: AuthToken | null = null;
  private boardId: string | null = null;

  constructor(config?: Partial<BoardConfig>) {
    this.config = {
      baseUrl: config?.baseUrl || process.env.COLLECTIVEBOARD_URL || 'http://localhost',
      username: config?.username || process.env.COLLECTIVEBOARD_USER || 'melanie',
      password: config?.password || process.env.COLLECTIVEBOARD_PASS || 'CollectiveBoard2026!',
      teamId: config?.teamId || process.env.COLLECTIVEBOARD_TEAM || '0',
    };
  }

  // ── Auth ───────────────────────────────────────────────────────

  private async login(): Promise<string> {
    // Reuse valid token (refresh 5min before expiry)
    if (this.auth && this.auth.expiresAt > Date.now() + 300_000) {
      return this.auth.token;
    }

    const res = await fetch(`${this.config.baseUrl}/api/v2/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        type: 'normal',
        username: this.config.username,
        email: `${this.config.username}@collective.local`,
        password: this.config.password,
      }),
    });

    if (!res.ok) {
      throw new Error(`CollectiveBoard login failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { token: string };
    this.auth = {
      token: data.token,
      expiresAt: Date.now() + 3_600_000, // 1hr conservative
    };
    return this.auth.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.login();
    const res = await fetch(`${this.config.baseUrl}/api/v2${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CollectiveBoard ${method} ${path}: ${res.status} ${text}`);
    }

    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // ── Board Management ───────────────────────────────────────────

  async ensureBoard(title = 'Collective Operations'): Promise<string> {
    if (this.boardId) return this.boardId;

    // Check existing boards
    const boards = await this.request<Board[]>('GET', `/teams/${this.config.teamId}/boards`);
    const existing = boards.find(b => b.title === title);

    if (existing) {
      this.boardId = existing.id;
      return this.boardId;
    }

    // Create with properties
    const board = await this.request<Board>('POST', '/boards', {
      title,
      teamId: this.config.teamId,
      type: 'O',
      description: 'Multi-agent task coordination board',
      cardProperties: BOARD_PROPERTIES,
    });

    this.boardId = board.id;
    return this.boardId;
  }

  // ── Card CRUD ──────────────────────────────────────────────────

  async createTask(opts: {
    title: string;
    agent: AgentName;
    status?: TaskStatus;
    priority?: TaskPriority;
    track?: TaskTrack;
    layer?: string;
    goalId?: string;
    missionId?: string;
    revenue?: number;
    dependsOn?: string;
  }): Promise<Card> {
    const boardId = await this.ensureBoard();
    const now = Date.now();

    // Dependency validation: if dependsOn specified, verify target exists and isn't done
    if (opts.dependsOn) {
      const depCard = await this.getCard(opts.dependsOn);
      if (!depCard) throw new Error(`Dependency card not found: ${opts.dependsOn}`);
    }

    const properties: Record<string, string> = {
      'prop-agent': AGENT_MAP[opts.agent],
      'prop-status': STATUS_MAP[opts.status || 'active'],
      'prop-priority': PRIORITY_MAP[opts.priority || 'normal'],
    };

    if (opts.track) properties['prop-track'] = TRACK_MAP[opts.track];
    if (opts.layer && LAYER_MAP[opts.layer]) properties['prop-layer'] = LAYER_MAP[opts.layer];
    if (opts.goalId) properties['prop-goal-id'] = opts.goalId;
    if (opts.missionId) properties['prop-mission-id'] = opts.missionId;
    if (opts.revenue !== undefined) properties['prop-revenue'] = String(opts.revenue);
    if (opts.dependsOn) properties['prop-depends-on'] = opts.dependsOn;

    const blocks = await this.request<Card[]>('POST', `/boards/${boardId}/blocks`, [{
      title: opts.title,
      boardId,
      type: 'card',
      fields: {
        icon: AGENT_ICONS[opts.agent],
        contentOrder: [],
        properties,
      },
      createAt: now,
      updateAt: now,
      deleteAt: 0,
    }]);

    const card = blocks[0];
    try {
      logBoardAudit(card.id, opts.title, opts.agent, 'create', '', '', opts.status || 'active');
      logStatusTransition(card.id, opts.title, opts.agent, '', opts.status || 'active');
    } catch { /* audit is best-effort */ }
    fireWebhook({
      event: 'create', cardId: card.id, cardTitle: opts.title,
      agent: opts.agent, timestamp: Math.floor(Date.now() / 1000),
    });

    return card;
  }

  /**
   * Fetch a single card by reading all blocks and filtering.
   * Focalboard's single-block GET returns HTML, so we use the list endpoint.
   */
  private async getCard(cardId: string): Promise<Card | undefined> {
    const boardId = await this.ensureBoard();
    const blocks = await this.request<Card[]>('GET', `/boards/${boardId}/blocks?type=card`);
    return blocks.find(b => b.id === cardId);
  }

  /**
   * Patch card fields using Focalboard's BlockPatch format.
   * `updatedFields` merges into block.Fields at top-level keys.
   * Properties require read-modify-write since the entire properties
   * map is replaced, not deep-merged.
   */
  private async patchCard(
    cardId: string,
    propertyUpdates?: Record<string, string>,
    fieldUpdates?: Record<string, unknown>,
  ): Promise<void> {
    const boardId = await this.ensureBoard();
    const updatedFields: Record<string, unknown> = { ...fieldUpdates };

    if (propertyUpdates) {
      // Read current properties and merge
      const card = await this.getCard(cardId);
      const currentProps = card?.fields?.properties || {};
      updatedFields['properties'] = { ...currentProps, ...propertyUpdates };
    }

    await this.request('PATCH', `/boards/${boardId}/blocks/${cardId}`, {
      updatedFields,
    });
  }

  async updateTaskStatus(
    cardId: string,
    status: TaskStatus,
    opts?: { approver?: string },
  ): Promise<void> {
    // Read old status for audit trail + gate check
    let oldStatus = '';
    let cardTitle = '';
    try {
      const card = await this.getCard(cardId);
      if (card) {
        cardTitle = card.title;
        const oldOptId = card.fields?.properties?.['prop-status'] as string || '';
        oldStatus = Object.entries(STATUS_MAP).find(([, v]) => v === oldOptId)?.[0] || oldOptId;
      }
    } catch { /* best-effort */ }

    // Dependency gate: can't move to 'active' or 'done' if dependency isn't done
    try {
      const card = await this.getCard(cardId);
      const depId = card?.fields?.properties?.['prop-depends-on'] as string || '';
      if (depId && (status === 'active' || status === 'done')) {
        const depCard = await this.getCard(depId);
        const depStatus = depCard?.fields?.properties?.['prop-status'] as string || '';
        if (depStatus !== STATUS_MAP.done) {
          const depLabel = Object.entries(STATUS_MAP).find(([, v]) => v === depStatus)?.[0] || 'unknown';
          throw new Error(`Blocked by dependency "${depCard?.title || depId}" (status: ${depLabel}). Complete dependency first.`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Blocked by dependency')) throw err;
      /* best-effort dep check */
    }

    // Approval gate: review→done requires approver
    if (oldStatus === 'review' && status === 'done' && !opts?.approver) {
      const msg = `Approval required: card "${cardTitle}" (${cardId}) is in review. Use --approver <name> to approve.`;
      try {
        logBoardAudit(cardId, cardTitle, this.config.username, 'gate_blocked', 'status', 'review', 'done');
      } catch { /* best-effort */ }
      fireWebhook({
        event: 'gate_blocked', cardId, cardTitle,
        agent: this.config.username, field: 'status',
        oldValue: 'review', newValue: 'done',
        timestamp: Math.floor(Date.now() / 1000),
      });
      throw new Error(msg);
    }

    await this.patchCard(cardId, { 'prop-status': STATUS_MAP[status] });

    try {
      const card = await this.getCard(cardId);
      const auditAction = opts?.approver ? 'approved' : 'status_change';
      const auditNew = opts?.approver ? `${status} (by ${opts.approver})` : status;
      const agentOptId = (card?.fields?.properties?.['prop-agent'] as string) || '';
      const assignedAgent = Object.entries(AGENT_MAP).find(([, v]) => v === agentOptId)?.[0] || this.config.username;
      logBoardAudit(cardId, card?.title || '', assignedAgent, auditAction, 'status', oldStatus, auditNew);
      logStatusTransition(cardId, card?.title || cardTitle, assignedAgent, oldStatus, status);
    } catch { /* audit is best-effort */ }
    fireWebhook({
      event: opts?.approver ? 'approved' : 'status_change',
      cardId, cardTitle, agent: this.config.username,
      field: 'status', oldValue: oldStatus, newValue: status,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  async reassignTask(cardId: string, agent: AgentName): Promise<void> {
    // Read old agent for audit trail
    let oldAgent = '';
    try {
      const card = await this.getCard(cardId);
      if (card) {
        const oldOptId = card.fields?.properties?.['prop-agent'] as string || '';
        oldAgent = Object.entries(AGENT_MAP).find(([, v]) => v === oldOptId)?.[0] || oldOptId;
      }
    } catch { /* best-effort */ }

    await this.patchCard(
      cardId,
      { 'prop-agent': AGENT_MAP[agent] },
      { icon: AGENT_ICONS[agent] },
    );

    try {
      const card = await this.getCard(cardId);
      logBoardAudit(cardId, card?.title || '', this.config.username, 'reassign', 'agent', oldAgent, agent);
    } catch { /* audit is best-effort */ }
    fireWebhook({
      event: 'reassign', cardId, cardTitle: '',
      agent: this.config.username, field: 'agent',
      oldValue: oldAgent, newValue: agent,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  async completeTask(cardId: string): Promise<void> {
    await this.updateTaskStatus(cardId, 'done');
  }

  async blockTask(cardId: string): Promise<void> {
    await this.updateTaskStatus(cardId, 'blocked');
  }

  async deleteTask(cardId: string): Promise<void> {
    const boardId = await this.ensureBoard();

    // Capture card title before deletion for audit
    let title = '';
    try {
      const card = await this.getCard(cardId);
      title = card?.title || '';
    } catch { /* best-effort */ }

    await this.request('DELETE', `/boards/${boardId}/blocks/${cardId}`);

    try {
      logBoardAudit(cardId, title, this.config.username, 'delete');
    } catch { /* audit is best-effort */ }
    fireWebhook({
      event: 'delete', cardId, cardTitle: title,
      agent: this.config.username,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  // ── Queries ────────────────────────────────────────────────────

  async getAllTasks(): Promise<Card[]> {
    const boardId = await this.ensureBoard();
    return this.request<Card[]>('GET', `/boards/${boardId}/blocks?type=card`);
  }

  async getAgentTasks(agent: AgentName): Promise<Card[]> {
    const all = await this.getAllTasks();
    return all.filter(c =>
      c.fields?.properties?.['prop-agent'] === AGENT_MAP[agent]
    );
  }

  async getActiveTasks(): Promise<Card[]> {
    const all = await this.getAllTasks();
    return all.filter(c =>
      c.fields?.properties?.['prop-status'] === STATUS_MAP.active
    );
  }

  async getBlockedTasks(): Promise<Card[]> {
    const all = await this.getAllTasks();
    return all.filter(c =>
      c.fields?.properties?.['prop-status'] === STATUS_MAP.blocked
    );
  }

  async getTrackTasks(track: TaskTrack): Promise<Card[]> {
    const all = await this.getAllTasks();
    return all.filter(c =>
      c.fields?.properties?.['prop-track'] === TRACK_MAP[track]
    );
  }

  async getFilteredTasks(filters: {
    agent?: AgentName;
    status?: TaskStatus;
    track?: TaskTrack;
    priority?: TaskPriority;
  }): Promise<Card[]> {
    const all = await this.getAllTasks();
    return all.filter(c => {
      const props = c.fields?.properties || {};
      if (filters.agent && props['prop-agent'] !== AGENT_MAP[filters.agent]) return false;
      if (filters.status && props['prop-status'] !== STATUS_MAP[filters.status]) return false;
      if (filters.track && props['prop-track'] !== TRACK_MAP[filters.track]) return false;
      if (filters.priority && props['prop-priority'] !== PRIORITY_MAP[filters.priority]) return false;
      return true;
    });
  }

  /** Reverse-resolve option IDs to human-readable labels */
  resolveCardProps(card: Card): {
    status: string; agent: string; priority: string; track: string; layer: string;
  } {
    const props = card.fields?.properties || {};
    const resolve = (map: Record<string, string>, propKey: string): string => {
      const val = props[propKey] as string || '';
      return Object.entries(map).find(([, v]) => v === val)?.[0] || val || '-';
    };
    return {
      status: resolve(STATUS_MAP, 'prop-status'),
      agent: resolve(AGENT_MAP, 'prop-agent'),
      priority: resolve(PRIORITY_MAP, 'prop-priority'),
      track: resolve(TRACK_MAP, 'prop-track'),
      layer: resolve(LAYER_MAP, 'prop-layer'),
    };
  }

  // ── Revenue ─────────────────────────────────────────────────────

  async setRevenue(cardId: string, amount: number): Promise<void> {
    const card = await this.getCard(cardId);
    await this.patchCard(cardId, { 'prop-revenue': String(amount) });
    try {
      logBoardAudit(cardId, card?.title || '', this.config.username, 'revenue_set', 'revenue',
        card?.fields?.properties?.['prop-revenue'] as string || '0', String(amount));
    } catch { /* best-effort */ }
    fireWebhook({
      event: 'revenue_set', cardId, cardTitle: card?.title || '',
      agent: this.config.username, field: 'revenue',
      oldValue: card?.fields?.properties?.['prop-revenue'] as string || '0',
      newValue: String(amount),
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  /** Pipeline value: sum of revenue on non-done cards */
  async getPipelineValue(filters?: { agent?: AgentName; track?: TaskTrack }): Promise<{
    total: number;
    byAgent: Record<string, number>;
    byTrack: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    const all = await this.getAllTasks();
    const result = { total: 0, byAgent: {} as Record<string, number>, byTrack: {} as Record<string, number>, byStatus: {} as Record<string, number> };

    for (const card of all) {
      const props = card.fields?.properties || {};
      const rev = parseFloat(props['prop-revenue'] as string || '0');
      if (rev <= 0) continue;

      if (filters?.agent && props['prop-agent'] !== AGENT_MAP[filters.agent]) continue;
      if (filters?.track && props['prop-track'] !== TRACK_MAP[filters.track]) continue;

      const agent = Object.entries(AGENT_MAP).find(([, v]) => v === (props['prop-agent'] as string))?.[0] || 'unknown';
      const track = Object.entries(TRACK_MAP).find(([, v]) => v === (props['prop-track'] as string))?.[0] || 'untracked';
      const status = Object.entries(STATUS_MAP).find(([, v]) => v === (props['prop-status'] as string))?.[0] || 'unknown';

      result.total += rev;
      result.byAgent[agent] = (result.byAgent[agent] || 0) + rev;
      result.byTrack[track] = (result.byTrack[track] || 0) + rev;
      result.byStatus[status] = (result.byStatus[status] || 0) + rev;
    }

    return result;
  }

  // ── Dependencies ───────────────────────────────────────────────

  async setDependency(cardId: string, dependsOnId: string): Promise<void> {
    // Verify target exists
    const dep = await this.getCard(dependsOnId);
    if (!dep) throw new Error(`Dependency card not found: ${dependsOnId}`);

    // Circular check: dependsOnId must not depend on cardId
    const depDep = dep.fields?.properties?.['prop-depends-on'] as string || '';
    if (depDep === cardId) throw new Error(`Circular dependency: ${dependsOnId} already depends on ${cardId}`);

    await this.patchCard(cardId, { 'prop-depends-on': dependsOnId });
    try {
      const card = await this.getCard(cardId);
      logBoardAudit(cardId, card?.title || '', this.config.username, 'dependency_set', 'depends-on', '', dependsOnId);
    } catch { /* best-effort */ }
  }

  /** Get cards that depend on this card */
  async getDependents(cardId: string): Promise<Card[]> {
    const all = await this.getAllTasks();
    return all.filter(c => (c.fields?.properties?.['prop-depends-on'] as string) === cardId);
  }

  // ── Time Tracking / History ────────────────────────────────────

  getTaskHistory(cardId: string): StatusHistoryEntry[] {
    return getStatusHistory(cardId);
  }

  getTaskCycleTime(cardId: string): number | null {
    return getCardCycleTime(cardId);
  }

  // ── Agent Health ───────────────────────────────────────────────

  getAgentHealthReport(agentId?: string): AgentHealthMetrics[] {
    return getAgentHealth(agentId);
  }

  async getBoard(): Promise<Board | null> {
    if (!this.boardId) await this.ensureBoard();
    if (!this.boardId) return null;
    return this.request<Board>('GET', `/boards/${this.boardId}`);
  }

  // ── Dashboard Summary ──────────────────────────────────────────

  async getDashboard(): Promise<{
    total: number;
    byStatus: Record<TaskStatus, number>;
    byAgent: Record<AgentName, number>;
    blocked: Card[];
    pipelineValue: number;
    revenueByAgent: Record<string, number>;
    health: AgentHealthMetrics[];
  }> {
    const all = await this.getAllTasks();

    const byStatus = { backlog: 0, active: 0, blocked: 0, review: 0, done: 0 };
    const byAgent = { melanie: 0, james: 0, annika: 0, sean: 0, melissa: 0, jackson: 0 };
    const revenueByAgent: Record<string, number> = {};
    let pipelineValue = 0;

    const blocked: Card[] = [];

    for (const card of all) {
      const props = card.fields?.properties || {};

      // Count by status
      for (const [status, optId] of Object.entries(STATUS_MAP)) {
        if (props['prop-status'] === optId) {
          byStatus[status as TaskStatus]++;
          if (status === 'blocked') blocked.push(card);
        }
      }

      // Count by agent + revenue
      for (const [agent, optId] of Object.entries(AGENT_MAP)) {
        if (props['prop-agent'] === optId) {
          byAgent[agent as AgentName]++;
          const rev = parseFloat(props['prop-revenue'] as string || '0');
          if (rev > 0) {
            pipelineValue += rev;
            revenueByAgent[agent] = (revenueByAgent[agent] || 0) + rev;
          }
        }
      }
    }

    let health: AgentHealthMetrics[] = [];
    try { health = getAgentHealth(); } catch { /* best-effort */ }

    return { total: all.length, byStatus, byAgent, blocked, pipelineValue, revenueByAgent, health };
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _instance: CollectiveBoardClient | null = null;

export function getClient(config?: Partial<BoardConfig>): CollectiveBoardClient {
  if (!_instance) {
    _instance = new CollectiveBoardClient(config);
  }
  return _instance;
}

export default CollectiveBoardClient;
