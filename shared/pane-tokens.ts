/**
 * herdr plugins attach short text values to a pane (`herdr pane report-metadata --token
 * name=value`): the Quota plugin's usage left, herdr-projects' summary and progress. herdr's own
 * sidebar draws one where the user's `[ui.sidebar.agents]` rows name it as `$name`. The web UI's
 * agent rows follow the `$name` tokens of those rows (server/herdr-sidebar.ts reads them from the
 * herdr config.toml of the PC the browser talks to, as herdr's sidebar is the client's config,
 * remote PCs included). Where the config names none they draw every token a pane has, save a blank
 * or non-text value and a `role` of `background`.
 */

/**
 * One of a `$name` token's `rules`, kept only for whether it hides the token: the web UI draws
 * every token in its own dim style, so herdr's `fg`, `bold` and `dim` overrides are left out.
 * Each rule has exactly one condition.
 */
export interface PaneTokenRule {
  equals?: string;
  contains?: string;
  starts_with?: string;
  gt?: number;
  lt?: number;
  /** ASCII letters only, as herdr matches */
  ignore_case?: boolean;
  hide?: boolean;
}

export interface PaneTokenSpec {
  /** the token's name, without its `$` */
  name: string;
  /** in herdr's order: the first rule that matches decides; absent when none of them hides the token */
  rules?: PaneTokenRule[];
}

/** The `$name` tokens of herdr's `[ui.sidebar.agents]`, in the order its rows name them; a token named in two places is listed at each. */
export interface AgentRowTokens {
  /** from `rows`; null when the config sets none (herdr's default rows name no token), and a row then draws every token */
  rows: PaneTokenSpec[] | null;
  /** `rows_by_agent`: a canonical agent id's own rows, in place of `rows` */
  by_agent: Record<string, PaneTokenSpec[]>;
}

/** herdr's rule for a token's name (`report-metadata --token name=value`) */
export const PANE_TOKEN_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** a whole finite number, as herdr's `gt` and `lt` read a value: no space, unit, NaN or infinity */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export const ROLE_TOKEN = "role";

export function isBackgroundRole(value: unknown): boolean {
  return typeof value === "string" && asciiLower(value.trim()) === "background";
}

/** Whether a rule's condition holds for a token's whole value, as herdr's sidebar tests it. */
export function paneTokenRuleMatches(rule: PaneTokenRule, value: string): boolean {
  if (rule.gt !== undefined || rule.lt !== undefined) {
    if (!NUMBER.test(value)) return false;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    return rule.gt !== undefined ? number > rule.gt : number < rule.lt!;
  }
  const fold = rule.ignore_case ? asciiLower : (text: string) => text;
  if (rule.equals !== undefined) return fold(value) === fold(rule.equals);
  if (rule.contains !== undefined) return fold(value).includes(fold(rule.contains));
  if (rule.starts_with !== undefined) return fold(value).startsWith(fold(rule.starts_with));
  return false;
}

export function paneTokenSpecs(layout: AgentRowTokens | null, agent: string | null): PaneTokenSpec[] | null {
  return (layout && agent !== null && Object.hasOwn(layout.by_agent, agent) ? layout.by_agent[agent] : undefined) ?? layout?.rows ?? null;
}

/** The values are text the row writes as it is, never markup. */
export function paneTokenValues(layout: AgentRowTokens | null, agent: string | null, tokens: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (!tokens) return [];
  const valueOf = (name: string): string | null => {
    const value = Object.hasOwn(tokens, name) ? tokens[name] : undefined;
    return typeof value === "string" && value.trim() ? value : null;
  };
  const specs = paneTokenSpecs(layout, agent);
  if (specs === null) return Object.keys(tokens).sort().flatMap((name) => name === ROLE_TOKEN && isBackgroundRole(tokens[name]) ? [] : valueOf(name)?.trim() ?? []);
  const shown: string[] = [];
  const said = new Set<string>();
  for (const { name, rules } of specs) {
    if (said.has(name)) continue;
    const value = valueOf(name);
    if (value === null || rules?.find((rule) => paneTokenRuleMatches(rule, value))?.hide) continue;
    said.add(name);
    shown.push(value.trim());
  }
  return shown;
}
