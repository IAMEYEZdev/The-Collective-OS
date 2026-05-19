/**
 * DeepSec Graph Enrichment
 *
 * Connects scanner findings to GitNexus graph.
 * Answers: "Is this vulnerability reachable from an entry point?"
 * Answers: "What's the blast radius if this vuln is exploited?"
 */

import type { Driver } from 'neo4j-driver';
import type { Finding } from './scanner.js';
import { analyzeImpact } from '../gitnexus/query.js';

export interface EnrichedFinding extends Finding {
  /** Symbols that call the vulnerable code */
  callerChain: string[];
  /** Files in blast radius if this vuln is exploited */
  blastRadius: string[];
  /** Whether this is reachable from an entry point (bot.ts, index.ts, cli.ts) */
  reachableFromEntry: boolean;
  /** Enrichment confidence: 'high' if resolved through graph, 'low' if symbol not found */
  graphConfidence: 'high' | 'low' | 'none';
}

const ENTRY_POINTS = ['src/index.ts', 'src/bot.ts', 'src/agent.ts'];

export async function enrichFindings(
  findings: Finding[],
  driver: Driver
): Promise<EnrichedFinding[]> {
  const enriched: EnrichedFinding[] = [];

  // Cache impact results per file to avoid duplicate queries
  const impactCache = new Map<string, Awaited<ReturnType<typeof analyzeImpact>>>();

  for (const finding of findings) {
    try {
      // Use cached result if same file already analyzed
      let impact = impactCache.get(finding.filePath);
      if (!impact) {
        impact = await analyzeImpact(driver, finding.filePath);
        impactCache.set(finding.filePath, impact);
      }

      const callerChain = impact.callers.map(c => `${c.callerName} (${c.callerFile})`);
      const blastRadius = [
        ...impact.directDependents,
        ...impact.callers.map(c => c.callerFile),
      ];

      const reachableFromEntry = blastRadius.some(f =>
        ENTRY_POINTS.some(ep => f.includes(ep))
      ) || ENTRY_POINTS.some(ep => finding.filePath.includes(ep));

      enriched.push({
        ...finding,
        callerChain,
        blastRadius: [...new Set(blastRadius)],
        reachableFromEntry,
        graphConfidence: callerChain.length > 0 ? 'high' : 'low',
      });
    } catch {
      // Graph unavailable or query failed — return unenriched
      enriched.push({
        ...finding,
        callerChain: [],
        blastRadius: [],
        reachableFromEntry: false,
        graphConfidence: 'none',
      });
    }
  }

  return enriched;
}
