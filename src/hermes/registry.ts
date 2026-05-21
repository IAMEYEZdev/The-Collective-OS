/**
 * Hermes Layer 4 - Agent Capability Registry
 *
 * Agents declare what message modes they accept/produce.
 * Registry enforces compatibility before routing.
 * Dual-mode backward compat: every agent defaults to text-capable.
 */

import { logger } from '../logger.js';

import type { AgentCapability, MessageMode } from './types.js';

// ── Registry State ──────────────────────────────────────────────────

const capabilities = new Map<string, AgentCapability>();

// ── Registration ────────────────────────────────────────────────────

/**
 * Register an agent's communication capabilities.
 * Called during agent init or when RecursiveMAS adapters are loaded.
 */
export function registerAgent(cap: AgentCapability): void {
  // Enforce dual-mode: text must always be in accepts (backward compat)
  if (!cap.accepts.includes('text')) {
    cap.accepts = ['text', ...cap.accepts];
  }
  capabilities.set(cap.agentId, cap);
  logger.info(
    { agentId: cap.agentId, accepts: cap.accepts, produces: cap.produces },
    'Hermes: agent registered',
  );
}

/** Remove an agent from the registry (cleanup). */
export function unregisterAgent(agentId: string): void {
  capabilities.delete(agentId);
}

/** Get an agent's capabilities, or null if not registered. */
export function getCapability(agentId: string): AgentCapability | null {
  return capabilities.get(agentId) ?? null;
}

/** List all registered agents. */
export function listRegistered(): AgentCapability[] {
  return [...capabilities.values()];
}

// ── Compatibility Checks ────────────────────────────────────────────

export interface RouteCheck {
  compatible: boolean;
  /** The best mode to use for this route */
  recommendedMode: MessageMode;
  /** Why it's incompatible (if applicable) */
  reason?: string;
}

/**
 * Check if source can send to target, and recommend the best mode.
 * Prefers latent > dual > text (highest fidelity first).
 */
export function checkRoute(fromAgent: string, toAgent: string): RouteCheck {
  const src = capabilities.get(fromAgent);
  const dst = capabilities.get(toAgent);

  // Unregistered agents default to text-only
  if (!src || !dst) {
    return {
      compatible: true,
      recommendedMode: 'text',
      reason: !src ? `${fromAgent} not registered` : `${toAgent} not registered`,
    };
  }

  // Find intersection: what can source produce that target accepts?
  const srcProduces = new Set(src.produces);
  const dstAccepts = new Set(dst.accepts);

  // Prefer latent if both support it
  if (srcProduces.has('latent') && dstAccepts.has('latent')) {
    return { compatible: true, recommendedMode: 'latent' };
  }
  if (srcProduces.has('dual') && (dstAccepts.has('latent') || dstAccepts.has('dual'))) {
    return { compatible: true, recommendedMode: 'dual' };
  }
  // Fallback: text always works (enforced in registerAgent)
  if (srcProduces.has('text') && dstAccepts.has('text')) {
    return { compatible: true, recommendedMode: 'text' };
  }

  return {
    compatible: false,
    recommendedMode: 'text',
    reason: `No compatible mode: ${fromAgent} produces [${src.produces}], ${toAgent} accepts [${dst.accepts}]`,
  };
}

/**
 * Validate dimension compatibility for latent transfer.
 * Source hidden size must match the outer adapter's in_dim.
 * Target hidden size must match the outer adapter's out_dim.
 */
export function validateDimensions(
  fromAgent: string,
  toAgent: string,
  outerInDim: number,
  outerOutDim: number,
): { valid: boolean; reason?: string } {
  const src = capabilities.get(fromAgent);
  const dst = capabilities.get(toAgent);

  if (src?.hiddenSize && src.hiddenSize !== outerInDim) {
    return {
      valid: false,
      reason: `${fromAgent} hidden_size=${src.hiddenSize} != outer in_dim=${outerInDim}`,
    };
  }
  if (dst?.hiddenSize && dst.hiddenSize !== outerOutDim) {
    return {
      valid: false,
      reason: `${toAgent} hidden_size=${dst.hiddenSize} != outer out_dim=${outerOutDim}`,
    };
  }
  return { valid: true };
}

/** Reset registry (for tests). */
export function clearRegistry(): void {
  capabilities.clear();
}
