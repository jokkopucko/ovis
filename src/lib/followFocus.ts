import { paneStorageId } from "../../shared/machines.ts";
import { composerDrafts } from "./composerDraft.ts";
import { restoreDraft } from "./draft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { readTerminalDraft } from "./terminalDraft.ts";
import { sameTarget, type SplitTarget } from "./split.ts";

/**
 * Following herdr's focus (Settings → Terminal, `followHerdrFocus`, #311): herdr's own window
 * moves to the pane a click there, `herdr tab focus` or a script brings to the front, and a
 * `pane-focused` frame says so. This device opens that pane too, only when it asked to and only on
 * the PC it has open: another PC's focus is that PC's business, and a pane already in front (the
 * selected one, or the other half of a split) stays where it is. A link still landing goes first,
 * someone using this device (`busy`, deviceInUse) keeps the pane they are on, and a move this device
 * asked for itself (`ownMove`, movingHerdrFocus) is opened by its own answer.
 */
export function followsHerdrFocus(input: {
  enabled: boolean;
  machineId: string;
  paneId: string;
  selection: { machineId: string; paneId: string | null };
  splitOthers: readonly SplitTarget[];
  linkPending: boolean;
  /** this device is in use: following would drop the keyboard, close what is open or leave an unsent message (#1470) */
  busy: boolean;
  ownMove: boolean;
}): boolean {
  if (!input.enabled || input.linkPending || input.busy || input.ownMove) return false;
  if (input.machineId !== input.selection.machineId || input.paneId === input.selection.paneId) return false;
  return !input.splitOthers.some((other) => sameTarget(other, { machineId: input.machineId, paneId: input.paneId }));
}

const ownMoves = new Map<string, number>();
/**
 * How long a request this device made leaves herdr's focus to it at most: a PC that never answers
 * (a stalled connection, neither refused nor closed) must not turn following off until a reload.
 */
export const OWN_MOVE_HOLD_MS = 10_000;

/**
 * A request from this device that moves herdr's focus (a split that opens its new pane): herdr's
 * pane-focused frame may come before the answer, and following it would open the pane as an
 * automatic pick, with no keyboard and no Back entry, before the caller opens it as its own (#1470).
 */
export function movingHerdrFocus<T>(machineId: string, request: Promise<T>): Promise<T> {
  ownMoves.set(machineId, (ownMoves.get(machineId) ?? 0) + 1);
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    const left = (ownMoves.get(machineId) ?? 1) - 1;
    if (left > 0) ownMoves.set(machineId, left);
    else ownMoves.delete(machineId);
  };
  const bound = setTimeout(release, OWN_MOVE_HOLD_MS);
  return request.finally(() => { clearTimeout(bound); release(); });
}

export function movingHerdrFocusOn(machineId: string): boolean {
  return ownMoves.has(machineId);
}

/**
 * A dialog is open over the pane, or the keyboard is in a text field (the composer, the input line,
 * the terminal's own): following herdr's focus would close the dialog or drop the keyboard
 * mid-sentence.
 */
export function deviceBusy(doc: Pick<Document, "activeElement" | "querySelector"> = document): boolean {
  if (doc.querySelector('[aria-modal="true"], dialog[open]') !== null) return true;
  const active = doc.activeElement;
  return active !== null && "matches" in active
    && active.matches("textarea, input, select, [contenteditable]:not([contenteditable='false'])");
}

export interface PaneDrafts {
  composer: (owner: string) => string;
  line: (owner: string) => string;
  held: (owner: string) => string;
}

const draftsHere: PaneDrafts = {
  composer: (owner) => composerDrafts.read(`ovis:composer-draft:${owner}`).text,
  line: (owner) => readTerminalDraft(owner),
  held: (owner) => {
    let raw: string | null = null;
    try { raw = paneLifetimes.paneStorage.getItem(`ovis:terminal-draft:${owner}`); } catch { /* private mode */ }
    return restoreDraft(raw, Date.now()).text;
  },
};

/**
 * The pane this device has open holds an unsent message in any of its drafts: following would
 * leave it behind, so the pane stays until it is sent or cleared.
 */
export function unsentDraft(selection: { machineId: string; paneId: string | null }, drafts: PaneDrafts = draftsHere): boolean {
  if (selection.paneId === null) return false;
  const owner = paneStorageId(selection.machineId, selection.paneId);
  return [drafts.composer(owner), drafts.line(owner), drafts.held(owner)].some((text) => text.trim() !== "");
}

export function deviceInUse(
  selection: { machineId: string; paneId: string | null },
  doc: Pick<Document, "activeElement" | "hasFocus" | "querySelector"> = document,
  drafts: PaneDrafts = draftsHere,
): boolean {
  return doc.hasFocus() && (deviceBusy(doc) || unsentDraft(selection, drafts));
}
