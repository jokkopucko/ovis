/**
 * The one way the client opens an address outside the app: a link to click (`ExternalLink`), an
 * address opened from code (`openExternal`) and a tab held in a click for a sign-in (`reserveTab`).
 * The shell decides which browser shows it (a tab here; the system browser in the apps). `kind`
 * names what the address is, for the place that will route it: `link` a page on the web,
 * `sign-in` a sign-in page, `ovis` an Ovis page (another PC's, a file in a tab of its own).
 * In the desktop and Mac apps a web `link` opens in the browser chosen in Settings (`linkBrowsers`); every
 * other address keeps to the system browser. src/conventions.test.ts keeps every other file off
 * target="_blank" and window.open.
 */
import { createElement, type AnchorHTMLAttributes, type MouseEvent, type ReactElement, type Ref } from "react";

import { isWebLink } from "../../shared/terminal-links.ts";
import { inMacApp, inNativeApp } from "./nativeApp.ts";
import { safariAddress } from "./safariLinks.ts";

export type ExternalLinkKind = "link" | "sign-in" | "ovis";

export interface LinkBrowserChoices {
  browsers: { id: string; name: string }[];
  systemDefault: string | null;
  /** null: the system default */
  chosen: string | null;
}

/** The desktop and Mac apps' browsers for web links (app/electron/src/browsers.ts, app/mac/.../LinkBrowsers.swift); a page names one by its id. */
export interface LinkBrowsers {
  list(): Promise<LinkBrowserChoices | null>;
  choose(id: string | null): Promise<void>;
  open(url: string): void;
}

/** A web address the chosen browser takes: never this app's own pages, which the app keeps (a new Ovis window). */
function choosesBrowser(kind: ExternalLinkKind, url: string): boolean {
  if (kind !== "link" || !isWebLink(url)) return false;
  try { return typeof location === "undefined" || new URL(url).origin !== location.origin; } catch { return false; }
}

export function linkBrowsers(): LinkBrowsers | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisBrowsers?: Partial<LinkBrowsers> }).ovisBrowsers;
  return typeof bridge?.list === "function" && typeof bridge.choose === "function" && typeof bridge.open === "function" ? bridge as LinkBrowsers : null;
}

/**
 * Whether this page can keep a browser tab to reuse. The iOS, Android, Mac and desktop apps hand an
 * external address to the system browser, so the window they give back is never that tab.
 */
export function canReuseExternalLinkTab(): boolean {
  return !inNativeApp() && !inMacApp() && !(typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent));
}

/**
 * A URI this app opens in a new tab: an http(s) address and nothing else. Both link paths in
 * PaneTerminal answer to it, so a line crafted to look like a link cannot hand the browser a
 * scheme of its own choosing (`javascript:`, `data:`, an OS handler).
 */
export { isWebLink };

/**
 * Makes an http(s) link opener. Each instance owns at most one reusable tab. A browser lets a page
 * steer a tab of another site only as its opener, so the reused tab keeps its opener: the site in it
 * can see and navigate this tab. That is why reuse is a setting, off by default; a new tab has none.
 */
export function createWebLinkOpener(): (uri: string, reuse: boolean) => void {
  let reusable: Window | null = null;
  const newTab = (uri: string): void => {
    const link = document.createElement("a");
    link.href = uri;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
  };
  return (uri, reuse) => {
    const address = safariAddress(uri);
    if (address !== uri) {
      newTab(address);
      return;
    }

    if (!reuse || !canReuseExternalLinkTab()) {
      newTab(uri);
      return;
    }
    try {
      if (reusable === null || reusable.closed) {
        reusable = window.open(uri, "_blank");
        if (reusable === null) newTab(uri);
        return;
      }
      reusable.location.href = uri;
      reusable.focus();
    } catch {
      // the browser refused to open or steer that tab (say, it no longer counts this page as its opener): a click never does nothing
      reusable = null;
      newTab(uri);
    }
  };
}

const openWebLink = createWebLinkOpener();

/**
 * Opens `url` outside the app from code. An http(s) address reuses the one external tab when
 * `reuse` (the "Reuse tab for external links" setting, for a plain click); any other address gets
 * a tab of its own, with no opener or referrer.
 */
export function openExternal(url: string, kind: ExternalLinkKind, reuse = false): void {
  const browsers = choosesBrowser(kind, url) ? linkBrowsers() : null;
  if (browsers) browsers.open(url);
  else if (isWebLink(url)) openWebLink(url, reuse);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * A blank tab opened in the click itself, before anything is awaited (a tab opened later is a
 * popup the browser blocks), to send to a sign-in page once the service names it. The page it gets
 * has no handle on this one. Null when the browser blocked it. In the desktop app the blank window
 * hands the address it is sent to to the system browser (app/electron/src/main.ts, guard).
 */
export function reserveTab(): Window | null {
  const tab = window.open("about:blank", "_blank");
  if (tab !== null) tab.opener = null;
  return tab;
}

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & {
  kind: ExternalLinkKind;
  /** send the page's address as the referrer: only to this app's own pages (the file viewer's) */
  referrer?: boolean;
  ref?: Ref<HTMLAnchorElement>;
};

/** `href` as the page resolves it, or `href` itself where there is no page or it does not parse. */
function resolvedHref(href: string): string {
  if (typeof location === "undefined") return href;
  try { return new URL(href, location.origin).href; } catch { return href; }
}

export function ExternalLink({ kind, referrer = false, href, onClick, ...props }: ExternalLinkProps): ReactElement {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    // only a plain click: a modified one keeps what the browser or the app does with it
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || href === undefined) return;
    // a protocol-relative `//host/path` is another site's address too, so the Safari rule reads it resolved
    const address = resolvedHref(href);
    if (safariAddress(address) !== address) {
      event.preventDefault();
      openExternal(address, kind);
      return;
    }

    if (!choosesBrowser(kind, href)) return;
    const browsers = linkBrowsers();
    if (!browsers) return;
    event.preventDefault();
    browsers.open(href);
  };
  return createElement("a", { href, target: "_blank", rel: referrer ? "noopener" : "noopener noreferrer", ...props, onClick: click });
}
