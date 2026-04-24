import { generateContent, parseJsonResponse } from './gemini.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import { getMemoriesWithEmbeddings, saveStructuredMemoryAtomic } from './db.js';
import { logger } from './logger.js';

// Callback for notifying when a high-importance memory is created.
// Set by bot.ts to send a Telegram notification.
let onHighImportanceMemory: ((memoryId: number, summary: string, importance: number) => void) | null = null;

export function setHighImportanceCallback(cb: (memoryId: number, summary: string, importance: number) => void): void {
  onHighImportanceMemory = cb;
}

interface ExtractionResult {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

const EXTRACTION_PROMPT = `You are a memory extraction agent. Given a conversation exchange between a user and their AI assistant, decide if it contains information worth remembering LONG-TERM (weeks/months from now).

The bar is HIGH. Most exchanges should be skipped. Only extract if a future conversation would go noticeably worse without this memory.

SKIP (return {"skip": true}) if:
- The message is just an acknowledgment (ok, yes, no, got it, thanks, send it, do it)
- It's a command with no lasting context (/chatid, /help, checkpoint, convolife, etc)
- It's ephemeral task execution (send this email, check my calendar, read this message, draft a response, move these emails, fill out this form)
- The content is only relevant to this exact moment or this session
- It's a greeting or small talk with no substance
- It's a one-off action request like "shorten that", "generate 3 ideas", "look up X", "draft a reply"
- It's a correction of a typo or minor instruction adjustment
- It's asking for information or a status check ("how much did we make", "what's trending", "what time is it")
- The assistant is SUMMARIZING what it just did ("I sent the messages", "Here's what I moved", "Done, here's your inbox")
- The assistant is SUMMARIZING the session or recapping prior conversation. Session summaries are meta-information, not new facts.
- It's form-filling, application steps, or draft iteration that won't matter once the form is submitted
- It describes what the assistant sent/did/moved/drafted for the user (these are task logs, not memories)
- The exchange is about a specific person's one-time message or request that won't recur

EXTRACT only if the exchange reveals:
- User preferences or habits that apply GOING FORWARD (not just this one time)
- Decisions or policies (how to handle X from now on)
- Important relationships: WHO someone is and HOW the user relates to them (not what they said in one message)
- Corrections to the assistant's behavior (feedback on approach)
- Business rules or workflows that are STANDING RULES
- Recurring patterns or routines
- Technical preferences or architectural decisions

If extracting, return JSON:
{
  "skip": false,
  "summary": "1-2 sentence summary focused on the LASTING FACT, not the conversation. Write as a rule or fact, not a narrative.",
  "entities": ["entity1", "entity2"],
  "topics": ["topic1", "topic2"],
  "importance": 0.0-1.0
}

Importance guide:
- 0.8-1.0: Core identity, strong preferences, critical business rules, relationship dynamics
- 0.5-0.7: Useful context, standing project decisions, moderate preferences, workflow patterns
- 0.3-0.4: Borderline. If in doubt, skip. Only extract if you are confident this will matter in a future session.

User message: {USER_MESSAGE}
Assistant response: {ASSISTANT_RESPONSE}`;

// ── Batched ingestion buffer (B.1 Task 2) ──────────────────────────
// Instead of calling Gemini on every turn, accumulate turns and flush
// in batches of BATCH_SIZE or after IDLE_FLUSH_MS of inactivity.

interface BufferedTurn {
  chatId: string;
  userMessage: string;
  assistantResponse: string;
  agentId: string;
}

const BATCH_SIZE = 5;
const IDLE_FLUSH_MS = 3 * 60 * 1000; // 3 minutes (Jason's tweak from 10)

const ingestionBuffer: BufferedTurn[] = [];
let idleFlushTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleFlushTimer) clearTimeout(idleFlushTimer);
  idleFlushTimer = setTimeout(() => {
    void flushIngestionBuffer().catch((err) => {
      logger.error({ err }, 'Idle flush of ingestion buffer failed');
    });
  }, IDLE_FLUSH_MS);
}

/**
 * Queue a conversation turn for batched ingestion.
 * Flushes when BATCH_SIZE is reached or IDLE_FLUSH_MS elapses.
 */
export function queueForIngestion(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  agentId = 'main',
): void {
  // Hard filter: skip very short messages and commands (same as before)
  if (userMessage.length <= 15 || userMessage.startsWith('/')) return;

  ingestionBuffer.push({ chatId, userMessage, assistantResponse, agentId });
  resetIdleTimer();

  if (ingestionBuffer.length >= BATCH_SIZE) {
    void flushIngestionBuffer().catch((err) => {
      logger.error({ err }, 'Batch flush of ingestion buffer failed');
    });
  }
}

/**
 * Flush the ingestion buffer, processing each turn through Gemini.
 * Called on batch threshold, idle timeout, session boundaries, and shutdown.
 */
export async function flushIngestionBuffer(): Promise<void> {
  if (ingestionBuffer.length === 0) return;

  // Drain the buffer atomically
  const batch = ingestionBuffer.splice(0, ingestionBuffer.length);
  if (idleFlushTimer) {
    clearTimeout(idleFlushTimer);
    idleFlushTimer = null;
  }

  logger.info({ count: batch.length }, 'Flushing ingestion buffer');

  for (const turn of batch) {
    try {
      await ingestConversationTurn(turn.chatId, turn.userMessage, turn.assistantResponse, turn.agentId);
    } catch (err) {
      // Individual turn failure should not block the rest
      logger.error({ err }, 'Memory ingestion failed for buffered turn');
    }
  }
}

/**
 * Synchronous flush for shutdown: persist unflushed turns to DB
 * so they can be picked up on next boot. Bias toward logging
 * and continuing rather than blocking shutdown.
 */
export function flushBufferOnShutdown(): void {
  if (ingestionBuffer.length === 0) return;
  logger.info({ count: ingestionBuffer.length }, 'Persisting unflushed ingestion buffer on shutdown');
  // We don't call Gemini here (that would block shutdown).
  // The turns are already in conversation_log (saved by saveConversationTurn).
  // They'll be available for the next consolidation run on restart.
  // Just clear the timer and log what we're dropping.
  if (idleFlushTimer) {
    clearTimeout(idleFlushTimer);
    idleFlushTimer = null;
  }
  const dropped = ingestionBuffer.splice(0, ingestionBuffer.length);
  logger.warn(
    { count: dropped.length, turns: dropped.map((t) => t.userMessage.slice(0, 50)) },
    'Unflushed turns at shutdown (already in conversation_log, will be available for next consolidation)',
  );
}

/**
 * Analyze a conversation turn and extract structured memory if warranted.
 * Called async (fire-and-forget) after the assistant responds.
 * Returns true if a memory was saved, false if skipped.
 */
export async function ingestConversationTurn(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  agentId = 'main',
): Promise<boolean> {
  // Hard filter: skip very short messages and commands
  if (userMessage.length <= 15 || userMessage.startsWith('/')) return false;

  try {
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MESSAGE}', userMessage.slice(0, 2000))
      .replace('{ASSISTANT_RESPONSE}', assistantResponse.slice(0, 2000));

    const raw = await generateContent(prompt);
    const result = parseJsonResponse<ExtractionResult & { skip?: boolean }>(raw);

    if (!result || result.skip) return false;

    // Validate required fields
    if (!result.summary || typeof result.importance !== 'number') {
      logger.warn({ result }, 'Gemini extraction missing required fields');
      return false;
    }

    // Hard filter: only save memories with meaningful importance.
    // 0.5 threshold ensures only genuinely useful context gets through.
    // The 0.3-0.4 tier was almost entirely noise (task logs, form steps).
    if (result.importance < 0.5) return false;

    // Clamp importance to valid range
    const importance = Math.max(0, Math.min(1, result.importance));

    // Generate embedding early so we can check for duplicates before saving
    let embedding: number[] = [];
    try {
      const embeddingText = `${result.summary} ${(result.entities ?? []).join(' ')} ${(result.topics ?? []).join(' ')}`;
      embedding = await embedText(embeddingText);
    } catch (embErr) {
      logger.warn({ err: embErr }, 'Failed to generate embedding for duplicate check');
    }

    // Duplicate detection: skip if a very similar memory already exists
    if (embedding.length > 0) {
      const existing = getMemoriesWithEmbeddings(chatId);
      for (const mem of existing) {
        const sim = cosineSimilarity(embedding, mem.embedding);
        if (sim > 0.85) {
          logger.debug(
            { similarity: sim.toFixed(3), existingId: mem.id, newSummary: result.summary.slice(0, 60) },
            'Skipping duplicate memory',
          );
          return false;
        }
      }
    }

    const memoryId = saveStructuredMemoryAtomic(
      chatId,
      userMessage,
      result.summary,
      result.entities ?? [],
      result.topics ?? [],
      importance,
      embedding,
      'conversation',
      agentId,
    );

    // Signal that new content was ingested (for consolidation gating)
    markNewContentIngested();

    // Notify on high-importance memories so the user can pin them
    if (importance >= 0.8 && onHighImportanceMemory) {
      try { onHighImportanceMemory(memoryId, result.summary, importance); } catch { /* non-fatal */ }
    }

    logger.info(
      { chatId, importance, memoryId, topics: result.topics, summary: result.summary.slice(0, 80) },
      'Memory ingested',
    );
    return true;
  } catch (err) {
    // Gemini failure should never block the bot
    logger.error({ err }, 'Memory ingestion failed (Gemini)');
    return false;
  }
}

// ── Consolidation gate (B.1 Task 2) ────────────────────────────────
// Track whether any new content has been ingested since last consolidation.
// Consolidation checks this flag before running.

let _newContentSinceLastConsolidation = false;

export function markNewContentIngested(): void {
  _newContentSinceLastConsolidation = true;
}

export function hasNewContentForConsolidation(): boolean {
  return _newContentSinceLastConsolidation;
}

export function clearConsolidationFlag(): void {
  _newContentSinceLastConsolidation = false;
}

// ── Trivial message detection (B.1 Task 2) ──────────────────────────
// Skip relevance evaluation for messages that carry no signal.

const TRIVIAL_PATTERNS = [
  /^(hi|hey|hello|yo|sup|hiya|howdy)[\s!.?]*$/i,
  /^(thanks|thank you|thankyou|thx|ty|cheers|ta)[\s!.?]*$/i,
  /^(okay|ok|k|kk|sure|yep|yup|yeah|yes|no|nah|nope)[\s!.?]*$/i,
  /^(cool|nice|great|awesome|perfect|good|fine|alright|right|gotcha|got it)[\s!.?]*$/i,
  /^(lol|haha|hah|lmao)[\s!.?]*$/i,
  /^\d{4,6}$/, // PIN codes
  /^\/\w+/, // Telegram commands
];

// Narrowed single-emoji list: only common acknowledgement reactions (Jason's tweak)
const TRIVIAL_SINGLE_EMOJIS = ['👍', '👎', '👌', '✅', '❤️', '🙏'];

export function isTrivialMessage(message: string): boolean {
  const trimmed = message.trim();

  // Short messages under 20 characters that match patterns
  if (trimmed.length < 20) {
    for (const pattern of TRIVIAL_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
  }

  // Single acknowledgement emoji
  if (TRIVIAL_SINGLE_EMOJIS.includes(trimmed)) return true;

  return false;
}
