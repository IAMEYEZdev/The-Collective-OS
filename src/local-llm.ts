import { OLLAMA_BASE_URL, LOCAL_CHAT_MODEL, LOCAL_EMBED_MODEL } from './config.js';
import { logger } from './logger.js';

// ── Local memory provider (MEM-SHIM-01 Workstream B) ───────────────
// Ollama serves both roles: chat completions via the OpenAI-compatible
// endpoint, embeddings via the native endpoint (768-dim nomic-embed-text).
// Selected with MEMORY_PROVIDER=local; gemini stays the default so a
// one-line .env change rolls back.

const REQUEST_TIMEOUT_MS = 120_000;

export async function ollamaGenerateContent(prompt: string, model = LOCAL_CHAT_MODEL): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ollama chat failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) logger.warn({ model }, 'Ollama returned empty response');
  return text;
}

export async function ollamaEmbedText(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { embedding?: number[] };
  return data.embedding ?? [];
}

/**
 * Startup health check for MEMORY_PROVIDER=local. Verifies Ollama is
 * reachable and both required models are pulled. No silent fallthrough:
 * callers must ERROR-log and alert the Captain on failure.
 */
export async function checkOllamaHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, detail: `Ollama responded ${res.status} at ${OLLAMA_BASE_URL}` };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name);
    const missing = [LOCAL_CHAT_MODEL, LOCAL_EMBED_MODEL].filter(
      (want) => !names.some((n) => n === want || n.startsWith(`${want}:`)),
    );
    if (missing.length > 0) {
      return { ok: false, detail: `Ollama up but missing models: ${missing.join(', ')} (have: ${names.join(', ')})` };
    }
    return { ok: true, detail: `Ollama healthy at ${OLLAMA_BASE_URL} with ${LOCAL_CHAT_MODEL} + ${LOCAL_EMBED_MODEL}` };
  } catch (err) {
    return { ok: false, detail: `Ollama unreachable at ${OLLAMA_BASE_URL}: ${String((err as Error)?.message ?? err).slice(0, 150)}` };
  }
}
