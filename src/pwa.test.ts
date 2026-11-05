import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stampServiceWorker } from "../scripts/service-worker-build.ts";

const publicDir = join(import.meta.dir, "..", "public");

/** Runs public/sw.js against a stand-in `self` and returns its fetch listener. */
function serviceWorkerFetch(): (request: { method: string; url: string; mode: string }) => boolean {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin: "https://app.test" }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) };
  const caches = { match: async () => new Response("cached"), open: async () => ({ match: async () => undefined, put: async () => undefined }) };
  const fetch = async () => new Response("network");
  new Function("self", "caches", "fetch", readFileSync(join(publicDir, "sw.js"), "utf8"))(self, caches, fetch);
  const listener = listeners.get("fetch")!;
  return (request) => {
    let answered = false;
    listener({ request, respondWith: () => { answered = true; }, waitUntil: () => undefined });
    return answered;
  };
}

describe("installed app", () => {
  it("leaves the screen orientation to the device's rotation lock", () => {
    // Chrome for Android before mid-2026 ran an `orientation: "any"` app full-sensor,
    // rotating it even with auto-rotate off; no orientation follows the system setting
    const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
    expect(manifest["orientation"]).toBeUndefined();
  });

  it("rereads the web manifest from the network while static assets stay cache-first", () => {
    const answers = serviceWorkerFetch();
    const get = (path: string) => ({ method: "GET", url: `https://app.test${path}`, mode: "no-cors" });
    expect(answers(get("/manifest.webmanifest"))).toBe(false);
    expect(answers(get("/icons/icon-192.png?v=sheep1"))).toBe(true);
    expect(answers(get("/assets/index-abc123.js"))).toBe(true);
  });
});

type WorkerRequest = { method: string; url: string; mode: string };

/** The cache no build retires: typefaces and icons (FILES in sw.js). */
const FILES = /const FILES = "([^"]+)"/.exec(readFileSync(join(publicDir, "sw.js"), "utf8"))![1]!;

type Kept = { body: string; type: string | null };
const kept = (entry: Kept): Response => new Response(entry.body, entry.type ? { headers: { "content-type": entry.type } } : undefined);

/** public/sw.js (or `source`, a build of it) over a stand-in CacheStorage and a network that can be cut. */
function serviceWorker(stored: Record<string, Record<string, string | Kept>>, source = readFileSync(join(publicDir, "sw.js"), "utf8")) {
  const origin = "https://app.test";
  const keyOf = (request: string | WorkerRequest): string => (typeof request === "string" ? request : request.url.slice(origin.length));
  const store = new Map(Object.entries(stored).map(([name, entries]) =>
    [name, new Map(Object.entries(entries).map(([key, entry]) => [key, typeof entry === "string" ? { body: entry, type: null } : entry]))]));
  const cacheOf = (entries: Map<string, Kept>) => ({
    keys: async () => [...entries.keys()].map((key) => ({ url: `${origin}${key}` })),
    match: async (request: string | WorkerRequest) => (entries.has(keyOf(request)) ? kept(entries.get(keyOf(request))!) : undefined),
    put: async (request: string | WorkerRequest, response: Response) => {
      await disk.ready;
      entries.set(keyOf(request), { body: await response.text(), type: response.headers.get("content-type") });
    },
  });
  const caches = {
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      return cacheOf(store.get(name)!);
    },
    // every cache, oldest first, as the browser's does
    match: async (request: string | WorkerRequest) => {
      for (const entries of store.values()) if (entries.has(keyOf(request))) return kept(entries.get(keyOf(request))!);
      return undefined;
    },
  };
  /** `ready` is awaited by every write: a test replaces it to hold the cache back. */
  const disk = { ready: Promise.resolve() as Promise<void> };
  /** `gone`: files the server no longer has, answered as `goneAs` says (a 404, or the shell as servers before it did) */
  const network = { online: true, shell: "shell", status: 200, fetched: [] as string[], gone: new Set<string>(), goneAs: "404" as "404" | "shell" };
  const fetch = async (request: WorkerRequest) => {
    if (!network.online) throw new TypeError("Failed to fetch");
    network.fetched.push(keyOf(request));
    const page = () => new Response(network.shell, { status: network.status, headers: { "content-type": "text/html; charset=utf-8" } });
    const response = request.mode === "navigate" ? page()
      : !network.gone.has(keyOf(request)) ? new Response(`network ${keyOf(request)}`)
      : network.goneAs === "shell" ? page() : new Response(null, { status: 404 });
    // a same-origin answer, which is all the worker keeps
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin }, clients: { claim: async () => undefined }, skipWaiting: () => undefined, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) };
  new Function("self", "caches", "fetch", source)(self, caches, fetch);
  /** The answer as the page gets it, and `kept`: everything the worker asked to stay alive for. */
  const fire = (type: string, event: Record<string, unknown> = {}): { answer: Promise<Response> | undefined; kept: () => Promise<void> } => {
    let answer: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...event, respondWith: (response: Promise<Response>) => { answer = response; }, waitUntil: (work: Promise<unknown>) => { waits.push(work); } });
    // a wait may be added while the answer is made, so the list is read again until it is still
    const kept = async (): Promise<void> => { for (let seen = -1; seen !== waits.length;) { seen = waits.length; await Promise.all(waits); } };
    return { answer, kept };
  };
  const dispatch = async (type: string, event: Record<string, unknown> = {}): Promise<Response | undefined> => {
    const { answer, kept } = fire(type, event);
    const response = await answer;
    await kept();
    return response;
  };
  const text = async (request: WorkerRequest): Promise<string | null> => {
    // a rejected answer is what the page sees as a network error
    const response = await dispatch("fetch", { request }).catch(() => undefined);
    const body = response === undefined || response.type === "error" ? null : await response.text();
    // an asset is kept without holding its answer back
    await new Promise((done) => setTimeout(done, 0));
    return body;
  };
  return {
    network,
    disk,
    fire: (path = "/") => fire("fetch", { request: { method: "GET", url: `${origin}${path}`, mode: "navigate" } }),
    names: () => [...store.keys()],
    entries: (name: string) => [...(store.get(name)?.keys() ?? [])],
    update: async () => { await dispatch("install"); await dispatch("activate"); },
    navigate: (path = "/") => text({ method: "GET", url: `${origin}${path}`, mode: "navigate" }),
    get: (path: string) => text({ method: "GET", url: `${origin}${path}`, mode: "no-cors" }),
    /** an asset request as fired, its answer apart from what the worker keeps alive for it */
    ask: (path: string) => fire("fetch", { request: { method: "GET", url: `${origin}${path}`, mode: "no-cors" } }),
  };
}

describe("a service worker under a new cache name", () => {
  const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
  const current = /const CACHE_NAME = "([^"]+)"/.exec(sw)![1]!;
  const before = "herdr-web-ui-v3-ram";
  const old = () => ({ [before]: { "/": "old shell", "/assets/index-old.js": "old bundle", "/assets/PretendardVariable.subset.91-old.woff2": "old chunk" } });

  it("starts offline from the shell and the files the worker before it kept", async () => {
    expect(current).not.toBe(before);
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.online = false;
    expect(await worker.navigate()).toBe("old shell");
    expect(await worker.get("/assets/index-old.js")).toBe("old bundle");
    expect(await worker.get("/assets/PretendardVariable.subset.91-old.woff2")).toBe("old chunk");
    expect(worker.network.fetched).toEqual([]);
    expect(worker.names()).toContain(before);
  });

  it("drops that cache once its own holds a shell, and carries over only its typefaces", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "new shell";
    expect(await worker.navigate("/?pane=p_1")).toBe("new shell");
    expect(worker.names()).toEqual([current, FILES]);
    expect(worker.entries(current)).toEqual(["/"]);
    expect(worker.entries(FILES)).toEqual(["/assets/PretendardVariable.subset.91-old.woff2"]);
    // what the new shell asks for is fetched and kept as before, one file at a time
    expect(await worker.get("/assets/index-new.js")).toBe("network /assets/index-new.js");
    expect(worker.entries(current)).toEqual(["/", "/assets/index-new.js"]);
    worker.network.online = false;
    expect(await worker.navigate()).toBe("new shell");
    expect(await worker.get("/assets/index-new.js")).toBe("network /assets/index-new.js");
    expect(await worker.get("/assets/index-old.js")).toBeNull();
    expect(await worker.get("/assets/PretendardVariable.subset.91-old.woff2")).toBe("old chunk");
  });

  it("gives the page its shell without waiting for the copy to be kept", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "new shell";
    let written = (): void => undefined;
    worker.disk.ready = new Promise<void>((done) => { written = done; });
    const { answer, kept } = worker.fire();
    // the answer settles while the write is still held
    expect(await (await answer)!.text()).toBe("new shell");
    expect(worker.entries(current)).toEqual([]);
    expect(worker.names()).toContain(before);
    written();
    await kept();
    expect(worker.entries(current)).toEqual(["/"]);
    expect(worker.names()).toEqual([current, FILES]);
  });

  it("keeps a file the old cache answered while the new shell's copy was still being kept", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "new shell";
    let written = (): void => undefined;
    worker.disk.ready = new Promise<void>((done) => { written = done; });
    const { answer, kept } = worker.fire();
    expect(await (await answer)!.text()).toBe("new shell");
    // the page asks for a bundle only the old cache holds, before that cache is retired
    const asked = worker.ask("/assets/index-old.js");
    expect(await (await asked.answer)!.text()).toBe("old bundle");
    written();
    await kept();
    await asked.kept();
    expect(worker.names()).toEqual([current, FILES]);
    expect(worker.entries(current)).toEqual(["/", "/assets/index-old.js"]);
    worker.network.online = false;
    expect(await worker.get("/assets/index-old.js")).toBe("old bundle");
  });

  it("keeps the old cache through a navigation the server refused", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "sign in";
    worker.network.status = 401;
    expect(await worker.navigate()).toBe("sign in");
    expect(worker.names()).toContain(before);
    expect(worker.entries(before)).toContain("/");
    worker.network.online = false;
    expect(await worker.navigate()).toBe("old shell");
  });

  it("has no shell to give a device that never loaded the app online", async () => {
    const worker = serviceWorker({});
    await worker.update();
    worker.network.online = false;
    expect(await worker.navigate()).toBeNull();
  });
});

describe("a file the server no longer has", () => {
  const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
  const current = /const CACHE_NAME = "([^"]+)"/.exec(sw)![1]!;

  for (const goneAs of ["404", "shell"] as const) {
    it(`is not kept when the server answers it with ${goneAs === "404" ? "a 404" : "its shell"}`, async () => {
      const worker = serviceWorker({});
      await worker.update();
      expect(await worker.navigate()).toBe("shell");
      worker.network.gone.add("/assets/katex-old.js");
      worker.network.goneAs = goneAs;
      await worker.get("/assets/katex-old.js");
      expect(worker.entries(current)).toEqual(["/"]);
      // asked again, it goes to the network again: a server that has it by then is heard
      worker.network.gone.clear();
      expect(await worker.get("/assets/katex-old.js")).toBe("network /assets/katex-old.js");
      expect(worker.entries(current)).toEqual(["/", "/assets/katex-old.js"]);
    });
  }

  it("is not served from a shell an older worker kept under its URL", async () => {
    const worker = serviceWorker({ [current]: { "/": "shell", "/assets/katex-old.js": { body: "shell", type: "text/html; charset=utf-8" } } },
      stampServiceWorker(sw, "0123456789ab"));
    await worker.update();
    expect(await worker.get("/assets/katex-old.js")).toBe("network /assets/katex-old.js");
  });
});

describe("a service worker of a new build", () => {
  const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
  const current = /const CACHE_NAME = "([^"]+)"/.exec(sw)![1]!;

  it("drops every file of the build before once its own cache holds a shell", async () => {
    const first = serviceWorker({}, stampServiceWorker(sw, "aaaaaaaaaaaa"));
    await first.update();
    expect(await first.navigate()).toBe("shell");
    await first.get("/assets/index-a.js");
    await first.get("/assets/katex-a.js");
    expect(first.names()).toEqual([`${current}-aaaaaaaaaaaa`, FILES]);

    // the next build's worker over what the first one kept
    const kept = Object.fromEntries(first.names().map((name) => [name, Object.fromEntries(first.entries(name).map((key) => [key, `kept ${key}`]))]));
    const next = serviceWorker(kept, stampServiceWorker(sw, "bbbbbbbbbbbb"));
    await next.update();
    // offline before it reached the server, the build before still starts
    next.network.online = false;
    expect(await next.navigate()).toBe("kept /");
    next.network.online = true;
    next.network.shell = "new shell";
    expect(await next.navigate()).toBe("new shell");
    expect(next.names().sort()).toEqual([`${current}-bbbbbbbbbbbb`, FILES].sort());
    expect(next.entries(`${current}-bbbbbbbbbbbb`)).toEqual(["/"]);
  });

  it("retires the unstamped cache every release used to share", async () => {
    const worker = serviceWorker({ [current]: { "/": "old shell", "/assets/index-1.js": "1", "/assets/index-2.js": "2", "/assets/index-3.js": "3" } },
      stampServiceWorker(sw, "cccccccccccc"));
    await worker.update();
    worker.network.shell = "new shell";
    expect(await worker.navigate()).toBe("new shell");
    expect(worker.names()).toEqual([`${current}-cccccccccccc`, FILES]);
    expect(worker.entries(`${current}-cccccccccccc`)).toEqual(["/"]);
  });

  // the worker before answered the new shell's files before this one was installed, so only its cache has them
  const shellB = '<script type="module" crossorigin src="/assets/index-b.js"></script><link rel="stylesheet" crossorigin href="/assets/index-b.css">';
  const before = () => ({ [`${current}-aaaaaaaaaaaa`]: { "/": "shell a", "/assets/index-b.js": "b script", "/assets/index-b.css": "b style", "/assets/index-a.js": "a script" } });

  it("carries the files its shell starts with over from the cache it retires", async () => {
    const worker = serviceWorker(before(), stampServiceWorker(sw, "bbbbbbbbbbbb"));
    await worker.update();
    worker.network.shell = shellB;
    // the network is gone for everything after the page itself
    const { answer, kept } = worker.fire();
    expect(await (await answer)!.text()).toBe(shellB);
    worker.network.online = false;
    await kept();
    expect(worker.names().sort()).toEqual([`${current}-bbbbbbbbbbbb`, FILES].sort());
    expect(worker.entries(`${current}-bbbbbbbbbbbb`).sort()).toEqual(["/", "/assets/index-b.css", "/assets/index-b.js"]);
    expect(await worker.navigate()).toBe(shellB);
    expect(await worker.get("/assets/index-b.js")).toBe("b script");
    expect(await worker.get("/assets/index-b.css")).toBe("b style");
    expect(await worker.get("/assets/index-a.js")).toBeNull();
  });

  it("keeps the cache before while a file its shell starts with can be had from nowhere", async () => {
    const stored = before();
    delete (stored[`${current}-aaaaaaaaaaaa`] as Record<string, string>)["/assets/index-b.css"];
    const worker = serviceWorker(stored, stampServiceWorker(sw, "bbbbbbbbbbbb"));
    await worker.update();
    worker.network.shell = shellB;
    const { answer, kept } = worker.fire();
    expect(await (await answer)!.text()).toBe(shellB);
    worker.network.online = false;
    await kept();
    expect(worker.names()).toContain(`${current}-aaaaaaaaaaaa`);
    // offline, the start the worker before kept: its shell, not one whose stylesheet is nowhere
    expect(await worker.navigate()).toBe("shell a");
    expect(await worker.get("/assets/index-a.js")).toBe("a script");
    expect(await worker.get("/assets/index-b.css")).toBeNull();
    // the next navigation that reaches the server finishes the copy and retires it
    worker.network.online = true;
    expect(await worker.navigate()).toBe(shellB);
    expect(worker.names().sort()).toEqual([`${current}-bbbbbbbbbbbb`, FILES].sort());
    // the old page's bundle it asked for meanwhile came along, as any file the old cache answers does
    expect(worker.entries(`${current}-bbbbbbbbbbbb`).sort()).toEqual(["/", "/assets/index-a.js", "/assets/index-b.css", "/assets/index-b.js"]);
  });

  it("keeps the typefaces and icons a phone already has across an update", async () => {
    const font = "/assets/PretendardVariable.subset.40-abc.woff2";
    const first = serviceWorker({}, stampServiceWorker(sw, "aaaaaaaaaaaa"));
    await first.update();
    expect(await first.navigate()).toBe("shell");
    await first.get(font);
    await first.get("/icons/icon-192.png?v=sheep1");
    await first.get("/assets/index-a.js");
    const kept = Object.fromEntries(first.names().map((name) => [name, Object.fromEntries(first.entries(name).map((key) => [key, `kept ${key}`]))]));
    const next = serviceWorker(kept, stampServiceWorker(sw, "bbbbbbbbbbbb"));
    await next.update();
    next.network.shell = "new shell";
    expect(await next.navigate()).toBe("new shell");
    next.network.online = false;
    expect(await next.get(font)).toBe(`kept ${font}`);
    expect(await next.get("/icons/icon-192.png?v=sheep1")).toBe("kept /icons/icon-192.png?v=sheep1");
    expect(await next.get("/assets/index-a.js")).toBeNull();
  });

  it("moves the typefaces of the unstamped cache into the one no build retires", async () => {
    const font = "/assets/PretendardVariable.subset.40-abc.woff2";
    const worker = serviceWorker({ [current]: { "/": "old shell", "/assets/index-1.js": "1", [font]: "chunk" } }, stampServiceWorker(sw, "cccccccccccc"));
    await worker.update();
    worker.network.shell = "new shell";
    expect(await worker.navigate()).toBe("new shell");
    expect(worker.entries(FILES)).toEqual([font]);
    worker.network.online = false;
    expect(await worker.get(font)).toBe("chunk");
  });

  it("moves the files of its build the worker before kept, and only those", async () => {
    // the reload after the update was answered by the worker before: build b's KaTeX chunk, fetched
    // early, sits in build a's cache with a's own bundle
    const worker = serviceWorker({ [`${current}-aaaaaaaaaaaa`]: { "/": "shell a", "/assets/katex-b.js": "b katex", "/assets/index-a.js": "a script" } },
      stampServiceWorker(sw, "bbbbbbbbbbbb", ["/assets/index-b.js", "/assets/katex-b.js"]));
    await worker.update();
    worker.network.shell = "new shell";
    let written = (): void => undefined;
    worker.disk.ready = new Promise<void>((done) => { written = done; });
    const { answer, kept } = worker.fire();
    expect(await (await answer)!.text()).toBe("new shell");
    // an old page asks for a's bundle before that cache is retired: answered, not copied forward
    const asked = worker.ask("/assets/index-a.js");
    expect(await (await asked.answer)!.text()).toBe("a script");
    written();
    await kept();
    await asked.kept();
    expect(worker.names().sort()).toEqual([`${current}-bbbbbbbbbbbb`, FILES].sort());
    expect(worker.entries(`${current}-bbbbbbbbbbbb`).sort()).toEqual(["/", "/assets/katex-b.js"]);
    // offline later, math still draws: the chunk was kept although it was not asked for again
    worker.network.online = false;
    expect(await worker.get("/assets/katex-b.js")).toBe("b katex");
    expect(await worker.get("/assets/index-a.js")).toBeNull();
  });

  it("keeps the entry files of the shell it retires, for a page that started from it and has not asked yet", async () => {
    const shellA = '<script type="module" crossorigin src="/assets/index-a.js"></script><link rel="stylesheet" crossorigin href="/assets/index-a.css">';
    const worker = serviceWorker({ [`${current}-aaaaaaaaaaaa`]: { "/": shellA, "/assets/index-a.js": "a script", "/assets/index-a.css": "a style", "/assets/katex-a.js": "a katex" } },
      stampServiceWorker(sw, "bbbbbbbbbbbb", ["/assets/index-b.js"]));
    await worker.update();
    // a window starts offline from build a's shell and is suspended before it asks for its script
    worker.network.online = false;
    expect(await worker.navigate()).toBe(shellA);
    // another window reaches the server and retires build a's cache
    worker.network.online = true;
    worker.network.shell = "new shell";
    worker.network.gone = new Set(["/assets/index-a.js", "/assets/index-a.css", "/assets/katex-a.js"]);
    expect(await worker.navigate()).toBe("new shell");
    expect(worker.names().sort()).toEqual([`${current}-bbbbbbbbbbbb`, FILES].sort());
    // the first window resumes: it boots (a later part of build a is gone, and the app offers a reload)
    expect(await worker.get("/assets/index-a.js")).toBe("a script");
    expect(await worker.get("/assets/index-a.css")).toBe("a style");
    // the rest of build a is gone: a 404, empty
    expect(await worker.get("/assets/katex-a.js")).toBe("");
  });
});

describe("a PC's worker in the hosted shell", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const OTHER = "fedcba9876543210fedcba9876543210";
  type Window = { url: string; focused: boolean; visibilityState: string; told: unknown[]; postMessage(data: unknown): void; focus(): Promise<void> };
  const windowAt = (path: string, visibilityState = "hidden"): Window => ({
    url: `https://app.test${path}`, focused: false, visibilityState, told: [],
    postMessage(data) { this.told.push(data); }, focus: async () => undefined,
  });

  /** public/sw.js registered at `/s/<ID>/`, with `windows` open on the origin (every PC's). */
  function scoped(windows: Window[]) {
    const listeners = new Map<string, (event: unknown) => void>();
    const opened: string[] = [];
    const shown: { silent: boolean }[] = [];
    const self = {
      registration: { scope: `https://app.test/s/${ID}/`, showNotification: async (_title: string, options: { silent: boolean }) => { shown.push(options); } },
      clients: { matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); return null; } },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    };
    new Function("self", readFileSync(join(publicDir, "sw.js"), "utf8"))(self);
    const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.get(type)!({ ...event, waitUntil: (work: Promise<unknown>) => { done = work; } });
      await done;
    };
    const click = (paneId: string | null) => fire("notificationclick", { notification: { data: { pane_id: paneId, machine_id: "local" }, close: () => undefined } });
    return { click, push: () => fire("push", { data: { json: () => ({ title: "t" }) } }), opened, shown };
  }

  it("opens a tap in the PC's own scope, not the shell's front page", async () => {
    const worker = scoped([]);
    await worker.click("w1:p1");
    await worker.click(null);
    expect(worker.opened).toEqual([`/s/${ID}/#machine=local&pane=w1%3Ap1&view=chat`, `/s/${ID}/`]);
  });

  it("never hands a tap to another PC's window on the same origin", async () => {
    const other = windowAt(`/s/${OTHER}/`);
    const front = windowAt("/");
    const worker = scoped([other, front]);
    await worker.click("w1:p1");
    expect(other.told).toEqual([]);
    expect(front.told).toEqual([]);
    expect(worker.opened).toEqual([`/s/${ID}/#machine=local&pane=w1%3Ap1&view=chat`]);

    const own = windowAt(`/s/${ID}/`);
    const open = scoped([other, own]);
    await open.click("w1:p1");
    expect(own.told).toHaveLength(2);
    expect(open.opened).toEqual([]);
  });

  it("rings for its PC's alert while only another PC's window is in view", async () => {
    const watchingOther = scoped([windowAt(`/s/${OTHER}/`, "visible")]);
    await watchingOther.push();
    const watchingOwn = scoped([windowAt(`/s/${ID}/`, "visible")]);
    await watchingOwn.push();
    expect([watchingOther.shown[0]!.silent, watchingOwn.shown[0]!.silent]).toEqual([false, true]);
  });
});
