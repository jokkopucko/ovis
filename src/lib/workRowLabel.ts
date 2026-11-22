import { isToolNarration, toolVerb } from "./toolVerbs.ts";

export function workRowLabel(part: { name: string; input: string }, summary: string): { narration: boolean; verb: string | null } {
  return { narration: isToolNarration(part, summary), verb: toolVerb(part, summary) };
}
