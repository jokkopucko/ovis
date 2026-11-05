/**
 * The first-run setup guide's opener: the guide (onboarding PR 3) listens, and Settings → Agents' Setup guide
 * (PR 4) asks. A request is a window event, so the page that opens it needs no handle on the
 * component that draws it.
 */
const OPEN_EVENT = "ovis:open-setup-guide";

/** Opens the setup guide again, from its first step; what was set up before stays as it is. */
export function openSetupGuide(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Calls `listener` on every request to open the guide; returns the unsubscribe. */
export function onSetupGuideRequest(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}
