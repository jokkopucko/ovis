export interface HideableWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  once(event: "leave-full-screen", listener: () => void): unknown;
  removeListener(event: "leave-full-screen", listener: () => void): unknown;
  hide(): void;
}

/**
 * Hides the window a close keeps in the tray. On macOS a full-screen window leaves full screen first and
 * hides once it has: hidden in full screen, its Space stays behind as a black screen (electron/electron#20263).
 * Returns what cancels a hide still waiting for that (the window opened again meanwhile), or null when it hid at once.
 */
export function hideWindow(window: HideableWindow, platform: NodeJS.Platform): (() => void) | null {
  if (platform !== "darwin" || !window.isFullScreen()) {
    window.hide();
    return null;
  }
  const hide = () => window.hide();
  window.once("leave-full-screen", hide);
  window.setFullScreen(false);
  return () => window.removeListener("leave-full-screen", hide);
}
