import type { PromptAnswer } from "../../shared/protocol.ts";
import type { ParsedPrompt } from "./shared.ts";

/**
 * A form whose own keys move between its questions without answering one (omo's Tab and Shift+Tab,
 * Codex's ←/→, Hermes's Tab and Shift+Tab), as read off its screen: the question shown, by its
 * place among the form's `count` stops (omo's Submit tab is the last of them).
 */
export interface NativeSteps {
  identity: string;
  index: number;
  count: number;
  next: string;
  previous: string;
}

export function nativeStepTarget(prompt: ParsedPrompt, body: PromptAnswer): number | string {
  const form = prompt.nativeSteps!;
  const actions = [body.step_back === true, body.step_next === true, body.step_index !== undefined].filter(Boolean).length;
  if (actions !== 1 || body.option_index !== undefined || body.option_indices !== undefined || body.custom_text !== undefined) {
    return "Exactly one supported navigation action is required.";
  }
  if (body.step_back === true) return prompt.can_step_back ? form.index - 1 : "Cannot step back from here.";
  if (body.step_next === true) return prompt.can_step_next ? form.index + 1 : "Cannot go on from here.";
  const target = body.step_index!;
  return Number.isInteger(target) && target >= 0 && target < form.count && target !== form.index && prompt.steps?.[target]?.can_navigate
    ? target : "Invalid question to navigate to.";
}

/**
 * The card's edits sent with a move must be the ones the form already shows: the agent's keys
 * carry none of the card's own over, so a move never drops a choice the user made in the card.
 */
export function draftKept(prompt: ParsedPrompt, draft: PromptAnswer["draft"]): boolean {
  if (draft === undefined) return true;
  const shown = prompt.multi_select ? prompt.default_option_indices ?? []
    : prompt.default_option_index !== undefined && prompt.default_option_index !== null ? [prompt.default_option_index] : [];
  return typeof draft === "object" && draft !== null && Array.isArray(draft.option_indices) && typeof draft.custom_text === "string"
    && draft.option_indices.every((index) => Number.isInteger(index))
    && JSON.stringify([...draft.option_indices].sort((a, b) => a - b)) === JSON.stringify(shown)
    && draft.custom_text === (prompt.default_custom_text ?? "");
}

export async function navigateNativeSteps(initial: ParsedPrompt, target: number, io: {
  read(): Promise<ParsedPrompt | null>;
  send(key: string, from: (shown: ParsedPrompt) => boolean): Promise<void>;
  active(): boolean;
  deadline: number;
}): Promise<ParsedPrompt | null> {
  const form = initial.nativeSteps!;
  let previous = initial;
  let index = form.index;
  while (index !== target) {
    if (!io.active() || Date.now() >= io.deadline) return null;
    const before = await io.read();
    if (!before || before.nativeSteps?.identity !== form.identity || before.nativeSteps.index !== index
      || before.id !== previous.id || !io.active()) return null;
    const direction = target > index ? 1 : -1;
    const at = index;
    const from = previous;
    await io.send(direction === 1 ? form.next : form.previous,
      (shown) => shown.nativeSteps?.identity === form.identity && shown.nativeSteps.index === at && shown.id === from.id && io.active());
    const expected = index + direction;
    let moved = false;
    while (io.active() && Date.now() < io.deadline) {
      const shown = await io.read();
      const steps = shown?.nativeSteps;
      if (shown && steps?.identity === form.identity && steps.index === expected) {
        previous = shown;
        index = expected;
        moved = true;
        break;
      }
      if (shown && steps !== undefined && (steps.identity !== form.identity || steps.index !== index || shown.id !== previous.id)) return null;
      if (shown && steps === undefined && shown.agent === "omp" && ((shown.ompCall !== undefined && shown.ompCall !== initial.ompCall)
        || (shown.steps !== undefined && JSON.stringify(shown.steps.map(step => step.label)) !== JSON.stringify(initial.steps?.map(step => step.label))))) return null;
      await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
    }
    if (!moved) return null;
  }
  return io.active() ? previous : null;
}
