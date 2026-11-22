import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestFreshShell } from "../src/lib/shellMode.ts";
import { stampServiceWorker } from "./service-worker-build.ts";

const source = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://app.ovis.sh";
const SERVER_ID = "0123456789abcdef".repeat(2);
const SCOPE = `${ORIGIN}/s/${SERVER_ID}/`;

type Store = Map<string, Response>;

function worker(options: { shell: boolean; build: string; caches?: Record<string, Record<string, string>>; network: Record<string, string>; keptAt?: Date; offline?: boolean; brokenCaches?: boolean }) {
  const stores = new Map<string, Store>();
  const key = (request: Request | string) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
  const page = (body: string, date = new Date()) => new Response(body, { headers: { "content-type": "text/html", date: date.toUTCString() } });
  const file = (body: string) => new Response(body, { headers: { "content-type": "text/javascript" } });
  for (const [name, entries] of Object.entries(options.caches ?? {})) {
    stores.set(name, new Map(Object.entries(entries).map(([path, body]) => [key(path), path === "/" ? page(body, options.keptAt) : file(body)])));
  }
  const open = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, store = new Map());
    const cache = store;
    return {
      match: async (request: Request | string) => cache.get(key(request))?.clone(),
      put: async (request: Request | string, response: Response) => { cache.set(key(request), response.clone()); },
      keys: async () => [...cache.keys()].map((url) => new Request(url)),
      delete: async (request: Request | string) => cache.delete(key(request)),
    };
  };
  const cacheStorage = {
    open: async (name: string) => {
      if (options.brokenCaches) throw new DOMException("denied", "SecurityError");
      return open(name);
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: Request | string) => {
      for (const store of stores.values()) { const hit = store.get(key(request)); if (hit) return hit.clone(); }
      return undefined;
    },
  };
  const fetch = async (request: Request | string) => {
    const url = new URL(key(request));
    if (options.offline) throw new TypeError("Failed to fetch");
    const body = options.network[url.pathname];
    if (body === undefined) return new Response("", { status: 404 });
    const response = url.pathname.startsWith("/assets/") ? file(body) : page(body);
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    location: new URL("/sw.js", ORIGIN),
    registration: { scope: SCOPE },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
  };
  const code = stampServiceWorker(source, options.build, undefined, options.shell);
  new Function("self", "caches", "fetch", code)(self, cacheStorage, fetch);

  async function navigate(at = SCOPE): Promise<string> {
    let responded: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners.get("fetch")!({
      request: new Request(at, { mode: "navigate" as RequestMode }),
      respondWith: (promise: Promise<Response>) => { responded = promise; },
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    });
    if (responded === undefined) return "(left to the network)";
    const body = await (await responded).text();
    while (pending.length) await pending.shift();
    return body;
  }
  return { navigate, stores, caches: cacheStorage, network: options.network };
}

const OLD_SHELL = '<script type="module" src="/assets/index-old.js"></script>';
const NEW_SHELL = '<script type="module" src="/assets/index-new.js"></script>';
const KEPT = { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old" } };
const NETWORK = { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" };

describe("service worker navigations", () => {
  it("leaves a sign-in's return to the network and keeps nothing of it", async () => {
    const sw = worker({ shell: false, build: "0000000000aa", network: { "/callback": NEW_SHELL, "/assets/index-new.js": "new" } });
    expect(await sw.navigate(`${ORIGIN}/callback?code=secret-code&state=s`)).toBe("(left to the network)");
    for (const store of sw.stores.values()) expect([...store.keys()].join(" ")).not.toContain("callback");
    expect(sw.stores.size === 0 || [...sw.stores.values()].every((store) => !store.has(`${ORIGIN}/`))).toBe(true);
  });

  it("opens the hosted shell from the shell it kept, and keeps the network's for the next open", async () => {
    const sw = worker({
      shell: true, build: "0000000000aa",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    expect(await sw.navigate()).toBe(OLD_SHELL);
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("asks the network on the reload that brings in a newer shell, once", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", caches: KEPT, network: { ...NETWORK } });
    await requestFreshShell(sw.caches, SERVER_ID);
    expect(await sw.navigate()).toBe(NEW_SHELL);
    sw.network[new URL(SCOPE).pathname] = OLD_SHELL;
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("leaves another PC's request for a fresh shell to that PC", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", caches: KEPT, network: NETWORK });
    await requestFreshShell(sw.caches, "fedcba9876543210".repeat(2));
    expect(await sw.navigate()).toBe(OLD_SHELL);
  });

  it("asks the network when the caches cannot be read", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", caches: KEPT, network: NETWORK, brokenCaches: true });
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("keeps the kept shell for a reload that finds the host unreachable", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", caches: KEPT, network: NETWORK, offline: true });
    await requestFreshShell(sw.caches, SERVER_ID);
    expect(await sw.navigate()).toBe(OLD_SHELL);
  });

  it("asks the network first once the kept shell is a day old", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", caches: KEPT, network: NETWORK, keptAt: new Date(Date.now() - 25 * 3600_000) });
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("still asks the network first on a PC's own server", async () => {
    const sw = worker({
      shell: false, build: "0000000000aa",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    expect(await sw.navigate()).toBe(NEW_SHELL);
  });

  it("asks the network when the hosted shell kept no shell yet", async () => {
    const sw = worker({ shell: true, build: "0000000000aa", network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" } });
    expect(await sw.navigate()).toBe(NEW_SHELL);
    expect(sw.stores.get("ovis-v4-sheep-0000000000aa")?.has(`${ORIGIN}/`)).toBe(true);
  });

  it("keeps the older build's cache while a page runs the shell it holds, and retires it on the next open", async () => {
    const sw = worker({
      shell: true, build: "0000000000bb",
      caches: { "ovis-v4-sheep-0000000000aa": { "/": OLD_SHELL, "/assets/index-old.js": "old", "/assets/katex-old.js": "lazy" } },
      network: { [new URL(SCOPE).pathname]: NEW_SHELL, "/assets/index-new.js": "new" },
    });
    expect(await sw.navigate()).toBe(OLD_SHELL);
    // the page still runs the old shell, and may ask for a chunk of its build later
    expect(sw.stores.get("ovis-v4-sheep-0000000000aa")?.has(`${ORIGIN}/assets/katex-old.js`)).toBe(true);
    expect(await sw.navigate()).toBe(NEW_SHELL);
    expect(sw.stores.has("ovis-v4-sheep-0000000000aa")).toBe(false);
  });
});
