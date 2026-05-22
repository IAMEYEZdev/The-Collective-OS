/**
 * Workflow Engine YAML Schema
 *
 * Pattern extracted from Keep (https://github.com/keephq/keep)
 * License: MIT (https://github.com/keephq/keep/blob/main/LICENSE)
 *
 * Keep's workflow engine uses YAML definitions with:
 *   - Triggers (manual, alert with filters, interval/cron)
 *   - Steps (data retrieval via providers, with conditions)
 *   - Actions (notifications, ticket creation, enrichment)
 *   - Conditions (CEL expressions, threshold comparisons)
 *   - foreach loops over step results
 *   - on-failure handlers with retry logic
 *
 * This is a clean-room TypeScript schema definition and validator
 * for ClaudeClaw's agent task routing. Not a YAML parser -- it defines
 * the type system that a YAML parser would produce.
 */

// ---------------------------------------------------------------------------
// Trigger types
// ---------------------------------------------------------------------------

export interface ManualTrigger {
  type: 'manual';
}

export interface AlertTrigger {
  type: 'alert';
  /** Key-value filters on the incoming alert (all must match). */
  filters?: AlertFilter[];
  /** CEL expression for complex filter logic. */
  cel?: string;
}

export interface AlertFilter {
  /** Field on the alert to match (e.g. 'source', 'severity', 'service'). */
  key: string;
  /** Expected value. Prefix with r"..." for regex matching. */
  value: string;
}

export interface IntervalTrigger {
  type: 'interval';
  /** Interval in seconds between runs. */
  value: number;
}

export interface CronTrigger {
  type: 'cron';
  // Cron expression (e.g. '0 */5 * * *').
  value: string;
}

export type WorkflowTrigger =
  | ManualTrigger
  | AlertTrigger
  | IntervalTrigger
  | CronTrigger;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export interface ThresholdCondition {
  type: 'threshold';
  /** The value to compare (can reference step results via template syntax). */
  value: string;
  /** Comparison operator. */
  compare_to: string;
  compare_type: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
}

export interface AssertCondition {
  type: 'assert';
  /** CEL expression or template that must evaluate to truthy. */
  assert: string;
}

export type StepCondition = ThresholdCondition | AssertCondition;

// ---------------------------------------------------------------------------
// Provider reference within a step/action
// ---------------------------------------------------------------------------

export interface StepProvider {
  /** Provider type (e.g. 'slack', 'jira', 'datadog', 'console'). */
  type: string;
  /** Config reference (e.g. '{{ providers.my-slack }}'). */
  config?: string;
  /** Parameters passed to the provider method. */
  with?: Record<string, unknown>;
  /** Failure handling for this specific step. */
  'on-failure'?: OnFailure;
}

// ---------------------------------------------------------------------------
// Steps and Actions
// ---------------------------------------------------------------------------

export interface OnFailure {
  retry?: {
    /** Number of retry attempts. */
    count: number;
    /** Delay between retries in seconds. */
    interval?: number;
  };
}

export interface WorkflowStep {
  /** Unique step name within the workflow. */
  name: string;
  /** Provider configuration for this step. */
  provider: StepProvider;
  /** Conditions that must be true for this step to execute. */
  condition?: StepCondition[];
  /** Template expression to iterate over (e.g. '{{ steps.get-data.results }}'). */
  foreach?: string;
  /** If false, workflow stops after this step. Default true. */
  continue?: boolean;
  /** Conditional execution (template expression). */
  if?: string;
}

export interface WorkflowAction {
  /** Unique action name within the workflow. */
  name: string;
  /** Provider configuration for this action. */
  provider: StepProvider;
  /** Conditions that must be true for this action to execute. */
  condition?: StepCondition[];
  /** Template expression to iterate over. */
  foreach?: string;
  /** If false, workflow stops after this action. Default true. */
  continue?: boolean;
  /** Conditional execution (template expression). */
  if?: string;
  /**
   * Enrich the triggering alert with results from this action.
   * Each entry maps a key on the alert to a value from action results.
   */
  enrich_alert?: EnrichmentMapping[];
}

export interface EnrichmentMapping {
  key: string;
  value: string;
  /** If true, enrichment is temporary and not persisted. */
  disposable?: boolean;
}

// ---------------------------------------------------------------------------
// Workflow execution strategy
// ---------------------------------------------------------------------------

export enum WorkflowStrategy {
  /** Skip if same fingerprint already running. */
  NONPARALLEL = 'nonparallel',
  /** Re-queue if same fingerprint already running. */
  NONPARALLEL_WITH_RETRY = 'nonparallel_with_retry',
  /** Allow parallel runs on same fingerprint. */
  PARALLEL = 'parallel',
}

// ---------------------------------------------------------------------------
// Top-level workflow definition
// ---------------------------------------------------------------------------

export interface WorkflowDefinition {
  /** Unique workflow identifier. */
  id: string;
  /** Human-readable workflow name. */
  name: string;
  /** Workflow description. */
  description?: string;
  /** Whether this workflow is disabled (won't run). */
  disabled?: boolean;
  /** Workflow owners (email addresses or usernames). */
  owners?: string[];
  /** Tags for categorization. */
  tags?: string[];
  /** Execution strategy for concurrent runs. */
  strategy?: WorkflowStrategy;
  /** Who can run this workflow (empty = everyone). */
  permissions?: string[];
  /** Triggers that activate this workflow. */
  triggers: WorkflowTrigger[];
  /** Data retrieval steps (run sequentially before actions). */
  steps?: WorkflowStep[];
  /** Actions to execute after steps complete. */
  actions: WorkflowAction[];
  /** Global constants available via {{ consts.KEY }}. */
  consts?: Record<string, string>;
  /** Handler for workflow-level failures. */
  on_failure?: WorkflowAction;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validate a workflow definition object.
 *
 * Does structural validation (required fields, valid types, referential
 * integrity). Does NOT evaluate template expressions or CEL.
 */
export function validateWorkflow(
  workflow: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required top-level fields
  if (!workflow['id'] || typeof workflow['id'] !== 'string') {
    errors.push({ path: 'id', message: 'Workflow id is required (string)' });
  }
  if (!workflow['name'] || typeof workflow['name'] !== 'string') {
    errors.push({
      path: 'name',
      message: 'Workflow name is required (string)',
    });
  }

  // Triggers
  const triggers = workflow['triggers'];
  if (!Array.isArray(triggers) || triggers.length === 0) {
    errors.push({
      path: 'triggers',
      message: 'At least one trigger is required',
    });
  } else {
    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i] as Record<string, unknown>;
      if (!trigger['type']) {
        errors.push({
          path: `triggers[${i}].type`,
          message: 'Trigger type is required',
        });
      } else {
        const validTypes = ['manual', 'alert', 'interval', 'cron'];
        if (!validTypes.includes(trigger['type'] as string)) {
          errors.push({
            path: `triggers[${i}].type`,
            message: `Invalid trigger type "${trigger['type']}". Valid: ${validTypes.join(', ')}`,
          });
        }
        if (trigger['type'] === 'interval' && !trigger['value']) {
          errors.push({
            path: `triggers[${i}].value`,
            message: 'Interval trigger requires a value (seconds)',
          });
        }
        if (trigger['type'] === 'cron' && !trigger['value']) {
          errors.push({
            path: `triggers[${i}].value`,
            message: 'Cron trigger requires a value (cron expression)',
          });
        }
      }
    }
  }

  // Actions (required, at least one)
  const actions = workflow['actions'];
  if (!Array.isArray(actions) || actions.length === 0) {
    errors.push({
      path: 'actions',
      message: 'At least one action is required',
    });
  } else {
    validateStepsOrActions(actions, 'actions', errors);
  }

  // Steps (optional)
  const steps = workflow['steps'];
  if (steps !== undefined) {
    if (!Array.isArray(steps)) {
      errors.push({ path: 'steps', message: 'Steps must be an array' });
    } else {
      validateStepsOrActions(steps, 'steps', errors);
    }
  }

  // Strategy
  const strategy = workflow['strategy'];
  if (strategy !== undefined) {
    const validStrategies = Object.values(WorkflowStrategy);
    if (!validStrategies.includes(strategy as WorkflowStrategy)) {
      errors.push({
        path: 'strategy',
        message: `Invalid strategy "${strategy}". Valid: ${validStrategies.join(', ')}`,
      });
    }
  }

  return errors;
}

function validateStepsOrActions(
  items: unknown[],
  prefix: string,
  errors: ValidationError[],
): void {
  const names = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;
    const path = `${prefix}[${i}]`;

    if (!item['name'] || typeof item['name'] !== 'string') {
      errors.push({
        path: `${path}.name`,
        message: 'Step/action name is required (string)',
      });
    } else {
      if (names.has(item['name'] as string)) {
        errors.push({
          path: `${path}.name`,
          message: `Duplicate name "${item['name']}" in ${prefix}`,
        });
      }
      names.add(item['name'] as string);
    }

    const provider = item['provider'] as Record<string, unknown> | undefined;
    if (!provider) {
      errors.push({
        path: `${path}.provider`,
        message: 'Provider is required for each step/action',
      });
    } else if (!provider['type'] || typeof provider['type'] !== 'string') {
      errors.push({
        path: `${path}.provider.type`,
        message: 'Provider type is required (string)',
      });
    }
  }
}
