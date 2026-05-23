# Collective-Goal Incorporation Plan

Status: APPROVED by Jason (May 23, 2026)
Fork: forks/collective-goal/ (from jthack/claude-goal)
Tests: 35/35 passing (20 core + 15 RecursiveMAS layer tests)

---

## Phase 1: Install to Melanie (Day 1)

**What:** Deploy collective-goal skill to Melanie's Claude Code instance.

Steps:
1. Run `install.ps1` from PowerShell on Jason's Windows machine
   - Creates junction: `~/.claude/skills/goal` -> `forks/collective-goal/goal`
   - Injects Stop hook into `~/.claude/settings.json`
   - Creates state dir: `~/.claude/goal/`
2. Verify `/goal` appears in Melanie's `/help` output
3. Test cycle: `/goal test installation` -> `/goal pause` -> `/goal resume` -> `/goal clear`
4. Verify Stop hook blocks correctly (set goal, let Claude try to stop, confirm block)
5. Verify Hive Mind logging: `node dist/hive-cli.js read` shows goal-set event

**Validation gate:** Melanie can set, pause, resume, delegate, block, complete, and clear goals. Hive logs visible.

---

## Phase 2: Deploy to All 6 Agents (Day 2-3)

**What:** Each agent gets the skill via their own Claude Code instance.

Per-agent deployment:
1. Run `install.ps1` in each agent's Claude Code working directory
2. Each agent's CLAUDE.md gets a `/goal` reference in their skill table
3. Agent-specific defaults configured via env vars:
   - `CLAUDE_GOAL_SESSION_ID` set per agent terminal
   - Shared `CLAUDE_GOAL_DB` path so Melanie sees all goals via `/goal team`

Agent CLAUDE.md additions (append to each agent's skill table):

| Agent | Addition to CLAUDE.md |
|-------|----------------------|
| Melanie | `goal` skill already documented. Add: "Use `/goal team` to monitor all agent goals." |
| James | Add `goal` to skill table. Default: `--agent james` on all goals. |
| Annika | Add `goal` to skill table. Default: `--agent annika` on all goals. |
| Sean | Add `goal` to skill table. Default: `--agent sean` on all goals. |
| Melissa | Add `goal` to skill table. Default: `--agent melissa` on all goals. |
| Jackson | Add `goal` to skill table. Default: `--agent jackson` on all goals. |

**Shared vs isolated DB decision:**
- RECOMMENDED: Single shared DB (`~/.claude/goal/goals.sqlite`) so `/goal team` works cross-agent
- Session isolation already prevents cross-leak (tested, 20/20)
- Each agent only sees own goals via session ID; Melanie sees all via `/goal team`

**Validation gate:** Each agent can set goals with `--agent` flag. `/goal team` from Melanie shows all active goals.

---

## Phase 3: Wire into Existing Workflows (Day 4-7)

### 3a. LinkedIn Content Pipeline
When Melissa starts daily content production:
```
/goal --agent melissa --priority high Produce today's LinkedIn post: research, draft, graphic, review chain
```
Sub-goals auto-created for each stage:
```
/goal --parent <id> --agent annika Research trending AI topics for today's post
/goal --parent <id> --agent james Final copy review and brand voice check
```

### 3b. Client Audit Delivery
When Sean schedules audit:
```
/goal --agent sean --priority critical Deliver [Client] audit by [date]
/goal --parent <id> --agent annika Deep research on [Client] tech stack
/goal --parent <id> --agent jackson Update CRM with audit status
```

### 3c. Outreach Sequences
When James runs engagement:
```
/goal --agent james LinkedIn engagement run: 15 comments, 5 DMs, 3 connection requests
```

### 3d. Melanie Orchestration Goals
For cross-team initiatives:
```
/goal --priority critical --agent melanie Deploy CRM Phase 1: containers up, Jackson adapter wired, pipeline flowing
```

**Validation gate:** At least 2 real workflows run through goal system with completion audit passing (including humanization check).

---

## Integration Points (already built, need wiring)

### RecursiveMAS 6-Layer Integration (built)
- Goals attach to any combination of L1-L6 via `--layer L1,L4,L6`
- Layer context stored as JSON in DB (no schema changes per layer)
- Completion signals fan out to L4 (Hermes cross-agent correlation), L5 (Ax playbook training), L6 (BorgQueen cluster coordination)
- Hermes trace linking via `/goal traces <trace-id>` for AxACE playbook learning
- Borg Queen credit scoring via `/goal credit +/-delta`
- Complexity-aware round budgets: linear=3, moderate=4, complex=8
- Layer events emitted as JSONL to `~/.claude/goal/layer_events/` in Hermes-compatible format
- Graceful degradation: all layer operations wrapped in try/except, never block goal ops
- Wiring: once RecursiveMAS layers go live, layer event consumers read from JSONL dir
- All constants match TypeScript source: 768-dim latent, 0.02 convergence, segment ranges from latent-bridge.ts

### Hive Mind (built)
- All goal events auto-log to hive via `node dist/hive-cli.js log`
- Cross-agent visibility without manual logging
- Wiring: set `CLAUDECLAW_PROJECT_ROOT` env var in each agent's terminal

### Humanization Enforcement (built)
- Completion audit blocks completion if em dashes, AI cliches, or brand voice violations found
- `/goal check <text>` available as standalone verification
- 25+ pattern matchers for common AI writing tells

### Priority System (built)
- `critical` and `high` goals get extra emphasis in Stop hook reason
- Priority visible in `/goal team` overview
- Future: priority-based ordering in Melanie's daily brief

### Delegation (built)
- `/goal delegate <agent>` changes status to `delegated`, records target
- Hive log broadcasts delegation for target agent pickup
- Future: auto-create matching goal in target agent's session

---

## Future Enhancements (post-incorporation)

### Near-term (Week 2-3)
1. **Auto-agent detection:** Read agent identity from CLAUDE.md, auto-set `--agent` flag
2. **Goal templates:** Pre-defined goal structures for recurring workflows (daily content, audit delivery, engagement runs)
3. **Completion webhooks:** Notify Telegram on goal complete/block/delegate
4. **Analytics dashboard:** Weekly goal velocity, completion rates, time-per-goal by agent
5. **Layer event consumers:** Build readers that consume `layer_events/*.jsonl` and feed into live RecursiveMAS layers

### Medium-term (Month 2)
6. **Hermes parity tracking:** Standing directive to monitor Hermes Agent releases, analyze new features, replicate into collective-goal
7. **Cross-session goal persistence:** Goal survives `/newchat` via SQLite (partially built; needs session-id continuity solution)
8. **Goal dependencies:** Block goal B until goal A completes
9. **Budget intelligence:** Learn typical token usage per goal type, suggest budgets
10. **Latent vector integration:** When layers go live, emit actual 768-dim latent vectors alongside JSONL events for direct convergence tracking

### Long-term (Month 3+)
9. **Goal-driven scheduling:** Sean auto-creates cron tasks from goal deadlines
10. **Performance scoring:** Track goal completion quality (humanization pass rate, time accuracy, delegation efficiency)
11. **Client-facing goals:** Goals tied to client projects, visible in CRM

---

## Risk Register

| Risk | Mitigation |
|------|-----------|
| Stop hook blocks agent when user wants manual control | `/goal pause` and `/goal clear` always available. Runaway guard at 500 continuations. |
| Shared DB contention with 6 agents | SQLite WAL mode handles concurrent reads. Writes are infrequent (goal state changes only). |
| Goal objective used as prompt injection vector | Objective wrapped in `<objective>` tags, treated as task context not instructions. Explicit in SKILL.md. |
| Windows path issues | Tested on Windows. PowerShell installer uses junctions. ASCII-safe output (no Unicode icons). |
| Hive CLI unavailable | Graceful degradation: hive_log() catches all exceptions, never blocks goal operations. |
| Layer event dir missing/unwritable | emit_layer_event() catches OSError, logs warning, never blocks goal ops. |
| RecursiveMAS layers not yet live | All layer hooks are no-ops until consumers exist. JSONL files accumulate safely. Zero runtime cost when layers inactive. |

---

## Execution Authorization

Jason approves this plan. Melanie to execute Phase 1 immediately upon directive.

Phase 1 command:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\windows\claudeclaw-os\forks\collective-goal\install.ps1"
```
