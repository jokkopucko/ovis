
export interface WebSocketLike {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
}

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (event: EventSourceEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  close(): void;
}

export interface Transport {
  readonly kind: "native" | "relay";
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  openSocket(url: string): WebSocketLike;
  openEventSource(url: string): EventSourceLike;
  resourceUrl(path: string, signal?: AbortSignal): string | Promise<string>;
  /** The carrier a relay transport has up now; undefined while it reconnects. */
  readonly route?: "relay" | "direct" | undefined;
  /** While `route` is `direct`: whether the carrier is on the PC's private address (`lan`) or its Tailscale one. */
  readonly directVia?: "lan" | "tailscale" | undefined;
  /** While a relay transport reconnects: `pc`, the relay has nobody for the PC; `relay`, no relay was reached. */
  readonly unreached?: "pc" | "relay" | undefined;
  /** A relay transport: the PC lets its account's devices in by the account's signed list alone (it is pinned to it). */
  readonly followsList?: boolean | undefined;
  /** Calls `listener` each time the carrier goes up, down or changes, and when `unreached` changes. */
  onRouteChange?(listener: () => void): () => void;
}

/**
 * A request the relay transport could not carry because its carrier is down while it reconnects: the PC never
 * saw it, so it says nothing about the PC. Still a TypeError, as a failed fetch is.
 */
export class CarrierDownError extends TypeError {
  constructor() { super("Relay carrier is disconnected"); }
}

const nativeReads = new Map<AbortController, string>();

function readMachine(pathname: string): string {
  const remote = /^\/api\/machines\/([^/]+)\//.exec(pathname);
  return remote ? decodeURIComponent(remote[1]!) : "local";
}

function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const target = new URL(input instanceof Request ? input.url : String(input), origin);
  const api = target.origin === origin && target.pathname.startsWith("/api/");
  // this server's API, a PC's through it included, never redirects: a redirect target's answer is no answer (S32-1)
  if (api) init = { ...init, redirect: "error" };
  // only this server's reads: a write is never given up for the caller (the server may have done it),
  // and another host's connections were not found dead
  if ((method !== "GET" && method !== "HEAD") || !api) return fetch(input, init);
  const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const read = new AbortController();
  let signal = read.signal;
  if (own && typeof AbortSignal.any === "function") signal = AbortSignal.any([own, read.signal]);
  else if (own?.aborted) read.abort(own.reason);
  else own?.addEventListener("abort", () => read.abort(own.reason), { once: true });
  nativeReads.set(read, readMachine(target.pathname));
  return fetch(input, { ...init, signal }).finally(() => { nativeReads.delete(read); });
}

/**
 * The connection to the server was found dead without a close (an unanswered probe): a read sent on
 * one of the browser's connections lost with it never answers, and holds one of the few connections
 * the browser keeps to a host, so every later request, the chat's reads too, waits behind it until
 * the browser gives that connection up, often a minute later. The reads still waiting are given up:
 * all of them for this server's own connection (its loss is the browser's path to the server), only
 * that PC's for another PC's, whose loss may be the server's own way to it.
 */
export function abandonNativeReads(machineId = "local"): void {
  for (const [read, machine] of nativeReads) {
    if (machineId !== "local" && machine !== machineId) continue;
    read.abort(new DOMException("The connection to the server was lost.", "AbortError"));
    nativeReads.delete(read);
  }
}

export const nativeTransport: Transport = {
  kind: "native",
  fetch: nativeFetch,
  openSocket: (url) => new WebSocket(url),
  openEventSource: (url) => new EventSource(url),
  resourceUrl: (path) => path,
};

let current: Transport = nativeTransport;

export function getTransport(): Transport {
  return current;
}

export function setTransport(transport: Transport): void {
  current = transport;
}

export function serverResourceUrl(path: string, transport: Transport = current, signal?: AbortSignal): string | Promise<string> {
  return path.startsWith("/api/") ? transport.resourceUrl(path, signal) : path;
}
