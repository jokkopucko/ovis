/**
 * How a request to the account service that an enrollment makes (accountController.ts) is sent again
 * (account/service.ts SendAgain): when it got no answer at all (AccountServiceUnreachableError: the connection dropped
 * under it) or the service said it is busy (429), within ACCOUNT_SENDS sends: a network that stays down ends it as it
 * always did.
 */
import { AccountServiceError, type SendAgain } from "../account/service.ts";

/** HTTP sends of one request in all, the first included. */
export const ACCOUNT_SENDS = 3;
/** The wait before the second, then the third send. A request that got no answer goes sooner once the browser is online again. */
export const NETWORK_RETRY_MS = [2_000, 8_000] as const;
/** The longest `retry-after` a busy answer (429) is waited out for: one that asks for longer ends the request as refused. */
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Sent again as above. A busy answer waits at least the `retry-after` it named; one that got no answer waits until the
 * browser is online again or its backoff is over. Either waits further while the page is hidden, so a tab left in the
 * background sends nothing. `before` runs immediately before each send, and ends it by throwing: the enrollment checks
 * there that it still owns its pairing. `signal` ends a wait, throwing its reason.
 */
export function sendAgainWhenBack(options: { readonly before: () => Promise<void>; readonly signal?: AbortSignal | undefined }): SendAgain {
  return {
    sends: ACCOUNT_SENDS,
    // a send again goes only from a page that is shown, checked last: a page hidden while the token refresh or the
    // checks before it were out waits until it is shown, then checks again
    before: async (send) => {
      for (;;) {
        await options.before();
        if (send === 1 || document.visibilityState !== "hidden") return;
        await shown(options.signal);
      }
    },
    wait: async (error, sent) => {
      const backoff = NETWORK_RETRY_MS[Math.min(sent, NETWORK_RETRY_MS.length) - 1] ?? NETWORK_RETRY_MS[0];
      const busy = error instanceof AccountServiceError ? Math.max(error.retryAfterMs ?? 0, backoff) : null;
      if (busy !== null && busy > RETRY_AFTER_MAX_MS) return false;
      console.warn("Ovis: a request to the account service failed while this PC joined the account; sending it again", error.name);
      await pause(busy ?? backoff, busy === null, options.signal);
      return true;
    },
  };
}

/** Settles once the page is shown: at once when it is. `signal` ends it, throwing its reason. */
function shown(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (document.visibilityState !== "hidden") { resolve(); return; }
    const end = (): void => { document.removeEventListener("visibilitychange", visible); signal?.removeEventListener("abort", aborted); };
    const visible = (): void => { if (document.visibilityState !== "hidden") { end(); resolve(); } };
    const aborted = (): void => { end(); reject(signal?.reason); };
    document.addEventListener("visibilitychange", visible);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** `ms`, then until the page is shown; `online`: the browser's online event ends it sooner, once the page is shown. */
function pause(ms: number, online: boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const end = (): void => {
      clearTimeout(timer);
      window.removeEventListener("online", ready);
      document.removeEventListener("visibilitychange", shown);
      signal?.removeEventListener("abort", aborted);
    };
    const go = (): void => { end(); resolve(); };
    const aborted = (): void => { end(); reject(signal?.reason); };
    const shown = (): void => { if (document.visibilityState !== "hidden") go(); };
    // the wait is over: at once on a page that is shown, else once it is
    const ready = (): void => {
      if (document.visibilityState !== "hidden") { go(); return; }
      document.addEventListener("visibilitychange", shown);
    };
    if (online) window.addEventListener("online", ready);
    signal?.addEventListener("abort", aborted, { once: true });
    // fixed wait: a backoff between sends (or the service's own retry-after), not a wait for a state
    const timer = setTimeout(ready, ms);
  });
}
