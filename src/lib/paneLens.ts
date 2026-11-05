import type { PaneView } from "./actions.ts";
import type { DefaultView } from "./settings.ts";

/**
 * The lens a pane opens in when nobody picked one for it: Settings' default for every pane
 * (chat needs an agent, a shell has no conversation to show), or, on Auto, the chat for an
 * agent pane on a touch screen. Until the snapshot says whether the pane has an agent (null),
 * it counts as one.
 */
export function defaultLens(hasAgent: boolean | null, defaultView: DefaultView, coarse: boolean): PaneView {
  if (defaultView === "chat") return hasAgent !== false ? "chat" : "terminal";
  if (defaultView === "terminal") return "terminal";
  return hasAgent !== false && coarse ? "chat" : "terminal";
}

/**
 * The default lens of each pane this page has shown, kept once the snapshot said whether the
 * pane has an agent. An agent that starts in a shell, or one that exits, leaves the pane on the
 * lens it was showing: re-deriving it turned a split's terminal into a chat while it was in use.
 * A new Settings default starts a new map (App), and a lens picked by hand is stored apart and
 * always wins.
 */
export class PaneLenses {
  private readonly settled = new Map<string, PaneView>();
  constructor(private readonly defaultView: DefaultView) {}

  of(key: string, hasAgent: boolean | null, coarse: boolean): PaneView {
    const settled = this.settled.get(key);
    if (settled !== undefined) return settled;
    const lens = defaultLens(hasAgent, this.defaultView, coarse);
    if (hasAgent !== null) this.settled.set(key, lens);
    return lens;
  }

  /** The lens `of` gives, without keeping it: a press that may not become a pick settles nothing. */
  peek(key: string, hasAgent: boolean | null, coarse: boolean): PaneView {
    return this.settled.get(key) ?? defaultLens(hasAgent, this.defaultView, coarse);
  }

  /** A pane this page started an agent in: its lens is an agent's, whatever the first snapshot says. */
  startedAgent(key: string, coarse: boolean): void {
    this.settled.set(key, defaultLens(true, this.defaultView, coarse));
  }
}
