import { isRelayResourceTarget, relayResourcePath, REQUEST_HEADERS, RESPONSE_HEADERS } from "../../../shared/relay-mux.ts";
import type { Transport } from "../transport.ts";

export const RELAY_BLOB_LIMIT = 64 * 1024 * 1024;

export class RelayResourceTooLargeError extends Error {
  constructor() { super("Relay resource exceeds 64 MiB"); this.name = "RelayResourceTooLargeError"; }
}

/** Bound even a chunked response with no Content-Length, cancelling as soon as it exceeds the cap. */
export async function relayResourceBlob(response: Response): Promise<Blob> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new TypeError(`Relay resource refused: ${response.status}`);
  }
  if (Number(response.headers.get("content-length")) > RELAY_BLOB_LIMIT) {
    try { await response.body?.cancel(); }
    finally { throw new RelayResourceTooLargeError(); }
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > RELAY_BLOB_LIMIT) throw new RelayResourceTooLargeError();
        chunks.push(next.value.slice());
      }
    } finally {
      try { await reader.cancel(); }
      finally {
        reader.releaseLock();
        if (size > RELAY_BLOB_LIMIT) throw new RelayResourceTooLargeError();
      }
    }
  }
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  // Blob URLs have the shell's origin but none of the PC's response policy. SVG
  // is active content when framed or navigated, so it is a download, not an image blob.
  const inline = mime !== "image/svg+xml" && /^(?:image|video|audio)\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    || mime === "application/pdf";
  return new Blob(chunks, { type: inline ? mime : "application/octet-stream" });
}

let transferableStreams: boolean | undefined;
/** serveRelayResources hands each body to the worker as a transferred stream, which Safari before 27 cannot do. */
function canTransferStreams(): boolean {
  if (transferableStreams !== undefined) return transferableStreams;
  const stream = new ReadableStream();
  const { port1, port2 } = new MessageChannel();
  try { port1.postMessage(stream, [stream]); transferableStreams = true; }
  catch (error) {
    if (!(error instanceof DOMException && error.name === "DataCloneError")) throw error;
    transferableStreams = false;
  } finally { port1.close(); port2.close(); }
  return transferableStreams;
}

/** Older shell workers control pages too: require the resource protocol before giving out its URL. */
const capabilities = new WeakMap<ServiceWorker, Promise<boolean>>();
export function resourceWorker(serverId: string): Promise<boolean> {
  const worker = typeof navigator === "undefined" ? null : navigator.serviceWorker?.controller;
  if (!worker || typeof location === "undefined" || !canTransferStreams()
    || new URL(worker.scriptURL).pathname !== `/s/${serverId}/sw.js`) return Promise.resolve(false);
  const known = capabilities.get(worker);
  if (known) return known;
  const ready = new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const finish = (supported: boolean): void => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(supported);
    };
    const timer = setTimeout(() => finish(false), 1500);
    channel.port1.onmessage = (event) => finish(event.data?.type === "ovis-relay-resources-v1");
    worker.postMessage({ type: "ovis-relay-resources-v1" }, [channel.port2]);
  });
  capabilities.set(worker, ready);
  return ready;
}

export async function relayResourceUrl(transport: Transport, serverId: string, path: string, signal?: AbortSignal): Promise<string> {
  const scoped = relayResourcePath(serverId, path);
  signal?.throwIfAborted();
  if (await resourceWorker(serverId)) return scoped;
  signal?.throwIfAborted();
  const blob = await relayResourceBlob(await transport.fetch(path, { signal }));
  // Downloads may be opened in place by a WebView. They must never execute active file content.
  return URL.createObjectURL(new URL(path, "https://resource.invalid").searchParams.get("download") === "1"
    ? new Blob([blob], { type: "application/octet-stream" }) : blob);
}

/**
 * Only our controlling worker can ask this window to use its channel. Each request owns its
 * abort controller until the transferred stream ends or is cancelled by the worker/browser.
 */
export function serveRelayResources(transport: Transport, serverId: string, connected: () => boolean): () => void {
  const workers = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!workers) return () => {};
  const active = new Set<AbortController>();
  const receive = (event: MessageEvent): void => {
    const port = event.ports[0];
    const data = event.data;
    if (!port || event.source !== workers.controller || data?.type !== "ovis-relay-resource"
      || data.serverId !== serverId || typeof data.target !== "string" || !isRelayResourceTarget(data.target)) return;
    if (!connected()) { port.postMessage({ available: false }); port.close(); return; }
    const abort = new AbortController();
    active.add(abort);
    const finish = (): void => { active.delete(abort); port.close(); };
    port.onmessage = (message) => { if (message.data?.type === "abort") { abort.abort(); finish(); } };
    const headers = new Headers();
    const received = new Headers(data.headers);
    for (const name of REQUEST_HEADERS) {
      const value = received.get(name);
      if (value !== null) headers.set(name, value);
    }
    // A live channel answers selection immediately; a slow disk is not an absent window.
    port.postMessage({ available: true });
    void transport.fetch(data.target, { headers, signal: abort.signal }).then((response) => {
      const allowed: readonly string[] = RESPONSE_HEADERS;
      const headers = [...response.headers].filter(([name]) => allowed.includes(name));
      const reader = response.body?.getReader();
      const body = reader ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { controller.close(); finish(); }
            else controller.enqueue(next.value);
          } catch (error) { controller.error(error); finish(); }
        },
        async cancel(reason) { abort.abort(); await reader.cancel(reason); finish(); },
      }, { highWaterMark: 0 }) : null;
      port.postMessage({ available: true, status: response.status, headers, body }, body ? [body] : []);
      if (!body) finish();
    // a failed fetch or hand-off: abort the request, whose body (locked by `reader`) would otherwise hold its stream slot
    }).catch(() => { abort.abort(); port.postMessage({ available: false }); finish(); });
  };
  workers.addEventListener("message", receive);
  return () => {
    workers.removeEventListener("message", receive);
    for (const abort of active) abort.abort();
    active.clear();
  };
}
