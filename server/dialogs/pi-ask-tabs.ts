import type { InteractivePromptStep } from "../../shared/protocol.ts";
import { ANSI_RE } from "./shared.ts";

/** Colored themes mark the active background; system uses neutral text versus dim/green inactive tabs. */
export function piAskTabs(raw: string): { steps: InteractivePromptStep[]; index: number | null; identity: string } | null {
  const plain = raw.replace(ANSI_RE, "");
  const tabs = [...plain.matchAll(/ ([□■]) (.*?) (?=  (?:[□■]|✓))/g)];
  if (tabs.length < 2 || tabs.length > 4 || tabs.some(tab => !tab[2]?.trim())) return null;
  const expected = " ← " + tabs.map(tab => ` ${tab[1]} ${tab[2]}  `).join("") + " ✓ Submit  →";
  if (plain.trim() !== expected.trim()) return null; // clipped or ambiguous header: no guessed tabs

  const index = piActiveTab(raw, [...tabs.map(tab => tab.index! + 1), plain.indexOf("✓ Submit")]);
  const allAnswered = tabs.every(tab => tab[1] === "■");
  const steps = [
    ...tabs.map(tab => ({ label: tab[2]!, answered: tab[1] === "■", current: false })),
    { label: "Submit", answered: false, current: false },
  ].map((step, at) => ({ ...step, current: at === index,
    ...(index !== null && (at < tabs.length || allAnswered) ? { can_navigate: true } : {}),
  }));
  return { steps, index, identity: JSON.stringify(tabs.map(tab => [tab[2], tab[1]])) };
}

/**
 * SGR evidence only: plain text never establishes the current tab. Offsets exclude ANSI.
 * `backgroundOnly`: a tab on a background alone counts, never the one tab in the default color.
 */
export function piActiveTab(raw: string, markers: number[], backgroundOnly = false): number | null {
  const backgrounds: boolean[] = [];
  const dimmed: boolean[] = [];
  const defaultForegrounds: boolean[] = [];
  let background = false;
  let dim = false;
  let defaultForeground = true;
  let offset = 0;
  // Keep string offsets (not terminal columns): the regexp's marker offsets are UTF-16 too.
  for (const escape of raw.matchAll(/\u001b\[([0-?]*)[ -/]*([@-~])/g)) {
    backgrounds.push(...Array<boolean>(escape.index! - offset).fill(background));
    dimmed.push(...Array<boolean>(escape.index! - offset).fill(dim));
    defaultForegrounds.push(...Array<boolean>(escape.index! - offset).fill(defaultForeground));
    offset = escape.index! + escape[0].length;
    if (escape[2] !== "m") continue;
    const codes = (escape[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) { background = false; dim = false; defaultForeground = true; }
      else if (code === 2) dim = true;
      else if (code === 22) dim = false;
      else if (code === 39) defaultForeground = true;
      else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) defaultForeground = false;
      else if (code === 49) background = false;
      else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) background = true;
      else if (code === 38 || code === 48 || code === 58) {
        const extra = codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
        if (!extra) return null;
        if (code === 48) background = true;
        if (code === 38) defaultForeground = false;
        i += extra; // RGB components such as 40 or 49 are data, never SGR instructions.
      }
    }
  }
  backgrounds.push(...Array<boolean>(raw.length - offset).fill(background));
  dimmed.push(...Array<boolean>(raw.length - offset).fill(dim));
  defaultForegrounds.push(...Array<boolean>(raw.length - offset).fill(defaultForeground));
  const active = markers.flatMap((at, index) => backgrounds[at] ? [index] : []);
  if (backgroundOnly) return active.length === 1 ? active[0]! : null;
  const normal = markers.flatMap((at, index) => !dimmed[at] && defaultForegrounds[at] ? [index] : []);
  // Never infer a position from plain text or from conflicting/ambiguous style evidence.
  return active.length > 1 || active.length === 1 && normal.length === 1 && active[0] !== normal[0]
    ? null : active.length === 1 ? active[0]! : normal.length === 1 ? normal[0]! : null;
}
