import { describe, it, expect } from 'vitest';
import { scanFile, scanDirectory } from './scanner.js';
import type { Rule } from './scanner.js';

const testRule: Rule = {
  id: 'TEST-001',
  name: 'Hardcoded secret',
  category: 'data-exposure',
  severity: 'critical',
  pattern: /(?:password|secret|api_key)\s*=\s*['"][^'"]+['"]/i,
  description: 'Hardcoded secret detected',
  remediation: 'Use environment variables',
  agentThreat: false,
};

const agentRule: Rule = {
  id: 'TEST-002',
  name: 'Agent impersonation',
  category: 'agent-hijack',
  severity: 'critical',
  pattern: /agentId\s*=\s*req\./,
  description: 'Agent ID from external input',
  remediation: 'Derive from session',
  agentThreat: true,
};

describe('scanFile', () => {
  it('finds hardcoded secret', () => {
    const content = 'const password = "hunter2";\nconst x = 1;';
    const findings = scanFile('/test/file.ts', content, [testRule], '/test');
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('TEST-001');
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].filePath).toBe('file.ts');
  });

  it('returns empty for clean file', () => {
    const content = 'const x = process.env.PASSWORD;';
    const findings = scanFile('/test/file.ts', content, [testRule], '/test');
    expect(findings).toHaveLength(0);
  });

  it('reports correct match text', () => {
    const content = 'const secret = "abc12345678";\n';
    const findings = scanFile('/test/file.ts', content, [testRule], '/test');
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toContain('secret');
  });

  it('applies multiple rules', () => {
    const content = 'const password = "hunter2";\nconst agentId = req.body.id;';
    const findings = scanFile('/test/file.ts', content, [testRule, agentRule], '/test');
    expect(findings).toHaveLength(2);
    expect(findings[0].agentThreat).toBe(false);
    expect(findings[1].agentThreat).toBe(true);
  });

  it('respects file filter', () => {
    const filteredRule: Rule = {
      ...testRule,
      id: 'TEST-003',
      fileFilter: '*.json',
    };
    const content = 'const password = "hunter2";';
    const findings = scanFile('/test/file.ts', content, [filteredRule], '/test');
    expect(findings).toHaveLength(0); // .ts file, rule wants .json
  });

  it('handles empty content', () => {
    const findings = scanFile('/test/file.ts', '', [testRule], '/test');
    expect(findings).toHaveLength(0);
  });

  it('normalizes windows paths in findings', () => {
    const content = 'const password = "hunter2";';
    const findings = scanFile('C:\\project\\src\\file.ts', content, [testRule], 'C:\\project');
    expect(findings[0].filePath).toBe('src/file.ts');
  });
});
