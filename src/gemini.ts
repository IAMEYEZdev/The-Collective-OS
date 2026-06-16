import { GoogleGenAI } from '@google/genai';

import { GOOGLE_API_KEY, GOOGLE_API_KEY_SECONDARY, MEMORY_PROVIDER } from './config.js';
import { ollamaGenerateContent } from './local-llm.js';
import { logger } from './logger.js';

// ── Dual-client management ─────────────────────────────────────────
// Primary key handles all traffic. Secondary activates only on primary 429.

let primaryClient: GoogleGenAI | null = null;
let secondaryClient: GoogleGenAI | null = null;

function getPrimaryClient(): GoogleGenAI {
  if (primaryClient) return primaryClient;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not set. Add it to .env for memory extraction.');
  }
  primaryClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  return primaryClient;
}

function getSecondaryClient(): GoogleGenAI | null {
  if (secondaryClient) return secondaryClient;
  if (!GOOGLE_API_KEY_SECONDARY) return null;
  secondaryClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY_SECONDARY });
  return secondaryClient;
}

// ── Rate limiter ────────────────────────────────────────────────────
// Google AI Studio free tier: 15 RPM for Flash, 2 RPM for Pro.
// Memory ingestion fires on every conversation turn and can easily
// exhaust the quota, blocking the War Room's Gemini Live connection.
// This simple token-bucket limiter caps requests to stay under the limit.

const RATE_LIMIT_RPM = 10; // stay under 15 RPM ceiling with headroom for War Room
const RATE_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

// Per-key rate limit tracking
let primaryBackoffUntil = 0;
let secondaryBackoffUntil = 0;

// Exponential backoff state (shared across keys, for double-429 scenario)
const BACKOFF_SEQUENCE_MS = [5_000, 15_000, 45_000]; // exponential, capped at 45s
let consecutiveDoubleRateLimits = 0;

// Rate-limit fatigue tracking: escalate to user after sustained failures
const FATIGUE_WINDOW_MS = 10 * 60_000; // 10 minutes
const FATIGUE_THRESHOLD = 10; // 10 failures (429/503/timeout/network) in 10 min = fatigue
const rateLimitHits: number[] = [];
let fatigueCallbackFired = false;

// ── Failure classification ──────────────────────────────────────────
// 429 alone is not enough: a 403 PERMISSION_DENIED killed the memory
// layer silently for ~4h on 2026-06-10 because nothing counted it.

export type GeminiFailureKind = 'auth' | 'capacity' | 'rate-limit' | 'other';
export interface MemoryOfflineEvent {
  kind: 'auth' | 'fatigue';
  detail: string;
}

// Callback for notifying when memory layer is effectively offline
let onRateLimitFatigue: ((event: MemoryOfflineEvent) => void) | null = null;
export function setRateLimitFatigueCallback(cb: (event: MemoryOfflineEvent) => void): void {
  onRateLimitFatigue = cb;
}

function fireOfflineCallback(event: MemoryOfflineEvent): void {
  if (onRateLimitFatigue) {
    try { onRateLimitFatigue(event); } catch { /* non-fatal */ }
  }
}

export function classifyGeminiError(err: unknown): GeminiFailureKind {
  const errAny = err as { status?: number; code?: number; message?: string };
  const status = errAny?.status ?? errAny?.code;
  const msg = errAny?.message ?? '';

  if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) return 'rate-limit';
  if (
    status === 403 || status === 401 ||
    msg.includes('PERMISSION_DENIED') || msg.includes('UNAUTHENTICATED') ||
    msg.includes('API_KEY_INVALID') || /\b40[13]\b/.test(msg)
  ) {
    return 'auth';
  }
  if (status === 503 || msg.includes('503') || msg.includes('UNAVAILABLE') || msg.toLowerCase().includes('overloaded')) {
    return 'capacity';
  }
  if (
    /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/.test(msg) ||
    msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out') ||
    msg.includes('fetch failed') || (err as { name?: string })?.name === 'AbortError'
  ) {
    return 'capacity'; // timeouts/network count toward fatigue like 503
  }
  return 'other';
}

// Auth failure latch: fires the offline callback IMMEDIATELY (no threshold)
// and does not heal with a cooldown. Only a subsequent successful call
// (i.e. the key was actually fixed) re-arms the alert.
let authFailureLatched = false;

function recordAuthFailure(err: unknown): void {
  if (authFailureLatched) return;
  authFailureLatched = true;
  const detail = (err as { message?: string })?.message?.slice(0, 200) ?? 'unknown auth error';
  logger.error({ detail }, 'Gemini auth failure (403/401): memory layer offline until key is fixed');
  fireOfflineCallback({ kind: 'auth', detail });
}

function recordSuccess(): void {
  if (authFailureLatched) {
    authFailureLatched = false;
    logger.info('Gemini auth recovered: alert re-armed');
  }
}

// Capacity failures (503, timeout, network) count toward the same fatigue
// window as 429s. Sustained failure of any kind = memory layer offline.
function trackFatigue(source: string): void {
  const now = Date.now();
  rateLimitHits.push(now);
  while (rateLimitHits.length > 0 && rateLimitHits[0]! < now - FATIGUE_WINDOW_MS) {
    rateLimitHits.shift();
  }
  if (rateLimitHits.length >= FATIGUE_THRESHOLD && !fatigueCallbackFired) {
    fatigueCallbackFired = true;
    logger.error(
      { hitsInWindow: rateLimitHits.length, source },
      'Gemini failure fatigue: memory layer effectively offline',
    );
    fireOfflineCallback({
      kind: 'fatigue',
      detail: `${rateLimitHits.length} failures (429/503/timeout) in 10 min, latest: ${source}`,
    });
    // Reset after firing so it can fire again if it persists
    setTimeout(() => { fatigueCallbackFired = false; }, FATIGUE_WINDOW_MS);
  }
}

/**
 * Classify and track a Gemini call failure. Auth errors alert immediately;
 * capacity/timeout/network errors count toward the fatigue threshold.
 */
function recordFailure(err: unknown): GeminiFailureKind {
  const kind = classifyGeminiError(err);
  if (kind === 'auth') recordAuthFailure(err);
  else if (kind === 'capacity') trackFatigue((err as { message?: string })?.message?.slice(0, 80) ?? 'capacity');
  return kind;
}

function isKeyRateLimited(key: 'primary' | 'secondary'): boolean {
  const until = key === 'primary' ? primaryBackoffUntil : secondaryBackoffUntil;
  return Date.now() < until;
}

function markKeyRateLimited(key: 'primary' | 'secondary'): void {
  const cooldownMs = 60_000;
  if (key === 'primary') {
    primaryBackoffUntil = Date.now() + cooldownMs;
  } else {
    secondaryBackoffUntil = Date.now() + cooldownMs;
  }
  logger.warn({ key }, 'Gemini 429 rate limit hit, key cooling off for 60s');
  trackFatigue('429 rate limit');
}

function isRateLimited(): boolean {
  const now = Date.now();

  // If both keys are limited, respect it
  if (isKeyRateLimited('primary') && (isKeyRateLimited('secondary') || !GOOGLE_API_KEY_SECONDARY)) {
    return true;
  }

  // Prune timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }

  return requestTimestamps.length >= RATE_LIMIT_RPM;
}

function recordRequest(): void {
  requestTimestamps.push(Date.now());
}

function is429(err: unknown): boolean {
  const errAny = err as { status?: number; message?: string };
  return errAny.status === 429 || (errAny.message?.includes('429') ?? false);
}

/**
 * Attempt a Gemini API call with a specific client.
 */
async function callGemini(
  ai: GoogleGenAI,
  prompt: string,
  model: string,
): Promise<string> {
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });
  if (!response.text) {
    logger.warn({ model }, 'Gemini returned empty response');
    return '';
  }
  return response.text;
}

/**
 * Generate text content via Gemini.
 * Defaults to gemini-2.5-flash for speed and cost efficiency.
 *
 * Includes a rate limiter to avoid exhausting the free-tier quota,
 * which would block the War Room's Gemini Live connection.
 * Set priority = 'high' to bypass the rate limiter (used by War Room).
 *
 * Fallback strategy (B.1):
 *   1. Try primary key
 *   2. On primary 429, immediately retry on secondary key (if configured)
 *   3. On double 429, apply exponential backoff with jitter (5s, 15s, 45s cap)
 */
export async function generateContent(
  prompt: string,
  model = 'gemini-2.5-flash',
  priority: 'normal' | 'high' = 'normal',
): Promise<string> {
  // Local provider: no Gemini client, no quota rate limiter. Failures
  // still feed the offline-alert tracking (network errors count as capacity).
  if (MEMORY_PROVIDER === 'local') {
    try {
      const text = await ollamaGenerateContent(prompt);
      recordSuccess();
      return text;
    } catch (err) {
      const kind = recordFailure(err);
      logger.error({ err, provider: 'local', kind }, 'Local LLM generateContent failed');
      throw err;
    }
  }

  // Rate limit non-critical calls (memory ingestion, consolidation)
  // to preserve quota for high-priority calls (War Room, user-facing)
  if (priority === 'normal' && isRateLimited()) {
    logger.debug('Gemini call skipped (rate limited)');
    return '';
  }

  // Try primary key (or secondary if primary is known-limited)
  const primaryLimited = isKeyRateLimited('primary');
  const secondary = getSecondaryClient();
  const firstClient = primaryLimited && secondary ? secondary : getPrimaryClient();
  const firstKey: 'primary' | 'secondary' = primaryLimited && secondary ? 'secondary' : 'primary';

  try {
    recordRequest();
    const text = await callGemini(firstClient, prompt, model);
    recordSuccess();
    return text;
  } catch (err) {
    if (!is429(err)) {
      const kind = recordFailure(err);
      logger.error({ err, model, key: firstKey, kind }, 'Gemini generateContent failed');
      throw err;
    }

    markKeyRateLimited(firstKey);

    // Try fallback key if available and not already limited
    const fallbackKey: 'primary' | 'secondary' = firstKey === 'primary' ? 'secondary' : 'primary';
    const fallbackClient = fallbackKey === 'primary' ? getPrimaryClient() : secondary;

    if (fallbackClient && !isKeyRateLimited(fallbackKey)) {
      try {
        logger.info({ fallbackKey }, 'Primary Gemini key rate-limited, trying secondary');
        const text = await callGemini(fallbackClient, prompt, model);
        recordSuccess();
        return text;
      } catch (fallbackErr) {
        if (is429(fallbackErr)) {
          markKeyRateLimited(fallbackKey);
          // Both keys are rate-limited
        } else {
          const kind = recordFailure(fallbackErr);
          logger.error({ err: fallbackErr, model, key: fallbackKey, kind }, 'Gemini fallback key failed (non-429)');
          throw fallbackErr;
        }
      }
    }

    // Both keys exhausted (or no secondary). Apply exponential backoff for high-priority.
    consecutiveDoubleRateLimits++;

    if (priority === 'normal') {
      // Background task: just skip, don't block
      return '';
    }

    // High-priority: wait with exponential backoff + jitter, then retry primary
    const backoffIdx = Math.min(consecutiveDoubleRateLimits - 1, BACKOFF_SEQUENCE_MS.length - 1);
    const baseMs = BACKOFF_SEQUENCE_MS[backoffIdx]!;
    const jitter = baseMs * (0.8 + Math.random() * 0.4); // +/- 20%
    logger.warn(
      { backoffMs: Math.round(jitter), attempt: consecutiveDoubleRateLimits },
      'Both Gemini keys rate-limited, backing off with jitter',
    );
    await new Promise((resolve) => setTimeout(resolve, jitter));

    try {
      const text = await callGemini(getPrimaryClient(), prompt, model);
      recordSuccess();
      return text;
    } catch (retryErr) {
      if (is429(retryErr)) {
        markKeyRateLimited('primary');
      } else {
        recordFailure(retryErr);
      }
      logger.error({ err: retryErr, model }, 'Gemini backoff retry failed');
      throw retryErr;
    }
  }
}

// Daily stats tracking for Gemini usage logging
let geminiCallsToday = 0;
let geminiSkippedToday = 0;
let gemini429sToday = 0;

export function recordGeminiSkip(): void { geminiSkippedToday++; }
export function getGeminiDailyStats(): { calls: number; skipped: number; rateLimited: number } {
  return { calls: geminiCallsToday, skipped: geminiSkippedToday, rateLimited: gemini429sToday };
}
export function resetGeminiDailyStats(): void {
  geminiCallsToday = 0;
  geminiSkippedToday = 0;
  gemini429sToday = 0;
}

/**
 * Parse a JSON response from Gemini, with fallback on malformed output.
 * Returns null if parsing fails.
 */
export function parseJsonResponse<T>(text: string): T | null {
  // Guard: empty or whitespace-only responses are not valid JSON (Fix 5).
  // This prevents SyntaxError noise when Gemini returns an empty body (e.g. on 429).
  if (!text || text.trim() === '') {
    return null;
  }

  try {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, 'Failed to parse Gemini JSON response');
    return null;
  }
}
