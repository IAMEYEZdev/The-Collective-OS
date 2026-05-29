/**
 * Alert Deduplication Engine
 *
 * Pattern extracted from Keep (https://github.com/keephq/keep)
 * License: MIT (https://github.com/keephq/keep/blob/main/LICENSE)
 *
 * Keep's AlertDeduplicator works in two phases:
 *   1. Fingerprinting: selected fields -> SHA-256 hash that groups "same" alerts
 *   2. Full dedup: entire alert payload (minus ignored fields) -> hash compared
 *      against last-seen hash for that fingerprint, yielding full/partial/none
 *
 * This is a clean-room TypeScript reimplementation. It is self-contained
 * (no database dependency) and uses an in-memory LRU cache for hash lookups.
 * Swap the storage backend for production persistence if needed.
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeduplicationRule {
  /** Unique rule ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Provider type this rule applies to (e.g. 'datadog'), or '*' for all. */
  providerType: string;
  /** Optional specific provider instance ID. */
  providerId?: string;
  /**
   * Fields used to compute the fingerprint that groups related alerts.
   * Supports dot-notation for nested fields (e.g. 'labels.env').
   * If empty, uses the full-dedup strategy (hash entire payload).
   */
  fingerprintFields: string[];
  /**
   * Fields to strip before computing the full-payload hash.
   * Typically volatile fields like 'lastReceived', 'event_id'.
   */
  ignoreFields: string[];
  /**
   * When true, the rule hashes the entire payload (minus ignoreFields)
   * rather than just fingerprintFields.
   */
  fullDeduplication: boolean;
  /** Whether this rule is active. */
  enabled: boolean;
}

export type DeduplicationType = 'full' | 'partial' | 'none';

export interface DeduplicationResult {
  /** The computed fingerprint for this event. */
  fingerprint: string;
  /** The content hash (full payload minus ignored fields). */
  contentHash: string;
  /** Dedup verdict. */
  type: DeduplicationType;
  /** Which rule triggered the dedup (null if none matched). */
  matchedRuleId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone an object then remove specified fields (dot-notation supported).
 */
function removeFields(
  obj: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const clone = structuredClone(obj);
  for (const field of fields) {
    const parts = field.split('.');
    let target: Record<string, unknown> = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = target[parts[i]];
      if (next == null || typeof next !== 'object') break;
      target = next as Record<string, unknown>;
    }
    delete target[parts[parts.length - 1]];
  }
  return clone;
}

/**
 * Extract a value from a nested object using dot-notation path.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Compute SHA-256 fingerprint from selected fields.
 */
function fingerprintFromFields(
  event: Record<string, unknown>,
  fields: string[],
): string {
  if (fields.length === 0) {
    // Fallback: use event name or entire payload
    const name = (event['name'] as string) ?? '';
    if (name) {
      return crypto.createHash('sha256').update(name).digest('hex');
    }
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(event, null, 0))
      .digest('hex');
  }

  const hash = crypto.createHash('sha256');
  for (const field of fields) {
    const value = getNestedValue(event, field);
    if (value !== undefined && value !== null) {
      const serialized =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
      hash.update(serialized);
    }
  }
  return hash.digest('hex');
}

/**
 * Compute SHA-256 hash of the full payload (with ignored fields stripped).
 * Keys are sorted for deterministic output.
 */
function contentHash(
  event: Record<string, unknown>,
  ignoreFields: string[],
): string {
  const cleaned = removeFields(event, ignoreFields);
  const serialized = JSON.stringify(cleaned, Object.keys(cleaned).sort());
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// ---------------------------------------------------------------------------
// LRU Cache (simple, bounded)
// ---------------------------------------------------------------------------

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this.map.keys().next().value!;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Deduplicator
// ---------------------------------------------------------------------------

export interface AlertDeduplicatorOptions {
  /** Max fingerprints to track in memory. Default: 10000. */
  maxFingerprints?: number;
  /**
   * Default fields to ignore when computing content hash.
   * Default: ['lastReceived', 'event_id'].
   */
  defaultIgnoreFields?: string[];
}

/**
 * AlertDeduplicator -- stateful dedup engine.
 *
 * Usage:
 * ```ts
 * const dedup = new AlertDeduplicator();
 * dedup.addRule({ ... });
 *
 * const result = dedup.evaluate(incomingEvent, 'datadog', 'my-datadog-1');
 * if (result.type === 'full') {
 *   // exact duplicate, suppress
 * } else if (result.type === 'partial') {
 *   // same fingerprint but content changed, maybe update
 * }
 * ```
 */
export class AlertDeduplicator {
  private rules: DeduplicationRule[] = [];
  /** Maps fingerprint -> last content hash seen. */
  private hashCache: LRUCache<string, string>;
  private defaultIgnoreFields: string[];

  constructor(options: AlertDeduplicatorOptions = {}) {
    this.hashCache = new LRUCache(options.maxFingerprints ?? 10_000);
    this.defaultIgnoreFields = options.defaultIgnoreFields ?? [
      'lastReceived',
      'event_id',
    ];
  }

  // -- Rule management ------------------------------------------------------

  addRule(rule: DeduplicationRule): void {
    // Prevent duplicate rule IDs
    if (this.rules.some((r) => r.id === rule.id)) {
      throw new Error(`Deduplication rule "${rule.id}" already exists`);
    }
    this.rules.push(rule);
  }

  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  getRules(): readonly DeduplicationRule[] {
    return this.rules;
  }

  // -- Core evaluation ------------------------------------------------------

  /**
   * Evaluate an event against dedup rules.
   *
   * Algorithm (mirrors Keep's two-phase approach):
   *   1. Find matching rules for this provider type/id
   *   2. For each rule:
   *      a. Compute fingerprint from fingerprintFields (or name fallback)
   *      b. Compute content hash from full payload minus ignoreFields
   *      c. Compare content hash against last-seen hash for this fingerprint
   *      d. full = same hash, partial = same fingerprint different hash, none = new
   *   3. First rule that yields full or partial wins. If no rules match, use
   *      a default full-dedup rule.
   */
  evaluate(
    event: Record<string, unknown>,
    providerType: string,
    providerId?: string,
  ): DeduplicationResult {
    const matchingRules = this.findMatchingRules(providerType, providerId);

    // If no rules match, use default full-dedup behavior
    if (matchingRules.length === 0) {
      return this.applyDefaultDedup(event);
    }

    for (const rule of matchingRules) {
      const result = this.applyRule(event, rule);
      if (result.type !== 'none') {
        return result;
      }
    }

    // All rules returned 'none' -- use the last rule's result
    // (fingerprint was still computed and cached)
    return this.applyRule(event, matchingRules[matchingRules.length - 1]);
  }

  // -- Internal -------------------------------------------------------------

  private findMatchingRules(
    providerType: string,
    providerId?: string,
  ): DeduplicationRule[] {
    return this.rules.filter((rule) => {
      if (!rule.enabled) return false;
      // Wildcard matches all
      if (rule.providerType === '*') return true;
      // Type must match
      if (rule.providerType !== providerType) return false;
      // If rule specifies a provider ID, it must match
      if (rule.providerId && rule.providerId !== providerId) return false;
      return true;
    });
  }

  private applyRule(
    event: Record<string, unknown>,
    rule: DeduplicationRule,
  ): DeduplicationResult {
    const fingerprint = rule.fullDeduplication
      ? fingerprintFromFields(event, []) // use name-based fingerprint
      : fingerprintFromFields(event, rule.fingerprintFields);

    const ignoreFields = [
      ...this.defaultIgnoreFields,
      ...rule.ignoreFields,
    ];
    const hash = contentHash(event, ignoreFields);

    const lastHash = this.hashCache.get(fingerprint);
    let type: DeduplicationType;

    if (lastHash === undefined) {
      // Never seen this fingerprint
      type = 'none';
    } else if (lastHash === hash) {
      // Exact duplicate
      type = 'full';
    } else {
      // Same fingerprint, different content
      type = 'partial';
    }

    // Always update the cache with the latest hash
    this.hashCache.set(fingerprint, hash);

    return {
      fingerprint,
      contentHash: hash,
      type,
      matchedRuleId: rule.id,
    };
  }

  private applyDefaultDedup(
    event: Record<string, unknown>,
  ): DeduplicationResult {
    const fingerprint = fingerprintFromFields(event, []);
    const hash = contentHash(event, this.defaultIgnoreFields);
    const lastHash = this.hashCache.get(fingerprint);

    let type: DeduplicationType;
    if (lastHash === undefined) {
      type = 'none';
    } else if (lastHash === hash) {
      type = 'full';
    } else {
      type = 'partial';
    }

    this.hashCache.set(fingerprint, hash);

    return {
      fingerprint,
      contentHash: hash,
      type,
      matchedRuleId: null,
    };
  }

  // -- Utility --------------------------------------------------------------

  /** Number of distinct fingerprints currently tracked. */
  get trackedFingerprints(): number {
    return this.hashCache.size;
  }

  /** Clear all cached hashes. Rules are preserved. */
  resetCache(): void {
    this.hashCache.clear();
  }
}
