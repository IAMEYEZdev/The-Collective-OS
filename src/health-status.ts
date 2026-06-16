import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT, STORE_DIR } from './config.js';
import { logger } from './logger.js';

// ── Off-chat-path health status (MEM-SHIM-01 Workstream C) ──────────
// The full vitest suite exceeds the 900s chat-turn timeout, so it must
// NEVER run inside a chat turn. A daily 05:30 job runs it out-of-band
// and writes a summary file; the 06:00 report and any "is the Collective
// healthy" question answer from that file in seconds.

type Sender = (text: string) => Promise<void>;

const HEALTH_DIR = path.join(STORE_DIR, 'health');
export const TEST_STATUS_FILE = path.join(HEALTH_DIR, 'test-status.json');
const RAW_RESULTS_FILE = path.join(HEALTH_DIR, 'vitest-raw.json');

const SUITE_TIME = '05:30';
const REPORT_TIME = '06:00';
const SUITE_TIMEOUT_MS = 30 * 60_000;
const STALE_AFTER_MS = 26 * 60 * 60_000;

export interface TestStatus {
  ranAt: string;
  durationMs: number;
  success: boolean;
  total: number;
  passed: number;
  failed: number;
  failedFiles: string[];
  error?: string;
}

function vitestJsonToStatus(ranAt: string, durationMs: number): TestStatus {
  const raw = JSON.parse(fs.readFileSync(RAW_RESULTS_FILE, 'utf-8')) as {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    success: boolean;
    testResults: Array<{ name: string; status: string }>;
  };
  return {
    ranAt,
    durationMs,
    success: raw.success,
    total: raw.numTotalTests,
    passed: raw.numPassedTests,
    failed: raw.numFailedTests,
    failedFiles: raw.testResults
      .filter((t) => t.status === 'failed')
      .map((t) => path.relative(PROJECT_ROOT, t.name)),
  };
}

/**
 * Run the full vitest suite out-of-band and write the summary to
 * TEST_STATUS_FILE. Never call this from a chat turn.
 */
export async function runTestSuiteJob(): Promise<TestStatus> {
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
  const startedAt = Date.now();
  const ranAt = new Date(startedAt).toISOString();
  logger.info('Health status: running full vitest suite (off-chat-path)');

  const vitestEntry = path.join(PROJECT_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

  const status = await new Promise<TestStatus>((resolve) => {
    execFile(
      process.execPath,
      [vitestEntry, 'run', '--reporter=json', `--outputFile=${RAW_RESULTS_FILE}`],
      { cwd: PROJECT_ROOT, timeout: SUITE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err) => {
        const durationMs = Date.now() - startedAt;
        try {
          // vitest exits non-zero when tests fail but still writes the JSON
          resolve(vitestJsonToStatus(ranAt, durationMs));
        } catch (parseErr) {
          resolve({
            ranAt,
            durationMs,
            success: false,
            total: 0,
            passed: 0,
            failed: 0,
            failedFiles: [],
            error: `Suite did not produce results: ${err ? String(err.message).slice(0, 200) : String(parseErr).slice(0, 200)}`,
          });
        }
      },
    );
  });

  fs.writeFileSync(TEST_STATUS_FILE, JSON.stringify(status, null, 2));
  logger.info(
    { success: status.success, passed: status.passed, total: status.total, durationMs: status.durationMs },
    'Health status: suite complete, summary written',
  );
  return status;
}

/** Read the latest test status. Fast: file read only, no test execution. */
export function readTestStatus(): TestStatus | null {
  try {
    return JSON.parse(fs.readFileSync(TEST_STATUS_FILE, 'utf-8')) as TestStatus;
  } catch {
    return null;
  }
}

/** Format the daily status report from the result file. */
export function formatStatusReport(): string {
  const status = readTestStatus();
  if (!status) {
    return '🧪 Collective daily test report: NO RESULT FILE. The 05:30 suite run has not produced store/health/test-status.json. Investigate.';
  }
  const ageMs = Date.now() - Date.parse(status.ranAt);
  const stale = ageMs > STALE_AFTER_MS;
  const mins = Math.round(status.durationMs / 60_000 * 10) / 10;
  const head = status.success
    ? `✅ Collective operating within normal parameters: ${status.passed}/${status.total} tests passed`
    : `❌ Collective health degraded: ${status.failed} of ${status.total} tests FAILED`;
  const lines = [
    `🧪 Collective daily test report`,
    head,
    `Run: ${status.ranAt} (${mins} min)`,
  ];
  if (status.failedFiles.length > 0) lines.push(`Failed files: ${status.failedFiles.join(', ')}`);
  if (status.error) lines.push(`Error: ${status.error}`);
  if (stale) lines.push(`⚠️ Result is STALE (>26h old). The 05:30 job may not be running.`);
  return lines.join('\n');
}

let lastSuiteDate = '';
let lastReportDate = '';

/**
 * Start the daily 05:30 suite run and 06:00 Telegram report.
 * Main process only — call once after the bot is ready.
 */
export function initHealthStatus(send: Sender): void {
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);

    if (hhmm === SUITE_TIME && lastSuiteDate !== today) {
      lastSuiteDate = today;
      void runTestSuiteJob().catch((err) => logger.error({ err }, 'Health status: suite job failed'));
    }

    if (hhmm === REPORT_TIME && lastReportDate !== today) {
      lastReportDate = today;
      send(formatStatusReport()).catch((err) => logger.error({ err }, 'Health status: report send failed'));
    }
  }, 30_000);
  logger.info({ suiteTime: SUITE_TIME, reportTime: REPORT_TIME }, 'Health status scheduler started');
}
