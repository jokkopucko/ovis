import type { SlashCommand } from "../../shared/protocol.ts";

/** The longest skill name the Close tab button setting keeps. */
const MAX_SKILL_NAME = 128;

/**
 * The skill name the Close tab button setting holds, also while it is typed: without a leading `/`
 * or `$` (the pane's agent decides its own trigger) and without the characters no skill name has.
 * It is only ever compared with the pane's listed skills, never sent as typed.
 */
export function sanitizeCloseTabSkill(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/^\s*[/$]/, "").replace(/[^\w.:-]/g, "").slice(0, MAX_SKILL_NAME);
}

/**
 * The pane's command for the configured close-tab skill: its exact name, else the one skill whose
 * name after its plugin namespace is that name (`close-tab` finds `jokko:close-tab`). None for a
 * builtin, which runs no check, or when two plugins name it: a guess there could run the wrong one.
 */
export function closeTabCommand(commands: readonly SlashCommand[], wanted: string): SlashCommand | null {
  if (wanted === "") return null;
  const skills = commands.filter((command) => command.source !== "builtin");
  const exact = skills.find((command) => command.name === wanted);
  if (exact !== undefined) return exact;
  if (wanted.includes(":")) return null;
  const namespaced = skills.filter((command) => command.name.includes(":") && command.name.split(":").at(-1) === wanted);
  return namespaced.length === 1 ? namespaced[0]! : null;
}

/** What the composer sends for the command: the skill in the form the pane's agent invokes it. */
export function closeTabMessage(command: SlashCommand): string {
  return `${command.trigger ?? "/"}${command.name}`;
}
