import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { inboxStartsOpen } from "./agentInbox.ts";
import { NAV_KEY, type AppLink } from "./deepLink.ts";
import { SEEN_KEY } from "./historyKeys.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";

const PARAM = "app";
const INBOX = "inbox";

export function inboxAddress(search: string): boolean {
  return new URLSearchParams(search).get(PARAM) === INBOX;
}

export function withInboxAddress(search: string, inbox: boolean): string {
  const query = new URLSearchParams(search);
  if (inbox) query.set(PARAM, INBOX);
  else if (query.get(PARAM) === INBOX) query.delete(PARAM);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * The state stays with its entry over a reload and when the browser restores the tab or loads it
 * again after discarding it, which a browser may report as a navigation.
 */
export function freshNavigation(type: string | undefined, state: unknown): boolean {
  return type !== "reload" && type !== "back_forward" && state === null;
}

/** How the browser says this page was loaded: navigate, reload, back_forward or prerender; undefined where it does not say. */
export function pageNavigation(): string | undefined {
  const [entry] = window.performance?.getEntriesByType?.("navigation") ?? [];
  return (entry as { type?: string } | undefined)?.type;
}

export function paneAddressStartsInInbox(link: AppLink | null): boolean {
  return Boolean(link?.pane);
}

export function startsInInbox(setting: boolean, phone: boolean, link: AppLink | null, fresh: boolean): boolean {
  return setting && phone && fresh && (inboxStartsOpen(true, link) || paneAddressStartsInInbox(link));
}

export function pageStartsInInbox(setting: boolean, phone: boolean, link: AppLink | null): boolean {
  return startsInInbox(setting, phone, link, freshNavigation(pageNavigation(), window.history.state));
}

export interface InboxMode {
  on: boolean;
  at(): boolean;
  enter(): void;
  leave(): void;
  drawerBlocked: RefObject<boolean>;
}

export function useInboxMode({ startsIn }: {
  startsIn?: () => boolean;
} = {}): InboxMode {
  const [starts] = useState(() => startsIn?.() === true);
  const [on, setOn] = useState(() => starts || inboxAddress(pageSearch()));
  const drawerBlocked = useRef(on);
  useEffect(() => {
    const address = starts && !inboxAddress(pageSearch()) ? pageAddress(window.location.pathname, withInboxAddress(pageSearch(), true), window.location.hash) : undefined;
    // An entry the app has stood on carries a state (freshNavigation): the one the page loaded on from here, and one
    // left without a state since (the auth link's own replace, a fragment typed into the address) by the time the
    // page is hidden, which comes before the browser can discard the tab or close with it.
    const seen = (): void => { if (window.history.state === null) window.history.replaceState({ [SEEN_KEY]: true }, ""); };
    const hidden = (): void => { if (document.visibilityState === "hidden") seen(); };
    if (address !== undefined) window.history.replaceState(window.history.state ?? { [SEEN_KEY]: true }, "", address);
    else seen();
    window.addEventListener("pagehide", seen);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", seen);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    const onPop = (): void => setOn(inboxAddress(pageSearch()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next: boolean): void => {
    const search = withInboxAddress(pageSearch(), next);
    if (search !== pageSearch()) window.history.pushState({ [NAV_KEY]: true }, "", pageAddress(window.location.pathname, search, window.location.hash));
    setOn(next);
  }, []);
  const enter = useCallback((): void => go(true), [go]);
  const leave = useCallback((): void => go(false), [go]);
  const at = useCallback((): boolean => inboxAddress(pageSearch()), []);
  return { on, at, enter, leave, drawerBlocked };
}
