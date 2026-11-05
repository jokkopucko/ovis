import type { LegendListRef } from "@legendapp/list/react";

// No row is this object, so the list finds nothing to scroll to.
const NO_ROW = Object.freeze({});
/**
 * The list's scrollToEnd does not scroll at once: it waits for the list's next commit, and then
 * for the layout to settle after a data change (up to 800 ms). A follow asked for while the reader
 * was at the end can so land after the reader paged or scrolled away, and pull them back. Any newer
 * scroll request supersedes a waiting one; a request for no row supersedes it without moving.
 */
export function dropPendingListScroll(list: LegendListRef | null): void {
  void list?.scrollToItem({ item: NO_ROW, animated: false });
}

/**
 * To hold the rows on screen where they were, the list pads the end of its content for a frame
 * (its ScrollAdjust sets the content's padding-bottom inline, and takes it away in the next
 * frame). While it is there, the scroller's end lies past the list's: a view put at the scroller's
 * end is put in that room, and the list taking it back moves the view up.
 */
export function listEndPadded(scroller: HTMLElement): boolean {
  const content = scroller.querySelector<HTMLElement>(".chat-transcript-virtual");
  return content !== null && content.style.paddingBottom !== "";
}
