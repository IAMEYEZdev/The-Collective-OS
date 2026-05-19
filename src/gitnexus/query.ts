/**
 * GitNexus Query API — Structural awareness for agents
 *
 * Agents call these to answer: "what calls X?", "what breaks if I change Y?",
 * "how does file A connect to file B?"
 */

import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';

// ── Types ──────────────────────────────────────────────────────────

export interface CallerResult {
  callerName: string;
  callerFile: string;
  callerKind: string;
}

export interface DependencyPath {
  path: string[];     // file paths from A to B
  length: number;
}

export interface SubgraphNode {
  label: string;
  name: string;
  filePath?: string;
  kind?: string;
}

export interface SubgraphEdge {
  from: string;
  to: string;
  type: string;
}

export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export interface ImpactResult {
  directDependents: string[];     // files that import this file
  callers: CallerResult[];        // symbols that call symbols in this file
  totalImpact: number;            // unique files affected
}

export interface SymbolSearchResult {
  name: string;
  kind: string;
  filePath: string;
  lineStart: number;
}

// ── Query Functions ────────────────────────────────────────────────

/**
 * Find all symbols that call a given symbol name.
 * Answers: "what calls initDatabase?"
 */
export async function findCallers(
  driver: Driver,
  symbolName: string
): Promise<CallerResult[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (caller:Symbol)-[:CALLS]->(callee:Symbol)
       WHERE callee.name = $name
       RETURN caller.name AS callerName, caller.filePath AS callerFile, caller.kind AS callerKind`,
      { name: symbolName }
    );
    return result.records.map(r => ({
      callerName: r.get('callerName'),
      callerFile: r.get('callerFile'),
      callerKind: r.get('callerKind'),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Find shortest import path between two files.
 * Answers: "how does bot.ts connect to db.ts?"
 */
export async function findDependencyPath(
  driver: Driver,
  fileA: string,
  fileB: string
): Promise<DependencyPath | null> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:File), (b:File)
       WHERE a.path CONTAINS $fileA AND b.path CONTAINS $fileB
       MATCH p = shortestPath((a)-[:IMPORTS*]-(b))
       RETURN [n IN nodes(p) | n.path] AS path, length(p) AS len
       LIMIT 1`,
      { fileA, fileB }
    );
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return {
      path: record.get('path'),
      length: typeof record.get('len') === 'object'
        ? (record.get('len') as { toNumber(): number }).toNumber()
        : record.get('len'),
    };
  } finally {
    await session.close();
  }
}

/**
 * Get subgraph around a file — all connected nodes up to N depth.
 * Answers: "what's the dependency neighborhood of scheduler.ts?"
 */
export async function getSubgraph(
  driver: Driver,
  filePath: string,
  depth = 2
): Promise<Subgraph> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (start:File)
       WHERE start.path CONTAINS $filePath
       CALL {
         WITH start
         MATCH path = (start)-[*1..${Math.min(depth, 5)}]-(connected)
         RETURN connected, relationships(path) AS rels
       }
       WITH collect(DISTINCT connected) AS nodes, collect(rels) AS allRels
       RETURN nodes, allRels`,
      { filePath }
    );

    const nodes: SubgraphNode[] = [];
    const edges: SubgraphEdge[] = [];
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();

    if (result.records.length > 0) {
      const record = result.records[0];
      const rawNodes = record.get('nodes') as any[];

      for (const n of rawNodes) {
        const labels = n.labels as string[];
        const props = n.properties;
        const key = `${labels[0]}:${props.name || props.path}`;
        if (seenNodes.has(key)) continue;
        seenNodes.add(key);

        nodes.push({
          label: labels[0],
          name: props.name || props.path,
          filePath: props.filePath || props.path,
          kind: props.kind,
        });
      }

      const rawRels = record.get('allRels') as any[];
      for (const relGroup of rawRels) {
        for (const rel of relGroup) {
          const startId = rel.startNodeElementId;
          const endId = rel.endNodeElementId;
          const type = rel.type;
          const edgeKey = `${startId}-${type}-${endId}`;
          if (seenEdges.has(edgeKey)) continue;
          seenEdges.add(edgeKey);

          edges.push({
            from: startId,
            to: endId,
            type,
          });
        }
      }
    }

    return { nodes, edges };
  } finally {
    await session.close();
  }
}

/**
 * Impact analysis — what breaks if this file changes?
 * Answers: "what's the blast radius of changing config.ts?"
 */
export async function analyzeImpact(
  driver: Driver,
  filePath: string
): Promise<ImpactResult> {
  const session = driver.session();
  try {
    // Files that directly import this file
    const importResult = await session.run(
      `MATCH (dependent:File)-[:IMPORTS]->(target:File)
       WHERE target.path CONTAINS $filePath
       RETURN dependent.path AS path`,
      { filePath }
    );
    const directDependents = importResult.records.map(r => r.get('path') as string);

    // Symbols in other files that call symbols defined in this file
    const callerResult = await session.run(
      `MATCH (caller:Symbol)-[:CALLS]->(callee:Symbol)-[:DEFINED_IN]->(file:File)
       WHERE file.path CONTAINS $filePath AND caller.filePath <> callee.filePath
       RETURN DISTINCT caller.name AS callerName, caller.filePath AS callerFile, caller.kind AS callerKind`,
      { filePath }
    );
    const callers = callerResult.records.map(r => ({
      callerName: r.get('callerName'),
      callerFile: r.get('callerFile'),
      callerKind: r.get('callerKind'),
    }));

    // Unique files in blast radius
    const affectedFiles = new Set([
      ...directDependents,
      ...callers.map(c => c.callerFile),
    ]);

    return {
      directDependents,
      callers,
      totalImpact: affectedFiles.size,
    };
  } finally {
    await session.close();
  }
}

/**
 * Search symbols by name (fulltext).
 * Answers: "find all symbols matching 'auth'"
 */
export async function searchSymbols(
  driver: Driver,
  query: string,
  limit = 20
): Promise<SymbolSearchResult[]> {
  const session = driver.session();
  const intLimit = neo4j.int(limit);
  try {
    // Try fulltext first, fall back to CONTAINS
    let result;
    try {
      result = await session.run(
        `CALL db.index.fulltext.queryNodes("symbol_name_fulltext", $query)
         YIELD node, score
         WHERE node.filePath <> '__UNRESOLVED__'
         RETURN node.name AS name, node.kind AS kind, node.filePath AS filePath, node.lineStart AS lineStart
         ORDER BY score DESC
         LIMIT $limit`,
        { query: `${query}*`, limit: intLimit }
      );
    } catch {
      result = await session.run(
        `MATCH (s:Symbol)
         WHERE s.name CONTAINS $query AND s.filePath <> '__UNRESOLVED__'
         RETURN s.name AS name, s.kind AS kind, s.filePath AS filePath, s.lineStart AS lineStart
         LIMIT $limit`,
        { query, limit: intLimit }
      );
    }

    return result.records.map(r => ({
      name: r.get('name'),
      kind: r.get('kind'),
      filePath: r.get('filePath'),
      lineStart: typeof r.get('lineStart') === 'object'
        ? (r.get('lineStart') as { toNumber(): number }).toNumber()
        : r.get('lineStart'),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Get high-level graph stats.
 */
export async function getStats(driver: Driver): Promise<Record<string, number>> {
  const session = driver.session();
  try {
    const queries: [string, string][] = [
      ['files', 'MATCH (f:File) RETURN count(f) AS c'],
      ['symbols', "MATCH (s:Symbol) WHERE s.filePath <> '__UNRESOLVED__' RETURN count(s) AS c"],
      ['imports', 'MATCH ()-[i:IMPORTS]->() RETURN count(i) AS c'],
      ['calls', 'MATCH ()-[c:CALLS]->() RETURN count(c) AS c'],
      ['definedIn', 'MATCH ()-[d:DEFINED_IN]->() RETURN count(d) AS c'],
      ['extends', 'MATCH ()-[e:EXTENDS]->() RETURN count(e) AS c'],
    ];

    const stats: Record<string, number> = {};
    for (const [key, query] of queries) {
      const result = await session.run(query);
      const val = result.records[0]?.get('c');
      stats[key] = typeof val === 'object' && val.toNumber ? val.toNumber() : Number(val ?? 0);
    }
    return stats;
  } finally {
    await session.close();
  }
}
