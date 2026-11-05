import { getTransport, type EventSourceLike } from "./transport.ts";

/**
 * App's one event stream (/api/machines/events), kept open while the app is in. The browser
 * reconnects a lost EventSource by itself, but a non-200 answer to a reconnect (a proxy's 502 while
 * the server restarts behind `tailscale serve`, a 401) closes it for good: then a new one is opened
 * after a wait, which each failed opening doubles up to a minute and an opening starts over.
 */
export const STREAM_REOPEN_MS = 2_000;
export const STREAM_REOPEN_MAX_MS = 60_000;
/** EventSource.CLOSED, named here: the demo's stand-in (site/demo/transport.ts) has no statics */
const CLOSED = 2;

export interface EventStreamHandlers {
  /** opened, reopened by the browser, or opened anew after the browser gave up on the last one */
  opened(): void;
  /** lost; the browser is reconnecting it */
  lost(): void;
  /** the browser gave up on it; a new one opens after a wait */
  closed(): void;
  message(event: MessageEvent<string>): void;
}

/** Opens the stream and keeps one open until the returned stop is called. */
export function keepEventStream(url: string, handlers: EventStreamHandlers, open: (url: string) => EventSourceLike = (target) => getTransport().openEventSource(target)): () => void {
  let current: EventSourceLike | null = null;
  let reopen: ReturnType<typeof setTimeout> | undefined;
  let wait = STREAM_REOPEN_MS;
  const subscribe = () => {
    const source = open(url);
    current = source;
    source.onopen = () => {
      if (source !== current) return;
      wait = STREAM_REOPEN_MS;
      handlers.opened();
    };
    source.onerror = () => {
      if (source !== current) return;
      if (source.readyState !== CLOSED) { handlers.lost(); return; }
      handlers.closed();
      clearTimeout(reopen);
      reopen = setTimeout(subscribe, wait);
      wait = Math.min(wait * 2, STREAM_REOPEN_MAX_MS);
    };
    source.onmessage = (event: MessageEvent<string>) => { if (source === current) handlers.message(event); };
  };
  subscribe();
  return () => {
    clearTimeout(reopen);
    const source = current;
    current = null;
    source?.close();
  };
}
