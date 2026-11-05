import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { stampServiceWorker } from "../scripts/service-worker-build.ts";
import { relayResourcePath } from "../shared/relay-mux.ts";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const id = "ab".repeat(16);
const origin = "https://app.test";
const scope = `/s/${id}/`;

// The worker runs with real Response/ReadableStream objects. Only the browser-owned clients and
// ports are in-process: Bun cannot transfer a stream, which the real-browser QA exercises.
class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer?: Port;
  postMessage(data: unknown): void { queueMicrotask(() => this.peer?.onmessage?.({ data })); }
  close(): void { this.onmessage = null; }
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}
interface Asked { target: string; headers: [string, string][]; serverId: string }
/** Who asks: a page the worker controls (its client id), or a navigation and the page it came from. */
type From = { client: string } | { navigation: string };
/** The pages the worker controls, by client id: this PC's app window, and another PC's. */
const pages: Record<string, string> = { app: origin + scope, other: `${origin}/s/${"cd".repeat(16)}/`, render: `${origin}${scope}~render` };
function worker(shell: boolean, clients: { url: string; postMessage(data: Asked, ports: Port[]): void }[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin }, registration: { scope: origin + scope },
    clients: { matchAll: async (options: unknown) => { expect(options).toEqual({ type: "window" }); return clients; },
      get: async (id: string) => (pages[id] === undefined ? undefined : { url: pages[id] }) },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) };
  new Function("self", "MessageChannel", stampServiceWorker(source, "abcdef", [], shell))(self, Channel);
  return (target: string, init: RequestInit = {}, from: From = { client: "app" }) => {
    let response: Promise<Response> | undefined;
    const request = new Request(origin + target, init);
    // a navigation's mode and referrer are the browser's to set: Request() refuses mode "navigate"
    if ("navigation" in from) Object.defineProperties(request, { mode: { value: "navigate" }, referrer: { value: from.navigation } });
    listeners.get("fetch")?.({ request, clientId: "client" in from ? from.client : "", respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  };
}

/** A window of this PC that answers every file with "file", recording what it was asked. */
function answering(asked: Asked[]) {
  return { url: origin + scope, postMessage(data: Asked, ports: Port[]) {
    asked.push(data);
    ports[0]?.postMessage({ available: true, status: 200, headers: [["content-type", "text/plain"]], body: new Response("file").body });
  } };
}

it("refuses another site's frame or link, a typed address and another PC's page, asking no window", async () => {
  // Given this PC's open app window, able to answer.
  const asked: Asked[] = [];
  const serve = worker(true, [answering(asked)]);
  const target = `${scope}~/api/fs/file?path=%2Fhome%2Fme%2F.ssh%2Fid_ed25519`;
  // When the file is asked for by anything but this PC's app.
  const strangers: From[] = [
    { navigation: "https://evil.example/frame.html" }, // another site's iframe or link
    { navigation: "" }, // no referrer: a typed address, or a page that withheld it
    { navigation: pages["other"]! }, { navigation: pages["render"]! },
    { client: "other" }, { client: "render" }, { client: "" }, { client: "gone" },
  ];
  for (const from of strangers) {
    const response = await serve(target, {}, from);
    // Then it is refused before the PC is asked, as the PC's own server refuses a request without its SameSite=Strict cookie.
    expect({ from, status: response?.status }).toEqual({ from, status: 403 });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  }
  expect(asked).toEqual([]);
});

it("serves this PC's app window and its own links, framable only by the shell itself", async () => {
  // Given this PC's open app window.
  const asked: Asked[] = [];
  const serve = worker(true, [answering(asked)]);
  // When the app asks itself, frames the file, or opens it in a tab of its own.
  for (const from of [{ client: "app" }, { navigation: `${pages["app"]}?pane=1` }] as From[]) {
    const response = await serve(`${scope}~/api/fs/file?path=a`, {}, from);
    // Then the file comes, and no other site may frame it.
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(response?.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await response?.text()).toBe("file");
  }
  expect(asked).toHaveLength(2);
});

it("streams local and remote resource targets with Range, status and all security headers intact", async () => {
  const asked: Asked[] = [];
  const headers = { "content-type": "image/svg+xml", "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff", "content-range": "bytes 2-4/10", "set-cookie": "never=passed" };
  const serve = worker(true, [
    { url: `${origin}/s/${"cd".repeat(16)}/`, postMessage() { throw new Error("other PC"); } },
    { url: origin + scope, postMessage(data, ports) {
      asked.push(data);
      ports[0]?.postMessage({ available: true });
      ports[0]?.postMessage({ available: true, status: 206, headers: Object.entries(headers), body: new Response("234").body });
    } },
  ]);
  for (const target of ["/api/fs/file?path=%2fA+%20", "/api/machines/pc%2F1/fs/file?path=x", "/api/pane/conversation/image?ref=a%3A0"]) {
    const response = await serve(relayResourcePath(id, target), { headers: { range: "bytes=2-4", "if-none-match": '"one"', authorization: "never-forward" } });
    expect(response?.status).toBe(206);
    expect(response?.headers.get("content-security-policy")).toStartWith(headers["content-security-policy"] + ", sandbox;");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(await response?.text()).toBe("234");
    expect(asked.at(-1)).toMatchObject({ target, headers: [["if-none-match", '"one"'], ["range", "bytes=2-4"]], serverId: id });
  }
});

for (const mime of ["text/html", "image/svg+xml", " APPLICATION/PDF ; version=1.7 ", "application/pdf", "application/pdfx"]) {
  for (const policy of [null, "sandbox allow-scripts allow-same-origin; script-src * 'unsafe-inline'"]) {
    it(`enforces shell isolation for ${mime} with PC policy ${policy}`, async () => {
      const received = new Headers({ "content-type": mime, "x-content-type-options": "unsafe" });
      if (policy) received.set("content-security-policy", policy);
      const serve = worker(true, [{ url: origin + scope, postMessage(_data, ports) {
        ports[0]?.postMessage({ available: true, status: 200, headers: [...received], body: new Response("file").body });
      } }]);
      const response = await serve(`${scope}~/api/fs/file`);
      const enforced = response?.headers.get("content-security-policy")?.split(", ").at(-1);
      expect(enforced).toContain("script-src 'none'");
      expect(enforced?.startsWith("sandbox;")).toBe(mime.trim().toLowerCase().split(";")[0]?.trim() !== "application/pdf");
      if (policy) expect(response?.headers.get("content-security-policy")).toStartWith(policy + ", ");
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response?.text()).toBe("file");
    });
  }
}

it("leaves non-GET, other API routes and the render host untouched, and leaves the server build unchanged", () => {
  const shell = worker(true, []);
  const native = worker(false, []);
  for (const path of [`${scope}~/api/devices`, `${scope}~/api/fs/%66ile`, `${scope}~render`, "/api/fs/file", "/ws"]) {
    expect(shell(path)).toBeUndefined();
  }
  expect(shell(`${scope}~/api/fs/file`, { method: "POST" })).toBeUndefined();
  expect(native(`${scope}~/api/fs/file`)).toBeUndefined();
});

it("returns 503 without a channel, skipping a controlled window that has none", async () => {
  const serve = worker(true, [{ url: origin + scope, postMessage(_data, ports) { ports[0]?.postMessage({ available: false }); } }]);
  expect((await serve(`${scope}~/api/fs/file`))?.status).toBe(503);
  expect((await worker(true, [])(`${scope}~/api/fs/file`))?.status).toBe(503);
});

it("aborts the window request when the browser aborts before the headers", async () => {
  const received = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const abort = new AbortController();
  const serve = worker(true, [{ url: origin + scope, postMessage(_data, ports) {
    const port = ports[0];
    if (port) port.onmessage = (event) => { expect(event.data).toEqual({ type: "abort" }); cancelled.resolve(); };
    received.resolve();
  } }]);
  const response = serve(`${scope}~/api/fs/file`, { signal: abort.signal });
  const rejected = response?.then(() => null, (error: unknown) => error);
  await received.promise;
  abort.abort();
  expect(await rejected).toBeInstanceOf(DOMException);
  await cancelled.promise;
});
