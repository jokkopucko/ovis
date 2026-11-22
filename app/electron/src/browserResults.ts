/**
 * The files the built-in browser kept (its downloads) in this run of the app, as the page's right
 * panel lists them (src/lib/desktopBrowser.ts): newest first, at most MAX_RESULTS, and where each
 * was kept, which only main reads (to show a finished one in its folder).
 */
import type { BrowserProfile } from "./browserTabs.ts";

export interface BrowserResult {
  id: string;
  kind: "download";
  name: string;
  /** ms since the epoch */
  at: number;
  bytes: number | null;
  done: boolean;
  tab: number | null;
  profile: BrowserProfile;
}

export const MAX_RESULTS = 50;

export class BrowserResults {
  private kept: { result: BrowserResult; path: string }[] = [];

  add(result: BrowserResult, path: string): void {
    this.kept.unshift({ result, path });
    this.kept.splice(MAX_RESULTS);
  }

  finish(id: string, bytes: number): void {
    const entry = this.kept.find(({ result }) => result.id === id);
    if (entry) entry.result = { ...entry.result, done: true, bytes };
  }

  /** a download that failed or was cancelled leaves the list; one already pushed out of it changes nothing */
  drop(id: string): void {
    this.kept = this.kept.filter(({ result }) => result.id !== id);
  }

  list(): BrowserResult[] {
    return this.kept.map(({ result }) => result);
  }

  path(id: string): string | null {
    const entry = this.kept.find(({ result }) => result.id === id);
    return entry?.result.done ? entry.path : null;
  }
}
