import { describe, it, expect } from 'vitest';
import { STANDARD_RULES, AGENT_THREAT_RULES, ALL_RULES } from './rules.js';
import { scanFile } from './scanner.js';

describe('rule definitions', () => {
  it('has unique rule IDs', () => {
    const ids = ALL_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has 10 standard rules', () => {
    expect(STANDARD_RULES).toHaveLength(10);
  });

  it('has 10 agent threat rules', () => {
    expect(AGENT_THREAT_RULES).toHaveLength(10);
  });

  it('standard rules are not agent threats', () => {
    for (const r of STANDARD_RULES) {
      expect(r.agentThreat).toBe(false);
    }
  });

  it('agent rules are agent threats', () => {
    for (const r of AGENT_THREAT_RULES) {
      expect(r.agentThreat).toBe(true);
    }
  });

  it('all rules have required fields', () => {
    for (const r of ALL_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.name).toBeTruthy();
      expect(r.pattern).toBeInstanceOf(RegExp);
      expect(r.description).toBeTruthy();
      expect(r.remediation).toBeTruthy();
    }
  });

  it('standard rule IDs start with DS-', () => {
    for (const r of STANDARD_RULES) {
      expect(r.id).toMatch(/^DS-\d{3}$/);
    }
  });

  it('agent rule IDs start with DA-', () => {
    for (const r of AGENT_THREAT_RULES) {
      expect(r.id).toMatch(/^DA-\d{3}$/);
    }
  });
});

describe('rule pattern matching', () => {
  it('DS-001 catches hardcoded API key', () => {
    const content = 'const api_key = "sk-abc123defgh456";';
    const findings = scanFile('/t/f.ts', content, [STANDARD_RULES[0]], '/t');
    expect(findings).toHaveLength(1);
  });

  it('DS-001 ignores env var usage', () => {
    const content = 'const apiKey = process.env.API_KEY;';
    const findings = scanFile('/t/f.ts', content, [STANDARD_RULES[0]], '/t');
    expect(findings).toHaveLength(0);
  });

  it('DS-004 catches eval', () => {
    const rule = STANDARD_RULES.find(r => r.id === 'DS-004')!;
    const content = 'const result = eval(userInput);';
    const findings = scanFile('/t/f.ts', content, [rule], '/t');
    expect(findings).toHaveLength(1);
  });

  it('DS-010 catches disabled TLS', () => {
    const rule = STANDARD_RULES.find(r => r.id === 'DS-010')!;
    const content = '{ rejectUnauthorized: false }';
    const findings = scanFile('/t/f.ts', content, [rule], '/t');
    expect(findings).toHaveLength(1);
  });

  it('DA-006 catches agent ID from input', () => {
    const rule = AGENT_THREAT_RULES.find(r => r.id === 'DA-006')!;
    const content = 'const agentId = req.body.agentId;';
    const findings = scanFile('/t/f.ts', content, [rule], '/t');
    expect(findings).toHaveLength(1);
  });

  it('DA-003 catches prompt injection surface', () => {
    const rule = AGENT_THREAT_RULES.find(r => r.id === 'DA-003')!;
    const content = 'systemPrompt += userInput;';
    const findings = scanFile('/t/f.ts', content, [rule], '/t');
    expect(findings).toHaveLength(1);
  });
});
