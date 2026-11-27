/** Paired synchronous notifications around an instant layout scroll, also used by the list patch. */
export const LAYOUT_SCROLL_START = "ovis:layout-scroll-start";
export const LAYOUT_SCROLL_END = "ovis:layout-scroll-end";

/** A layout write must not disguise a reader's scroll whose event has not arrived yet. */
export function layoutScroll(node: HTMLElement, write: () => void): void {
  // the node's own window makes the event, so a document in another realm (a test page) accepts it
  const NodeEvent = node.ownerDocument?.defaultView?.Event ?? Event;
  node.dispatchEvent(new NodeEvent(LAYOUT_SCROLL_START, { bubbles: true }));
  try { write(); }
  finally { node.dispatchEvent(new NodeEvent(LAYOUT_SCROLL_END, { bubbles: true })); }
}
