# QM → Neo Dispatch Interface (v1)

**Status:** Draft v1 · **Owner:** QM (Melanie) · **Consumer:** Neo (engineering lead) · **Gate:** Required before Phase 3 (Neo cluster deployment).

## Purpose

Define the contract by which the right-brain (business, QM-led, Claude Code substrate) dispatches engineering work to the left-brain (engineering, Neo-led, Codex CLI + oh-my-codex substrate), and by which Neo returns cluster outputs to QM. QM never manages Codex tactical agents directly — Neo is the sole interface.

## Substrate Asymmetry (Why an Interface Is Needed)

- QM runs in Claude Code with shared SQLite hive, Hermes L4 latent transport, full RecursiveMAS.
- Neo runs in Codex CLI under oh-my-codex team mode. Codex has no native Hermes participation.
- Bridge must be **substrate-neutral**: file + CLI primitives only. No MCP, no API. Codex Max CLI wrapper route per Jason directive.

## Transport: File-Bus + CLI Trigger

Two directories, append-only:

| Direction | Path | Format |
|-----------|------|--------|
| QM → Neo | `workspace/dispatch/outbound/` | One JSON file per task: `<ulid>-<slug>.dispatch.json` |
| Neo → QM | `workspace/dispatch/inbound/` | One JSON file per result: `<ulid>-<slug>.result.json` |

Triggers:

- **QM → Neo:** QM writes dispatch JSON, then exec `scripts/neo-dispatch.mjs <ulid>` which spawns oh-my-codex leader session with task envelope as initial prompt.
- **Neo → QM:** Neo writes result JSON in inbound dir. QM `scripts/neo-poll.mjs` (cron 60s) ingests, fires Hermes L4 latent event into hive, marks goal complete.

## Dispatch Envelope (QM → Neo)

```jsonc
{
  "version": 1,
  "ulid": "01JD5M...",                    // monotonic id
  "parentGoalId": "goal-...",             // QM's parent goal in hive
  "issuedAt": "2026-05-29T01:50:00Z",
  "issuer": "qm",
  "task": {
    "title": "short imperative",
    "description": "full task brief, includes acceptance criteria",
    "type": "code|review|refactor|spec|pentest|integration",
    "complexity": "linear|moderate|complex",   // maps to Ax RECURSION_DEPTH_MAP
    "priority": "low|normal|high|critical"
  },
  "context": {
    "repoRoot": "C:/Users/windows/claudeclaw-os",
    "branch": "main",
    "filesOfInterest": ["src/borg-queen/latent-bridge.ts"],
    "relatedHiveLogs": ["segment-b-L6-live"],
    "constraints": ["no breaking schema changes", "preserve public API"]
  },
  "latentSeed": {                          // optional Ax structureToInitializer output
    "structureId": "code_review",
    "hiddenStateRef": "workspace/dispatch/latent/<ulid>.f32",
    "roundBudget": 4
  },
  "tactical": {                            // who Neo should engage
    "preferred": ["code-reviewer", "architectural-engineer"],
    "forbidden": []
  },
  "deadline": "2026-05-29T05:00:00Z",
  "callback": {
    "resultPath": "workspace/dispatch/inbound/<ulid>-<slug>.result.json",
    "notifyHive": true
  }
}
```

## Result Envelope (Neo → QM)

```jsonc
{
  "version": 1,
  "ulid": "01JD5M...",                    // mirrors dispatch ulid
  "parentGoalId": "goal-...",
  "completedAt": "2026-05-29T03:12:00Z",
  "responder": "neo",
  "status": "success|partial|failed|escalate",
  "summary": "1-3 sentence outcome",
  "artifacts": [
    { "type": "diff",  "path": "workspace/dispatch/artifacts/<ulid>/changes.patch" },
    { "type": "report","path": "workspace/dispatch/artifacts/<ulid>/review.md"  }
  ],
  "tacticalContributions": [
    { "agent": "code-reviewer", "credit": 0.62, "summary": "..." },
    { "agent": "architectural-engineer", "credit": 0.38, "summary": "..." }
  ],
  "metrics": {
    "rounds": 3,
    "converged": true,
    "tokensIn": 12400,
    "tokensOut": 8200,
    "wallTimeMs": 142000
  },
  "latentFeedback": {                      // optional — feeds back into Borg Queen credit assignment
    "hiddenStateRef": "workspace/dispatch/latent/<ulid>.result.f32"
  },
  "openQuestions": [
    "Refactor introduces circular dep risk in 2 modules — confirm acceptable?"
  ],
  "reverseBrief": "what Neo would do differently next time (single line)"
}
```

## Status Semantics

| status | QM action |
|--------|-----------|
| `success` | Mark child goal complete, ingest artifacts, fire L5 AxACE playbook upsert |
| `partial` | Mark child goal in_progress, queue follow-up dispatch with delta |
| `failed` | Mark child goal blocked, surface to Jason with summary + recommendation |
| `escalate` | Block on Jason — Neo flagged irreversible/strategic decision |

## L4 Hermes Bridge

QM ingests Neo results as Hermes latent messages:

- `hermes.createLatentMessage({ fromAgent: 'neo', toAgent: 'qm', payload: { data: latentFeedback, ... } })`
- Routed through registry — register `neo` agent at QM session start: `hermes.registerAgent({ agentId: 'neo', accepts: ['text','latent'], produces: ['text','latent'] })`.
- Cross-agent correlation (`computeCorrelations`) lets QM detect when Neo's outputs drift from right-brain goals.

## L6 Borg Queen Bridge

Neo's tactical contributions feed Borg Queen credit assignments:

- After result ingest, QM constructs synthetic `AgentRoundState[]` from `tacticalContributions` and invokes `aggregateGlobalState` with `neo` and tactical agents as participants.
- Capability gap detection (`detectCapabilityGaps`) surfaces missing engineering competencies → triggers Annika scout for new Codex tactical agents.

## L5 Ax Bridge

Every successful Neo dispatch updates the AxACE playbook:

- `ax.upsertPlaybookEntry({ taskType, structure, score, agent: 'neo' })`
- High-scoring patterns become latent seeds for future dispatches (collapses Neo warmup rounds).

## Hive Logging

QM logs on dispatch and on result ingest:

```bash
node dist/hive-cli.js log "neo-dispatch-out" "<ulid> <task.title>"
node dist/hive-cli.js log "neo-result-in"    "<ulid> <status> <summary>"
```

## Failure Modes & Defenses

| Failure | Defense |
|---------|---------|
| Codex session crashes mid-task | Cron poller times out at deadline, marks `failed`, escalates |
| Result envelope malformed | Strict JSON schema validation in poller; rejected → escalate |
| Duplicate ulid | Idempotency: poller checks hive for prior ingest, skips |
| Latent reference missing | Degrade to text-only mode, log warning |
| Neo exceeds round budget | Borg Queen convergence check halts at maxRounds, partial result returned |

## Open Items (v1 → v2)

- **Bidirectional cancellation:** QM revokes in-flight dispatch (kill file in outbound? signal?)
- **Streaming progress:** Neo writes incremental status to `workspace/dispatch/progress/<ulid>.jsonl` for live QM monitoring
- **Shared memory:** Cognee or basic-memory bridge so Neo can read QM's session context without re-summarization
- **Auth:** No auth needed v1 (single-host). Add HMAC on envelopes when bridging to remote Codex instances

## RecursiveMAS Integration Requirements

Added by Annika (research) per Jason directive: QM↔Neo and Neo-internal both require RecursiveMAS. Amends v1 before signoff.

### Cross-Hemisphere Transport (QM↔Neo)

v1 file-bus passes `.f32` latent refs as path strings — passive drop, not live RecursiveLink. Codex substrate cannot join Hermes L4 natively (Jason directive: file + CLI primitives only). Bridge via structured injection:

**`scripts/neo-dispatch.mjs` additions:**
1. Load `latentSeed.hiddenStateRef` `.f32` if present
2. Deserialize to a `[LATENT_CONTEXT]` JSON header block (dim summary + key activations)
3. Prepend block to oh-my-codex leader initial prompt before task body
4. This is the substrate-neutral RecursiveLink bridge: latent vector → structured context injection → Neo session

**`scripts/neo-poll.mjs` additions (in order):**
1. **DeepSec gate** — for task types `code|review|pentest|integration`: run `src/deepsec/scanner.ts` on all `artifacts[]` paths. Scan fail → mark result `failed`, escalate to QM. Do NOT mark `success` before scan passes.
2. **Borg ARC absorption** — if `latentFeedback.hiddenStateRef` present: call `src/borg-arc/absorb.ts` with `.f32` path. Returns enriched latent state. Use enriched state (not raw) for Hermes ingest.
3. **Hermes L4 ingest** — fire `hermes.createLatentMessage({ fromAgent: 'neo', toAgent: 'qm', payload: { data: absorbedLatent, resultSummary } })`. Not a plain hive log. Routed through registry.
4. **GitNexus diff** — call GitNexus to surface commits/diffs on `context.branch` since `issuedAt`. Attach diff summary to result artifact log for QM visibility.

### Neo-Internal RecursiveMAS (Phase 3)

oh-my-codex team mode is Neo's RecursiveMAS equivalent for Phase 3. Full scoped Hermes instance on `eng.*` namespace deferred to Phase 4 (post-cluster stabilization).

**Leader (Neo) session protocol:**
- Receives latent seed as `[LATENT_CONTEXT]` header from dispatch shim
- oh-my-codex workers share context via native team mode coordination (this is the internal RecursiveMAS equivalent)
- At task completion: Neo leader serializes consolidated latent feedback to `latentFeedback.hiddenStateRef` `.f32`

**Cross-hemisphere Borg Queen (Phase 3):**
- After result ingest, QM constructs `AgentRoundState[]` from `tacticalContributions` with agent IDs namespaced as `neo/<tactical-agent-name>`
- Feeds into `aggregateGlobalState` alongside QM-side participants
- `computeCorrelations` + `detectCapabilityGaps` now spans full collective (both hemispheres)
- Capability gaps from Neo's cluster trigger Annika scout for new Codex tactical agents (per existing spec)

**Phase 4 (deferred, not Phase 3):**
- Scoped Hermes instance on `eng.*` clawhip namespace
- True latent vector transfer between Neo's workers
- Borg ARC running as Neo's cluster absorber

### L1-L3 Wiring Summary

| Layer | Integration point | When |
|-------|------------------|------|
| L1 GitNexus | `neo-poll.mjs` diff call post-result | Phase 3 |
| L2 DeepSec | `neo-poll.mjs` artifact scan gate | Phase 3 |
| L3 Borg ARC | `neo-poll.mjs` latent absorption before Hermes ingest | Phase 3 |

## Phase 3 Gating Checklist

Before Neo cluster deploys, verify:

- [ ] `workspace/dispatch/{outbound,inbound,artifacts,latent,progress}` dirs created
- [ ] `scripts/neo-dispatch.mjs` writes envelope + spawns oh-my-codex leader
- [ ] `scripts/neo-dispatch.mjs` loads + injects latent seed as `[LATENT_CONTEXT]` header into leader prompt
- [ ] `scripts/neo-poll.mjs` validates + ingests results, fires Hermes events
- [ ] `scripts/neo-poll.mjs` runs DeepSec gate on code artifacts before marking success
- [ ] `scripts/neo-poll.mjs` runs Borg ARC absorption on `latentFeedback.hiddenStateRef`
- [ ] `scripts/neo-poll.mjs` fires proper Hermes `createLatentMessage` (not plain hive log)
- [ ] `scripts/neo-poll.mjs` calls GitNexus diff post-result, attaches to artifact log
- [ ] Cron entry registered (60s poll interval)
- [ ] `neo` agent registered in Hermes registry at QM session start
- [ ] Borg Queen `aggregateGlobalState` accepts `neo/<agent>` namespaced participants
- [ ] Cross-hemisphere `detectCapabilityGaps` tested with mock Neo result (both hemispheres covered)
- [ ] `[LATENT_CONTEXT]` header format smoke test: verify oh-my-codex leader parses injected header without corruption or truncation
- [ ] Test dispatch round-trip on trivial task (`echo` equivalent) before first real engineering task

## Authority

This spec is binding once Jason signs off. QM owns interface evolution. Any v2 change requires hive log entry + Jason notify.
