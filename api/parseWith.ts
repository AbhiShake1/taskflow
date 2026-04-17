import type { AgentName } from '../core/types';

const KNOWN_AGENTS: readonly AgentName[] = [
  'claude-code',
  'pi',
  'codex',
  'cursor',
  'opencode',
] as const;

/**
 * Split an `'agent'` or `'agent:model'` string on the FIRST `:`. Any further
 * `:` chars stay in the `model` portion (so `'pi:anthropic/claude-opus-4-7:thinking'`
 * parses cleanly). Throws on unknown agent names so typos fail fast at
 * authoring time rather than at spawn time.
 */
export function parseWith(s: string): { agent: AgentName; model?: string } {
  const idx = s.indexOf(':');
  const agent = idx === -1 ? s : s.slice(0, idx);
  const model = idx === -1 ? undefined : s.slice(idx + 1);
  if (!KNOWN_AGENTS.includes(agent as AgentName)) {
    throw new Error(
      `unknown agent in with: "${s}" — must start with one of ${KNOWN_AGENTS.join('|')}`,
    );
  }
  return { agent: agent as AgentName, model: model === '' ? undefined : model };
}
