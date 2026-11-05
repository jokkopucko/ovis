import { looksLikeKey } from "../../shared/secret-prompt.ts";
import { paneLifetimes, paneStateKey } from "./paneLifetime.ts";

/** Unsent terminal lines belong to a PC/pane, never to the currently mounted view. */
const listeners = new Set<() => void>();
const pending = new Map<string, { written: string; canClear: boolean }>();
export function subscribeTerminalDraft(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify(): void { for (const listener of listeners) listener(); }
export function terminalDraftSending(owner: string): boolean { return pending.has(owner); }
export function setTerminalDraftSending(owner: string, value: boolean): void {
  if (value) pending.set(owner, { written: readTerminalDraft(owner), canClear: true });
  else pending.delete(owner);
  notify();
}
const memory = new Map<string, string>();
/** how many times each owner's draft was written: a paste that waited on the clipboard compares it (TerminalInput.tsx) */
const versions = new Map<string, number>();
export function terminalDraftVersion(owner: string): number {
  // a line asked about is counted from here on, so a herdr replacement can count it too (onRetire below)
  if (!versions.has(owner)) versions.set(owner, 0);
  return versions.get(owner)!;
}
/** lines storage refused: they live in `memory` alone */
const unsaved = new Set<string>();
const PREFIX = "ovis:terminal-line:";
export const TERMINAL_LINE_LIMIT = 32_768;
/** the herdr each line that looks like a key was typed under: it stays in this page alone while that herdr does */
const keyLifetimes = new Map<string, string | null | undefined>();
function lifetimeOf(owner: string): string | null | undefined {
  const pane = paneStateKey(PREFIX + owner);
  return pane ? paneLifetimes.generation(pane.machineId) : undefined;
}
export function readTerminalDraft(owner: string): string {
  if (memory.has(owner)) return memory.get(owner)!;
  let stored = "";
  try { stored = (paneLifetimes.paneStorage.getItem(PREFIX + owner) ?? "").slice(0, TERMINAL_LINE_LIMIT); } catch { return ""; }
  // a key an earlier release stored leaves storage on its first read, and stays in this page
  if (looksLikeKey(stored)) {
    memory.set(owner, stored);
    keyLifetimes.set(owner, lifetimeOf(owner));
    try { paneLifetimes.paneStorage.removeItem(PREFIX + owner); } catch { /* storage refused: retirement still never archives it */ }
  }
  return stored;
}
export function writeTerminalDraft(owner: string, text: string): void {
  const value = text.slice(0, TERMINAL_LINE_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
  const sent = pending.get(owner);
  if (sent && !value.startsWith(sent.written)) sent.canClear = false;
  memory.set(owner, value);
  versions.set(owner, terminalDraftVersion(owner) + 1);
  // a key is never written down: not to storage, nor to the recovery a herdr replacement leaves
  const key = looksLikeKey(value);
  if (key) keyLifetimes.set(owner, lifetimeOf(owner));
  else keyLifetimes.delete(owner);
  try {
    if (value && !key) paneLifetimes.paneStorage.setItem(PREFIX + owner, value);
    else paneLifetimes.paneStorage.removeItem(PREFIX + owner);
    unsaved.delete(owner);
  } catch {
    // private mode: preserve across view changes in memory
    if (key) unsaved.delete(owner);
    else unsaved.add(owner);
  }
  notify();
}

// keys an earlier release stored, for panes this page may never open
if (typeof window !== "undefined") paneLifetimes.forgetLineKeys();

// another herdr took the PC's pane IDs: its lines are read again from where they now are
paneLifetimes.onRetire((machineId) => {
  for (const owner of new Set([...memory.keys(), ...versions.keys()])) {
    const pane = paneStateKey(PREFIX + owner);
    if (pane?.machineId !== machineId) continue;
    // a key typed under the herdr the PC still has (storage took its record late) stays where it is
    if (memory.has(owner) && keyLifetimes.has(owner) && keyLifetimes.get(owner) === paneLifetimes.generation(machineId)) continue;
    keyLifetimes.delete(owner);
    // a line storage refused lives only here: it goes to recovery, not away
    const line = memory.get(owner);
    if (unsaved.delete(owner) && line !== undefined) paneLifetimes.keep(machineId, pane.paneId, "line", line);
    memory.delete(owner);
    // the line is another one now: a paste still waiting on the clipboard is not put into it
    versions.set(owner, terminalDraftVersion(owner) + 1);
  }
  notify();
});

/** An acknowledgement removes only the unchanged sent prefix, never replacement text. */
export function acknowledgeTerminalDraft(owner: string): void {
  const sent = pending.get(owner);
  const current = readTerminalDraft(owner);
  if (sent?.canClear && current.startsWith(sent.written)) writeTerminalDraft(owner, current.slice(sent.written.length));
}
