import { KEY, type ParsedPrompt } from "./shared.ts";

type Tabs = { identity: string; index: number };

/** How long a tab lit over the question it left must stay so before it counts: two tabs may ask the same. */
const SAME_QUESTION_SETTLE_MS = 150;

/** The question as drawn, without the tab's title: what a redraw changes after the tab bar. */
const questionOf = (prompt: ParsedPrompt): string => JSON.stringify([prompt.kind, prompt.question, prompt.options]);

/**
 * Switch only native tabs, observing every move; this path never sends text, Enter or Space.
 * `tabsOf` names the form's tab shown: pi's by default, Claude's question tabs (claude.ts) too.
 * Returns the frame the form ended on, showing the tab asked for; null when it stopped.
 */
export async function navigatePiAsk(initial: ParsedPrompt, target: number, io: {
  read(): Promise<ParsedPrompt | null>;
  /** sends the key once the read right before it still shows `from`, the tab it moves from */
  send(key: string, from: (shown: ParsedPrompt) => boolean): Promise<void>;
  active(): boolean;
  deadline: number;
}, tabsOf: (prompt: ParsedPrompt) => Tabs | undefined = (prompt) => prompt.piAskForm): Promise<ParsedPrompt | null> {
  const form = tabsOf(initial);
  if (!form || !Number.isInteger(target) || target < 0 || target === form.index
    || !initial.steps?.[target]?.can_navigate) return null;
  let previous = initial;
  let index = form.index;
  while (index !== target) {
    if (!io.active() || Date.now() >= io.deadline) return null;
    // The request's first read can already be stale; recheck before the first arrow too.
    let before = await io.read();
    // a Claude frame mid-redraw whose colors could not be checked shows no tab: look again
    while (before && tabsOf(before) === undefined && initial.claudeTabs !== undefined && io.active() && Date.now() < io.deadline) {
      await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
      before = await io.read();
    }
    // before the first arrow the card asked from is still the one shown; after a move the tabs say
    // where the form is, and a question still being redrawn under them is no other form
    if (!before || tabsOf(before)?.identity !== form.identity || tabsOf(before)!.index !== index
      || previous === initial && before.id !== initial.id || !io.active()) return null;
    previous = before; // what the arrow leaves: the wait below tells a move from this frame
    const direction = target > index ? 1 : -1;
    const at = index;
    const left = previous;
    await io.send(direction === 1 ? KEY.right : KEY.left,
      (shown) => tabsOf(shown)?.identity === form.identity && tabsOf(shown)!.index === at && shown.id === left.id && io.active());
    const expected = index + direction;
    let moved = false;
    let litOverOld: number | undefined;
    while (io.active() && Date.now() < io.deadline) {
      const shown = await io.read();
      if (!shown) return null;
      const tabs = tabsOf(shown);
      // a Claude read whose colors could not be checked (a frame mid-redraw) shows no tab: no evidence
      // either way, so look again; pi's reads stop as before
      if (tabs === undefined) {
        if (initial.claudeTabs === undefined) return null;
        await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
        continue;
      }
      if (tabs.identity !== form.identity) return null;
      if (tabs.index === expected) {
        // the bar can light the new tab before the question under it is redrawn: that frame is no
        // finished move until its question changes, or stays the same long enough to be the tab's own
        litOverOld ??= Date.now();
        if (questionOf(shown) !== questionOf(previous) || Date.now() - litOverOld >= SAME_QUESTION_SETTLE_MS) {
          previous = shown; index = expected; moved = true; break;
        }
        await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
        continue;
      }
      litOverOld = undefined;
      if (tabs.index !== index || shown.id !== previous.id) return null;
      await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
    }
    if (!moved) return null;
  }
  return io.active() ? previous : null;
}
