/**
 * GitNexus Ingest — Batched Neo4j MERGE writer
 *
 * Takes ParseResult from parser.ts, writes to Neo4j in batches of 500.
 * Idempotent — safe to re-run. Creates constraints and indexes on first run.
 * Uses separate labels from Graphiti (File, Symbol vs Community, Saga, etc).
 */

import neo4j, { Driver, Session } from 'neo4j-driver';
import type { ParseResult, FileNode, SymbolNode, ImportEdge, CallEdge, ExtendsEdge } from './parser.js';

const BATCH_SIZE = 500;

// ── Connection ─────────────────────────────────────────────────────

export function createDriver(
  uri = 'bolt://localhost:7687',
  user = 'neo4j',
  password = 'graphiti2026'
): Driver {
  return neo4j.driver(uri, neo4j.auth.basic(user, password));
}

// ── Schema Setup ───────────────────────────────────────────────────

async function ensureSchema(session: Session): Promise<void> {
  // Constraints (idempotent with IF NOT EXISTS)
  await session.run(`
    CREATE CONSTRAINT file_path_unique IF NOT EXISTS
    FOR (f:File) REQUIRE f.path IS UNIQUE
  `);
  await session.run(`
    CREATE CONSTRAINT symbol_unique IF NOT EXISTS
    FOR (s:Symbol) REQUIRE (s.name, s.filePath) IS UNIQUE
  `);

  // Indexes for query performance
  await session.run(`
    CREATE INDEX file_name_idx IF NOT EXISTS
    FOR (f:File) ON (f.name)
  `);
  await session.run(`
    CREATE INDEX symbol_kind_idx IF NOT EXISTS
    FOR (s:Symbol) ON (s.kind)
  `);

  // Fulltext index for symbol search
  try {
    await session.run(`
      CREATE FULLTEXT INDEX symbol_name_fulltext IF NOT EXISTS
      FOR (s:Symbol) ON EACH [s.name]
    `);
  } catch {
    // May already exist with different config — non-fatal
  }
}

// ── Batch Writers ──────────────────────────────────────────────────

async function ingestFiles(session: Session, files: FileNode[]): Promise<number> {
  let count = 0;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS f
       MERGE (file:File {path: f.path})
       SET file.name = f.name, file.updatedAt = timestamp()`,
      { batch }
    );
    count += batch.length;
  }
  return count;
}

async function ingestSymbols(session: Session, symbols: SymbolNode[]): Promise<number> {
  let count = 0;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS s
       MERGE (sym:Symbol {name: s.name, filePath: s.filePath})
       SET sym.kind = s.kind, sym.lineStart = s.lineStart, sym.updatedAt = timestamp()`,
      { batch }
    );
    count += batch.length;
  }
  return count;
}

async function ingestImports(session: Session, imports: ImportEdge[]): Promise<number> {
  let count = 0;
  for (let i = 0; i < imports.length; i += BATCH_SIZE) {
    const batch = imports.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS e
       MATCH (from:File {path: e.from})
       MATCH (to:File {path: e.to})
       MERGE (from)-[:IMPORTS]->(to)`,
      { batch }
    );
    count += batch.length;
  }
  return count;
}

async function ingestDefinedIn(session: Session, symbols: SymbolNode[]): Promise<number> {
  let count = 0;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS s
       MATCH (sym:Symbol {name: s.name, filePath: s.filePath})
       MATCH (file:File {path: s.filePath})
       MERGE (sym)-[:DEFINED_IN]->(file)`,
      { batch }
    );
    count += batch.length;
  }
  return count;
}

async function ingestCalls(session: Session, calls: CallEdge[]): Promise<number> {
  // Split into resolved and unresolved
  const resolved = calls.filter(c => c.calleeFile !== null);
  const unresolved = calls.filter(c => c.calleeFile === null);

  let count = 0;

  // Resolved calls — match both caller and callee symbols
  for (let i = 0; i < resolved.length; i += BATCH_SIZE) {
    const batch = resolved.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS c
       MATCH (caller:Symbol {name: c.caller, filePath: c.callerFile})
       MATCH (callee:Symbol {name: c.callee, filePath: c.calleeFile})
       MERGE (caller)-[:CALLS]->(callee)`,
      { batch }
    );
    count += batch.length;
  }

  // Unresolved calls — create edge with UNRESOLVED marker
  for (let i = 0; i < unresolved.length; i += BATCH_SIZE) {
    const batch = unresolved.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS c
       MATCH (caller:Symbol {name: c.caller, filePath: c.callerFile})
       MERGE (callee:Symbol {name: c.callee, filePath: '__UNRESOLVED__'})
       ON CREATE SET callee.kind = 'unresolved'
       MERGE (caller)-[:CALLS {resolved: false}]->(callee)`,
      { batch }
    );
    count += batch.length;
  }

  return count;
}

async function ingestExtends(session: Session, extendsEdges: ExtendsEdge[]): Promise<number> {
  let count = 0;
  const resolved = extendsEdges.filter(e => e.parentFile !== null);

  for (let i = 0; i < resolved.length; i += BATCH_SIZE) {
    const batch = resolved.slice(i, i + BATCH_SIZE);
    await session.run(
      `UNWIND $batch AS e
       MATCH (child:Symbol {name: e.child, filePath: e.childFile})
       MATCH (parent:Symbol {name: e.parent, filePath: e.parentFile})
       MERGE (child)-[:EXTENDS]->(parent)`,
      { batch }
    );
    count += batch.length;
  }

  return count;
}

// ── Main Ingest ────────────────────────────────────────────────────

export interface IngestStats {
  files: number;
  symbols: number;
  imports: number;
  definedIn: number;
  calls: number;
  extends: number;
  durationMs: number;
}

export async function ingestToNeo4j(
  data: ParseResult,
  driver: Driver
): Promise<IngestStats> {
  const start = Date.now();
  const session = driver.session();

  try {
    await ensureSchema(session);

    // Clear stale data from previous scans
    await session.run(`
      MATCH (n)
      WHERE n:File OR n:Symbol
      DETACH DELETE n
    `);

    const stats: IngestStats = {
      files: await ingestFiles(session, data.files),
      symbols: await ingestSymbols(session, data.symbols),
      imports: await ingestImports(session, data.imports),
      definedIn: await ingestDefinedIn(session, data.symbols),
      calls: await ingestCalls(session, data.calls),
      extends: await ingestExtends(session, data.extends),
      durationMs: 0,
    };

    stats.durationMs = Date.now() - start;
    return stats;
  } finally {
    await session.close();
  }
}
