/**
 * Whether a phone's browser tab shows the line that says how to add Ovis to the home screen
 * (components/InstallHint.tsx): installed, the page gets alerts and keeps its storage. Desktop
 * browsers, the desktop app and the phone apps never see it, nor does a page served over plain
 * http, which gets no alerts installed either.
 */

export type InstallHintKind = "ios" | "android";

export interface InstallHintEnvironment {
  userAgent: string;
  /** iPadOS reports a Mac user agent; touch points tell the two apart */
  maxTouchPoints: number;
  secure: boolean;
  installed: boolean;
  nativeApp: boolean;
  dismissed: boolean;
}

export function installHintKind(env: InstallHintEnvironment): InstallHintKind | null {
  if (env.installed || env.nativeApp || env.dismissed || !env.secure) return null;
  if (/iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(env.userAgent)) return "android";
  return null;
}

const KEY = "ovis:install-hint-dismissed";

export function readHintDismissed(): boolean {
  try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function writeHintDismissed(): void {
  try { window.localStorage.setItem(KEY, "1"); } catch { }
}
