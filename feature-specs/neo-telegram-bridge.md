# Neo Telegram Bridge

## Goal

Provide a dedicated Neo Telegram bot that converts authorized, unlocked text messages into governed Neo dispatch envelopes and returns correlated Neo results to the originating private chat.

## Design

- Use `NEO_BOT_TOKEN` exclusively for the Neo bot. Never fall back to `TELEGRAM_BOT_TOKEN`, `activeBotToken`, or an agent token.
- Accept only private text messages whose chat ID exactly matches `ALLOWED_CHAT_ID`.
- Check the existing lock before creating a dispatch and touch activity only after authorization and lock checks pass.
- Create envelopes only through `scripts/neo-dispatch.mjs enqueue`, with bounded JSON supplied through standard input.
- Store the originating chat at `callback.telegram.chatId` in the governed outbound envelope.
- Use the dispatch ULID as the sole reply-correlation key. Neo results must echo that ULID.
- Have `neo-poll.mjs` load the original outbound envelope by `result.ulid`, then recover the chat ID from the trusted callback metadata.
- Keep result ingestion state separate from Telegram delivery state so delivery retries never repeat Hermes or hive ingestion.
- Send replies through the dedicated Neo bot only, with destination revalidation immediately before delivery.
- Apply bounded retry only to recognized transient Telegram network errors.

## Implementation

### 1. Configuration and Telegram client

- Add isolated `NEO_BOT_TOKEN` configuration and sensitive-value redaction.
- Restore only the approved Telegram network-error classifier and retry middleware behavior.
- Expose reusable retry installation so both bot clients receive identical protection.
- Add a Neo bot factory with explicit missing-token failure, private-chat enforcement, authorization, locking, text-only handling, and governed dispatch callback injection.

### 2. Governed enqueue path

- Preserve the existing dispatch-by-ULID mode in `scripts/neo-dispatch.mjs`.
- Add an enqueue mode that validates a bounded request from standard input, generates a ULID, creates the canonical version 1 envelope, records Telegram callback metadata, and writes the outbound envelope atomically.
- Return structured success data with the ULID and envelope path.
- Never interpolate Telegram content into a shell command or write dispatch envelopes from `src/bot.ts` or `src/index.ts`.

### 3. Correlated result delivery

- Extend `scripts/neo-poll.mjs` to emit machine-readable pending Telegram replies after existing validation and ingestion complete.
- Derive the destination only from the original outbound envelope located by the echoed result ULID.
- Track delivery independently with an idempotent acknowledgement keyed by ULID.
- Extend the scheduler to send validated reply records through an injected Neo sender, acknowledge only after delivery succeeds, and leave failures pending.

### 4. Process lifecycle

- Create and start the optional Neo bot independently from the existing main bot.
- Spawn the governed enqueue script and pass the dispatch request through child standard input.
- Acknowledge accepted requests with the generated ULID.
- Inject `neoBot.api.sendMessage` into the scheduler for Neo replies.
- Stop both bots during normal shutdown and handle Neo startup failures without substituting or disabling the main bot.

### 5. Configuration example and tests

- Add only an empty `NEO_BOT_TOKEN=` placeholder to `.env.example`; do not modify `.env`.
- Add regression coverage for token isolation, authorization, locking, text limits, standard-input dispatch, ULID acknowledgement, transient network retry, round-trip correlation, pending delivery, and idempotent acknowledgement.

## Dependencies

- Existing `grammy` Telegram client.
- Existing security lock and activity helpers.
- Existing governed dispatch and poll scripts.
- Existing scheduler lifecycle.
- No new packages.

## Constraints

- Do not restore `AUTHORISED_CHAT_IDS`, `NEO_CHAT_ID`, `isNeoChat`, unknown-chat forwarding, or persona-prefix routing.
- Do not apply, pop, or drop `stash@{0}`. Reintroduce only the two approved retry hunks by implementation.
- Do not deploy, restart bots, merge, push, or modify live credentials.
- Do not log Telegram tokens or include them in child-process arguments.
- Preserve the existing 60-second Neo poll cadence and single-flight guard.

## Verification checklist

- [ ] `NEO_BOT_TOKEN` has no fallback and is redacted.
- [ ] Unauthorized, group, locked, empty, oversized, and unsupported messages create no envelope.
- [ ] Authorized text creates exactly one governed enqueue request through standard input.
- [ ] The outbound envelope stores the allowed chat ID at `callback.telegram.chatId`.
- [ ] Result correlation uses only the echoed dispatch ULID and the original outbound envelope.
- [ ] The scheduler sends only to `ALLOWED_CHAT_ID` through the Neo bot.
- [ ] Failed delivery remains pending without repeating Hermes or hive ingestion.
- [ ] Delivery acknowledgement is idempotent.
- [ ] Retry recognizes only approved transient network errors, stops after eight attempts, and caps delay at 30 seconds.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
