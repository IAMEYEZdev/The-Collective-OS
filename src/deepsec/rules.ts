/**
 * DeepSec Rule Definitions
 *
 * Two categories:
 * - Standard SAST (OWASP Top 10 web): injection, auth, data exposure, etc.
 * - Agent Threats (OWASP Agentic Top 10 2026): tool misuse, prompt injection,
 *   privilege abuse, agent hijacking, unbounded consumption
 *
 * Priority 1 rules included: all agent-threat rules are Priority 1 (highest
 * priority for agentic system security).
 */

import type { Rule } from './scanner.js';

// ── Standard SAST Rules ────────────────────────────────────────────

export const STANDARD_RULES: Rule[] = [
  {
    id: 'DS-001',
    name: 'Hardcoded secret or API key',
    category: 'data-exposure',
    severity: 'critical',
    pattern: /(?:api[_-]?key|secret[_-]?key|password|token|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-\.]{8,}['"]/i,
    description: 'Hardcoded credential found. May be committed to version control.',
    remediation: 'Move to environment variable or secrets manager. Never commit credentials.',
    agentThreat: false,
  },
  {
    id: 'DS-002',
    name: 'SQL injection vector',
    category: 'injection',
    severity: 'high',
    pattern: /(?:query|exec|run|prepare)\s*\(\s*`[^`]*\$\{/,
    description: 'Template literal used in SQL query. Potential SQL injection.',
    remediation: 'Use parameterized queries ($1, $2) instead of template interpolation.',
    agentThreat: false,
  },
  {
    id: 'DS-003',
    name: 'Command injection vector',
    category: 'injection',
    severity: 'critical',
    pattern: /(?:exec|execSync|spawn|execFile)\s*\(\s*(?:`[^`]*\$\{|[^,]+\+)/,
    description: 'User-controlled input in shell command. Command injection risk.',
    remediation: 'Use execFile with argument array. Never interpolate user input into commands.',
    agentThreat: false,
  },
  {
    id: 'DS-004',
    name: 'Eval usage',
    category: 'injection',
    severity: 'high',
    pattern: /\beval\s*\(/,
    description: 'eval() executes arbitrary code. Major injection vector.',
    remediation: 'Remove eval. Use JSON.parse for data, Function constructor only if absolutely required.',
    agentThreat: false,
  },
  {
    id: 'DS-005',
    name: 'Insecure HTTP URL',
    category: 'config',
    severity: 'medium',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    description: 'Non-localhost HTTP URL. Data transmitted in plaintext.',
    remediation: 'Use HTTPS for all external URLs.',
    agentThreat: false,
  },
  {
    id: 'DS-006',
    name: 'Debug/console.log in production code',
    category: 'config',
    severity: 'low',
    pattern: /console\.(log|debug|trace)\s*\(/,
    description: 'Console output may leak sensitive data in production.',
    remediation: 'Use structured logger (pino). Remove console.log from production paths.',
    agentThreat: false,
  },
  {
    id: 'DS-007',
    name: 'Weak random generation',
    category: 'crypto',
    severity: 'medium',
    pattern: /Math\.random\s*\(\)/,
    description: 'Math.random() is not cryptographically secure.',
    remediation: 'Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.',
    agentThreat: false,
  },
  {
    id: 'DS-008',
    name: 'Path traversal risk',
    category: 'injection',
    severity: 'high',
    pattern: /(?:readFile|writeFile|createReadStream|createWriteStream)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/,
    description: 'User input used in file path. Path traversal risk.',
    remediation: 'Validate and sanitize paths. Use path.resolve() + startsWith() check.',
    agentThreat: false,
  },
  {
    id: 'DS-009',
    name: 'Missing error handling on async',
    category: 'config',
    severity: 'low',
    pattern: /\.then\s*\([^)]+\)\s*(?!\.catch)/,
    description: 'Promise .then() without .catch(). Unhandled rejection risk.',
    remediation: 'Add .catch() or use async/await with try/catch.',
    agentThreat: false,
  },
  {
    id: 'DS-010',
    name: 'Disabled TLS verification',
    category: 'crypto',
    severity: 'critical',
    pattern: /rejectUnauthorized\s*:\s*false/,
    description: 'TLS certificate verification disabled. MITM attack vector.',
    remediation: 'Enable TLS verification. Fix underlying certificate issues instead.',
    agentThreat: false,
  },
];

// ── Agent Threat Rules (OWASP Agentic Top 10 2026) — PRIORITY 1 ──

export const AGENT_THREAT_RULES: Rule[] = [
  {
    id: 'DA-001',
    name: 'Unbounded tool execution',
    category: 'agent-hijack',
    severity: 'critical',
    pattern: /(?:while\s*\(true\)|for\s*\(\s*;\s*;\s*\)).*(?:exec|spawn|run|tool|invoke)/s,
    description: 'Infinite loop with tool execution. Agent could run unbounded operations.',
    remediation: 'Add MAX_LOOPS constant. Implement loop counter with hard exit.',
    agentThreat: true,
  },
  {
    id: 'DA-002',
    name: 'Missing tool execution timeout',
    category: 'agent-hijack',
    severity: 'high',
    pattern: /(?:exec|execSync|spawn)\s*\([^)]*\)\s*(?!.*timeout)/,
    description: 'Shell execution without timeout. Agent tool call could hang indefinitely.',
    remediation: 'Add timeout option to all exec/spawn calls. Default 120s max.',
    agentThreat: true,
  },
  {
    id: 'DA-003',
    name: 'Prompt injection surface',
    category: 'injection',
    severity: 'critical',
    pattern: /(?:systemPrompt|system_prompt|messages)\s*[+=].*(?:user|input|message|content)/,
    description: 'User-controlled content concatenated into system prompt or message array.',
    remediation: 'Separate system prompts from user content. Never concatenate user input into system messages.',
    agentThreat: true,
  },
  {
    id: 'DA-004',
    name: 'Agent delegation without auth check',
    category: 'privilege-abuse',
    severity: 'high',
    pattern: /(?:delegate|dispatch|createTask|runAgent)\s*\([^)]*\)(?!.*(?:auth|permission|allowed|check))/,
    description: 'Agent delegates task without verifying caller permissions.',
    remediation: 'Verify caller identity and permissions before delegation. Implement RBAC for agent-to-agent calls.',
    agentThreat: true,
  },
  {
    id: 'DA-005',
    name: 'Unrestricted file system access in agent tool',
    category: 'privilege-abuse',
    severity: 'high',
    pattern: /(?:readFile|writeFile|unlink|rmdir)\s*\([^)]*(?:toolInput|toolArgs|params)\[/,
    description: 'Agent tool accesses filesystem using unchecked tool input.',
    remediation: 'Allowlist permitted directories. Validate all paths against project root.',
    agentThreat: true,
  },
  {
    id: 'DA-006',
    name: 'Agent impersonation risk',
    category: 'agent-hijack',
    severity: 'critical',
    pattern: /agentId\s*[:=]\s*(?:req\.|params\.|input\.|args\.)/,
    description: 'Agent ID taken from external input. Agent impersonation possible.',
    remediation: 'Derive agent ID from authenticated session, not from input parameters.',
    agentThreat: true,
  },
  {
    id: 'DA-007',
    name: 'Missing rate limit on agent actions',
    category: 'agent-hijack',
    severity: 'medium',
    pattern: /(?:sendMessage|createPost|sendEmail|apiCall)\s*\([^)]*\)(?!.*(?:rateLimit|throttle|cooldown))/,
    description: 'External action without rate limiting. Agent could spam APIs.',
    remediation: 'Implement per-agent rate limits. Track action counts per time window.',
    agentThreat: true,
  },
  {
    id: 'DA-008',
    name: 'Sensitive data in agent memory/context',
    category: 'data-exposure',
    severity: 'high',
    pattern: /(?:memory|context|store|persist).*(?:password|secret|token|apiKey|credit.?card)/i,
    description: 'Sensitive data may be stored in agent memory or context window.',
    remediation: 'Redact sensitive fields before storing in agent memory. Use reference IDs instead.',
    agentThreat: true,
  },
  {
    id: 'DA-009',
    name: 'Tool output used without sanitization',
    category: 'injection',
    severity: 'high',
    pattern: /tool_?(?:result|output|response)\s*(?:\.\w+\s*)?(?:\+|`\$\{)/,
    description: 'Raw tool output interpolated into next prompt or command. Indirect injection vector.',
    remediation: 'Sanitize and validate all tool outputs before using in subsequent prompts or commands.',
    agentThreat: true,
  },
  {
    id: 'DA-010',
    name: 'No fail-closed behavior',
    category: 'config',
    severity: 'medium',
    pattern: /catch\s*\([^)]*\)\s*\{[^}]*(?:continue|\/\*\s*(?:ok|ignore|swallow))/,
    description: 'Error silently swallowed. Agent proceeds despite failure. Should fail closed.',
    remediation: 'Log errors. For security-critical paths, halt on failure (fail closed).',
    agentThreat: true,
  },
];

/** All rules combined */
export const ALL_RULES: Rule[] = [...STANDARD_RULES, ...AGENT_THREAT_RULES];
