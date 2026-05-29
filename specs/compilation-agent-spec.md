# Compilation Agent Spec

## Purpose

Scheduled agent that closes the compile loop between our three memory layers:
- **Hive Mind SQLite** (structured facts, source of truth)
- **Graphiti/Neo4j** (relationship graph)
- **Basic Memory/Obsidian** (browsable wiki synthesis)

Without this agent, all three layers receive parallel writes from team agents but never read from each other. Knowledge compounds within each silo but not across them.

## Architecture

```
             ┌─────────────┐
             │  Team Agents │
             │ (Mel, James, │
             │  Annika, etc)│
             └──────┬───────┘
                    │ write raw facts
                    ▼
           ┌────────────────┐
           │   Hive Mind    │  ← SINGLE SOURCE OF TRUTH
           │   (SQLite)     │
           └────────┬───────┘
                    │ compile agent reads
                    ▼
           ┌────────────────┐
           │   Graphiti     │  ← RELATIONSHIP LAYER
           │   (Neo4j)      │
           │   entities,    │
           │   edges,       │
           │   contradictions│
           └────────┬───────┘
                    │ compile agent reads
                    ▼
           ┌────────────────┐
           │ Basic Memory   │  ← BROWSABLE WIKI (read-only artifacts)
           │ (Obsidian)     │
           │ generated pages│
           │ with timestamps│
           └────────────────┘
```

**Data flows DOWN only.** Wiki pages are never edited directly. Obsidian notes are generated artifacts, not sources of truth.

## Core Principle: Contradiction Preservation

The compilation agent MUST NOT resolve contradictions between agents. It surfaces them.

Example output in wiki page:
```markdown
## Greenwich Ace Plumbing — Pipeline Status

**⚠️ TENSION DETECTED:**
- Jackson (Apr 28): "Spec website built, ready for outreach"
- James (Apr 30): "No voiceover script drafted yet — outreach blocked"
- Sean: No follow-up scheduled in calendar

**Signal:** Outreach pipeline stalled between build and delivery.
```

Contradictions = highest-value signal. Never smooth into consensus.

## Compilation Passes

### Pass 1: Hive Mind → Graphiti (Entity Extraction + Relationships)

**Trigger:** Daily at 5am (before 6am Reddit scrape, before team wakes up)

**Process:**
1. Query Hive Mind for entries created/modified since last compilation
2. Extract entities: people, companies, projects, decisions, deadlines
3. For each entity, check if Graphiti node exists
   - Yes: update attributes, add new edges
   - No: create node, infer initial edges from co-occurrence
4. Run contradiction detection across edges
   - Same entity, conflicting attributes from different agents → flag
   - Same deadline, different dates → flag
   - Same prospect, conflicting status → flag
5. Store contradiction flags as special edge type in Graphiti

**Entity types:**
- `Prospect` (name, status, last_contact, assigned_agent)
- `Project` (name, status, blockers, deadline)
- `Decision` (what, who_decided, when, context)
- `ContentPiece` (title, platform, status, engagement_metrics)
- `TeamMember` (agent_id, current_focus, last_active)
- `PainPoint` (source, category, frequency, content_relevance_score)

### Pass 2: Graphiti → Basic Memory (Wiki Page Generation)

**Trigger:** Immediately after Pass 1 completes

**Process:**
1. Query Graphiti for all entities updated in Pass 1
2. Group by domain: Pipeline, Content, Operations, Research
3. For each domain, generate wiki page from graph traversal:
   - Entity summaries with source attribution
   - Cross-references (which agents touched this entity)
   - Contradiction callouts (from Pass 1 flags)
   - Staleness warnings (entities not updated in 7+ days)
   - Action items surfaced from tension patterns
4. Write to Basic Memory with metadata header:
   ```markdown
   ---
   compiled_from: hive_mind
   compiled_at: 2026-05-06T05:15:00Z
   entries_processed: 47
   contradictions_found: 3
   stale_entities: 5
   ---
   ```

**Generated pages:**

| Page | Content | Update frequency |
|------|---------|-----------------|
| `Pipeline/weekly-brief.md` | All active prospects, status, tensions, next actions | Daily |
| `Pipeline/{prospect}.md` | Per-prospect dossier from all agent inputs | On change |
| `Content/performance.md` | LinkedIn engagement trends, Reddit themes, content gaps | Daily |
| `Content/editorial-calendar.md` | Planned vs published, Melissa's queue | Daily |
| `Operations/team-pulse.md` | Agent activity, blockers, capacity | Daily |
| `Operations/decisions-log.md` | All decisions with context and who made them | On change |
| `Research/themes.md` | Recurring patterns from Annika's research | Weekly |
| `Contradictions/unresolved.md` | Master list of all active tensions | Daily |

### Pass 3: Staleness Audit

**Trigger:** Weekly (Sunday 8pm)

**Process:**
1. Scan all wiki pages for `compiled_at` timestamp
2. Flag any page not regenerated in 7+ days
3. Cross-reference: find Hive Mind entries that updated since last wiki compile
4. Produce staleness report:
   ```markdown
   ## Staleness Report — Week of 2026-05-05
   
   ### Stale Wiki Pages (not compiled in 7+ days)
   - Pipeline/greenwich-ace-plumbing.md — last compiled Apr 28
   
   ### Drift Risk (source updated, wiki not recompiled)
   - 12 Hive Mind entries modified since last Pipeline compile
   - 3 Graphiti edges added since last Operations compile
   ```

## Contradiction Detection Rules

| Pattern | Severity | Action |
|---------|----------|--------|
| Same entity, different status from 2+ agents | HIGH | Surface in prospect page + contradictions page |
| Deadline in Hive Mind vs no calendar entry in Sean's data | MEDIUM | Surface in operations pulse |
| Content published but no engagement data after 48h | LOW | Surface in content performance |
| Agent hasn't written to Hive Mind in 3+ days | INFO | Surface in team pulse |
| Decision recorded but no follow-through actions in 7 days | HIGH | Surface in decisions log |

## Implementation Plan

### Phase 1: Minimal Viable Compile Loop (1-2 days)
- Script that reads Hive Mind → generates Obsidian markdown pages
- Skip Graphiti pass initially (graph adds complexity)
- Manual trigger via CLI: `node dist/compile-cli.js run`
- Generates: pipeline brief, team pulse, contradictions page

### Phase 2: Graphiti Integration (2-3 days)  
- Add Pass 1 (entity extraction → Neo4j)
- Contradiction detection via graph queries
- Per-entity wiki pages generated from graph traversal

### Phase 3: Scheduled + Automated (1 day)
- Cron job at 5am daily
- Staleness audit weekly
- Notification to Jason via Telegram when contradictions found

### Phase 4: Feedback Loop (ongoing)
- Jason browses Obsidian, flags inaccurate synthesis
- Flag goes back to Hive Mind as correction entry
- Next compile cycle picks up correction
- Wiki self-heals from ground truth, never from direct edit

## CLI Interface

```bash
# Run full compilation
node dist/compile-cli.js run

# Run specific pass only
node dist/compile-cli.js run --pass 1    # Hive Mind → Graphiti only
node dist/compile-cli.js run --pass 2    # Graphiti → Wiki only
node dist/compile-cli.js run --pass 3    # Staleness audit only

# Check what changed since last compile
node dist/compile-cli.js diff

# View contradiction summary
node dist/compile-cli.js contradictions

# Force recompile specific domain
node dist/compile-cli.js run --domain pipeline
node dist/compile-cli.js run --domain content
```

## Success Criteria

1. **No wiki page exists without a `compiled_from` header** — proves all synthesis traces to structured data
2. **Contradictions surfaced within 24h of occurring** — proves tension detection works
3. **Jason browses Obsidian and finds cross-agent intelligence he couldn't get from any single agent** — proves compilation adds value beyond aggregation
4. **Stale pages flagged before they mislead** — proves staleness detection works
5. **Zero data loss** — Hive Mind always authoritative, wiki regenerable from scratch

## What This Enables

- Jason opens Obsidian, sees compiled prospect dossiers pulling from Jackson + Annika + James + Sean simultaneously
- Content strategy emerges from Reddit scrape themes + LinkedIn engagement data compiled together
- Team coordination gaps visible without anyone having to report them
- Decision archaeology: trace any conclusion back through wiki → graph → source facts
- Foundation for MELMON's memory lifecycle: compile loop IS the "living memory" mechanism from MELMON spec
