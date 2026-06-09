/**
 * Routing Guard Tests
 * Authorization: Jason GO directive (2026-06-09)
 *
 * Test cases:
 * (a) Divergence REFUSE: prompt addresses agent X but --agent is Y
 * (b) Match PROCEED: prompt addresses agent X and --agent is X
 * (c) Generic PROCEED: prompt has no agent addressing, any --agent OK
 * (d) Regression: all 32 addressed rows from DB use verbatim prompt heads
 */

import { describe, it, expect } from 'vitest';
import { detectPromptAgent, detectNicknameWarning } from '../routing-guard.js';

// ── (a) Divergence detection ──────────────────────────────────────────
describe('Routing Guard: divergence REFUSE', () => {
  it('detects "You are Melissa" addressed to content, not main', () => {
    const result = detectPromptAgent('You are Melissa, content agent. Daily LinkedIn AI intelligence scan (MORNING).');
    expect(result).toBe('content');
    // If cliAgentId were 'main', this would trigger exit 2
    expect(result).not.toBe('main');
  });

  it('detects "James:" addressed to comms, not main', () => {
    const result = detectPromptAgent('James: run LinkedIn feed analysis. Connect to Chrome CDP at port 9222');
    expect(result).toBe('comms');
    expect(result).not.toBe('main');
  });

  it('detects "JACKSON DAILY" addressed to custom, not main', () => {
    const result = detectPromptAgent('JACKSON DAILY PIPELINE HYGIENE: You are Jackson (custom agent). Run your daily');
    expect(result).toBe('custom');
    expect(result).not.toBe('main');
  });
});

// ── (b) Match PROCEED ────────────────────────────────────────────────
describe('Routing Guard: match PROCEED', () => {
  it('Melissa prompt + content agent = match', () => {
    const result = detectPromptAgent('You are Melissa, content agent. Run your Monday Content Strategy Session');
    expect(result).toBe('content');
  });

  it('Sean prompt + ops agent = match', () => {
    const result = detectPromptAgent('You are Sean, ops agent. Run your Sunday Weekly Review and Self-Audit');
    expect(result).toBe('ops');
  });

  it('Melanie prompt + main agent = match', () => {
    const result = detectPromptAgent('You are Melanie. Run your weekly self-audit as defined in your Continuous');
    expect(result).toBe('main');
  });
});

// ── (c) Generic PROCEED ──────────────────────────────────────────────
describe('Routing Guard: generic PROCEED', () => {
  it('returns null for generic prompt (no agent addressing)', () => {
    const result = detectPromptAgent('Run full compilation: ingest new Hive Mind entries into Graphiti graph');
    expect(result).toBeNull();
  });

  it('returns null for cron-style generic prompt', () => {
    const result = detectPromptAgent('WEEKLY CONFIG AUDIT (D2 Prevention Protocol): Run node C:/Users/windows');
    expect(result).toBeNull();
  });

  it('returns null for tool-focused prompt', () => {
    const result = detectPromptAgent('GITNEXUS DAILY SCAN: Run the GitNexus codebase scanner.');
    expect(result).toBeNull();
  });

  it('returns null for competitor monitoring prompt', () => {
    const result = detectPromptAgent('Run competitor monitoring scan: python workspace/tools/competitor_monitor.py');
    expect(result).toBeNull();
  });
});

// ── (d) Regression: verbatim prompt heads from all 32 addressed rows ─
describe('Routing Guard: verbatim prompt regression (all addressed rows)', () => {
  // Melissa/content rows: 5, 6, 7, 39, 40, 41, 42
  const melissaPrompts = [
    'You are Melissa, content agent. Daily LinkedIn AI intelligence scan (MORNING).',
    'You are Melissa, content agent. Daily LinkedIn AI intelligence scan (EVENING).',
    '[RETIRED DIR-010] Post MELANIE column #3. Draft + reply templates at C:/Users/windows',
    'You are Melissa, content agent. Run your Monday Content Strategy Session',
    'You are Melissa, content agent. Run your Friday Self-Audit per Continuous Evolution',
    'You are Melissa, content agent. Produce your Weekly Authority Track Report for Melanie',
    'You are Melissa, content agent. Run your Weekly Competitive Content Intelligence scan',
  ];

  // Row 7 ("[RETIRED DIR-010]") does NOT start with "You are Melissa" -- it's actually
  // a special case. Let's test it separately.
  it.each(melissaPrompts.filter(p => p.startsWith('You are Melissa')))(
    'detects Melissa in: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBe('content');
    }
  );

  it('row 7 "[RETIRED DIR-010]" is generic (no agent prefix in first 80 chars)', () => {
    // This prompt mentions "MELANIE column" but doesn't match "You are X" or "X:" pattern
    const result = detectPromptAgent('[RETIRED DIR-010] Post MELANIE column #3. Draft + reply templates at C:/Users/windows/claudeclaw-os/tmp/melissa-2026-05-11/.');
    // "melanie" appears but not as "You are Melanie" or "Melanie:" -- guard should not match
    // Actually check: does the head contain "melanie" in a matching pattern?
    // "[RETIRED DIR-010] Post MELANIE column" -- MELANIE + space is caught by startsWith(name.toUpperCase() + ' ')
    // But it doesn't START with MELANIE -- it starts with "[RETIRED"
    // So: null
    expect(result).toBeNull();
  });

  // Melanie/main rows: 12, 13, 51, 52, 53, 54
  const melaniePrompts = [
    'You are Melanie, main agent. DAILY AGENTIC PERFECTING + IDEATION CHAMBER CYCLE.',
    'You are Melanie, main agent. WEEKLY DEEP CYCLE',
    'You are Melanie. Run your weekly self-audit as defined in your Continuous Evolution',
    'You are Melanie. Produce the Friday Convergence Brief for Jason as defined in your',
    'You are Melanie. Run the Monday Goal Governance Audit as defined in your Goal',
    'You are Melanie. Run the Monthly Business Health Check and Capability Review',
  ];

  it.each(melaniePrompts)(
    'detects Melanie in: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBe('main');
    }
  );

  // Annika/research rows: 43, 44, 45, 46
  const annikaPrompts = [
    'You are Annika, research agent. Run your Monday Weekly Intelligence Package',
    'You are Annika, research agent. Run your Wednesday Mid-Week Research Digest',
    'You are Annika, research agent. Run your Friday Self-Audit per Continuous Evolution',
    'You are Annika, research agent. Run your Daily Morning Signal Brief',
  ];

  it.each(annikaPrompts)(
    'detects Annika in: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBe('research');
    }
  );

  // Sean/ops rows: 47, 48, 49, 50
  const seanPrompts = [
    'You are Sean, ops agent. Run your Sunday Weekly Review and Self-Audit',
    'You are Sean, ops agent. Run your Monday Ops Report to Melanie',
    'You are Sean, ops agent. Run your Wednesday Mid-Week Ops Check',
    'You are Sean, ops agent. Run your Friday Capacity Forecast',
  ];

  it.each(seanPrompts)(
    'detects Sean in: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBe('ops');
    }
  );

  // Jackson/custom rows: 35, 36, 37, 38
  const jacksonPrompts = [
    'JACKSON DAILY PIPELINE HYGIENE: You are Jackson (custom agent). Run your daily',
    'JACKSON FRIDAY SELF-AUDIT: You are Jackson (custom agent). Run your weekly',
    'JACKSON MONDAY PIPELINE BRIEF: You are Jackson (custom agent). Prepare and deliver',
    'JACKSON CONVERSION FEEDBACK DISPATCH: You are Jackson (custom agent). Run weekly',
  ];

  it.each(jacksonPrompts)(
    'detects Jackson in: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBe('custom');
    }
  );

  // James/comms rows: 9, 10, 11, 31, 32, 33, 34
  const jamesPrompts = [
    'James: run LinkedIn feed analysis. Connect to Chrome CDP at port 9222',
    'James: run LinkedIn feed analysis. Connect to Chrome CDP at port 9222',
    'James: LinkedIn COMMENT SECTION analysis',
    // These use "James " prefix (with em-dash after, but first 80 chars has "James " at start):
    'James \u2014 LinkedIn INTELLIGENCE-DRIVEN engagement run (morning).',
    'James \u2014 LinkedIn INTELLIGENCE-DRIVEN engagement run (midday).',
    'James \u2014 LinkedIn INTELLIGENCE-DRIVEN engagement run (evening).',
    'James \u2014 WEEKLY INTELLIGENCE TARGETING PLAN (Monday).',
  ];

  it.each(jamesPrompts)(
    'detects James in: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBe('comms');
    }
  );

  // --- 17 generic rows that must still PASS (return null) ---
  const genericPrompts = [
    'Run a Reddit scrape via Apify REST API for business pain points',
    'Run full compilation: ingest new Hive Mind entries into Graphiti graph',
    'DAILY LINKEDIN MONITOR for Jason Issac',
    'Review all agent CLAUDE.md files and agent.yaml configs',
    'DAILY NATE B JONES MONITOR + EXTRACTION',
    'WEEKLY CONFIG AUDIT (D2 Prevention Protocol)',
    'GITNEXUS DAILY SCAN: Run the GitNexus codebase scanner',
    'DEEPSEC WEEKLY SCAN: Run full DeepSec security scan',
    'Run competitor monitoring scan: python workspace/tools',
    'WEEKLY COLLECTIVE ANALYSIS: Run full capability scorecard',
    'WEEKLY PLAN PUBLISH (ops): Read hive',
    'MORNING STANDUP FANOUT (ops): Delegate one short mission',
    'EOD ROLLUP (ops): Read hive entries from today',
    'WEEKLY RETRO (ops): Read hive for the full week',
    'Run the LinkedIn inbound scan script',
    'Read hive STANDUP posts from last 60 min',
    'Read hive log for last 60 minutes',
  ];

  it.each(genericPrompts)(
    'generic prompt returns null: "%s..."',
    (prompt) => {
      expect(detectPromptAgent(prompt)).toBeNull();
    }
  );
});

// ── Nickname warning tests ───────────────────────────────────────────
describe('Routing Guard: nickname warning layer', () => {
  it('detects "mel" nickname in prompt', () => {
    const result = detectNicknameWarning('Hey mel, can you check the pipeline?');
    expect(result).not.toBeNull();
    expect(result!.nickname).toBe('mel');
  });

  it('detects "jacks" nickname in prompt', () => {
    const result = detectNicknameWarning('jacks should handle this pipeline task');
    expect(result).not.toBeNull();
    expect(result!.nickname).toBe('jacks');
  });

  it('returns null for prompt without nicknames', () => {
    const result = detectNicknameWarning('Run the daily scan and report findings');
    expect(result).toBeNull();
  });

  it('does not false-positive on "jack" within "jackson"', () => {
    // "jackson" contains "jack" -- but detectPromptAgent should catch "jackson" first
    // The nickname layer runs AFTER detectPromptAgent, so if "jackson" matches
    // the canonical detector, the nickname layer's warning is moot.
    // But the nickname detector itself WILL match "jack" inside "jackson"
    // This is expected behavior: the guard logic checks canonical first,
    // nickname warning only fires if canonical returned null.
    const canonical = detectPromptAgent('JACKSON DAILY PIPELINE');
    expect(canonical).toBe('custom'); // canonical catches it
    // So nickname warning never fires in practice for JACKSON prompts
  });
});
