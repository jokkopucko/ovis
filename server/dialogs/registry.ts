import { isPiQuestionnaireScreen } from "./pi-questionnaire.ts";
import { readers } from "./index.ts";
import { claudeModelListWaits, CLAUDE_EFFORT_GUARD_RE } from "./claude.ts";
import { codexModelListWaits } from "./codex.ts";
import { hermesModalWaits } from "./hermes.ts";
import { agyWriteInWaits } from "./agy.ts";
import { kiroApprovalLeftToTerminal, kiroApprovalWaits } from "./kiro.ts";
import type { DialogReader, OmoAsk } from "./shared.ts";
import { agentPickerOwnsScreen } from "./fallback.ts";
export type { DialogReader } from "./shared.ts";

export interface ReaderContext {
  readonly agent: string;
  readonly omoAsk: OmoAsk | null;
  readonly omoTrusted: boolean;
  readonly omoOpen: readonly OmoAsk[];
  readonly sent: string | null;
  readonly working: boolean;
}

export const SCREEN_READ_AGENTS: ReadonlySet<string> = new Set(["claude", "omp", "codex", "omo", "pi", "gjc", "hermes", "cmd", "opencode", "letta", ""]);

/**
 * A picker of its own that has an agent's input while herdr may report it at rest (agentPickerOwnsScreen), for agents
 * no reader knows: a chat message would pick a row, so it is refused, and the fallback card answers the picker.
 */
export function agentPickerWaits(agent: string, screen: string): boolean {
  return !SCREEN_READ_AGENTS.has(agent) && (agentPickerOwnsScreen(screen) || (agent === "kiro" && kiroApprovalWaits(screen)));
}

export function readersFor(agent: string): readonly DialogReader[] {
  return readers.filter((reader) => reader.agents.includes(agent) || reader.agents.includes("*")).sort((a, b) => a.priority - b.priority);
}

export const registry = {
  readersFor,
  readerFor(responder: string): DialogReader | undefined {
    return readers.find((reader) => reader.id === responder);
  },
  waits(agent: string, screen: string): boolean {
    return (agent === "pi" && isPiQuestionnaireScreen(screen)) || claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE) || (agent === "codex" && codexModelListWaits(screen))
      || (agent === "hermes" && hermesModalWaits(screen)) || (agent === "agy" && agyWriteInWaits(screen)) || (agent === "kiro" && kiroApprovalLeftToTerminal(screen));
  },
};
