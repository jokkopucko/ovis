/**
 * A few words of each agent pane's first message, shared with the other browsers of the server
 * (the `tab_labels` of shared/preferences.ts, through lib/preferencesSync.ts). A tab herdr still
 * names by its number shows them (lib/tabName.ts autoTabLabel), so tabs of the same agent tell
 * apart (#2019). It is an Ovis display name only: herdr's tab label is never written, so herdr's
 * own tab row and its other clients keep theirs.
 *
 * A label is keyed with the pane's PC, its id and its terminal (`tabLabelKey`): herdr reuses pane
 * ids after a restart, never a terminal id, so a new pane never shows an old one's words. A label
 * leaves once this page saw its pane and then saw it gone (`settleTabLabels`), and the server drops
 * all when the setting is turned off. Only the short label is kept, never the message.
 *
 * A line is learned once per pane, from what Ovis knows first: the New tab dialog's first message,
 * a transcript read from its beginning, or a Chat send delivered to a pane with no transcript. It
 * is first held by pane id (`pending`) and keyed once the pane's terminal is seen in a snapshot.
 * Only a user's own action shares it (the dialog's Start, a message delivered from Chat to an agent's
 * pane): a label read from a transcript is this page's alone (`shownTabLabels`) until then, so
 * reading or watching a pane never writes the shared preferences.
 */

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { capTabLabels, MAX_TAB_LABEL_LENGTH } from "../../shared/preferences.ts";
import type { ConversationResponse, ConversationTurn, PaneInfo } from "../../shared/protocol.ts";

/** how many columns a tab shows of the line before it is cut with an ellipsis; a wide character (Hangul, CJK, an emoji) takes two */
export const SHORT_TAB_LABEL_COLUMNS = 24;
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

let labels: Readonly<Record<string, string>> = {};
/** labels read from a transcript and not yet shared by a user's action: this page's alone */
let localLabels: Readonly<Record<string, string>> = {};
/** the shared labels and this page's own, as the tabs show them */
let shown: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();
/** labels learned for a pane whose terminal this page has not seen yet, by `paneStorageId`; `shared` once a user's action shares it */
const pending = new Map<string, { label: string; shared: boolean }>();
/** off on a watching device, and while the setting is off: nothing is learned */
let learning = true;
/** the labels whose pane and terminal this page has seen live: only those can be seen gone */
const seen = new Set<string>();
/** labels seen gone: their terminal is never back, so one a save brings back again leaves again */
const gone = new Set<string>();

export function tabLabelKey(machineId: string, pane: Pick<PaneInfo, "pane_id" | "terminal_id">): string {
  return `${paneStorageId(machineId, pane.pane_id)}|${pane.terminal_id}`;
}

/** The labels as this page knows them: the server's, and the ones learned here and not yet sent. */
export function currentTabLabels(): Readonly<Record<string, string>> {
  return labels;
}

const sameMap = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => {
  const before = Object.entries(a);
  const after = Object.entries(b);
  return before.length === after.length && after.every(([key, line], index) => before[index]?.[0] === key && before[index]?.[1] === line);
};

function changed(): void {
  shown = { ...localLabels, ...labels };
  for (const listener of [...listeners]) listener();
}

/** The shared labels (lib/preferencesSync.ts): the server's, and the ones a user's action shared here and not yet sent. */
export function setTabLabels(next: Readonly<Record<string, string>>): void {
  if (sameMap(labels, next)) return;
  labels = { ...next };
  changed();
}

function setLocalLabels(next: Readonly<Record<string, string>>): void {
  if (sameMap(localLabels, next)) return;
  localLabels = { ...next };
  changed();
}

/** The labels the tabs show: the shared ones and this page's own. */
export function shownTabLabels(): Readonly<Record<string, string>> {
  return shown;
}

export function subscribeTabLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A line's characters as drawn: graphemes, or code points where the browser has no Intl.Segmenter (Safari 14). */
function characters(text: string): string[] {
  return typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(({ segment }) => segment) : Array.from(text);
}

/** A line that names nothing a tab could be told by: a slash command, a path, a code fence. */
const NOT_A_NAME = /^(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/]|```|~~~)/;

/**
 * An attached file's mention, `@` and its absolute path (lib/compose.ts imageMention), which names
 * nothing a tab could be told by (#2637). An upload's path may hold spaces (a folder under
 * ~/Library), so one in the shape an upload takes (server/paste.ts: `<name>-<YYYYMMDD>-<HHMMSS>-
 * <8 hex>.<ext>`, a name with no space) is taken whole up to the next path or mention, as
 * lib/chatImages.ts reads it; any other path ends at a space. Only one in an upload folder `.ovis` may
 * run past a word ending in an image's extension, so the words after another mention never read as an
 * upload's path (#2682). A folder's " @" or " ~" followed by a space is part of it.
 */
const ATTACHMENT = /(^|\s)@(?:\/|~[\\/]|[A-Za-z]:[\\/])(?:(?:(?!\s(?:@\S|[\\/]|~[\\/]|[A-Za-z]:[\\/])).){0,1024}?[\\/]\.ovis[\\/][\p{L}\p{N}._-]*-\d{8}-\d{6}-[0-9a-f]{8}(?:\.[a-z0-9]{1,10})?(?=\s|$)|(?:(?!\s(?:@\S|[\\/]|~[\\/]|[A-Za-z]:[\\/])|\.(?:png|jpe?g|gif|webp)\s).){0,1024}?[\\/][\p{L}\p{N}._-]*-\d{8}-\d{6}-[0-9a-f]{8}(?:\.[a-z0-9]{1,10})?(?=\s|$)|\S*)/giu;

/**
 * A label an Ovis before #2637 learned with an attachment's mention in it (a label learned now never
 * holds one): it is never shown, and a new one takes its place.
 */
export function attachmentTabLabel(label: string): boolean {
  return /(?:^|\s)@(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(label);
}

/**
 * What the tab shows of a message: its first line that says something (not a slash command, a path
 * or a code fence) once attached files' mentions are left out, its spaces collapsed, a few words of it cut at a word's end when one is near
 * the limit, else at the limit (a language written without spaces), with an ellipsis when anything
 * was cut; null for a message with nothing to name a tab by.
 */
export function shortTabLabel(text: string): string | null {
  const line = text.split(/\r\n|[\n\r\u2028\u2029]/).map((part) => part.replace(ATTACHMENT, "$1").replace(/\s+/g, " ").trim()).find((part) => part !== "" && !NOT_A_NAME.test(part));
  if (line === undefined) return null;
  const head: string[] = [];
  let columns = 0;
  let space = -1;
  let spaceAt = 0;
  for (const segment of characters(line)) {
    const width = WIDE.test(segment) ? 2 : 1;
    if (columns + width > SHORT_TAB_LABEL_COLUMNS || head.join("").length + segment.length >= MAX_TAB_LABEL_LENGTH) {
      const kept = space >= 0 && spaceAt >= SHORT_TAB_LABEL_COLUMNS / 2 ? head.slice(0, space) : head;
      return `${kept.join("").trimEnd()}…`;
    }
    if (segment === " ") { space = head.length; spaceAt = columns; }
    head.push(segment);
    columns += width;
  }
  return line;
}

/** The setting, and whether this device may learn (a watching device takes the labels and learns none). */
export function setTabLabelLearning(setting: boolean, watching: boolean): void {
  learning = setting && !watching;
  if (!learning) pending.clear();
  // the setting off deletes this page's own labels too (the server deletes the shared ones), so none comes back on, or with a send
  if (!setting) setLocalLabels({});
}

/**
 * Learns a pane's label from `text` unless it has one, once its terminal is seen (`settleTabLabels`):
 * `shared` for a user's own action, else this page's alone until one shares it (`shareTabLabel`).
 */
export function learnTabLabel(machineId: string, paneId: string, text: string, shared = true): void {
  if (!learning) return;
  const id = paneStorageId(machineId, paneId);
  const held = pending.get(id);
  if (held !== undefined) { if (shared && !held.shared) { held.shared = true; changed(); } return; }
  const label = shortTabLabel(text);
  if (label === null) return;
  pending.set(id, { label, shared });
  // the roster's settling (App) keys it as soon as it can
  changed();
}

/**
 * Brings the labels in line with the PCs this page knows: a line learned for a pane the snapshot now
 * shows takes its key, and a label leaves once this page saw its pane on its terminal and then a
 * connected PC's roster without it (closed, or its id reused by another terminal after a restart).
 * A label whose pane this page never saw stays, however the roster looks: it may come from another
 * browser ahead of this page's roster. One that is never seen again is never shown either (its key
 * names its terminal), and leaves with the oldest past MAX_TAB_LABELS.
 */
export function settleTabLabels(machines: readonly Pick<Machine, "id" | "state" | "snapshot">[]): void {
  const authoritative = machines.filter((machine) => machine.state === "connected" && machine.snapshot !== null);
  const live = new Map<string, string>();
  for (const machine of authoritative) for (const pane of machine.snapshot!.panes) live.set(paneStorageId(machine.id, pane.pane_id), tabLabelKey(machine.id, pane));
  const liveKeys = new Set(live.values());
  const onPc = (key: string, machineId: string): boolean => machineId === "local" ? !key.startsWith("remote:") : key.startsWith(paneStorageId(machineId, ""));
  const keep = (map: Readonly<Record<string, string>>): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const [key, label] of Object.entries(map)) {
      if (attachmentTabLabel(label)) continue;
      if (liveKeys.has(key)) { seen.add(key); kept[key] = label; continue; }
      if (seen.has(key) && authoritative.some((machine) => onPc(key, machine.id))) { seen.delete(key); gone.add(key); }
      if (!gone.has(key)) kept[key] = label;
    }
    return kept;
  };
  const next = keep(labels);
  const local = keep(localLabels);
  for (const [id, { label, shared }] of pending) {
    const key = live.get(id);
    if (key === undefined) continue;
    pending.delete(id);
    // a label of this terminal is kept; one of an earlier terminal of the same pane id is never shown, and blocks nothing
    if (key in next || gone.has(key)) continue;
    seen.add(key);
    if (shared) { next[key] = local[key] ?? label; delete local[key]; }
    else if (!(key in local)) local[key] = label;
  }
  for (const key of Object.keys(local)) if (key in next) delete local[key];
  setLocalLabels(capTabLabels(local));
  setTabLabels(capTabLabels(next));
}

/** panes whose chat is drawn from the screen (no transcript Ovis reads): a message sent from Chat is the first Ovis can know of */
const untranscribed = new Set<string>();

/**
 * What a conversation answer teaches (ChatView): the first message of turns read from the beginning
 * (`cursor` null), and whether the pane has a transcript at all.
 */
export function learnFromConversation(machineId: string, paneId: string, conversation: Pick<ConversationResponse, "source" | "cursor" | "turns">): void {
  const id = paneStorageId(machineId, paneId);
  if (conversation.source === "scrollback") { untranscribed.add(id); return; }
  untranscribed.delete(id);
  if (conversation.cursor !== null) return;
  const first = firstPromptOf(conversation.turns);
  // a read is no one's action: the label stays this page's until a send shares it
  if (first !== null) learnTabLabel(machineId, paneId, first, false);
}

/**
 * A message delivered from Chat: it names the tab only where no transcript will say which message
 * came first, and only an agent's pane (a line typed to a shell names nothing). A pane with a
 * transcript learns its label from it instead, read from the beginning.
 */
export function learnFromSend(machineId: string, paneId: string, agent: string | null | undefined, text: string): void {
  if (!agent || !learning) return;
  const id = paneStorageId(machineId, paneId);
  // the user's send shares the label this page read from the pane's transcript
  const own = Object.keys(localLabels).filter((key) => key.startsWith(`${id}|`));
  if (own.length > 0) {
    setTabLabels(capTabLabels({ ...labels, ...Object.fromEntries(own.map((key) => [key, localLabels[key]!])) }));
    setLocalLabels(Object.fromEntries(Object.entries(localLabels).filter(([key]) => !own.includes(key))));
    return;
  }
  const held = pending.get(id);
  if (held !== undefined) { held.shared = true; changed(); return; }
  if (untranscribed.has(id)) learnTabLabel(machineId, paneId, text);
}

/** Every label, line and fact this page holds, as at its start: each test stands alone. */
export function forgetTabLabelsForTests(): void {
  labels = {};
  localLabels = {};
  shown = {};
  pending.clear();
  seen.clear();
  gone.clear();
  untranscribed.clear();
  learning = true;
}

/** The text of a conversation's first message, when the turns start at its beginning; null when it has none with words yet. */
export function firstPromptOf(turns: readonly ConversationTurn[]): string | null {
  const first = turns.find((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text.trim() !== ""));
  if (!first) return null;
  return first.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
}
