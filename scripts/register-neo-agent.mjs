#!/usr/bin/env node
/**
 * register-neo-agent.mjs — Register Neo in Hermes L4 registry
 *
 * Called at QM session start to ensure the Neo engineering agent
 * is registered before any dispatch or result ingestion occurs.
 *
 * Neo capabilities:
 *   - Accepts: text, latent (can receive latent seeds from QM)
 *   - Produces: text, latent (returns enriched latent feedback)
 *   - Hidden size: 768 (matches Borg ARC outer adapter default)
 *
 * Usage:
 *   node scripts/register-neo-agent.mjs
 *
 * Phase 3 gating checklist item:
 *   - [x] `neo` agent registered in Hermes registry at QM session start
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Register via compiled Hermes module
const registerScript = `
  const { registerAgent, getCapability } = require('./dist/hermes/index.js');

  // Check if already registered (idempotent)
  const existing = getCapability('neo');
  if (existing) {
    console.log('[register-neo] Neo already registered:', JSON.stringify(existing));
    process.exit(0);
  }

  registerAgent({
    agentId: 'neo',
    accepts: ['text', 'latent'],
    produces: ['text', 'latent'],
    hiddenSize: 768,
  });

  // Verify registration
  const cap = getCapability('neo');
  if (cap) {
    console.log('[register-neo] Neo registered in Hermes L4');
    console.log('[register-neo] Accepts:', cap.accepts.join(', '));
    console.log('[register-neo] Produces:', cap.produces.join(', '));
    console.log('[register-neo] Hidden size:', cap.hiddenSize);
  } else {
    console.error('[register-neo] FAILED: Neo not found in registry after registration');
    process.exit(1);
  }
`;

try {
  execSync(`node -e "${registerScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  // Fallback: try ESM import path
  console.error('[register-neo] CJS path failed, trying direct registration...');
  try {
    const hermesPath = path.join(PROJECT_ROOT, 'dist', 'hermes', 'index.js');
    const { registerAgent, getCapability } = await import(`file://${hermesPath.replace(/\\/g, '/')}`);

    const existing = getCapability('neo');
    if (existing) {
      console.log('[register-neo] Neo already registered:', JSON.stringify(existing));
      process.exit(0);
    }

    registerAgent({
      agentId: 'neo',
      accepts: ['text', 'latent'],
      produces: ['text', 'latent'],
      hiddenSize: 768,
    });

    const cap = getCapability('neo');
    if (cap) {
      console.log('[register-neo] Neo registered in Hermes L4 (ESM path)');
    } else {
      console.error('[register-neo] FAILED');
      process.exit(1);
    }
  } catch (err2) {
    console.error(`[register-neo] Registration failed: ${err2.message}`);
    console.error('[register-neo] Hermes module may not be built yet. Run: npm run build');
    process.exit(1);
  }
}
