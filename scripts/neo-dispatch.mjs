#!/usr/bin/env node
/**
 * neo-dispatch.mjs — QM → Neo dispatch script
 *
 * Reads a dispatch envelope JSON, optionally loads + injects latent seed
 * as [LATENT_CONTEXT] header, then spawns oh-my-codex leader session
 * with the task envelope as initial prompt.
 *
 * Usage:
 *   node scripts/neo-dispatch.mjs <ulid>
 *
 * Expects dispatch file at:
 *   workspace/dispatch/outbound/<ulid>-*.dispatch.json
 *
 * Phase 3 gating checklist items covered:
 *   - [x] Writes envelope + spawns oh-my-codex leader
 *   - [x] Loads + injects latent seed as [LATENT_CONTEXT] header
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DISPATCH_DIR = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'outbound');

// ── Args ──────────────────────────────────────────────────────────────
const ulid = process.argv[2];
if (!ulid) {
  console.error('Usage: neo-dispatch.mjs <ulid>');
  process.exit(1);
}

// ── Find dispatch file ────────────────────────────────────────────────
const files = fs.readdirSync(DISPATCH_DIR).filter(f => f.startsWith(ulid) && f.endsWith('.dispatch.json'));
if (files.length === 0) {
  console.error(`No dispatch file found for ULID ${ulid} in ${DISPATCH_DIR}`);
  process.exit(1);
}
const dispatchPath = path.join(DISPATCH_DIR, files[0]);
const envelope = JSON.parse(fs.readFileSync(dispatchPath, 'utf-8'));

console.log(`[neo-dispatch] Loading: ${files[0]}`);
console.log(`[neo-dispatch] Task: ${envelope.task?.title}`);
console.log(`[neo-dispatch] Type: ${envelope.task?.type} | Complexity: ${envelope.task?.complexity}`);

// ── Latent seed injection ─────────────────────────────────────────────
// If latentSeed.hiddenStateRef points to a .f32 file, deserialize it
// into a [LATENT_CONTEXT] JSON header block for the leader prompt.
let latentHeader = '';

if (envelope.latentSeed?.hiddenStateRef) {
  const f32Path = path.resolve(PROJECT_ROOT, envelope.latentSeed.hiddenStateRef);
  if (fs.existsSync(f32Path)) {
    try {
      const buffer = fs.readFileSync(f32Path);
      const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      // Extract dimensional summary: mean, variance, top-k activations
      const values = Array.from(floats);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;

      // Top 10 activation indices (highest absolute values)
      const indexed = values.map((v, i) => ({ i, v: Math.abs(v) }));
      indexed.sort((a, b) => b.v - a.v);
      const topK = indexed.slice(0, 10).map(({ i, v }) => ({ dim: i, activation: v.toFixed(4) }));

      const latentContext = {
        structureId: envelope.latentSeed.structureId || 'unknown',
        dimensions: values.length,
        mean: mean.toFixed(6),
        variance: variance.toFixed(6),
        topActivations: topK,
        roundBudget: envelope.latentSeed.roundBudget || 4,
      };

      latentHeader = `[LATENT_CONTEXT]\n${JSON.stringify(latentContext, null, 2)}\n[/LATENT_CONTEXT]\n\n`;
      console.log(`[neo-dispatch] Latent seed loaded: ${values.length} dims, structure=${latentContext.structureId}`);
    } catch (err) {
      // Degrade to text-only mode per spec failure defense
      console.error(`[neo-dispatch] WARNING: Failed to load latent seed: ${err.message}`);
      console.error('[neo-dispatch] Degrading to text-only mode');
    }
  } else {
    console.error(`[neo-dispatch] WARNING: Latent ref missing: ${f32Path}`);
    console.error('[neo-dispatch] Degrading to text-only mode');
  }
}

// ── Build leader prompt ───────────────────────────────────────────────
const tacticalHint = envelope.tactical?.preferred?.length
  ? `\nPreferred tactical agents: ${envelope.tactical.preferred.join(', ')}`
  : '';

const constraintsBlock = envelope.context?.constraints?.length
  ? `\nConstraints:\n${envelope.context.constraints.map(c => `- ${c}`).join('\n')}`
  : '';

const filesBlock = envelope.context?.filesOfInterest?.length
  ? `\nFiles of interest:\n${envelope.context.filesOfInterest.map(f => `- ${f}`).join('\n')}`
  : '';

const resultRelPath = envelope.callback?.resultPath || `workspace/dispatch/inbound/${ulid}.result.json`;
const resultAbsPath = path.resolve(envelope.context?.repoRoot || PROJECT_ROOT, resultRelPath);

const leaderPrompt = `${latentHeader}YOUR PRIMARY OBJECTIVE: Write a JSON file to this EXACT absolute path:
${resultAbsPath}

The JSON file MUST contain these fields:
{
  "version": 1,
  "ulid": "${envelope.ulid}",
  "status": "success" or "partial" or "failed" or "escalate",
  "summary": "1-3 sentence description of what you did",
  "artifacts": [],
  "metrics": { "rounds": 1, "wallTimeMs": 0 },
  "openQuestions": [],
  "reverseBrief": "what you would do differently next time",
  "timestamp": "<current ISO timestamp>"
}

Write this file FIRST, then do the task below. Update the file again after completing the task.

---

# Task: ${envelope.task?.title}

ULID: ${envelope.ulid}
Type: ${envelope.task?.type} | Complexity: ${envelope.task?.complexity} | Priority: ${envelope.task?.priority}

${envelope.task?.description}
${constraintsBlock}
${filesBlock}
${tacticalHint}

Working directory: ${envelope.context?.repoRoot || PROJECT_ROOT}
`;

// ── Spawn oh-my-codex leader ──────────────────────────────────────────
// Codex CLI: unattended execution with full sandbox access for file writes
// Prompt written to temp file, piped via shell redirect to avoid
// detached + stdin pipe race condition on Windows.
const codexBin = process.env.CODEX_BIN || 'codex';

console.log(`[neo-dispatch] Spawning oh-my-codex leader...`);
console.log(`[neo-dispatch] Command: ${codexBin} exec --model ${process.env.CODEX_MODEL || 'gpt-5.5'} -s danger-full-access -C <cwd> - < tmpfile`);
console.log(`[neo-dispatch] Prompt length: ${leaderPrompt.length} chars`);

// Log dispatch to hive
try {
  execSync(
    `node "${path.join(PROJECT_ROOT, 'dist', 'hive-cli.js')}" log "neo-dispatch-out" "${ulid} ${(envelope.task?.title || '').slice(0, 60)}" --agent melanie --hemisphere xhemi`,
    { stdio: 'inherit', cwd: PROJECT_ROOT },
  );
} catch { /* best-effort */ }

// Run codex synchronously. Detached spawn on Windows kills the child
// process silently. The caller (scheduler/orchestrator) is responsible
// for running neo-dispatch.mjs in the background if async is needed.
const isWindows = process.platform === 'win32';
const tmpDir = path.join(PROJECT_ROOT, 'workspace', 'dispatch', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const promptFile = path.join(tmpDir, `${ulid}.prompt.txt`);
fs.writeFileSync(promptFile, leaderPrompt, 'utf-8');

const model = process.env.CODEX_MODEL || 'gpt-5.5';
const cwd = envelope.context?.repoRoot || PROJECT_ROOT;
const shellCmd = isWindows
  ? `${codexBin} exec --model ${model} -s danger-full-access -C "${cwd}" --skip-git-repo-check - < "${promptFile}"`
  : `${codexBin} exec --model ${model} -s danger-full-access -C '${cwd}' --skip-git-repo-check - < '${promptFile}'`;

console.log(`[neo-dispatch] Running codex synchronously...`);
try {
  execSync(shellCmd, {
    cwd,
    stdio: 'inherit',
    shell: true,
    timeout: 300_000, // 5 min max for any single task
    env: {
      ...process.env,
      NEO_DISPATCH_ULID: ulid,
      NEO_DISPATCH_FILE: dispatchPath,
    },
  });
  console.log(`[neo-dispatch] Codex completed successfully.`);
} catch (err) {
  console.error(`[neo-dispatch] Codex execution failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(promptFile); } catch { /* already gone */ }
}
