import { createContext } from "react";

export const WEB_LINK_TARGETS = ["tab", "panel"] as const;
export type WebLinkTarget = (typeof WEB_LINK_TARGETS)[number];

export interface AppLocation {
  protocol: string;
  hostname: string;
  origin: string;
}

export type WebPanelOpener = (uri: string, shiftKey: boolean, machineId: string) => boolean;

/** Whether a link click asks the app to take over, keeping the browser's modifier-click meanings. */
export function shouldOpenWebPage(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  uri: string,
  openWebPage: WebPanelOpener | null,
  machineId: string,
): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey
    && (openWebPage?.(uri, event.shiftKey, machineId) ?? false);
}

/** Names a pane prints for the PC it runs on: a dev server's own "Local: http://localhost:5173/". */
const LOOPBACK = /^(?:localhost|[^.]+(?:\.[^.]+)*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

/**
 * The address the panel frames for `uri`, or null when it opens in a tab. Only a page served
 * by the PC this app runs on is framed, on another port than the app's: the app's policy
 * (server/static.ts) frames that host alone, and most other sites refuse to be framed anyway.
 * A loopback name means that PC, so it is reached under the host the browser used for the app:
 * from another computer, `localhost:5173` would be that computer's own. An https app cannot
 * frame an http page (mixed content), so that one opens in a tab too.
 */
export function panelUrl(uri: string, app: AppLocation): string | null {
  if (!/^https?:\/\//i.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (LOOPBACK.test(url.hostname)) url.hostname = app.hostname;
  else if (url.hostname.toLowerCase() !== app.hostname.toLowerCase()) return null;
  if (url.origin === app.origin) return null;
  if (app.protocol === "https:" && url.protocol === "http:") return null;
  return url.href;
}

export function wantsPanel(target: WebLinkTarget, shiftKey: boolean): boolean {
  return (target === "panel") !== shiftKey;
}

/**
 * Opens a web address in the docked panel or narrow-screen popup when the setting (or Shift) asks
 * for it and the address can be framed; false leaves the caller's new-tab behavior in place.
 * `machineId` is the PC whose pane named the address.
 */
export const WebPanelContext = createContext<WebPanelOpener | null>(null);
