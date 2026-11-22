import { AGENT_NAME_MAX_LENGTH as MAX_LENGTH } from "../shared/agent-name.ts";

/**
 * herdr's agent.start takes a name no other agent in the session holds (it answers
 * `agent_name_taken` otherwise), and a name follows the rule in shared/agent-name.ts
 * (`invalid_agent_name`).
 */

export function freeAgentName(kind: string, taken: Iterable<string | null | undefined>): string {
  const used = new Set(taken);
  if (!used.has(kind)) return kind;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const name = `${kind.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(name)) return name;
  }
}
