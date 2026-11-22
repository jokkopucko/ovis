import type { GuideState } from "./setupGuideFlow.ts";

const OPEN_EVENT = "ovis:open-setup-guide";

export function openSetupGuide(at?: GuideState["at"]): void {
  window.dispatchEvent(new CustomEvent<GuideState["at"]>(OPEN_EVENT, { detail: at }));
}

export function onSetupGuideRequest(listener: (at: GuideState["at"]) => void): () => void {
  const handle = (event: Event): void => listener(event instanceof CustomEvent && (event.detail === "theme" || event.detail === "phone") ? event.detail : undefined);
  window.addEventListener(OPEN_EVENT, handle);
  return () => window.removeEventListener(OPEN_EVENT, handle);
}
