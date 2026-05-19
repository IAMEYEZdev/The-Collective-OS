#!/usr/bin/env node
/**
 * GitNexus CLI — Entry point for scan + query
 *
 * Usage:
 *   node dist/gitnexus/cli.js scan                          # full parse + ingest
 *   node dist/gitnexus/cli.js stats                         # graph statistics
 *   node dist/gitnexus/cli.js callers <symbolName>          # who calls this symbol?
 *   node dist/gitnexus/cli.js path <fileA> <fileB>          # shortest import path
 *   node dist/gitnexus/cli.js impact <filePath>             # blast radius analysis
 *   node dist/gitnexus/cli.js search <query>                # fulltext symbol search
 *   node dist/gitnexus/cli.js subgraph <filePath> [depth]   # neighborhood graph
 */

import path from 'node:path';
import { parseProject } from './parser.js';
import { createDriver, ingestToNeo4j } from './ingest.js';
import {
  findCallers,
  findDependencyPath,
  getSubgraph,
  analyzeImpact,
  searchSymbols,
  getStats,
} from './query.js';

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT
  ?? path.resolve(import.meta.dirname, '..', '..');

const TSCONFIG = path.join(PROJECT_ROOT, 'tsconfig.json');

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  printUsage();
  process.exit(1);
}

async function main(): Promise<void> {
  switch (command) {
    case 'scan': {
      console.log(`Parsing ${TSCONFIG}...`);
      const start = Date.now();
      const data = parseProject(TSCONFIG);
      const parseMs = Date.now() - start;

      console.log(`Parsed in ${parseMs}ms:`);
      console.log(`  Files:   ${data.files.length}`);
      console.log(`  Symbols: ${data.symbols.length}`);
      console.log(`  Imports: ${data.imports.length}`);
      console.log(`  Calls:   ${data.calls.length}`);
      console.log(`  Extends: ${data.extends.length}`);

      console.log('\nIngesting to Neo4j...');
      const driver = createDriver();
      try {
        const stats = await ingestToNeo4j(data, driver);
        console.log(`Ingested in ${stats.durationMs}ms`);
        console.log('\nGitNexus scan complete. Graph is live.');
      } finally {
        await driver.close();
      }
      break;
    }

    case 'stats': {
      const driver = createDriver();
      try {
        const stats = await getStats(driver);
        console.log('GitNexus Graph Stats:');
        for (const [key, val] of Object.entries(stats)) {
          console.log(`  ${key}: ${val}`);
        }
      } finally {
        await driver.close();
      }
      break;
    }

    case 'callers': {
      const name = args[1];
      if (!name) {
        console.error('Usage: gitnexus callers <symbolName>');
        process.exit(1);
      }
      const driver = createDriver();
      try {
        const results = await findCallers(driver, name);
        if (results.length === 0) {
          console.log(`No callers found for "${name}"`);
        } else {
          console.log(`Callers of "${name}" (${results.length}):`);
          for (const r of results) {
            console.log(`  ${r.callerName} (${r.callerKind}) in ${r.callerFile}`);
          }
        }
      } finally {
        await driver.close();
      }
      break;
    }

    case 'path': {
      const fileA = args[1];
      const fileB = args[2];
      if (!fileA || !fileB) {
        console.error('Usage: gitnexus path <fileA> <fileB>');
        process.exit(1);
      }
      const driver = createDriver();
      try {
        const result = await findDependencyPath(driver, fileA, fileB);
        if (!result) {
          console.log(`No import path found between "${fileA}" and "${fileB}"`);
        } else {
          console.log(`Path (${result.length} hops):`);
          for (const p of result.path) {
            console.log(`  -> ${p}`);
          }
        }
      } finally {
        await driver.close();
      }
      break;
    }

    case 'impact': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: gitnexus impact <filePath>');
        process.exit(1);
      }
      const driver = createDriver();
      try {
        const result = await analyzeImpact(driver, filePath);
        console.log(`Impact analysis for "${filePath}":`);
        console.log(`  Total blast radius: ${result.totalImpact} files`);
        if (result.directDependents.length > 0) {
          console.log(`\n  Direct dependents (${result.directDependents.length}):`);
          for (const d of result.directDependents) {
            console.log(`    ${d}`);
          }
        }
        if (result.callers.length > 0) {
          console.log(`\n  External callers (${result.callers.length}):`);
          for (const c of result.callers) {
            console.log(`    ${c.callerName} in ${c.callerFile}`);
          }
        }
      } finally {
        await driver.close();
      }
      break;
    }

    case 'search': {
      const query = args[1];
      if (!query) {
        console.error('Usage: gitnexus search <query>');
        process.exit(1);
      }
      const driver = createDriver();
      try {
        const results = await searchSymbols(driver, query);
        if (results.length === 0) {
          console.log(`No symbols matching "${query}"`);
        } else {
          console.log(`Symbols matching "${query}" (${results.length}):`);
          for (const r of results) {
            console.log(`  ${r.name} (${r.kind}) at ${r.filePath}:${r.lineStart}`);
          }
        }
      } finally {
        await driver.close();
      }
      break;
    }

    case 'subgraph': {
      const filePath = args[1];
      const depth = parseInt(args[2] ?? '2', 10);
      if (!filePath) {
        console.error('Usage: gitnexus subgraph <filePath> [depth]');
        process.exit(1);
      }
      const driver = createDriver();
      try {
        const result = await getSubgraph(driver, filePath, depth);
        console.log(`Subgraph for "${filePath}" (depth ${depth}):`);
        console.log(`  Nodes: ${result.nodes.length}`);
        console.log(`  Edges: ${result.edges.length}`);
        if (result.nodes.length > 0) {
          console.log('\n  Nodes:');
          for (const n of result.nodes) {
            console.log(`    [${n.label}] ${n.name}${n.kind ? ` (${n.kind})` : ''}`);
          }
        }
      } finally {
        await driver.close();
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
GitNexus — Structural Awareness for ClaudeClaw

Commands:
  scan                          Parse source + ingest to Neo4j
  stats                         Show graph statistics
  callers <symbolName>          Find all callers of a symbol
  path <fileA> <fileB>          Shortest import path between files
  impact <filePath>             Blast radius if file changes
  search <query>                Fulltext symbol search
  subgraph <filePath> [depth]   Neighborhood graph (default depth: 2)
`);
}

main().catch((err) => {
  console.error('GitNexus error:', err.message ?? err);
  process.exit(1);
});
