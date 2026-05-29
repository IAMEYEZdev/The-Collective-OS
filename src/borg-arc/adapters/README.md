# Borg ARC Adapters

Patterns extracted from [Keep](https://github.com/keephq/keep) (MIT License) and reimplemented as clean-room TypeScript for ClaudeClaw's agent system.

## License Attribution

All patterns in this directory are inspired by Keep, an open-source alert management platform.

- **Source**: https://github.com/keephq/keep
- **License**: MIT (https://github.com/keephq/keep/blob/main/LICENSE)
- **Extraction date**: 2026-05-19
- **Method**: Pattern analysis and clean-room TypeScript reimplementation. No code was copied verbatim.

## Modules

### `adapter.ts` -- Provider Adapter Framework

**Source pattern**: `keep/providers/base/base_provider.py` + `keep/providers/providers_factory.py`

Keep has 131+ provider integrations (Datadog, PagerDuty, Grafana, Slack, CloudWatch, etc.) all inheriting from `BaseProvider`. The `ProvidersFactory` handles dynamic registration and instantiation via filesystem scanning.

**What we extracted**:
- `BaseAdapter` abstract class with lifecycle methods (validateConfig, dispose, healthCheck)
- `NormalizedEvent` interface (equivalent to Keep's `AlertDto`) as the common data model
- `AdapterFactory` registry for provider registration and instantiation
- `computeFingerprint()` utility for stable event deduplication keys
- Type system: `Severity`, `EventStatus`, `ProviderScope`, `ProviderConfig`

**Usage**:
```typescript
import { BaseAdapter, AdapterFactory, NormalizedEvent } from './adapter.js';

class DatadogAdapter extends BaseAdapter {
  static FINGERPRINT_FIELDS = ['name', 'service', 'environment'];
  static PROVIDER_TAGS = ['alert', 'monitoring'] as const;

  validateConfig() { /* check auth keys */ }
  async dispose() { /* cleanup */ }
  formatEvent(raw) { /* raw Datadog payload -> NormalizedEvent */ }
  async healthCheck() { /* ping Datadog API */ }
}

AdapterFactory.register({
  type: 'datadog',
  displayName: 'Datadog',
  categories: ['Monitoring'],
  tags: ['alert', 'monitoring'],
  scopes: [],
  ctor: DatadogAdapter,
});

const adapter = AdapterFactory.create('datadog', { name: 'my-dd', authentication: { apiKey: '...' } });
```

### `dedup.ts` -- Alert Deduplication Engine

**Source pattern**: `keep/api/alert_deduplicator/alert_deduplicator.py` + fingerprinting in `base_provider.py`

Keep deduplicates alerts across 131 providers using a two-phase approach:
1. Fingerprint phase: selected fields hashed to group "same" alerts
2. Content hash phase: full payload (minus ignored fields) compared to last-seen hash

**What we extracted**:
- `AlertDeduplicator` class with in-memory LRU cache (configurable size)
- Configurable `DeduplicationRule` objects (per-provider or wildcard)
- Three-state output: `full` (exact duplicate), `partial` (same fingerprint, content changed), `none` (new)
- Field removal with dot-notation support
- No database dependency -- swap the LRU cache for persistent storage in production

**Usage**:
```typescript
import { AlertDeduplicator } from './dedup.js';

const dedup = new AlertDeduplicator({ maxFingerprints: 50000 });

dedup.addRule({
  id: 'datadog-default',
  name: 'Datadog dedup',
  providerType: 'datadog',
  fingerprintFields: ['name', 'service', 'labels.env'],
  ignoreFields: ['lastReceived'],
  fullDeduplication: false,
  enabled: true,
});

const result = dedup.evaluate(incomingEvent, 'datadog', 'my-dd-1');
if (result.type === 'full') { /* suppress */ }
if (result.type === 'partial') { /* update existing */ }
```

### `workflow-schema.ts` -- Workflow Engine YAML Schema

**Source pattern**: `keep/workflowmanager/workflow.py` + `keep/parser/parser.py` + `keep/step/step.py` + examples in `examples/workflows/`

Keep's workflow engine defines alert routing/escalation as YAML with triggers, steps, actions, conditions, and foreach loops.

**What we extracted**:
- Full TypeScript type definitions for: `WorkflowDefinition`, `WorkflowTrigger` (manual/alert/interval/cron), `WorkflowStep`, `WorkflowAction`, `StepCondition`, `EnrichmentMapping`
- `WorkflowStrategy` enum (nonparallel, nonparallel_with_retry, parallel)
- `validateWorkflow()` structural validator (checks required fields, valid types, duplicate names)
- Alert trigger filters with regex support

**Usage**:
```typescript
import { WorkflowDefinition, validateWorkflow } from './workflow-schema.js';
import yaml from 'js-yaml'; // or your preferred YAML parser

const raw = yaml.load(yamlString) as Record<string, unknown>;
const errors = validateWorkflow(raw['workflow']);
if (errors.length > 0) {
  console.error('Invalid workflow:', errors);
} else {
  const workflow = raw['workflow'] as unknown as WorkflowDefinition;
  // route to agent task system
}
```

## Architecture Notes

- All modules are self-contained with zero internal ClaudeClaw dependencies
- Each file can be imported independently
- The adapter framework is the foundation -- dedup and workflow-schema can use `NormalizedEvent` from adapter.ts but don't require it
- For production: replace the LRU cache in dedup.ts with Redis/SQLite, add a YAML parser wrapper around workflow-schema.ts
