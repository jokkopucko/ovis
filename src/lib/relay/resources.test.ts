import { afterEach, describe, expect, it } from "bun:test";
import { bounded, deferred } from "../../../server/relay/test-helpers.ts";
import { isRelayResourceTarget, relayResourcePath, relayResourceTarget } from "../../../shared/relay-mux.ts";
import { fileUrl, projectFaviconUrl } from "../api.ts";
import { toolGalleryImage, userGalleryImages } from "../chatImages.ts";
import { readerHref } from "../fileReader.ts";
import { relayResourceBlob, RELAY_BLOB_LIMIT, RelayResourceTooLargeError, relayResourceUrl, serveRelayResources } from "./resources.ts";
import { nativeTransport } from "../transport.ts";

const id = "ab".repeat(16);
const scope = `/s/${id}/`;

describe("resource builders round trip through the per-PC scope", () => {
  for (const machine of ["local", "pc /한%?#"]) it(`preserves every builder's bytes for ${machine}`, () => {
    const t = (text: string) => text;
    const paths = [
      fileUrl("/a &+#/image.png", "p:1", machine),
      fileUrl("/a &+#/image.png", null, machine, true),
      projectFaviconUrl("/a &+#", machine),
      toolGalleryImage(machine, "p:1", { part: { kind: "tool", name: "Read", summary: "", input: "", output: "" },
        ref: "a:0&+#%", mediaType: "image/png", ordinal: 0 }, t).src,
      ...userGalleryImages(machine, "p:1", [{ kind: "image", ref: "b:0&+#%", media_type: "image/png" }], "@/a/image.png", t).map((image) => image.src),
    ];
    expect(paths).toHaveLength(6);
    for (const path of paths) {
      const scoped = relayResourcePath(id, path);
      expect(scoped).toBe(`${scope}~${path}`);
      expect(relayResourceTarget(scope, scoped)).toBe(path);
    }
    const query = "/api/fs/file?path=%2fA%2bB+%20&path=x&&revision=%ff";
    expect(relayResourceTarget(scope, relayResourcePath(id, query))).toBe(query);
  });

  it("refuses mutations and encoded route or scope tricks without normalizing them", () => {
    for (const target of ["/api/devices", "/api/fs/stat", "/api/fs/file/../file", "/api/fs/%66ile",
      "/api//fs/file", "/api/fs/file#x", "/api/machines/../fs/file", "/api/machines/%2e%2E/fs/file", "//api/fs/file", "/api/fs/file\n"]) {
      expect(isRelayResourceTarget(target)).toBe(false);
      expect(() => relayResourcePath(id, target)).toThrow(TypeError);
    }
    for (const path of [`/s/${"cd".repeat(16)}/~/api/fs/file`, `${scope}%7e/api/fs/file`,
      `${scope}~/../~/api/fs/file`, `${scope}~//api/fs/file`]) expect(relayResourceTarget(scope, path)).toBeNull();
  });

  it("makes a stable reader link rather than an active-content blob link", () => {
    expect(readerHref("remote pc", "/a/evil.svg", scope, "relay")).toBe(`${scope}#read=%2Fa%2Fevil.svg&machine=remote+pc`);
  });
});

describe("bounded blob resources", () => {
  it("refuses an announced 70 MiB file before pulling any body", async () => {
    let cancelled = false;
    let pulled = false;
    const response = new Response(new ReadableStream({
      pull() { pulled = true; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "content-length": String(70 * 1024 * 1024) } });
    await expect(relayResourceBlob(response)).rejects.toBeInstanceOf(RelayResourceTooLargeError);
    expect(cancelled).toBe(true);
    expect(pulled).toBe(false);
  });

  it("caps an unannounced stream and cancels it at the first excess byte", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls === 1 ? RELAY_BLOB_LIMIT : 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await expect(relayResourceBlob(response)).rejects.toBeInstanceOf(RelayResourceTooLargeError);
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it("keeps the MIME and bytes of an allowed image", async () => {
    const blob = await relayResourceBlob(new Response("image", { headers: { "content-type": "image/png" } }));
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("image");
  });

  for (const [mime, expected] of [
    [" IMAGE/PNG ; charset=binary ", "image/png"], ["Video/MP4; codecs=avc1", "video/mp4"],
    [" audio/ogg ", "audio/ogg"], [" APPLICATION/PDF ; version=1.7", "application/pdf"],
    ["IMAGE/SVG+XML ; charset=utf-8", "application/octet-stream"], ["text/html", "application/octet-stream"],
    ["application/xhtml+xml", "application/octet-stream"], ["image/", "application/octet-stream"],
    ["image/png garbage", "application/octet-stream"], ["application/pdfx", "application/octet-stream"],
    ["", "application/octet-stream"],
  ] as const) it(`opens only inert media or PDF for MIME ${mime}`, async () => {
    const transport = { ...nativeTransport, fetch: async () => new Response("bytes", { headers: { "content-type": mime ?? "" } }) };
    const url = await relayResourceUrl(transport, id, "/api/fs/file?path=untrusted.pdf");
    try {
      const response = await fetch(url);
      expect(response.headers.get("content-type")).toBe(expected);
      expect(await response.text()).toBe("bytes");
    } finally { URL.revokeObjectURL(url); }
  });

  it("makes downloads inert even if a WebView opens them in place", async () => {
    const transport = { ...nativeTransport, fetch: async () => new Response("<script>bad()</script>", { headers: { "content-type": "text/html" } }) };
    const url = await relayResourceUrl(transport, id, "/api/fs/file?path=a.html&download=1");
    try { expect((await fetch(url)).headers.get("content-type")).toBe("application/octet-stream"); }
    finally { URL.revokeObjectURL(url); }
  });
});

/** This window as a page of the shell whose service worker `worker` controls, for one test. */
function controlledBy(worker: object, workers: object = { controller: worker }): void {
  Object.defineProperty(navigator, "serviceWorker", { value: workers, configurable: true });
  Object.defineProperty(globalThis, "location", { value: new URL(`https://shell.example/s/${id}/`), configurable: true });
}
afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(globalThis, "location");
});

function streamTransfers(): boolean {
  const stream = new ReadableStream();
  const { port1, port2 } = new MessageChannel();
  try { port1.postMessage(stream, [stream]); return true; }
  catch (error) { if (error instanceof DOMException && error.name === "DataCloneError") return false; throw error; }
  finally { port1.close(); port2.close(); }
}

describe("the service worker resource path", () => {
  it("falls back to a blob where this window cannot transfer a stream to the worker", async () => {
    // Given a runtime that cannot transfer a ReadableStream (Bun, as Safari before 27), under a worker that speaks the resource protocol
    expect(streamTransfers()).toBe(false);
    controlledBy({
      scriptURL: `https://shell.example/s/${id}/sw.js`,
      postMessage(message: { type: string }, [port]: MessagePort[]) { port?.postMessage({ type: message.type }); },
    });
    const transport = { ...nativeTransport, fetch: async () => new Response("image", { headers: { "content-type": "image/png" } }) };
    // When
    const url = await relayResourceUrl(transport, id, "/api/fs/file?path=a.png");
    // Then the page gets a blob, not the worker's scoped URL that serveRelayResources could never answer
    try { expect(url).toStartWith("blob:"); }
    finally { URL.revokeObjectURL(url); }
  });

  it("aborts the relay request when its body cannot be handed to the worker", async () => {
    // Given a window serving the worker's resource requests, where transferring the body fails
    const worker = {};
    let receive: (event: MessageEvent) => void = () => {};
    controlledBy(worker, { controller: worker, addEventListener: (_: string, listener: typeof receive) => { receive = listener; }, removeEventListener() {} });
    const requested = deferred<AbortSignal>();
    const transport = { ...nativeTransport, fetch: async (_: RequestInfo | URL, init?: RequestInit) => {
      requested.resolve(init!.signal!);
      return new Response(new ReadableStream({ pull() {} }), { headers: { "content-type": "image/png" } });
    } };
    const stop = serveRelayResources(transport, id, () => true);
    const aborted = deferred<void>();
    // When the worker asks for a file
    const { port1, port2 } = new MessageChannel();
    receive({ data: { type: "ovis-relay-resource", serverId: id, target: "/api/fs/file?path=a.png", headers: [] }, ports: [port1], source: worker } as unknown as MessageEvent);
    const signal = await bounded(requested.promise);
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    if (signal.aborted) aborted.resolve();
    // Then the relay request is aborted, not left holding its stream slot
    await bounded(aborted.promise);
    port2.close();
    stop();
  });
});
