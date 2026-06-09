/**
 * Routing Guard: Prompt-Agent Mismatch Detection
 * Authorization: Jason GO directive (2026-06-09). Governed-surface edit per Rule 10.
 *
 * Pure detection functions with no side effects.
 * Used by schedule-cli.ts create command.
 */

export const AGENT_NAME_TO_ID: Record<string, string> = {
  james: 'comms',
  annika: 'research',
  sean: 'ops',
  melissa: 'content',
  jackson: 'custom',
  melanie: 'main',
};

// Nicknames / abbreviations that are agent-adjacent but not canonical
export const AGENT_NICKNAMES: Record<string, string> = {
  mel: 'content',    // could be Melissa or Melanie -- ambiguous
  niks: 'research',  // Annika nickname
  jacks: 'custom',   // Jackson shorthand
  lissa: 'content',  // Melissa shorthand
  jack: 'custom',    // Jackson shorthand
  annie: 'research', // Annika shorthand
};

export function detectPromptAgent(prompt: string): string | null {
  const head = prompt.slice(0, 80).toLowerCase();
  for (const [name, agentId] of Object.entries(AGENT_NAME_TO_ID)) {
    if (head.includes(`you are ${name}`)) return agentId;
    if (head.startsWith(`${name}:`)) return agentId;
    if (head.startsWith(`${name} `)) return agentId;
    if (head.startsWith(name.toUpperCase() + ' ')) return agentId;
  }
  return null;
}

export function detectNicknameWarning(prompt: string): { nickname: string; possibleAgent: string } | null {
  const head = prompt.slice(0, 80).toLowerCase();
  for (const [nick, agentId] of Object.entries(AGENT_NICKNAMES)) {
    if (head.includes(nick)) return { nickname: nick, possibleAgent: agentId };
  }
  return null;
}
