export type GrokScreenState = {
  readonly status: string;
  readonly output: readonly string[];
  readonly prompt: string;
  readonly queue: readonly string[];
  readonly card?: boolean;
  readonly minimal?: boolean;
};

const WIDTH = 113;

function queuedRow(message: string): string {
  const [first = "", ...rest] = message.split("\n");
  const cut = first.length > 107 ? `${first.slice(0, 107)}…` : first;
  return rest.length === 0 ? cut : `${cut} (+${rest.length} line${rest.length === 1 ? "" : "s"})`;
}

function footer(state: GrokScreenState): string {
  if (state.prompt !== "") return "  Enter:queue  │  Shift+Enter/Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+Enter:send now";
  if (state.queue.length > 0) return "  Enter:send now  │  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+;:queue  │  Ctrl+.:shortcuts";
  return state.status === "working" ? "  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+.:shortcuts" : "  Shift+Tab:mode  │  Ctrl+.:shortcuts";
}

export function grokScreen(state: GrokScreenState): string {
  const working = state.status === "working" || state.status === "blocked";
  if (state.minimal) {
    const queued = state.queue.length > 0 ? ` · ${state.queue.length} queued · /queue` : "";
    return [...state.output, ...(working ? ["⠴ Responding… 2.8s"] : []), `❯ ${state.prompt}`.trimEnd(), `Stand-in · 2.5K / 128K (2%)${queued} · ctrl+o transcript`].join("\n");
  }
  const [first = "", ...more] = state.prompt.split("\n");
  const prompt = state.card
    ? ["  ┃", "  ┃  ›  scratch command", "  ┃  │ echo hello > made-by-grok.txt", "  ┃", "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (●) Yes, proceed", "  ┃  3 (○) No, reject (type to add feedback)", "  ┃", "",
      "  1/4:select  │  Tab:next option  │  ←/→:scope  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback"]
    : [`  ╭${"─".repeat(WIDTH)}╮`, `  │ ❯ ${first.padEnd(WIDTH - 3)}│`, ...more.map((line) => `  │   ${line.padEnd(WIDTH - 3)}│`),
      `  ╰${"─".repeat(WIDTH - 11)} Stand-in ─╯`, "", footer(state)];
  return [
    "",
    "  main ~/scratch/grok                                                                     2.1K / 128K │ [Dashboard]",
    "",
    ...state.output.map((line) => `     ${line}`),
    "",
    ...state.queue.map((message, index) => `    #${index + 1} ${queuedRow(message)}`),
    ...(state.queue.length > 0 ? [""] : []),
    ...(working ? ["    ⠦ Responding… 3.0s                                                                             3.1s ⇣2.10k [stop]", ""] : []),
    ...prompt,
  ].join("\n");
}
