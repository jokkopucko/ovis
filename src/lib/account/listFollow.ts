/**
 * When a device reads its account's list (docs/account-list.md, "On a device"): at once when something says the list
 * may have moved (a sign-in, the doorbell, the app coming to the front), and by the clock only while the app is in
 * front. How often is the list's own rule (accountList.ts, due); this only keeps the one timer.
 */
import type { AccountList } from "./accountList.ts";
import { SignedOutError } from "./service.ts";

/** The page a device's list is followed on: its clock, whether it is in front, and when that changes. */
export interface FollowingPage {
  now(): number;
  visible(): boolean;
  onVisibility(listener: () => void): () => void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const browserPage: FollowingPage = {
  now: () => Date.now(),
  visible: () => document.visibilityState === "visible",
  onVisibility(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Two rounds never begin closer than this, whatever a round says of when the next is due. */
export const ROUND_GAP_MS = 5_000;

export interface FollowedList {
  /** A round now: the list may have moved, or the sign-in changed. Settles when that round is over, whatever became of it. */
  poke(): Promise<void>;
  stop(): void;
}

export function followAccountList(list: AccountList, page: FollowingPage = browserPage): FollowedList {
  let timer: unknown;
  let stopped = false;
  let began = -Infinity;
  const disarm = (): void => {
    if (timer !== undefined) page.clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    disarm();
    if (stopped) return;
    const due = list.due(page.visible());
    if (due !== null) timer = page.setTimeout(() => { void run(); }, Math.max(0, Math.max(due, began + ROUND_GAP_MS) - page.now()));
  };
  const run = async (): Promise<void> => {
    // a round begun by a poke is the one a waiting timer would have begun
    disarm();
    if (stopped) return;
    began = page.now();
    await list.sync().catch((error: unknown) => {
      if (!(error instanceof SignedOutError)) console.warn("Ovis: the account's list could not be read", error instanceof Error ? error.name : error);
    }).finally(arm);
  };
  const unwatch = page.onVisibility(arm);
  return {
    poke: run,
    stop() {
      stopped = true;
      unwatch();
      arm();
    },
  };
}
