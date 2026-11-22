import type { SkillActivity } from "../../shared/protocol.ts";

// agy 1.2.16 and 1.4.12: the metadata block opens with the local time, then the mentioned items in
// request order, each skill's body after its line.
const FIRST_MENTION = /^\s*<ADDITIONAL_METADATA>\nThe current local time is: [^\n]*\n\nThe user has mentioned some items in the form @\[ITEM\]\. Here is extra information about the items that were mentioned by the user, in the order that they appear:\n\n\/([^\s()<>]{1,200}) is a \[Slash Command\]:\n<SKILL>The user has explicitly invoked the \(([^()\r\n<>]{1,200})\) skill\./;

/**
 * Only the first item sits before any skill body: a later one could be text inside a body, so it
 * gives no row, and a request holding the envelope's own tags gives none either.
 */
export function agyInvokedSkills(request: string, metadata: string): SkillActivity[] {
  if (/<\/?(?:USER_REQUEST|ADDITIONAL_METADATA)>/.test(request)) return [];
  const match = FIRST_MENTION.exec(metadata);
  if (!match || match[1] !== match[2]) return [];
  const typed = new RegExp(`(?:^|\\s)/${match[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`);
  return typed.test(request) ? [{ name: match[1]!, evidence: "instructions", status: "loaded" }] : [];
}
