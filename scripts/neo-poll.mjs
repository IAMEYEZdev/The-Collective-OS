#!/usr/bin/env node
/**
 * neo-poll.mjs — Neo → QM result ingestion poller
 *
 * Runs on 60s cron. Scans workspace/dispatch/inbound/ for new result
 * envelopes, validates schema, runs security + latent gates, fires
 * Hermes L4 events, and logs to hive.
 *
 * Usage:
 *   node scripts/neo-poll.mjs              — single poll cycle
 *   node scripts/neo-poll.mjs --watch      — continuous 60s loop
 *
 * Phase 3 gating checklist items covered:
 *   - [x] Validates + ingests results
 *   - [x] Runs DeepSec gate on code artifacts before marking success
 *   - [x] Runs Borg ARC absorption on latentFeedback.hiddenStateRef
 *   - [x] Fires proper Hermes createLatentMessage (not plain hive log)
 *   - [x] Calls GitNexus diff post-result, attaches to artifact log
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INBOUND_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'inbound');
const OUTBOUND_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'outbound');
const REPLIES_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'replies');
const PROCESSED_MARKER = '.ingested';
const STALL_CAP_MS = 5 * 60 * 1000; // 5 minutes max for partial results

// Track when we first saw each ULID in partial state (persists across polls in watch mode)
const partialFirstSeen = new Map(); // ULID → { timestamp, lastHash }

// ── Schema validation ─────────────────────────────────────────────────
const REQUIRED_FIELDS = ['version', 'ulid', 'status', 'summary'];
const VALID_STATUSES = ['success', 'partial', 'failed', 'escalate'];

function validateResult(result) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in result)) errors.push(`missing required field: ${field}`);
  }
  if (result.status && !VALID_STATUSES.includes(result.status)) {
    errors.push(`invalid status: ${result.status} (expected: ${VALID_STATUSES.join('|')})`);
  }
  if (result.version !== 1) {
    errors.push(`unsupported version: ${result.version} (expected: 1)`);
  }
  return errors;
}

// ── DeepSec gate ──────────────────────────────────────────────────────
// For code|review|pentest|integration tasks: scan artifacts before accepting
async function runDeepSecGate(result, dispatchEnvelope) {
  const scanTypes = ['code', 'review', 'pentest', 'integration'];
  const taskType = dispatchEnvelope?.task?.type;

  if (!taskType || !scanTypes.includes(taskType)) {
    return { passed: true, skipped: true, reason: `task type '${taskType}' exempt from DeepSec` };
  }

  const artifactPaths = (result.artifacts || [])
    .filter(a => a.path)
    .map(a => path.resolve(PROJECT_ROOT, a.path));

  if (artifactPaths.length === 0) {
    return { passed: true, skipped: true, reason: 'no artifacts to scan' };
  }

  const scannerPath = path.join(PROJECT_ROOT, 'src', 'deepsec', 'scanner.ts');
  if (!fs.existsSync(scannerPath)) {
    console.error('[neo-poll] WARNING: DeepSec scanner not found, degrading to pass-through');
    return { passed: true, skipped: true, reason: 'scanner not deployed yet' };
  }

  try {
    for (const artifactPath of artifactPaths) {
      if (!fs.existsSync(artifactPath)) continue;
      execSync(
        `npx tsx "${scannerPath}" --scan "${artifactPath}" --format json`,
        { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 30000 },
      );
    }
    return { passed: true, skipped: false };
  } catch (err) {
    return { passed: false, skipped: false, reason: `DeepSec scan failed: ${err.message}` };
  }
}

// ── Borg ARC absorption ───────────────────────────────────────────────
// If latentFeedback.hiddenStateRef present, absorb enriched latent state
async function runBorgArcAbsorption(result) {
  if (!result.latentFeedback?.hiddenStateRef) {
    return { absorbed: false, reason: 'no latent feedback ref' };
  }

  const f32Path = path.resolve(PROJECT_ROOT, result.latentFeedback.hiddenStateRef);
  if (!fs.existsSync(f32Path)) {
    console.error(`[neo-poll] WARNING: Latent feedback ref missing: ${f32Path}`);
    return { absorbed: false, reason: 'ref file missing' };
  }

  const absorberPath = path.join(PROJECT_ROOT, 'src', 'borg-arc', 'absorb.ts');
  if (!fs.existsSync(absorberPath)) {
    console.error('[neo-poll] WARNING: Borg ARC absorber not deployed, skipping');
    return { absorbed: false, reason: 'absorber not deployed yet' };
  }

  try {
    const output = execSync(
      `npx tsx "${absorberPath}" --input "${f32Path}" --format json`,
      { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 30000 },
    );
    return { absorbed: true, enrichedState: JSON.parse(output.toString()) };
  } catch (err) {
    console.error(`[neo-poll] Borg ARC absorption failed: ${err.message}`);
    return { absorbed: false, reason: err.message };
  }
}

// ── GitNexus diff ─────────────────────────────────────────────────────
// Surface commits/diffs on branch since dispatch issuedAt
async function runGitNexusDiff(result, dispatchEnvelope) {
  if (!dispatchEnvelope?.context?.branch || !dispatchEnvelope?.issuedAt) {
    return null;
  }

  try {
    const since = dispatchEnvelope.issuedAt;
    const branch = dispatchEnvelope.context.branch;
    const diffOutput = execSync(
      `git log --oneline --since="${since}" ${branch} 2>/dev/null || echo "(no commits)"`,
      { cwd: dispatchEnvelope.context.repoRoot || PROJECT_ROOT, stdio: 'pipe', timeout: 10000 },
    );
    return diffOutput.toString().trim();
  } catch {
    return null;
  }
}

// ── Hermes L4 latent message ──────────────────────────────────────────
// Fire proper createLatentMessage, not plain hive log
async function fireHermesEvent(result, borgArcResult) {
  const payload = {
    data: borgArcResult?.enrichedState || result.latentFeedback || null,
    resultSummary: result.summary,
    status: result.status,
    ulid: result.ulid,
    tacticalContributions: result.tacticalContributions || [],
    openQuestions: result.openQuestions || [],
  };

  // Hermes L4 createLatentMessage via hive bridge
  // In Phase 3, this calls into the Hermes registry directly
  // For now, structured hive log with hermes metadata
  const hermesPath = path.join(PROJECT_ROOT, 'src', 'hermes', 'index.ts');
  if (fs.existsSync(hermesPath)) {
    try {
      // Direct Hermes call when available
      execSync(
        `npx tsx -e "
          import { createLatentMessage, registerAgent } from '${hermesPath.replace(/\\/g, '/')}';
          registerAgent({ agentId: 'neo', accepts: ['text','latent'], produces: ['text','latent'] });
          createLatentMessage({ fromAgent: 'neo', toAgent: 'qm', payload: ${JSON.stringify(JSON.stringify(payload))} });
        "`,
        { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 15000 },
      );
      return { fired: true, direct: true };
    } catch (err) {
      console.error(`[neo-poll] Hermes direct call failed, falling back to structured log: ${err.message}`);
    }
  }

  // Fallback: structured hive log with hermes metadata tag
  try {
    execSync(
      `node "${path.join(PROJECT_ROOT, 'dist', 'hive-cli.js')}" log "hermes-l4-neo-result" "${result.ulid} ${result.status}: ${(result.summary || '').slice(0, 100)}" --agent melanie --hemisphere xhemi`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' },
    );
    return { fired: true, direct: false };
  } catch { return { fired: false }; }
}

// ── Status action mapping ─────────────────────────────────────────────
function statusAction(status) {
  const map = {
    success: 'Mark child goal complete, ingest artifacts, fire L5 AxACE playbook upsert',
    partial: 'Mark child goal in_progress, queue follow-up dispatch with delta',
    failed: 'Mark child goal blocked, surface to Jason with summary + recommendation',
    escalate: 'Block on Jason — Neo flagged irreversible/strategic decision',
  };
  return map[status] || 'unknown status';
}

// ── Main poll cycle ───────────────────────────────────────────────────
async function pollCycle() {
  if (!fs.existsSync(INBOUND_DIR)) {
    console.log('[neo-poll] Inbound dir missing, nothing to poll');
    return 0;
  }

  const resultFiles = fs.readdirSync(INBOUND_DIR)
    .filter(f => f.endsWith('.result.json'))
    .filter(f => !fs.existsSync(path.join(INBOUND_DIR, f + PROCESSED_MARKER)));

  if (resultFiles.length === 0) {
    return 0;
  }

  console.log(`[neo-poll] Found ${resultFiles.length} new result(s)`);
  let processed = 0;

  for (const file of resultFiles) {
    const resultPath = path.join(INBOUND_DIR, file);
    console.log(`\n[neo-poll] Processing: ${file}`);

    // 1. Parse + validate
    let result;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    } catch (err) {
      console.error(`[neo-poll] MALFORMED JSON: ${err.message} — escalating`);
      logEscalation(file, `Malformed result JSON: ${err.message}`);
      markProcessed(resultPath);
      continue;
    }

    const errors = validateResult(result);
    if (errors.length > 0) {
      console.error(`[neo-poll] VALIDATION FAILED: ${errors.join('; ')} — escalating`);
      logEscalation(file, `Schema validation: ${errors.join('; ')}`);
      markProcessed(resultPath);
      continue;
    }

    // Idempotency: content-hash check to prevent re-ingesting identical content
    const contentHash = Buffer.from(JSON.stringify(result)).toString('base64').slice(0, 32);
    const priorIngest = partialFirstSeen.get(result.ulid);
    if (priorIngest && priorIngest.lastHash === contentHash) {
      const elapsed = Date.now() - priorIngest.timestamp;
      if (result.status === 'partial' && elapsed > STALL_CAP_MS) {
        console.log(`[neo-poll] STALL CAP: ${result.ulid} stuck partial for ${Math.round(elapsed / 1000)}s (>${STALL_CAP_MS / 1000}s). Skipping until content changes.`);
        markProcessed(resultPath);
        continue;
      }
      // Same content, not yet stalled. Only retire a TERMINAL unchanged result.
      // A still-partial file is left unmarked so a later tick re-reads it once
      // Codex updates it to success/failed (the reply is emitted then).
      console.log(`[neo-poll] SKIP: ${result.ulid} unchanged since last ingest`);
      if (result.status !== 'partial') markProcessed(resultPath);
      continue;
    }

    // Track this ULID + content state
    if (!priorIngest) {
      partialFirstSeen.set(result.ulid, { timestamp: Date.now(), lastHash: contentHash });
    } else {
      // Content changed -- reset timer but keep tracking
      priorIngest.lastHash = contentHash;
      // Don't reset timestamp: stall cap measures total partial duration
    }

    // Load original dispatch for context
    let dispatchEnvelope = null;
    const dispatchFiles = fs.existsSync(OUTBOUND_DIR)
      ? fs.readdirSync(OUTBOUND_DIR).filter(f => f.startsWith(result.ulid) && f.endsWith('.dispatch.json'))
      : [];
    if (dispatchFiles.length > 0) {
      try {
        dispatchEnvelope = JSON.parse(fs.readFileSync(path.join(OUTBOUND_DIR, dispatchFiles[0]), 'utf-8'));
      } catch { /* non-fatal */ }
    }

    // 2. DeepSec gate (BEFORE marking success)
    const deepSec = await runDeepSecGate(result, dispatchEnvelope);
    if (!deepSec.passed) {
      console.error(`[neo-poll] DEEPSEC GATE FAILED: ${deepSec.reason}`);
      console.error('[neo-poll] Overriding status to "failed", escalating to QM');
      result.status = 'failed';
      result.summary = `[DeepSec BLOCKED] ${deepSec.reason}. Original: ${result.summary}`;
    } else if (!deepSec.skipped) {
      console.log('[neo-poll] DeepSec gate: PASSED');
    }

    // 3. Borg ARC absorption
    const borgArc = await runBorgArcAbsorption(result);
    if (borgArc.absorbed) {
      console.log('[neo-poll] Borg ARC absorption: complete');
    }

    // 4. Hermes L4 ingest
    const hermes = await fireHermesEvent(result, borgArc);
    console.log(`[neo-poll] Hermes L4: ${hermes.fired ? (hermes.direct ? 'direct' : 'fallback') : 'FAILED'}`);

    // 5. GitNexus diff
    const gitDiff = await runGitNexusDiff(result, dispatchEnvelope);
    if (gitDiff) {
      // Append diff summary to artifact log
      const artifactDir = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'artifacts', result.ulid);
      if (!fs.existsSync(artifactDir)) fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDir, 'gitnexus-diff.txt'),
        `# GitNexus diff since dispatch (${dispatchEnvelope?.issuedAt || 'unknown'})\n\n${gitDiff}\n`,
      );
      console.log('[neo-poll] GitNexus diff: attached to artifacts');
    }

    // 6. Log to hive
    const action = statusAction(result.status);
    try {
      execSync(
        `node "${path.join(PROJECT_ROOT, 'dist', 'hive-cli.js')}" log "neo-result-in" "${result.ulid} ${result.status}: ${(result.summary || '').slice(0, 80)}" --agent melanie --hemisphere xhemi`,
        { cwd: PROJECT_ROOT, stdio: 'inherit' },
      );
    } catch { /* best-effort */ }

    // 6b. Telegram reply: if this dispatch came from the Neo bot, queue a reply.
    try {
      emitTelegramReply(result, dispatchEnvelope);
    } catch (err) {
      console.error('[neo-poll] Telegram reply emit failed (non-fatal):', err.message);
    }

    // 7. Status-specific actions — clear stall tracker on terminal status
    if (result.status !== 'partial') {
      partialFirstSeen.delete(result.ulid);
    }
    console.log(`[neo-poll] Status: ${result.status} → ${action}`);

    if (result.openQuestions?.length) {
      console.log(`[neo-poll] Open questions (${result.openQuestions.length}):`);
      result.openQuestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    }

    if (result.reverseBrief) {
      console.log(`[neo-poll] Reverse brief: ${result.reverseBrief}`);
    }

    // Print metrics
    if (result.metrics) {
      const m = result.metrics;
      console.log(`[neo-poll] Metrics: ${m.rounds} rounds, converged=${m.converged}, ${m.wallTimeMs}ms wall`);
    }

    // Retire only terminal results. A 'partial' stays unmarked so the next tick
    // re-reads the file after Codex finalises it, and the Telegram reply fires.
    if (result.status !== 'partial') markProcessed(resultPath);
    processed++;
  }

  return processed;
}

function emitTelegramReply(result, dispatchEnvelope) {
  // Only emit a reply when this dispatch originated from the Neo Telegram bot.
  const chatId = dispatchEnvelope && dispatchEnvelope.callback
    && dispatchEnvelope.callback.telegram
    && dispatchEnvelope.callback.telegram.chatId;
  if (!chatId) return; // not a Telegram-originated dispatch; nothing to do.

  // Deliver only terminal results. Neo emits 'partial' repeatedly while it
  // works; forwarding those floods the Telegram chat. Wait for the final
  // status (completed / failed / blocked). 'partial' is suppressed.
  if (result.status === 'partial') return;

  if (!fs.existsSync(REPLIES_DIR)) fs.mkdirSync(REPLIES_DIR, { recursive: true });

  const replyPath = path.join(REPLIES_DIR, result.ulid + '.reply.json');
  // Idempotent: if we already wrote a reply for this ULID, don't overwrite.
  if (fs.existsSync(replyPath)) return;

  // Build a readable reply from the result.
  const lines = [];
  lines.push('Neo (' + (result.status || 'done') + '): ' + (result.summary || '(no summary)'));
  if (Array.isArray(result.openQuestions) && result.openQuestions.length) {
    lines.push('');
    lines.push('Open questions:');
    result.openQuestions.forEach((q, i) => lines.push((i + 1) + '. ' + q));
  }
  if (result.reverseBrief) {
    lines.push('');
    lines.push('Note: ' + result.reverseBrief);
  }

  const record = {
    ulid: result.ulid,
    chatId: String(chatId),
    text: lines.join('\n'),
    status: result.status,
    createdAt: new Date().toISOString(),
  };

  const tmp = replyPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, replyPath);
  console.log('[neo-poll] Telegram reply queued for chat ' + chatId + ' (ULID ' + result.ulid + ')');
}

function markProcessed(resultPath) {
  fs.writeFileSync(resultPath + PROCESSED_MARKER, new Date().toISOString());
}

function logEscalation(file, reason) {
  try {
    execSync(
      `node "${path.join(PROJECT_ROOT, 'dist', 'hive-cli.js')}" log "neo-poll-escalation" "Result ${file} rejected: ${reason.slice(0, 80)}" --agent melanie --hemisphere xhemi`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' },
    );
  } catch { /* best-effort */ }
}

// ── Entry point ───────────────────────────────────────────────────────
const watchMode = process.argv.includes('--watch');

if (watchMode) {
  console.log('[neo-poll] Watch mode: polling every 60s');
  const run = async () => {
    const count = await pollCycle();
    if (count > 0) console.log(`[neo-poll] Processed ${count} result(s)`);
  };
  run();
  setInterval(run, 60_000);
} else {
  pollCycle().then(count => {
    if (count > 0) console.log(`\n[neo-poll] Processed ${count} result(s)`);
    else console.log('[neo-poll] No new results');
  });
}
