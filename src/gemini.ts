import { GoogleGenAI } from '@google/genai';

import { GOOGLE_API_KEY, GOOGLE_API_KEY_SECONDARY } from './config.js';
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
const FATIGUE_THRESHOLD = 10; // 10 consecutive 429s in 10 min = fatigue
const rateLimitHits: number[] = [];
let fatigueCallbackFired = false;

// Callback for notifying when memory layer is effectively offline
let onRateLimitFatigue: (() => void) | null = null;
export function setRateLimitFatigueCallback(cb: () => void): void {
  onRateLimitFatigue = cb;
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

  // Track fatigue
  const now = Date.now();
  rateLimitHits.push(now);
  // Prune old entries
  while (rateLimitHits.length > 0 && rateLimitHits[0]! < now - FATIGUE_WINDOW_MS) {
    rateLimitHits.shift();
  }
  if (rateLimitHits.length >= FATIGUE_THRESHOLD && !fatigueCallbackFired) {
    fatigueCallbackFired = true;
    logger.error(
      { hitsInWindow: rateLimitHits.length },
      'Gemini rate-limit fatigue: memory layer effectively offline',
    );
    if (onRateLimitFatigue) {
      try { onRateLimitFatigue(); } catch { /* non-fatal */ }
    }
    // Reset after firing so it can fire again if it persists
    setTimeout(() => { fatigueCallbackFired = false; }, FATIGUE_WINDOW_MS);
  }
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
 * Defaults to gemini-2.0-flash for speed and cost efficiency.
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
  model = 'gemini-2.0-flash',
  priority: 'normal' | 'high' = 'normal',
): Promise<string> {
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
    return await callGemini(firstClient, prompt, model);
  } catch (err) {
    if (!is429(err)) {
      logger.error({ err, model, key: firstKey }, 'Gemini generateContent failed');
      throw err;
    }

    markKeyRateLimited(firstKey);

    // Try fallback key if available and not already limited
    const fallbackKey: 'primary' | 'secondary' = firstKey === 'primary' ? 'secondary' : 'primary';
    const fallbackClient = fallbackKey === 'primary' ? getPrimaryClient() : secondary;

    if (fallbackClient && !isKeyRateLimited(fallbackKey)) {
      try {
        logger.info({ fallbackKey }, 'Primary Gemini key rate-limited, trying secondary');
        return await callGemini(fallbackClient, prompt, model);
      } catch (fallbackErr) {
        if (is429(fallbackErr)) {
          markKeyRateLimited(fallbackKey);
          // Both keys are rate-limited
        } else {
          logger.error({ err: fallbackErr, model, key: fallbackKey }, 'Gemini fallback key failed (non-429)');
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
      return await callGemini(getPrimaryClient(), prompt, model);
    } catch (retryErr) {
      if (is429(retryErr)) {
        markKeyRateLimited('primary');
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
