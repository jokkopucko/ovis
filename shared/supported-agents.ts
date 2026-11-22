/**
 * herdr's manifests name more; any of those still runs from a pane's shell.
 *
 * Its own file: the browser imports the value, and shared/protocol.ts reads `process.env` as it loads.
 */
export const SUPPORTED_AGENT_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "copilot", "omp", "omo", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "letta", "dsh-tui"]);

/**
 * herdr's custom agents that launch an agent Ovis reads under a name of their own: gentle-shell runs pi
 * with a home of its own and reports pi's lifecycle as `gentle-shell` (#4198). The server still proves
 * the agent from the pane's own processes, as for a pane herdr labels `pi`; the label herdr gives stays
 * the one shown.
 */
const LAUNCHER_NAMES: Readonly<Record<string, string>> = { "gentle-shell": "pi" };

/** The agent Ovis reads and drives a pane as, from the name herdr labels it with. */
export function labelledAgent<T extends string | null | undefined>(label: T): string | T {
  return label && Object.hasOwn(LAUNCHER_NAMES, label) ? LAUNCHER_NAMES[label]! : label;
}
