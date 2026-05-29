# UniMatrix CRM -- Technical Specification

**Status:** Draft v1
**Date:** 2026-05-21
**Owner:** Melanie (lead), Jackson (CRM ops)
**Base:** Fork of Twenty CRM (AGPL-3.0)
**Repo:** github.com/twentyhq/twenty (~46K stars, 629 contributors, weekly releases)

---

## 1. Strategic Context

### Why build
- GHL costs $297-1000/mo with no API control for agents
- LeadStack is closed-source ($891+), Firebase-locked, not truly self-hosted
- Need agent-native CRM where all 6 ClaudeClaw agents can read/write programmatically
- Standing rule: OSS first > Fork > Build > Buy

### Why Twenty as base
- AGPL-3.0 (free to fork for internal use)
- TypeScript full-stack (matches ClaudeClaw stack)
- PostgreSQL + Docker (real self-hosting)
- Custom objects at runtime (new entity types via API, auto-generates GraphQL + DB tables)
- GraphQL + REST API on every object (agent-ready from day one)
- Webhooks on create/update/delete for any object
- Active: daily commits, ~weekly releases, 629 contributors
- Workspace isolation already built in

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React + TypeScript | Twenty's SPA |
| Backend | NestJS + TypeScript | Matches ClaudeClaw |
| Database | PostgreSQL 16 | Persistent volume |
| ORM | TypeORM | Custom metadata layer |
| Cache | Redis | noeviction policy |
| Queue | BullMQ | Redis-backed, worker process |
| Search | PostgreSQL FTS | Upgrade to Meilisearch at scale |
| API | GraphQL (primary) + REST | Auto-generated from metadata |
| Monorepo | Nx | packages: front, server, docker, emails |
| Automation | n8n (self-hosted) | Bolted on for complex workflows |
| SMS | Twilio API | Custom module |
| Hosting | Docker Compose | 4 containers: server, worker, db, redis |

### Infrastructure Requirements

| Tier | CPU | RAM | Storage |
|------|-----|-----|---------|
| Minimum (1-5 users) | 2 cores | 2 GB | 10 GB |
| Recommended | 4 cores | 8 GB | 50 GB |
| Idle footprint | -- | ~750 MB | -- |

---

## 3. Feature Matrix

### Phase 1: Core CRM (Weeks 1-3)
Fork Twenty, deploy via Docker, configure for agency use.

| Feature | Twenty Status | Work Required |
|---------|--------------|---------------|
| Contacts CRUD | Built-in | Configure fields for agency model |
| Companies CRUD | Built-in | Map to client accounts |
| Custom fields | Built-in | Define agency-specific fields |
| CSV import | Built-in | None |
| Pipeline/deals | Built-in | Configure stages per LeadStack model |
| Email sync | Built-in (Gmail/Microsoft) | Enable OAuth credentials |
| Calendar sync | Built-in (Google/Microsoft) | Enable OAuth credentials |
| Tasks/notes | Built-in | None |
| Webhooks | Built-in | Wire to ClaudeClaw event bus |
| GraphQL API | Built-in | None -- agents use immediately |
| Workspace isolation | Built-in | Configure per-client workspaces |

**Deliverable:** Running CRM with contacts, pipeline, email, calendar. Jackson migrates off GHL.

### Phase 2: Agent Integration Layer (Weeks 3-5)
Wire ClaudeClaw agents into CRM via API.

| Agent | Integration | Method |
|-------|------------|--------|
| Jackson | Pipeline CRUD, contact updates, deal progression | GraphQL mutations |
| Annika | Prospect data injection, intel attachments | GraphQL + custom objects |
| James | Outreach tracking, reply logging, DM records | Webhooks + mutations |
| Sean | Task creation, calendar sync, deadline tracking | GraphQL + calendar API |
| Melissa | Content performance metrics per contact | Custom object + mutations |
| Melanie | Full read access, delegation triggers | GraphQL queries + webhooks |

**New custom objects to create:**
- `ProspectIntel` -- Annika's research per contact (pain points, competitors, opportunities)
- `OutreachLog` -- James's DM/email/call records with sentiment
- `ContentLink` -- Melissa's content tied to contacts/deals
- `AuditRecord` -- Audit deliverables and outcomes per deal

**Deliverable:** All 6 agents can read/write CRM. Hive mind indexes CRM events.

### Phase 3: Automation Engine (Weeks 5-7)
Bolt n8n onto Twenty for complex workflows.

| Automation | Trigger | Actions |
|-----------|---------|---------|
| Speed-to-Lead | New contact via form/API | SMS welcome (Twilio), email intro (Resend), notify owner (Telegram) |
| Pipeline progression | Deal stage change | Auto-task creation, follow-up scheduling, agent notification |
| Stale deal alert | Deal idle > 7 days | Sean creates follow-up task, James queues outreach |
| Audit delivery | Audit complete | Email PDF, create follow-up deal stage, schedule meeting |
| Review request | Service delivered + 14 days | Auto-email requesting Google review |

**n8n integration:**
- Self-hosted Docker container added to compose stack
- Twenty webhooks trigger n8n workflows
- n8n calls back to Twenty GraphQL for mutations
- Templates stored in repo, version controlled

**Deliverable:** Automated lead response, pipeline management, follow-up chains.

### Phase 4: Forms + SMS (Weeks 7-9)
Build missing modules LeadStack had.

**Forms builder:**
- React component library for form building
- Field types: text, email, phone, dropdown, checkbox, textarea
- Pipeline assignment on submission (contact created + deal opened)
- Auto-tagging by source/form
- HTML embed snippet export (like LeadStack)
- Thank-you message / redirect config
- Stored as custom objects in Twenty

**SMS module:**
- Twilio integration (send/receive)
- SMS templates with variable substitution
- Conversation threading on contact record
- Cost tracking per message
- n8n triggers for automated SMS

**Deliverable:** Form submissions create contacts + deals. SMS send/receive from CRM.

### Phase 5: Agency Multi-Tenant (Weeks 9-11)
Extend Twenty's workspace model for agency use.

| Feature | Implementation |
|---------|---------------|
| Sub-accounts per client | One workspace per client, agency admin across all |
| Client portal | Read-only workspace view for clients |
| White-label | Custom branding per workspace (logo, colors, domain) |
| Collaborator roles | Admin, Manager, Viewer per workspace |
| Billing isolation | Per-workspace usage tracking |

**Deliverable:** Onboard clients into isolated workspaces with their own branding.

### Phase 6: Website Builder (Weeks 11-14)
Lowest priority. Can use external tools initially.

| Option | Approach |
|--------|----------|
| MVP | GitPage integration (like LeadStack) -- template-based, AI-generated |
| V2 | Embedded page builder (fork GrapesJS, MIT license) |
| Forms integration | Website forms submit to Phase 4 forms API |

**Deliverable:** Client websites with integrated CRM forms.

---

## 4. Architecture Diagram

```
                    +------------------+
                    |   Telegram Bot   |
                    |  (ClaudeClaw OS) |
                    +--------+---------+
                             |
                    +--------v---------+
                    |    Melanie       |
                    |  (Router/Lead)   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
    +---------v--+  +--------v---+  +-------v----+
    | Jackson    |  | Annika     |  | James      |
    | (Pipeline) |  | (Research) |  | (Outreach) |
    +-----+------+  +-----+------+  +-----+------+
          |                |               |
          +--------+-------+-------+-------+
                   |               |
          +--------v--------+  +---v---+
          |  Twenty CRM     |  |  n8n  |
          |  (GraphQL API)  |  | (Auto)|
          +--------+--------+  +---+---+
                   |               |
          +--------v--------+     |
          |  PostgreSQL 16  |<----+
          +-----------------+
          |  Redis          |
          +-----------------+
```

---

## 5. AGPL-3.0 Compliance

**What AGPL requires:**
- Any modifications to Twenty source served to users over network must be open-sourced
- Internal-only use has no disclosure requirement
- Custom modules that don't modify Twenty core can remain proprietary if kept as separate services

**Our strategy:**
- Keep Twenty core modifications minimal (upstream-compatible where possible)
- Build custom modules (forms, SMS, agent layer) as separate NestJS services that communicate via API
- This keeps proprietary business logic in separate repos, not subject to AGPL copyleft
- If we modify Twenty core, those changes get contributed back (good community standing)

---

## 6. Migration Plan (GHL to UniMatrix)

| Step | Action | Owner | Timeline |
|------|--------|-------|----------|
| 1 | Export GHL contacts as CSV | Jackson | Day 1 |
| 2 | Export GHL pipeline/deals | Jackson | Day 1 |
| 3 | Deploy Twenty via Docker | Melanie | Day 1-2 |
| 4 | Import contacts + deals via CSV/API | Jackson + Melanie | Day 2-3 |
| 5 | Configure pipelines to match current stages | Jackson | Day 3 |
| 6 | Wire agent API integrations | Melanie | Week 1-2 |
| 7 | Run parallel (GHL + UniMatrix) for 2 weeks | All agents | Week 2-4 |
| 8 | Cut over, cancel GHL | Jason | Week 4 |

---

## 7. Integration Targets

| System | Integration Method | Priority |
|--------|-------------------|----------|
| ClaudeClaw agents | GraphQL API + webhooks | P0 |
| Hive mind (memory) | Webhook events indexed | P0 |
| Stripe | Payment tracking on deals | P1 |
| DemoDrop/DD4 | Pipeline stage sync | P1 |
| TurboMock | Mockup delivery tracking | P2 |
| Phone validator | Contact enrichment on create | P1 |
| FreeScout | Support ticket linking | P2 |
| DeepSec | Security scan results per client | P3 |

---

## 8. Success Criteria

| Metric | Target |
|--------|--------|
| GHL subscription | Cancelled by Week 4 |
| Agent API coverage | All 6 agents can CRUD contacts + deals |
| Automation response time | Speed-to-Lead < 60 seconds |
| Uptime | 99.5% (Docker + auto-restart) |
| Data migration | Zero contact/deal loss from GHL |
| Monthly cost | < $5 (hosting + Twilio SMS) vs $297-1000 GHL |

---

## 9. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Twenty breaking changes (rapid release) | API disruption | Pin to specific release, test before upgrading |
| AGPL copyleft scope creep | Legal exposure | Keep custom modules as separate services |
| n8n complexity | Automation reliability | Start with simple workflows, expand gradually |
| Twilio SMS costs | Budget | Per-message tracking, daily cap alerts |
| Twenty permissions are flat | Security gap | Build RBAC as custom middleware (Phase 5) |
| PostgreSQL FTS limits at scale | Slow search | Meilisearch migration path documented |

---

## 10. Open Questions

1. **DD4 API stability** -- pipeline stage auto-advance broken on v14 (per Dar community scan). Wait for fix or build adapter?
2. **Phone validator timeline** -- build before or after CRM? Affects contact enrichment in Phase 2.
3. **Client count projection** -- how many sub-accounts needed in 90 days? Sizes Phase 5 urgency.
4. **GHL data format** -- need sample export to map fields before migration.

---

## Appendix A: LeadStack Feature Reference

Features observed from demo transcript (used as target feature set):

- Multi-tenant sub-accounts with client isolation
- Contact management with CSV import and source tracking
- Deal pipeline with filters and geo-map
- Activity timeline per contact/deal
- Automation templates (welcome SMS, email, owner notify)
- Form builder with pipeline stage assignment
- Auto-tagging by source
- Website builder (GitPage-based, niche templates)
- HTML form embed snippets
- White-label branding per sub-account
- 40% affiliate commission program
- Email and SMS sending built-in
- Calendar and task management
