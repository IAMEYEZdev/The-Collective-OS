import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { tempRoot } = vi.hoisted(() => {
  const fsModule = require('fs') as typeof import('fs');
  const osModule = require('os') as typeof import('os');
  const pathModule = require('path') as typeof import('path');
  return {
    tempRoot: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'claudeclaw-health-test-')),
  };
});

vi.mock('./config.js', () => ({
  PROJECT_ROOT: tempRoot,
  STORE_DIR: path.join(tempRoot, 'store'),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { formatStatusReport, TEST_STATUS_FILE, type TestStatus } from './health-status.js';

afterEach(() => {
  fs.rmSync(path.join(tempRoot, 'store'), { recursive: true, force: true });
});

describe('formatStatusReport', () => {
  it('reports missing daily test results as a health gap', () => {
    expect(formatStatusReport()).toContain('NO RESULT FILE');
  });

  it('formats a passing status file without running tests', () => {
    const status: TestStatus = {
      ranAt: new Date().toISOString(),
      durationMs: 90_000,
      success: true,
      total: 12,
      passed: 12,
      failed: 0,
      failedFiles: [],
    };
    fs.mkdirSync(path.dirname(TEST_STATUS_FILE), { recursive: true });
    fs.writeFileSync(TEST_STATUS_FILE, JSON.stringify(status));

    const report = formatStatusReport();

    expect(report).toContain('12/12 tests passed');
    expect(report).toContain('Run:');
  });

  it('includes failed files for failing status files', () => {
    const status: TestStatus = {
      ranAt: new Date().toISOString(),
      durationMs: 30_000,
      success: false,
      total: 3,
      passed: 2,
      failed: 1,
      failedFiles: ['src/db-memory.test.ts'],
    };
    fs.mkdirSync(path.dirname(TEST_STATUS_FILE), { recursive: true });
    fs.writeFileSync(TEST_STATUS_FILE, JSON.stringify(status));

    const report = formatStatusReport();

    expect(report).toContain('1 of 3 tests FAILED');
    expect(report).toContain('src/db-memory.test.ts');
  });
});
