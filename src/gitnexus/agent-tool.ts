#!/usr/bin/env node
/**
 * GitNexus Agent Tool
 *
 * Thin wrapper that lets any ClaudeClaw agent run GitNexus queries
 * without knowing CLI internals. Designed to be called via mission-cli:
 *
 *   node dist/mission-cli.js create --agent main --title "GitNexus: callers of parseProject" \
 *     "Run GitNexus agent tool: node dist/gitnexus/agent-tool.js callers parseProject"
 *
 * Or directly by Melanie/any agent with shell access:
 *   node dist/gitnexus/agent-tool.js impact src/scheduler.ts
 *
 * Outputs JSON for easy parsing by agents. Exits 0 on success, 1 on error.
 */

import { createDriver } from './ingest.js';
import {
  findCallers,
  findDependencyPath,
  getSubgraph,
  analyzeImpact,
  searchSymbols,
  getStats,
} from './query.js';

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help') {
  console.log(JSON.stringify({
    tool: 'gitnexus',
    commands: {
      stats: { args: [], description: 'Graph node/edge counts' },
      callers: { args: ['symbolName'], description: 'Find all callers of a symbol' },
      path: { args: ['fileA', 'fileB'], description: 'Shortest import path between files' },
      impact: { args: ['filePath'], description: 'Blast radius if file changes' },
      search: { args: ['query'], description: 'Fulltext symbol search' },
      subgraph: { args: ['filePath', 'depth?'], description: 'Neighborhood graph' },
    },
    usage: 'node dist/gitnexus/agent-tool.js <command> [args...]',
  }, null, 2));
  process.exit(0);
}

async function run(): Promise<void> {
  const driver = createDriver();
  try {
    let result: unknown;

    switch (command) {
      case 'stats': {
        result = await getStats(driver);
        break;
      }
      case 'callers': {
        const name = args[1];
        if (!name) throw new Error('Missing argument: symbolName');
        result = await findCallers(driver, name);
        break;
      }
      case 'path': {
        const fileA = args[1];
        const fileB = args[2];
        if (!fileA || !fileB) throw new Error('Missing arguments: fileA fileB');
        result = await findDependencyPath(driver, fileA, fileB);
        break;
      }
      case 'impact': {
        const filePath = args[1];
        if (!filePath) throw new Error('Missing argument: filePath');
        result = await analyzeImpact(driver, filePath);
        break;
      }
      case 'search': {
        const query = args[1];
        if (!query) throw new Error('Missing argument: query');
        result = await searchSymbols(driver, query);
        break;
      }
      case 'subgraph': {
        const filePath = args[1];
        const depth = parseInt(args[2] ?? '2', 10);
        if (!filePath) throw new Error('Missing argument: filePath');
        result = await getSubgraph(driver, filePath, depth);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}. Run with 'help' for usage.`);
    }

    console.log(JSON.stringify({ ok: true, command, result }, null, 2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, command, error: message }));
    process.exit(1);
  } finally {
    await driver.close();
  }
}

run();
