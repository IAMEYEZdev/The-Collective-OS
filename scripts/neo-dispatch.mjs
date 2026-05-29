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
import { execSync, spawn } from 'child_process';
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

const leaderPrompt = `${latentHeader}# Neo Engineering Task: ${envelope.task?.title}

ULID: ${envelope.ulid}
Parent Goal: ${envelope.parentGoalId || 'none'}
Type: ${envelope.task?.type}
Complexity: ${envelope.task?.complexity}
Priority: ${envelope.task?.priority}
Deadline: ${envelope.deadline || 'none'}

## Description
${envelope.task?.description}
${constraintsBlock}
${filesBlock}
${tacticalHint}

## Repository Context
Root: ${envelope.context?.repoRoot || PROJECT_ROOT}
Branch: ${envelope.context?.branch || 'main'}

## Output Requirements
Write result envelope to: ${envelope.callback?.resultPath || `workspace/dispatch/inbound/${ulid}.result.json`}
Write artifacts to: workspace/dispatch/artifacts/${ulid}/

Result envelope must include:
- status: success|partial|failed|escalate
- summary: 1-3 sentence outcome
- artifacts[]: array of {type, path}
- tacticalContributions[]: array of {agent, credit, summary}
- metrics: {rounds, converged, tokensIn, tokensOut, wallTimeMs}
- openQuestions[]: any unresolved issues
- reverseBrief: what you would do differently next time
`;

// ── Spawn oh-my-codex leader ──────────────────────────────────────────
// oh-my-codex team mode: leader session with task as initial prompt
const codexBin = process.env.CODEX_BIN || 'codex';
const codexArgs = [
  '--model', process.env.CODEX_MODEL || 'o4-mini',
  '--approval-mode', 'auto-edit',
  '--quiet',
  leaderPrompt,
];

console.log(`[neo-dispatch] Spawning oh-my-codex leader...`);
console.log(`[neo-dispatch] Command: ${codexBin} ${codexArgs.slice(0, 3).join(' ')} [prompt...]`);

// Log dispatch to hive
try {
  execSync(
    `node "${path.join(PROJECT_ROOT, 'dist', 'hive-cli.js')}" log "neo-dispatch-out" "${ulid} ${(envelope.task?.title || '').slice(0, 60)}" --agent melanie --hemisphere xhemi`,
    { stdio: 'inherit', cwd: PROJECT_ROOT },
  );
} catch { /* best-effort */ }

// Spawn detached so QM doesn't block
const child = spawn(codexBin, codexArgs, {
  cwd: envelope.context?.repoRoot || PROJECT_ROOT,
  stdio: 'inherit',
  detached: true,
  env: {
    ...process.env,
    NEO_DISPATCH_ULID: ulid,
    NEO_DISPATCH_FILE: dispatchPath,
  },
});

child.unref();
console.log(`[neo-dispatch] Leader spawned (PID: ${child.pid}). QM can continue.`);
