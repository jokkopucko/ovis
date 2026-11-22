/**
 * herdr gives a pane a new ID when it moves to another workspace (`pane.move`). What this browser
 * keeps under the old ID and the user would miss goes to the new one: the chat's draft, the input
 * the terminal held while it was cut off, and the lens picked for the pane. Nothing is sent: the
 * text waits there for its Send or Discard, as it did before. What another browser keeps, and a
 * move made elsewhere (herdr's TUI), are not seen here.
 */
import { paneStorageId } from "../../shared/machines.ts";
import { moveChatPosition } from "./chatScrollMemory.ts";
import { pendingMessages } from "./pendingMessages.ts";
import { currentSidebarPins, movedSidebarPins, setSidebarPins } from "./sidebarPins.ts";
import { composerDrafts, sendLease, underSendLock, type ComposerDraftStore } from "./composerDraft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { PANE_VIEW_KEY_PREFIX } from "./settings.ts";
import { REPLY_COMMENTS_PREFIX, replyComments, type ReplyCommentStore } from "./replyComments.ts";
import { readTerminalDraft, terminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CARRIED = ["ovis:terminal-draft:", PANE_VIEW_KEY_PREFIX];

export function carryPaneState(machineId: string, from: string, to: string, drafts: ComposerDraftStore = composerDrafts, storage: () => KeyStorage = () => paneLifetimes.paneStorage,
  comments: ReplyCommentStore = replyComments): void {
  const before = paneStorageId(machineId, from);
  const after = paneStorageId(machineId, to);
  // Inside the old ID's send lock, so no tab's send claims them half moved (#2369)
  underSendLock(`ovis:composer-draft:${before}`, () => {
    const draft = `ovis:composer-draft:${before}`;
    const lease = sendLease(storage(), draft);
    comments.move(REPLY_COMMENTS_PREFIX + before, REPLY_COMMENTS_PREFIX + after, lease && { draft, at: lease.at });
    if (lease !== null) {
      drafts.refresh(draft);
      const unsubscribe = drafts.subscribe(() => {
        if (drafts.read(draft).sending) return;
        unsubscribe();
        comments.refresh();
      });
    }
    drafts.move(`ovis:composer-draft:${before}`, `ovis:composer-draft:${after}`);
  });
  const line = readTerminalDraft(before);
  if (line && !terminalDraftSending(before) && !readTerminalDraft(after)) {
    writeTerminalDraft(after, line);
    writeTerminalDraft(before, "");
  }
  // through the herdr fence (lib/paneLifetime.ts): a PC whose herdr is not proven keeps them in this page
  for (const prefix of CARRIED) {
    try {
      const value = storage().getItem(prefix + before);
      // a key the new ID holds already is that pane's own
      if (value === null || storage().getItem(prefix + after) !== null) continue;
      storage().setItem(prefix + after, value);
      storage().removeItem(prefix + before);
    } catch {}
  }
}

/**
 * Everything this browser keeps under a pane's ID, carried when herdr moved the pane under a new one, wherever
 * the move was made (the server's `pane-moved`, #1503): what carryPaneState carries, the pane's pending-message
 * rows (held as they were: nothing is sent), its place in the chat and its sidebar pin. Safe to run again for the same move (each
 * tab hears it, the moving one also from its own request): what was carried is not under the old ID any more.
 */
export function carryMovedPane(machineId: string, from: string, to: string): void {
  if (from === to) return;
  carryPaneState(machineId, from, to);
  const before = paneStorageId(machineId, from), after = paneStorageId(machineId, to);
  pendingMessages.move(before, after);
  moveChatPosition(before, after);
  setSidebarPins(movedSidebarPins(currentSidebarPins(), machineId, from, to));
}

type PaneTarget = { machineId: string; paneId: string };

export function movedView<S extends { panes: Record<string, PaneTarget> }>(selection: { machineId: string | null; paneId: string | null }, split: S | null, machineId: string, from: string, to: string): { selection: string | null; split: S | null } {
  const moved = split === null ? [] : Object.entries(split.panes).filter(([, pane]) => pane.machineId === machineId && pane.paneId === from);
  return {
    selection: selection.machineId === machineId && selection.paneId === from ? to : null,
    split: split !== null && moved.length > 0 ? { ...split, panes: { ...split.panes, ...Object.fromEntries(moved.map(([slot]) => [slot, { machineId, paneId: to }])) } } : null,
  };
}
