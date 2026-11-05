/**
 * The one way this client reaches its server: every HTTP request, the terminal WebSocket, the
 * event stream and the address of a file the browser loads itself. The native transport is the
 * browser's own, read from the globals at each call, so a stand-in installed on `window` (the
 * demo's site/demo/transport.ts) still answers. Another transport is set once, at boot.
 */

/** What HerdrSocket needs of a WebSocket; the browser's own is one. */
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

/** What the event stream needs of an EventSource; the browser's own is one. */
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
  /** The address the browser loads a server path from (an <img>, a <video>, a download link). */
  resourceUrl(path: string, signal?: AbortSignal): string | Promise<string>;
}

export const nativeTransport: Transport = {
  kind: "native",
  fetch: (input, init) => fetch(input, init),
  openSocket: (url) => new WebSocket(url),
  openEventSource: (url) => new EventSource(url),
  resourceUrl: (path) => path,
};

let current: Transport = nativeTransport;

export function getTransport(): Transport {
  return current;
}

/** Called once at boot, before the first request; tests also restore the native one with it. */
export function setTransport(transport: Transport): void {
  current = transport;
}

/** A server path (`/api/…`) as the transport loads it; data:, blob: and other addresses stay as they are. */
export function serverResourceUrl(path: string, transport: Transport = current, signal?: AbortSignal): string | Promise<string> {
  return path.startsWith("/api/") ? transport.resourceUrl(path, signal) : path;
}
