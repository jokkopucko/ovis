/**
 * Runs a frame later, once React has taken the vanished control out of the document.
 */
export function focusWorkspaceListToggle(when: "always" | "lost" = "always"): void {
  window.requestAnimationFrame(() => {
    if (when === "lost" && document.activeElement !== null && document.activeElement !== document.body) return;
    const shown = (selector: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>(selector)].find((toggle) => toggle.getClientRects().length > 0);
    (shown(".app-header .drawer-toggle, .app-header .sidebar-toggle") ?? shown(".app-header .inbox-back"))?.focus();
  });
}

/**
 * Whether a modal surface is up (Settings, a dialog). A pane that appears under one, as a link
 * that opens Settings mounts it beneath the dialog (lib/deepLink.ts), must not take the focus out
 * of the modal: its composer and its grid leave the keyboard where it is.
 */
export function modalOpen(): boolean {
  return document.querySelector("[aria-modal='true'], dialog[open]") !== null;
}
