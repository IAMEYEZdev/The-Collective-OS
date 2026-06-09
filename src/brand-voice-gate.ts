#!/usr/bin/env node
/**
 * Brand Voice Enforcement Gate (Item 5 — L2 Fix)
 *
 * Sits on the delivery boundary between agent output and Jason.
 * Two-tier enforcement:
 *   HARD BLOCK: em-dash U+2014 — auto-correct + notify + track per-agent
 *   HARD BLOCK: .md files in SEND_FILE — block entirely, agent must regenerate
 *   ADVISORY:   en-dash U+2013 — log only (legitimate uses exist)
 *   ADVISORY:   AI cliche phrases — log only
 *
 * Design principle: correct-and-notify-and-track, NOT correct-and-silently-continue.
 * The gate's success metric is violation RATE dropping over time, not just clean output.
 *
 * Usage as library:
 *   import { applyBrandVoiceGate, checkFileExtension } from './brand-voice-gate.js';
 *
 * Usage as CLI (for notify.sh Path D):
 *   echo "text" | node dist/brand-voice-gate.js --agent <agentId>
 *   Reads stdin, writes cleaned text to stdout, logs violations internally.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = process.env.CLAUDECLAW_PROJECT_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');

const VIOLATIONS_LOG = path.join(PROJECT_ROOT, 'logs', 'brand-voice-violations.jsonl');

// ── Hard block: em-dash U+2014 ──────────────────────────────────────
const EM_DASH_RE = /\u2014/g;

// ── Advisory: en-dash U+2013 (not hard-blocked: legitimate in ranges) ──
const EN_DASH_RE = /\u2013/g;

// ── Advisory: AI cliche starters ─────────────────────────────────────
const AI_CLICHES = [
  'Certainly!',
  'Great question!',
  "I'd be happy to",
  "I'd love to",
  'As an AI',
  'Let me help you with that',
  'Absolutely!',
  'Of course!',
  "That's a great point",
];

// ── Types ────────────────────────────────────────────────────────────

export interface Violation {
  type: 'em-dash';
  count: number;
  context: string;
  action: 'corrected';
}

export interface Advisory {
  type: 'en-dash' | 'ai-cliche';
  detail: string;
  context: string;
}

export interface BrandVoiceResult {
  cleaned: string;
  violations: Violation[];
  advisories: Advisory[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractContext(text: string, index: number, radius = 30): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\n/g, ' ').trim();
}

// ── Core gate ────────────────────────────────────────────────────────

export function applyBrandVoiceGate(text: string, agentId: string): BrandVoiceResult {
  const violations: Violation[] = [];
  const advisories: Advisory[] = [];

  // --- Hard block: em-dash U+2014 ---
  const emDashMatches = [...text.matchAll(EM_DASH_RE)];
  if (emDashMatches.length > 0) {
    const contexts = emDashMatches.slice(0, 3).map(m => extractContext(text, m.index!));
    violations.push({
      type: 'em-dash',
      count: emDashMatches.length,
      context: contexts.join(' | '),
      action: 'corrected',
    });
  }
  // Auto-correct: em-dash -> hyphen (clean output reaches Jason)
  let cleaned = text.replace(EM_DASH_RE, '-');

  // --- Advisory: en-dash U+2013 ---
  const enDashMatches = [...cleaned.matchAll(EN_DASH_RE)];
  if (enDashMatches.length > 0) {
    const contexts = enDashMatches.slice(0, 3).map(m => extractContext(cleaned, m.index!));
    advisories.push({
      type: 'en-dash',
      detail: `${enDashMatches.length} en-dash(es) found`,
      context: contexts.join(' | '),
    });
  }

  // --- Advisory: AI cliches ---
  const lowerText = cleaned.toLowerCase();
  for (const cliche of AI_CLICHES) {
    const idx = lowerText.indexOf(cliche.toLowerCase());
    if (idx !== -1) {
      advisories.push({
        type: 'ai-cliche',
        detail: cliche,
        context: extractContext(cleaned, idx),
      });
    }
  }

  // Log to JSONL for rate tracking
  if (violations.length > 0 || advisories.length > 0) {
    logToJSONL(agentId, violations, advisories);
  }

  return { cleaned, violations, advisories };
}

// ── .md file block for SEND_FILE (R7) ────────────────────────────────

export function checkFileExtension(filePath: string): { blocked: boolean; reason?: string } {
  if (filePath.toLowerCase().endsWith('.md')) {
    return {
      blocked: true,
      reason: 'R7 violation: .md files cannot be sent to Jason. Regenerate as .docx or .pdf.',
    };
  }
  return { blocked: false };
}

// ── JSONL violation log (rate tracking) ──────────────────────────────

function logToJSONL(agentId: string, violations: Violation[], advisories: Advisory[]): void {
  try {
    const logDir = path.dirname(VIOLATIONS_LOG);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const ts = new Date().toISOString();
    const entries: string[] = [];

    for (const v of violations) {
      entries.push(JSON.stringify({
        ts, agent: agentId, tier: 'hard-block',
        type: v.type, count: v.count, context: v.context, action: v.action,
      }));
    }
    for (const a of advisories) {
      entries.push(JSON.stringify({
        ts, agent: agentId, tier: 'advisory',
        type: a.type, detail: a.detail, context: a.context, action: 'logged',
      }));
    }

    fs.appendFileSync(VIOLATIONS_LOG, entries.join('\n') + '\n');
  } catch {
    // Best-effort logging. Never crash the send path.
  }
}

// ── Hive notification (agent attribution) ────────────────────────────

export function buildHiveNotification(agentId: string, violations: Violation[], advisories: Advisory[]): string | null {
  const parts: string[] = [];

  for (const v of violations) {
    parts.push(`HARD-BLOCK: ${v.type} x${v.count} from [${agentId}] -- auto-corrected. Agent must stop generating em-dashes (Rule 1).`);
  }
  for (const a of advisories) {
    if (a.type === 'ai-cliche') {
      parts.push(`ADVISORY: AI cliche "${a.detail}" from [${agentId}] -- not blocked, review recommended.`);
    } else if (a.type === 'en-dash') {
      parts.push(`ADVISORY: ${a.detail} from [${agentId}] -- check if legitimate range usage.`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

// ── Rate report (for Jason visibility) ───────────────────────────────

export function getViolationReport(): string {
  try {
    if (!fs.existsSync(VIOLATIONS_LOG)) return 'No violations recorded.';

    const lines = fs.readFileSync(VIOLATIONS_LOG, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return 'No violations recorded.';

    // Per-agent, per-type counts
    const counts: Record<string, Record<string, number>> = {};
    let totalHard = 0;
    let totalAdvisory = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const agent = entry.agent || 'unknown';
        const key = `${entry.tier}:${entry.type}`;
        if (!counts[agent]) counts[agent] = {};
        counts[agent][key] = (counts[agent][key] || 0) + (entry.count || 1);
        if (entry.tier === 'hard-block') totalHard += entry.count || 1;
        else totalAdvisory++;
      } catch { /* skip malformed lines */ }
    }

    const report: string[] = [
      `BRAND VOICE GATE -- Violation Report`,
      `Total entries: ${lines.length} (${totalHard} hard-blocks, ${totalAdvisory} advisories)`,
      '',
    ];

    for (const [agent, types] of Object.entries(counts).sort()) {
      report.push(`[${agent}]`);
      for (const [key, count] of Object.entries(types).sort()) {
        report.push(`  ${key}: ${count}`);
      }
    }

    return report.join('\n');
  } catch {
    return 'Could not read violation log.';
  }
}

// ── CLI entry point (Path D: notify.sh pipes through here) ──────────

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename.replace(/\.ts$/, '.js'));

if (isMain) {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf('--agent');
  const agentId = agentIdx >= 0 && args[agentIdx + 1] ? args[agentIdx + 1] : 'notify';

  // --report mode: dump violation rates
  if (args.includes('--report')) {
    console.log(getViolationReport());
    process.exit(0);
  }

  // --filter mode (default): read stdin, write cleaned stdout
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { input += chunk; });
  process.stdin.on('end', () => {
    const result = applyBrandVoiceGate(input, agentId);
    process.stdout.write(result.cleaned);

    // Log to hive if hard-block violations found (agent notification)
    if (result.violations.length > 0) {
      const notification = buildHiveNotification(agentId, result.violations, result.advisories);
      if (notification) {
        const hiveCli = path.join(PROJECT_ROOT, 'dist', 'hive-cli.js');
        import('child_process').then(({ execSync }) => {
          try {
            execSync(
              `node "${hiveCli}" log "brand-voice-violation" "${notification.replace(/"/g, '\\"')}"`,
              { stdio: 'pipe', timeout: 5000 },
            );
          } catch { /* best-effort */ }
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    } else {
      process.exit(0);
    }
  });
}
