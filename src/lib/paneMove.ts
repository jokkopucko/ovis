/**
 * herdr gives a pane a new ID when it moves to another workspace (`pane.move`). What this browser
 * keeps under the old ID and the user would miss goes to the new one: the chat's draft, the input
 * the terminal held while it was cut off, and the lens picked for the pane. Nothing is sent: the
 * text waits there for its Send or Discard, as it did before. What another browser keeps, and a
 * move made elsewhere (herdr's TUI), are not seen here.
 */
import { paneStorageId } from "../../shared/machines.ts";
import { composerDrafts, type ComposerDraftStore } from "./composerDraft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { PANE_VIEW_KEY_PREFIX } from "./settings.ts";
import { REPLY_COMMENTS_PREFIX, replyComments } from "./replyComments.ts";
import { readTerminalDraft, terminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// the comments waiting on its replies (#511) go with it, as the draft they will be sent with does
const CARRIED = ["ovis:terminal-draft:", PANE_VIEW_KEY_PREFIX, REPLY_COMMENTS_PREFIX];

export function carryPaneState(machineId: string, from: string, to: string, drafts: ComposerDraftStore = composerDrafts, storage: () => KeyStorage = () => paneLifetimes.paneStorage): void {
  const before = paneStorageId(machineId, from);
  const after = paneStorageId(machineId, to);
  // a send on its way carries the comments it took, and settles them under the ID it went with: they stay there with it
  const sending = drafts.read(`ovis:composer-draft:${before}`).sending;
  drafts.move(`ovis:composer-draft:${before}`, `ovis:composer-draft:${after}`);
  // a touch screen's terminal input line, through its store (it keeps the line in memory too); a
  // line on its way stays, as a chat draft on its way does
  const line = readTerminalDraft(before);
  if (line && !terminalDraftSending(before) && !readTerminalDraft(after)) {
    writeTerminalDraft(after, line);
    writeTerminalDraft(before, "");
  }
  // through the herdr fence (lib/paneLifetime.ts): a PC whose herdr is not proven keeps them in this page
  for (const prefix of CARRIED) {
    if (prefix === REPLY_COMMENTS_PREFIX && sending) continue;
    try {
      const value = storage().getItem(prefix + before);
      // a key the new ID holds already is that pane's own
      if (value === null || storage().getItem(prefix + after) !== null) continue;
      storage().setItem(prefix + after, value);
      storage().removeItem(prefix + before);
    } catch { /* private mode: nothing was kept to carry */ }
  }
  replyComments.refresh();
}
