# OpenCoreLead Specification
**Layer 2 ICP/Discovery Tool for Lead Gen Hybrid Stack**

## Overview
OpenCoreLead fills the prospecting gap in The Collective's lead gen stack. It combines Apollo's free tier API (10k contacts/month) with CloakBrowser's stealth LinkedIn scraping to build targeted ICP lists, then passes leads to WaterfallEnricher for 6-layer enrichment before landing in Twenty CRM.

## Architecture

### Stack
- **CloakBrowser**: Stealth Playwright substrate for LinkedIn profile scraping (already forked to cloakbrowser-collective)
- **Apollo API**: Free tier (10k contacts/month) for B2B ICP targeting via firmographics
- **Custom ICP Logic**: Node.js/TypeScript service orchestrating the discovery workflow
- **Output**: CSV export compatible with WaterfallEnricher input format
- **Storage**: Twenty CRM via Jackson's MCP integration

### Data Flow
```
Apollo Filters (SIC/headcount/geo)
  → Apollo API call (10k/mo limit)
    → Extract company + decision-maker names
      → CloakBrowser LinkedIn scrape (profile URLs, titles, bios)
        → Merge Apollo + LinkedIn data
          → CSV export
            → WaterfallEnricher 6-layer cascade
              → Twenty CRM pipeline ingestion
```

## ICP Targeting Logic

### Apollo Filters (Input)
- **Industry**: SIC codes or keywords (e.g., "SaaS", "Fintech", "Legal Tech")
- **Company size**: Headcount range (e.g., 10-200 for Tier 1 targets)
- **Geography**: Country/state/city targeting
- **Revenue band**: Optional (if Apollo provides it on free tier)
- **Job titles**: Decision-maker roles (e.g., "CTO", "VP Engineering", "Founder")

### LinkedIn Enrichment (Scraping)
For each Apollo result:
1. Construct LinkedIn company page URL from company name
2. Extract employee list (limit: top 10 per company to stay under rate limits)
3. Filter by title keywords (engineering, product, founder, C-suite)
4. Scrape profile URLs, current title, headline, location
5. Merge with Apollo firmographics

### Output Schema (CSV)
```csv
company_name,domain,sic_code,headcount,location,revenue,contact_name,contact_title,contact_linkedin,contact_email_apollo,scraped_at
Acme Corp,acme.com,7372,45,"San Francisco, CA",5M,Jane Doe,CTO,linkedin.com/in/janedoe,jane@acme.com,2026-05-27T06:00:00Z
```

## Rate Limits & Quotas

| Service | Limit | Strategy |
|---------|-------|----------|
| Apollo API | 10k contacts/month | Batch requests, cache results daily |
| LinkedIn (CloakBrowser) | ~100 profiles/hour (safe) | Throttle to 1 profile every 30s, rotate user-agents |
| WaterfallEnricher | 1k-1.5k leads/month on $47/mo plan | Queue output, batch process weekly |

## Implementation Plan

### Phase 1: Apollo Integration (Day 1)
- [ ] Set up Apollo API client (free tier key)
- [ ] Build ICP filter interface (CLI or config file)
- [ ] Test search endpoint with sample SIC code query
- [ ] Extract company + contact data from API response
- [ ] Store raw Apollo JSON in `tmp/apollo-cache/` for debugging

### Phase 2: CloakBrowser LinkedIn Scraper (Day 2)
- [ ] Wire CloakBrowser fork into OpenCoreLead repo
- [ ] Build LinkedIn company page scraper (employee list extraction)
- [ ] Build LinkedIn profile scraper (title, headline, URL)
- [ ] Add rate limiting (1 req/30s) and user-agent rotation
- [ ] Test with 5 sample companies from Apollo output

### Phase 3: Data Merge & CSV Export (Day 2-3)
- [ ] Merge Apollo firmographics + LinkedIn profile data
- [ ] Generate CSV in WaterfallEnricher-compatible format
- [ ] Add deduplication logic (domain + contact email)
- [ ] Validate CSV headers match WaterfallEnricher input spec

### Phase 4: WaterfallEnricher Integration (Day 3)
- [ ] Review WaterfallEnricher input format (check fork docs)
- [ ] Build CSV → WaterfallEnricher API integration
- [ ] Test full pipeline: Apollo → LinkedIn → CSV → WaterfallEnricher
- [ ] Verify enriched output lands in expected format

### Phase 5: Twenty CRM Integration (Day 3-4)
- [ ] Map OpenCoreLead output fields to Twenty CRM custom object schema
- [ ] Use Jackson's MCP integration to bulk import leads
- [ ] Add pipeline stage tagging (e.g., "Prospecting", "Enriched", "Qualified")
- [ ] Test end-to-end: Apollo → LinkedIn → WaterfallEnricher → Twenty CRM

### Phase 6: CLI Interface & Automation (Day 4)
- [ ] Build CLI: `opencorelead run --industry "SaaS" --headcount 10-200 --geo "US"`
- [ ] Add dry-run mode for quota checking
- [ ] Add resume-from-checkpoint for interrupted runs
- [ ] Document usage in README

## Success Criteria
1. CLI successfully queries Apollo API with ICP filters and returns company list
2. CloakBrowser scrapes LinkedIn profiles without triggering rate limits or detection
3. CSV export contains merged Apollo + LinkedIn data with all required fields
4. WaterfallEnricher accepts CSV input and returns enriched leads
5. Twenty CRM receives leads via Jackson's MCP with correct field mapping
6. Full pipeline runs end-to-end for 50 test leads without errors
7. Documentation includes setup, usage, and troubleshooting

## Dependencies
- **Already forked**: cloakbrowser-collective, waterfall-enricher-collective, salesgpt-collective, twenty-collective
- **API keys needed**: Apollo API (free tier), LinkedIn session cookies (for CloakBrowser)
- **Infrastructure**: Twenty CRM running (confirmed healthy 4/4 containers as of May 26)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LinkedIn rate limits | Scraper blocked | Throttle to 1 req/30s, rotate proxies if needed |
| Apollo free tier cap | Only 10k contacts/month | Cache results, batch requests, prioritize highest-value ICPs |
| WaterfallEnricher format mismatch | Enrichment fails | Validate CSV schema against fork docs before integration |
| Twenty CRM schema drift | Import fails | Lock custom object schema version, add schema validation step |

## Next Steps (Immediate)
1. Create OpenCoreLead repo at `C:\Users\windows\claudeclaw-os\opencorelead`
2. Initialize Node.js/TypeScript project with Apollo SDK
3. Wire CloakBrowser fork as Git submodule or npm link
4. Build Phase 1 (Apollo integration) and test with sample ICP query
5. Report progress to Jason after Phase 1 completion
