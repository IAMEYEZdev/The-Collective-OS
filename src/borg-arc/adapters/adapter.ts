/**
 * Provider Adapter Framework
 *
 * Pattern extracted from Keep (https://github.com/keephq/keep)
 * License: MIT (https://github.com/keephq/keep/blob/main/LICENSE)
 *
 * Keep uses a BaseProvider abstract class with 131+ concrete providers,
 * a ProvidersFactory for dynamic registration/instantiation, and
 * normalized AlertDto models across all integrations.
 *
 * This is a clean-room TypeScript reimplementation of that architecture
 * for ClaudeClaw's agent system. Not a port -- the API surface is
 * designed for our use case (agent service integrations, not alert management).
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Severity levels, ordered by priority (higher = more severe). */
export enum Severity {
  LOW = 1,
  INFO = 2,
  WARNING = 3,
  HIGH = 4,
  CRITICAL = 5,
}

/** Status of a normalized event. */
export enum EventStatus {
  FIRING = 'firing',
  RESOLVED = 'resolved',
  ACKNOWLEDGED = 'acknowledged',
  SUPPRESSED = 'suppressed',
  PENDING = 'pending',
}

/** Provider capability tags -- what a provider can do. */
export type ProviderTag =
  | 'alert'
  | 'messaging'
  | 'ticketing'
  | 'data'
  | 'topology'
  | 'incident'
  | 'monitoring';

/** Provider category for grouping in UI/CLI. */
export type ProviderCategory =
  | 'Monitoring'
  | 'Incident Management'
  | 'Cloud Infrastructure'
  | 'Ticketing'
  | 'Collaboration'
  | 'Security'
  | 'Developer Tools'
  | 'Database'
  | 'Queues'
  | 'AI'
  | 'Other';

/** A required permission/scope for the provider to function. */
export interface ProviderScope {
  name: string;
  description?: string;
  mandatory: boolean;
  documentationUrl?: string;
}

/** Configuration needed to instantiate a provider. */
export interface ProviderConfig {
  /** Human-readable name for this provider instance. */
  name: string;
  /** Auth credentials / tokens -- shape varies per provider. */
  authentication: Record<string, unknown>;
  /** Optional description. */
  description?: string;
}

/**
 * Normalized event -- the common data model that all providers
 * convert their native payloads into. Inspired by Keep's AlertDto.
 */
export interface NormalizedEvent {
  id: string;
  name: string;
  status: EventStatus;
  severity: Severity;
  source: string[];
  message?: string;
  description?: string;
  service?: string;
  environment?: string;
  url?: string;
  labels: Record<string, string>;
  fingerprint: string;
  lastReceived: string; // ISO 8601
  /** Provider-specific raw payload, preserved for passthrough. */
  raw?: Record<string, unknown>;
}

/** Health check result for a provider. */
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  message?: string;
  checkedAt: string; // ISO 8601
}

/** Registration metadata stored in the factory registry. */
export interface ProviderRegistration {
  type: string;
  displayName: string;
  categories: ProviderCategory[];
  tags: ProviderTag[];
  scopes: ProviderScope[];
  /** The class constructor for this provider. */
  ctor: new (config: ProviderConfig) => BaseAdapter;
}

// ---------------------------------------------------------------------------
// Fingerprinting utility
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint from selected fields on an event-like object.
 *
 * Keep's approach: SHA-256 over concatenated field values, with dot-notation
 * support for nested fields. Falls back to the event name if no fields given.
 */
export function computeFingerprint(
  event: Record<string, unknown>,
  fields: string[],
): string {
  if (fields.length === 0) {
    const name = (event['name'] as string) ?? '';
    return crypto.createHash('sha256').update(name).digest('hex');
  }

  const hash = crypto.createHash('sha256');
  for (const field of fields) {
    let value: unknown = event;
    for (const key of field.split('.')) {
      if (value != null && typeof value === 'object') {
        value = (value as Record<string, unknown>)[key];
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined && value !== null) {
      const serialized =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
      hash.update(serialized);
    }
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Abstract base adapter
// ---------------------------------------------------------------------------

/**
 * BaseAdapter -- the abstract provider adapter that concrete integrations extend.
 *
 * Lifecycle:
 *   1. Construct with ProviderConfig
 *   2. Call validateConfig() (called automatically in constructor)
 *   3. Use query(), notify(), formatEvent(), healthCheck() as needed
 *   4. Call dispose() when done
 */
export abstract class BaseAdapter {
  readonly providerId: string;
  readonly config: ProviderConfig;

  /** Fields used to compute the default fingerprint for this provider. */
  static FINGERPRINT_FIELDS: string[] = [];
  static PROVIDER_SCOPES: ProviderScope[] = [];
  static PROVIDER_TAGS: ProviderTag[] = [];
  static PROVIDER_CATEGORIES: ProviderCategory[] = ['Other'];

  constructor(config: ProviderConfig) {
    this.config = config;
    this.providerId = config.name;
    this.validateConfig();
  }

  // -- Abstract methods (must implement) ------------------------------------

  /** Validate that config.authentication has all required fields. Throw on failure. */
  abstract validateConfig(): void;

  /** Clean up connections, timers, etc. */
  abstract dispose(): Promise<void>;

  // -- Optional overrides ---------------------------------------------------

  /**
   * Format a raw provider-specific payload into a NormalizedEvent.
   * Override in concrete providers that receive webhooks/events.
   */
  formatEvent(_rawPayload: Record<string, unknown>): NormalizedEvent | null {
    throw new Error(`formatEvent() not implemented for ${this.providerId}`);
  }

  /**
   * Pull events/alerts from the provider (polling mode).
   * Override in providers that support pulling.
   */
  async getEvents(): Promise<NormalizedEvent[]> {
    throw new Error(`getEvents() not implemented for ${this.providerId}`);
  }

  /**
   * Send a notification/message via this provider.
   * Override in messaging/ticketing providers.
   */
  async notify(
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    throw new Error(`notify() not implemented for ${this.providerId}`);
  }

  /**
   * Run an arbitrary query against the provider.
   * Override in data/monitoring providers.
   */
  async query(
    _params: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error(`query() not implemented for ${this.providerId}`);
  }

  /**
   * Check provider connectivity and auth validity.
   * Default implementation just returns healthy=true. Override for real checks.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
      message: 'Default health check (no remote validation)',
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate that the configured scopes/permissions are sufficient.
   * Returns a map of scope name -> true (valid) or error string.
   */
  async validateScopes(): Promise<Record<string, boolean | string>> {
    return {};
  }

  // -- Utility methods ------------------------------------------------------

  /** Compute fingerprint for a normalized event using this provider's fields. */
  computeEventFingerprint(event: NormalizedEvent): string {
    const ctor = this.constructor as typeof BaseAdapter;
    return computeFingerprint(
      event as unknown as Record<string, unknown>,
      ctor.FINGERPRINT_FIELDS,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider Factory (Registry)
// ---------------------------------------------------------------------------

/**
 * AdapterFactory -- dynamic registration and instantiation of providers.
 *
 * Inspired by Keep's ProvidersFactory which uses filesystem scanning +
 * importlib. We use explicit registration since TypeScript doesn't have
 * the same dynamic import patterns as Python.
 */
export class AdapterFactory {
  private static registry = new Map<string, ProviderRegistration>();

  /**
   * Register a provider adapter class. Call once per provider type at startup.
   *
   * ```ts
   * AdapterFactory.register({
   *   type: 'datadog',
   *   displayName: 'Datadog',
   *   categories: ['Monitoring'],
   *   tags: ['alert', 'data'],
   *   scopes: [],
   *   ctor: DatadogAdapter,
   * });
   * ```
   */
  static register(registration: ProviderRegistration): void {
    if (AdapterFactory.registry.has(registration.type)) {
      throw new Error(
        `Provider type "${registration.type}" is already registered`,
      );
    }
    AdapterFactory.registry.set(registration.type, registration);
  }

  /** Remove a provider registration. Useful for tests. */
  static unregister(type: string): boolean {
    return AdapterFactory.registry.delete(type);
  }

  /** Get a registration by type. Returns undefined if not found. */
  static getRegistration(type: string): ProviderRegistration | undefined {
    return AdapterFactory.registry.get(type);
  }

  /** List all registered provider types. */
  static listProviders(): ProviderRegistration[] {
    return Array.from(AdapterFactory.registry.values());
  }

  /** Filter providers by tag. */
  static listByTag(tag: ProviderTag): ProviderRegistration[] {
    return AdapterFactory.listProviders().filter((p) => p.tags.includes(tag));
  }

  /** Filter providers by category. */
  static listByCategory(category: ProviderCategory): ProviderRegistration[] {
    return AdapterFactory.listProviders().filter((p) =>
      p.categories.includes(category),
    );
  }

  /**
   * Instantiate a provider adapter from a registered type + config.
   * Throws if the type is not registered.
   */
  static create(type: string, config: ProviderConfig): BaseAdapter {
    const reg = AdapterFactory.registry.get(type);
    if (!reg) {
      throw new Error(
        `Unknown provider type "${type}". Registered: [${Array.from(
          AdapterFactory.registry.keys(),
        ).join(', ')}]`,
      );
    }
    return new reg.ctor(config);
  }

  /** Clear all registrations. Primarily for tests. */
  static clearRegistry(): void {
    AdapterFactory.registry.clear();
  }
}
