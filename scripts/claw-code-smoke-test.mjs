#!/usr/bin/env node
// scripts/claw-code-smoke-test.mjs
// Verifies claw-code integration is wired correctly

import { execSync } from 'child_process';

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT || '.';
const tests = [];

// Test 1: Binary exists
try {
  const bin = process.env.CLAW_CODE_BIN || 'claw';
  execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 5000 });
  tests.push({ name: 'Binary', status: 'PASS' });
} catch {
  tests.push({ name: 'Binary', status: 'SKIP', note: 'claw binary not found (build with scripts/claw-code-build.sh)' });
}

// Test 2: TypeScript adapter files exist
import { existsSync } from 'fs';
import { join } from 'path';

const adapterFiles = [
  'src/borg-arc/adapters/claw-code-types.ts',
  'src/borg-arc/adapters/claw-code-adapter.ts',
  'src/borg-arc/adapters/claw-code-rag.ts',
  'src/borg-arc/adapters/claw-code-events.ts',
];

const allExist = adapterFiles.every((f) => existsSync(join(PROJECT_ROOT, f)));
tests.push({
  name: 'Adapter files',
  status: allExist ? 'PASS' : 'FAIL',
  note: allExist ? undefined : 'Missing adapter files in src/borg-arc/adapters/',
});

// Test 3: RAG service reachable
try {
  const ragUrl = process.env.CLAW_RAG_URL || 'http://localhost:8787';
  const res = await fetch(`${ragUrl}/health`);
  tests.push({ name: 'RAG health', status: res.ok ? 'PASS' : 'FAIL' });
} catch {
  tests.push({ name: 'RAG health', status: 'SKIP', note: 'RAG not running (start with docker compose -f docker/claw-code-compose.yml up -d)' });
}

// Test 4: Unit tests pass
try {
  execSync('npx vitest run tests/borg-arc/', {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 60000,
    stdio: 'pipe',
  });
  tests.push({ name: 'Unit tests', status: 'PASS' });
} catch (err) {
  tests.push({ name: 'Unit tests', status: 'FAIL', note: err.stderr?.slice(0, 200) || 'vitest failed' });
}

// Test 5: Docker compose file exists
tests.push({
  name: 'Docker compose',
  status: existsSync(join(PROJECT_ROOT, 'docker/claw-code-compose.yml')) ? 'PASS' : 'FAIL',
});

// Test 6: Build script exists
tests.push({
  name: 'Build script',
  status: existsSync(join(PROJECT_ROOT, 'scripts/claw-code-build.sh')) ? 'PASS' : 'FAIL',
});

// Report
console.log('\n=== Claw-Code Integration Smoke Test ===\n');
for (const t of tests) {
  const icon = t.status === 'PASS' ? 'OK' : t.status === 'SKIP' ? '--' : 'XX';
  console.log(`  [${icon}] ${t.name}${t.note ? ' (' + t.note + ')' : ''}`);
}

const passed = tests.filter((t) => t.status === 'PASS').length;
const skipped = tests.filter((t) => t.status === 'SKIP').length;
const failed = tests.filter((t) => t.status === 'FAIL').length;
const total = tests.length;
console.log(`\n  ${passed}/${total} passed, ${skipped} skipped, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
