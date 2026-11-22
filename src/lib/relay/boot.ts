import "../../components/SheepMascot.css";

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppCrash, AppLoadFailed } from "../../components/AppCrash.tsx";
import { moveQueryToFragment, queryWithoutSignIn } from "../pageQuery.ts";
import { loadRelayShell } from "../relay.ts";
import { SHEEP_FOR } from "./sheepBadges.ts";

interface Page {
  location: { href: string; pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
}

/**
 * The offer travels in the fragment, which no request carries; taking it off the address before anything else runs keeps it out of the history entry, a bookmark, a shared tab and a screenshot of the
 * address bar, and a reload then lands on the saved PC instead of pairing again. What the page
 * shows rides in the fragment too (lib/pageQuery.ts) and stays; a query from an address made
 * before that reached the host with the page's load, and is moved into the fragment (in place of
 * any other fragment, as pageSearch reads it) so no later request carries it.
 */
export function takeEntryUrl(page: Page): string {
  const { href, pathname, search, hash } = page.location;
  // a sign-in's return (`#code=…&state=…`, account/signin.ts) leaves with the offer: its code is a credential too. So
  // does a link that starts a sign-in (`#sign-in=<provider>`), so a reload or Back does not start it again
  // A query naming one is dropped, never moved into the fragment (pageQuery.ts)
  const query = search.length > 1 ? queryWithoutSignIn(search) : "";
  const kept = query !== "" ? `#${query}` : enteredBy(hash) ? "" : hash;
  if (`${search}${hash}` !== kept) page.history.replaceState(null, "", pathname + kept);
  return href;
}

/** An offer, a link that starts a sign-in or a sign-in's return: what the shell reads from the entry alone. */
function enteredBy(hash: string): boolean {
  return hash.startsWith("#offer=") || hash.startsWith("#sign-in=") || signInFragment(hash);
}

function signInFragment(hash: string): boolean {
  const fields = new URLSearchParams(hash.slice(1));
  return fields.has("state") && (fields.has("code") || fields.has("error"));
}

/**
 * The start screen while the shell loads and reads this device's pairings: once the mascot is drawn, the page's
 * loading ring gives way to it in its badge, nothing else; the shell's first screen replaces it.
 */
export function showStart(container: ParentNode, load: () => Promise<Pick<typeof import("./mascot.ts"), "playMascot" | "SMALL_BELOW_PX">> = () => import("./mascot.ts")): Promise<void> {
  const boot = container.querySelector(".boot"), ring = boot?.querySelector(".boot-spinner");
  if (!boot || !ring) return Promise.resolve();
  const badge = document.createElement("span"), sheep = document.createElement("span");
  badge.className = "sheep-badge sheep-badge-112";
  sheep.className = "sheep-mascot sheep-mascot-112";
  badge.append(sheep);
  const quiet = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  // the ring and its words stay until the sheep is there to take their place
  return load()
    .then(({ playMascot, SMALL_BELOW_PX }) => {
      if (!ring.isConnected) return;
      ring.replaceWith(badge);
      boot.classList.add("relay-start");
      playMascot(sheep, SHEEP_FOR.start, { small: 112 < SMALL_BELOW_PX, quiet });
    })
    .catch((error: unknown) => { console.warn("Ovis: the mascot was not drawn", error); });
}

/**
 * Whether this tab navigated since the call (a fragment, an offer pasted in, Back). Boot starts it as it reads the entry,
 * before anything loads, so a navigation while the shell still loads counts too.
 */
export function watchNavigation(target: { addEventListener(type: string, listener: () => void): void }): () => boolean {
  let navigated = false;
  const note = (): void => { navigated = true; };
  target.addEventListener("hashchange", note);
  target.addEventListener("popstate", note);
  return () => navigated;
}

export type TabMemory = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const LOAD_RELOAD_KEY = "ovis:shell-load-reload";

/**
 * Whether the page reloads after the shell's code failed to load (a dropped link, a host between two
 * deployments): once, until a load succeeds (`shellLoaded`), recorded in the tab's sessionStorage so a
 * load that fails again after the reload shows the retry notice instead of reloading forever. A retry in
 * the page could not help: Chrome keeps a failed import's answer for the page's life, and Vite's loader
 * skips a stylesheet it tried before. Storage that throws answers no: a missed reload costs less than a loop.
 */
export function reloadAfterFailedLoad(memory: TabMemory | null): boolean {
  if (memory === null) return false;
  try {
    if (memory.getItem(LOAD_RELOAD_KEY) !== null) return false;
    memory.setItem(LOAD_RELOAD_KEY, "1");
    return memory.getItem(LOAD_RELOAD_KEY) !== null;
  } catch { return false; }
}

export function shellLoaded(memory: TabMemory | null): void {
  try { memory?.removeItem(LOAD_RELOAD_KEY); } catch { /* the next failure then shows the notice at once */ }
}

/**
 * The address a reload after a failed load opens: the entry's, whose offer or sign-in's return takeEntryUrl took off the
 * address before the shell could read it (the reloaded page takes it off again), with a query in the fragment as
 * takeEntryUrl keeps it, so no request carries it again. The offer takes the whole fragment, so an older link with both
 * keeps the offer and drops the query (a pane or a view to show). Null once the tab navigated since: the address it went
 * to stays.
 */
export function reloadAddress(entryUrl: string, navigated: boolean): string | null {
  if (navigated) return null;
  const { pathname, search, hash } = new URL(entryUrl);
  if (search.length <= 1 || enteredBy(hash)) return pathname + hash;
  const query = queryWithoutSignIn(search);
  return pathname + (query !== "" ? `#${query}` : "");
}

export function reloadAt(page: { history: Page["history"]; location: { reload(): void } }, address: string | null): void {
  if (address !== null) page.history.replaceState(null, "", address);
  page.location.reload();
}

function tabMemory(): TabMemory | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function bootRelayShell(container: HTMLElement, renderApp: () => Root, load: typeof loadRelayShell = loadRelayShell): void {
  const entryUrl = takeEntryUrl(window);
  const navigatedSinceEntry = watchNavigation(window);
  void showStart(container);
  // an older entry of this tab's history may still hold its query: it moves as the load's did, before the app reads it
  window.addEventListener("popstate", () => { moveQueryToFragment(window); });
  // data-relay-shell="mounted": the shell has read its entry to the end (a sign-in's return included), so whatever it
  // opens by itself has started; a test that changes the saved PCs waits for it
  const memory = tabMemory();
  void load().then(
    ({ mountRelayShell }) => {
      shellLoaded(memory);
      return mountRelayShell({ container, entryUrl, renderApp, navigatedSinceEntry }).then(() => { container.dataset["relayShell"] = "mounted"; });
    },
    (error: unknown) => {
      console.error("Ovis: the relay shell did not load", error);
      const retry = (): void => reloadAt(window, reloadAddress(entryUrl, navigatedSinceEntry()));
      if (reloadAfterFailedLoad(memory)) retry();
      else createRoot(container).render(createElement(AppLoadFailed, { retry }));
    },
  ).catch((error: unknown) => {
    console.error("Ovis: the relay shell did not start", error);
    createRoot(container).render(createElement(AppCrash, { error }));
  });
}
