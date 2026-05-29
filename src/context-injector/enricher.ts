/**
 * Prompt Enricher — ClaudeClaw Collective
 *
 * Auto-populates context from available sources (hive-mind, operator context,
 * agent directives, memory) and injects into mission/scheduled task prompts
 * before agent dispatch.
 *
 * Usage in scheduler:
 *   const enriched = await enrichPrompt(mission.prompt, mission.assigned_agent);
 *   const result = await runAgent(enriched, ...);
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { ContextCollector } from './collector.js';
import { injectContextIntoText } from './injector.js';
import type { InjectionStrategy, InjectionResult } from './types.js';
import { searchMemories, getOtherAgentActivity, searchConsolidations, getRecentConsolidations } from '../db.js';
import type { Memory, HiveMindEntry, Consolidation } from '../db.js';

/** Result of prompt enrichment */
export interface EnrichmentResult {
  prompt: string;
  injection: InjectionResult;
  sources: string[];
}

/**
 * Enrich a task prompt with available context sources.
 * Creates a temporary collector, populates it, injects, and returns enriched prompt.
 *
 * @param prompt      Raw task prompt
 * @param agentId     Target agent (e.g. 'research', 'comms')
 * @param options     Optional overrides
 */
export async function enrichPrompt(
  prompt: string,
  agentId: string | null,
  options: {
    strategy?: InjectionStrategy;
    skipHive?: boolean;
    skipOperator?: boolean;
    skipAgentDirectives?: boolean;
    skipMemory?: boolean;
    skipTeamActivity?: boolean;
    skipConsolidations?: boolean;
    projectRoot?: string;
  } = {}
): Promise<EnrichmentResult> {
  const {
    strategy = 'wrap',
    skipHive = false,
    skipOperator = false,
    skipAgentDirectives = false,
    skipMemory = false,
    skipTeamActivity = false,
    skipConsolidations = false,
    projectRoot = process.env.CLAUDECLAW_PROJECT_ROOT || process.cwd(),
  } = options;

  const collector = new ContextCollector();
  const sessionId = 'enrichment-' + Date.now();
  const sources: string[] = [];

  // 1. Operator context from env or standing rules file
  if (!skipOperator) {
    // Check env var first (set by mission-cli or externally)
    if (process.env.CLAUDECLAW_OPERATOR_CONTEXT) {
      collector.register(sessionId, {
        id: 'operator-env',
        source: 'operator-context',
        content: process.env.CLAUDECLAW_OPERATOR_CONTEXT,
        priority: 'high',
      });
      sources.push('operator-env');
    }

    // Check standing rules file
    const rulesPath = join(projectRoot, 'docs', 'standing-rules.md');
    if (existsSync(rulesPath)) {
      try {
        const rules = readFileSync(rulesPath, 'utf-8').trim();
        if (rules.length > 0 && rules.length < 2000) {
          collector.register(sessionId, {
            id: 'standing-rules',
            source: 'operator-context',
            content: `[Standing Rules]\n${rules}`,
            priority: 'normal',
          });
          sources.push('standing-rules');
        }
      } catch {
        // Non-fatal: skip if unreadable
      }
    }
  }

  // 2. Agent-specific directives from CLAUDE.md
  if (!skipAgentDirectives && agentId) {
    const agentDir = resolveAgentDir(agentId, projectRoot);
    if (agentDir) {
      const claudeMd = join(agentDir, 'CLAUDE.md');
      if (existsSync(claudeMd)) {
        try {
          const directives = readFileSync(claudeMd, 'utf-8').trim();
          // Only inject a summary hint, not the full CLAUDE.md (agent loads that itself)
          const identityLine = extractIdentityLine(directives);
          if (identityLine) {
            collector.register(sessionId, {
              id: 'agent-identity',
              source: 'agent-directives',
              content: `[Agent: ${agentId}] ${identityLine}`,
              priority: 'low',
            });
            sources.push('agent-identity');
          }
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // 3. Recent hive-mind activity (last 5 entries from hive log)
  if (!skipHive) {
    try {
      const hiveEntries = await getRecentHiveEntries(projectRoot, 5);
      if (hiveEntries.length > 0) {
        collector.register(sessionId, {
          id: 'hive-recent',
          source: 'hive-mind',
          content: `[Recent team activity]\n${hiveEntries.join('\n')}`,
          priority: 'low',
        });
        sources.push('hive-recent');
      }
    } catch {
      // Hive read failure is non-fatal
    }
  }

  // 4. Memory context — search relevant past memories for this task
  if (!skipMemory && process.env.ALLOWED_CHAT_ID) {
    try {
      const memories = searchMemories(process.env.ALLOWED_CHAT_ID, prompt, 3);
      if (memories.length > 0) {
        const memoryLines = memories.map((m: Memory) =>
          `- [${(m.importance / 10).toFixed(1)}] ${m.summary}`
        );
        collector.register(sessionId, {
          id: 'memory-recall',
          source: 'memory-context',
          content: `[Relevant memories]\n${memoryLines.join('\n')}`,
          priority: 'normal',
        });
        sources.push('memory-recall');
      }
    } catch {
      // Memory search failure is non-fatal
    }
  }

  // 5. Cross-agent team activity (what other agents did in last 24h)
  if (!skipTeamActivity && agentId) {
    try {
      const otherActivity = getOtherAgentActivity(agentId, 24, 5);
      if (otherActivity.length > 0) {
        const activityLines = otherActivity.map((e: HiveMindEntry) => {
          const ago = Math.round((Date.now() / 1000 - e.created_at) / 60);
          const timeLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
          return `- [${e.agent_id}] ${timeLabel}: ${e.summary.slice(0, 150)}`;
        });
        collector.register(sessionId, {
          id: 'team-activity',
          source: 'team-activity',
          content: `[Other agents' recent activity]\n${activityLines.join('\n')}`,
          priority: 'low',
        });
        sources.push('team-activity');
      }
    } catch {
      // Team activity read failure is non-fatal
    }
  }

  // 6. Mission state context (if CLAUDECLAW_MISSION_CONTEXT env is set)
  if (process.env.CLAUDECLAW_MISSION_CONTEXT) {
    collector.register(sessionId, {
      id: 'mission-state',
      source: 'mission-state',
      content: process.env.CLAUDECLAW_MISSION_CONTEXT,
      priority: 'normal',
    });
    sources.push('mission-state');
  }

  // 7. Consolidation insights — higher-level patterns derived from grouped memories
  if (!skipConsolidations && process.env.ALLOWED_CHAT_ID) {
    try {
      // Try task-relevant search first; fall back to most recent consolidations
      const keywords = prompt.split(/\s+/).slice(0, 8).join(' ');
      let consolidations: Consolidation[] = searchConsolidations(process.env.ALLOWED_CHAT_ID, keywords, 3);
      if (consolidations.length === 0) {
        consolidations = getRecentConsolidations(process.env.ALLOWED_CHAT_ID, 3);
      }
      if (consolidations.length > 0) {
        const insightLines = consolidations.map((c: Consolidation) =>
          `- ${c.summary}${c.insight ? ' → ' + c.insight : ''}`
        );
        collector.register(sessionId, {
          id: 'consolidation-insights',
          source: 'memory-context',
          content: `[Higher-level patterns]\n${insightLines.join('\n')}`,
          priority: 'low',
        });
        sources.push('consolidation-insights');
      }
    } catch {
      // Consolidation read failure is non-fatal
    }
  }

  // Inject
  if (!collector.hasPending(sessionId)) {
    return { prompt, injection: { injected: false, contextLength: 0, entryCount: 0 }, sources };
  }

  const { text, result } = injectContextIntoText(collector, sessionId, prompt, strategy);
  return { prompt: text, injection: result, sources };
}

// ---- Helpers ----

/** Map agent ID to directory path */
function resolveAgentDir(agentId: string, projectRoot: string): string | null {
  const agentMap: Record<string, string> = {
    melanie: 'agents/_template',
    annika: 'agents/research',
    research: 'agents/research',
    james: 'agents/comms',
    comms: 'agents/comms',
    sean: 'agents/ops',
    ops: 'agents/ops',
    melissa: 'agents/content',
    content: 'agents/content',
    jackson: 'agents/custom',
    custom: 'agents/custom',
  };

  const dir = agentMap[agentId];
  if (!dir) return null;
  const full = join(projectRoot, dir);
  return existsSync(full) ? full : null;
}

/** Extract first identity/personality line from CLAUDE.md */
function extractIdentityLine(claudeMd: string): string | null {
  // Look for "You are..." or "Your name is..." pattern
  const match = claudeMd.match(/(?:^|\n)\s*(You are [^\n]{10,120})/i)
    || claudeMd.match(/(?:^|\n)\s*(Your name is [^\n]{10,80})/i);
  return match ? match[1].trim() : null;
}

/** Read recent hive-mind entries via hive-cli */
async function getRecentHiveEntries(projectRoot: string, count: number): Promise<string[]> {
  const { execSync } = await import('child_process');
  try {
    const output = execSync(
      `node "${join(projectRoot, 'dist', 'hive-cli.js')}" read --limit ${count} --format oneline`,
      { encoding: 'utf-8', timeout: 5000, cwd: projectRoot }
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(line => line.trim().length > 0);
  } catch {
    return [];
  }
}
