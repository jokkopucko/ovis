/**
 * The desktop app's built-in browser as its bridge tells this page (app/electron/src/preload.ts,
 * `window.ovisBrowser`): the tabs main lists once their address was allowed, and what the browser
 * kept (downloads, an agent's screenshots). Null without the desktop app or while its setting is
 * off, where main answers null. Main is the authority on every field; this only reads them.
 */
import { useEffect, useState, useCallback } from "react";

export type DesktopBrowserProfile = "mine" | "agent";

export interface DesktopBrowserTab {
  id: number;
  profile: DesktopBrowserProfile;
  /** the address without its query, as main shows it */
  address: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** an agent tab a person holds: the agent's tools wait */
  held: boolean;
  /** the pane (on this PC) whose agent opened an agent tab; null for a person's own tab */
  owner: string | null;
}

export interface DesktopBrowserResult {
  id: string;
  kind: "download" | "screenshot";
  name: string;
  /** ms since the epoch */
  at: number;
  bytes: number | null;
  done: boolean;
  tab: number | null;
  profile: DesktopBrowserProfile;
}

export interface DesktopBrowser {
  tabs: DesktopBrowserTab[];
  results: DesktopBrowserResult[];
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bridge {
  current(): Promise<unknown>;
  onChange(listener: (browser: unknown) => void): () => void;
  close(id: number): void;
  thumbnail?(id: number): Promise<unknown>;
  reveal?(id: string): void;
  open?(url: string): Promise<number | null>;
  show?(id: number, bounds: BrowserBounds): void;
  hide?(): void;
  navigate?(id: number, url: string): Promise<boolean>;
  go?(id: number, step: "back" | "forward" | "reload" | "stop"): void;
  hold?(id: number, held: boolean): void;
}

function bridge(): Bridge | undefined {
  const found = typeof window === "undefined" ? undefined : (window as Window & { ovisBrowser?: Partial<Bridge> }).ovisBrowser;
  return typeof found?.current === "function" && typeof found.onChange === "function" && typeof found.close === "function" ? found as Bridge : undefined;
}

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const profile = (value: unknown): DesktopBrowserProfile | null => value === "mine" || value === "agent" ? value : null;

function tab(value: unknown): DesktopBrowserTab | null {
  const row = record(value);
  const kind = profile(row?.["profile"]);
  if (!row || kind === null || typeof row["id"] !== "number" || typeof row["address"] !== "string") return null;
  return {
    id: row["id"],
    profile: kind,
    address: row["address"],
    title: typeof row["title"] === "string" ? row["title"] : "",
    loading: row["loading"] === true,
    canGoBack: row["canGoBack"] === true,
    canGoForward: row["canGoForward"] === true,
    held: row["held"] === true,
    owner: typeof row["owner"] === "string" ? row["owner"] : null,
  };
}

const validTime = (value: unknown): value is number => typeof value === "number" && !Number.isNaN(new Date(value).getTime());

function result(value: unknown): DesktopBrowserResult | null {
  const row = record(value);
  const kind = row?.["kind"];
  const owner = profile(row?.["profile"]);
  if (!row || (kind !== "download" && kind !== "screenshot") || owner === null || typeof row["id"] !== "string" || typeof row["name"] !== "string" || !validTime(row["at"])) return null;
  return {
    id: row["id"],
    kind,
    name: row["name"],
    at: row["at"],
    bytes: typeof row["bytes"] === "number" && Number.isFinite(row["bytes"]) && row["bytes"] >= 0 ? row["bytes"] : null,
    done: row["done"] === true,
    tab: typeof row["tab"] === "number" ? row["tab"] : null,
    profile: owner,
  };
}

/** The bridge's view as this page reads it; a field main does not send yet reads as empty. */
export function desktopBrowserView(value: unknown): DesktopBrowser | null {
  const view = record(value);
  if (!view) return null;
  const list = <T,>(rows: unknown, read: (row: unknown) => T | null): T[] => Array.isArray(rows) ? rows.map(read).filter((row): row is T => row !== null) : [];
  return { tabs: list(view["tabs"], tab), results: list(view["results"], result) };
}

/** The built-in browser while the desktop app has it on, else null. */
export function useDesktopBrowser(): DesktopBrowser | null {
  const [browser, setBrowser] = useState<DesktopBrowser | null>(null);
  useEffect(() => {
    const found = bridge();
    if (!found) return;
    let alive = true;
    // a change main sent (off included) is newer than any answer still on its way
    let changed = false;
    const stop = found.onChange((next) => {
      changed = true;
      if (alive) setBrowser(desktopBrowserView(next));
    });
    found.current().then((next) => { if (alive && !changed) setBrowser(desktopBrowserView(next)); }, () => undefined);
    return () => { alive = false; stop(); };
  }, []);
  return browser;
}

export function closeBrowserTab(id: number): void {
  bridge()?.close(id);
}

/** shows a kept file in its folder (main never opens it); false where main has no way to */
export function revealBrowserResult(id: string): boolean {
  const reveal = bridge()?.reveal;
  if (typeof reveal !== "function") return false;
  reveal(id);
  return true;
}

/** A small picture of an allowed tab, taken by main when asked and kept nowhere; null while main draws none of it. */
export async function browserTabThumbnail(id: number): Promise<string | null> {
  const thumbnail = bridge()?.thumbnail;
  if (typeof thumbnail !== "function") return null;
  const picture = await thumbnail(id).catch(() => null);
  return typeof picture === "string" && picture.startsWith("data:image/") ? picture : null;
}

/** Whether this page runs in the desktop app, whose built-in browser a setting turns on. */
export function hasDesktopBrowser(): boolean {
  return bridge() !== undefined;
}

/** a tab of the person's own on `url`: its id, or null when main refused the address or has no place for one */
export async function openBrowserTab(url: string): Promise<number | null> {
  const open = bridge()?.open;
  return typeof open === "function" ? open(url).catch(() => null) : null;
}

/** has main draw the tab over `bounds` of the window, in the page's CSS pixels */
export function showBrowserTab(id: number, bounds: BrowserBounds): void {
  bridge()?.show?.(id, bounds);
}

export function hideBrowserTab(): void {
  bridge()?.hide?.();
}

/** loads another address in a tab of the person's own, or in an agent's tab they hold */
export async function navigateBrowserTab(id: number, url: string): Promise<boolean> {
  const navigate = bridge()?.navigate;
  return typeof navigate === "function" ? navigate(id, url).catch(() => false) : false;
}

export function goBrowserTab(id: number, step: "back" | "forward" | "reload" | "stop"): void {
  bridge()?.go?.(id, step);
}

/** a person takes an agent's tab (the agent waits) or hands it back */
export function holdBrowserTab(id: number, held: boolean): void {
  bridge()?.hold?.(id, held);
}

/**
 * What a person types in the address field: a web address. Without a scheme it takes https://, and
 * http:// for this PC's own pages (a dev server on localhost), which seldom have a certificate, unless port 443 is typed.
 */
export function typedAddress(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  const schemed = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(trimmed);
  try {
    const url = new URL(schemed ? trimmed : `https://${trimmed}`);
    const typedPort = schemed ? null : /^[^/?#]*:(\d+)(?:[/?#]|$)/.exec(trimmed)?.[1] ?? null;
    if (!schemed && typedPort !== "443" && /^(?:localhost|.+\.localhost|127(?:\.\d+){3}|\[::1\])$/i.test(url.hostname)) url.protocol = "http:";
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Which built-in browser tab the file panel's place shows: a tab's id, "new" for a tab of the person's own yet to
 * open, or null. A tab opened from "new" is shown once main lists it (its first address allowed); a tab that goes
 * away, or the whole browser turned off, shows nothing.
 */
export function useShownBrowserTab(tabs: DesktopBrowserTab[] | null) {
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  // a choice made while a typed tab is still on its way wins over it, whether main has answered yet or not
  const select = useCallback((next: number | "new" | null) => { setOpening(null); setSelected(next); }, []);
  const shown = tabs === null || selected === null || selected === "new" ? null : tabs.find((tab) => tab.id === selected) ?? null;
  useEffect(() => {
    if (tabs === null || (typeof selected === "number" && shown === null)) setSelected(null);
    if (opening !== null && selected !== "new") setOpening(null);
    else if (opening !== null && tabs?.some((tab) => tab.id === opening)) {
      setSelected(opening);
      setOpening(null);
    }
  }, [tabs, selected, shown, opening]);
  return { selected, select, shown, opened: setOpening };
}
