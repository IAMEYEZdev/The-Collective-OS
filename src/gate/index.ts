/**
 * Decision-Surfacing Gate — Public API
 *
 * Single entry point for gate enforcement. Exposes plan-time
 * classification, action-time interception, and halt delivery.
 *
 * Usage:
 *   import { gate } from './gate/index.js';
 *   const ledger = gate.classifyBuildPlan(buildId, targets);
 *   gate.armInterceptor(clearanceSet);
 *   const verdict = gate.interceptWrite(path, 'write');
 */

// Registry
export {
  loadRegistry,
  reloadRegistry,
  classifyPath,
  classifyAction,
  extractTargetsFromCommand,
  extractTargetsWithUncertainty,
  isPathUnclassifiable,
  type GatePolicy,
  type Classification,
  type RegistryEntry,
  type Registry,
  type ExtractResult,
} from './registry.js';

// Plan-time
export {
  classifyBuildPlan,
  formatLedgerForReview,
  buildClearanceSet,
  isCleared,
  type DeclaredTarget,
  type DecisionLedger,
  type ClearanceSet,
  type LedgerEntry,
} from './plan-time.js';

// Action-time
export {
  armInterceptor,
  disarmInterceptor,
  isArmed,
  getInterceptorState,
  interceptWrite,
  interceptBash,
  verifyWrite,
  formatSupplementalLedger,
  buildGateSummary,
  type InterceptVerdict,
  type SupplementalLedgerEntry,
  type VerifyResult,
  type InterceptorState,
} from './action-time.js';

// Delivery (Step 4)
export {
  detectHarness,
  getInjectionPath,
  deliverPlanTimeHalt,
  deliverActionTimeHalt,
  recordRuling,
  clearGateBlock,
  type DeliveryTarget,
  type DeliveryResult,
  type RulingRecord,
} from './delivery.js';

// Lifecycle (go-live management)
export {
  initGate,
  reloadGateRegistry,
  startGatedBuild,
  endGatedBuild,
  getGateStatus,
  getGateStatusLine,
  setHiveLogger,
  type GateStatus,
} from './lifecycle.js';
