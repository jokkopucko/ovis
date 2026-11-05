/** Static invocation syntax, safe to import as a value in the browser. */
export interface SkillSyntax {
  skillTriggers: readonly ("/" | "$")[];
  inline: readonly ("/" | "$")[];
  namespaced: boolean;
  /** `{bare}` is the command name without its `skill:` namespace. */
  chipForms: readonly string[];
}

export const DEFAULT_SKILL_SYNTAX: SkillSyntax = {
  skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [],
};

export const SKILL_SYNTAX: Readonly<Record<string, SkillSyntax>> = {
  omo: { skillTriggers: ["/", "$"], inline: ["$"], namespaced: true, chipForms: ["$skill:{bare}", "[skill: {bare}]"] },
  // `/prompts:x`, `/plugin:x` and `/skill:x` keep the menu open past their `:`
  codex: { skillTriggers: ["$"], inline: ["/", "$"], namespaced: true, chipForms: [] },
  claude: { skillTriggers: ["/"], inline: ["/"], namespaced: true, chipForms: [] },
  copilot: DEFAULT_SKILL_SYNTAX,
  pi: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  omp: { skillTriggers: ["/"], inline: ["/"], namespaced: true, chipForms: [] },
  gjc: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  devin: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  cmd: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  hermes: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  opencode: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  grok: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  agy: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  // its menu opens only on a leading `/`, and lists skills as bare `/<skill-id>` rows
  // (letta-code 0.34.23, src/cli/components/SlashCommandAutocomplete.tsx)
  letta: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  // a direct-call skill joins its command menu as a leading `/name` (dsh-tui 0.17.0 user guide, Skills)
  "dsh-tui": { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
};

export function skillSyntax(agent: string | null | undefined): SkillSyntax {
  return agent != null && Object.hasOwn(SKILL_SYNTAX, agent)
    ? SKILL_SYNTAX[agent] ?? DEFAULT_SKILL_SYNTAX
    : DEFAULT_SKILL_SYNTAX;
}
