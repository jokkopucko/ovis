/**
 * Todo 17: two real PCs, a remote bridge, one shell origin, and the real encrypted relay.
 * Run after both builds, with FFMPEG pointing at ffmpeg and an isolated HERDR_TEST_SESSION.
 * Reuses the shell QA's Pages host and WebSocket bridge. All waits name an event; the browser
 * clock is frozen, so a readiness check cannot accidentally win by letting a timer elapse.
 * The browser lane (scripts/ci-browser.sh) runs it as an entry of its own; relay-e2e-regression.ts
 * calls `relayMediaQa` only with another server tree (RELAY_E2E_SERVER_DIR, --skew).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { fileInfo, fileResponse, pagePolicy } from "../server/file-view.ts";
import { herdrRpc, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { opencodeImage } from "../server/opencode.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import { relayResourcePath } from "../shared/relay-mux.ts";
import { fileUrl } from "../src/lib/api.ts";
import { userGalleryImages } from "../src/lib/chatImages.ts";
import { readerHref } from "../src/lib/fileReader.ts";
import { chromePath } from "./chrome-path.ts";
import { loadPagesSite, pagesResponse } from "./pages-static.ts";
import { relayBrowserSocket, relayServerTree } from "./relay-browser-bridge.ts";
import type { RelayServerTree } from "./relay-browser-bridge.ts";

/** Todo 17's two-PC resource proof, against `tree`'s server (relay-e2e-regression.ts runs it against another server tree). */
export async function relayMediaQa(tree: RelayServerTree): Promise<void> {
  const { createServer, RelayService } = tree;
  const repo = join(import.meta.dir, "..");
  const root = mkdtempSync(join(tmpdir(), "relay-media-"));
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) mkdirSync(evidence, { recursive: true });
  const log: string[] = [];
  const note = (message: string): void => { log.push(message); console.log(message); };
  const keep = (name: string, text: string): void => { if (evidence) writeFileSync(join(evidence, `task-17-${name}.txt`), text); };
  const shot = async (page: Page, name: string): Promise<void> => {
    if (evidence) await page.screenshot({ path: join(evidence, `task-17-${name}.png`), animations: "disabled" });
  };
  async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), 30_000); })]); }
    finally { clearTimeout(timer); }
  }

  const requests: { pc: string; target: string; range: string | null }[] = [];
  const arrivals = new EventTarget();
  const record = (pc: string, request: Request): void => {
    const url = new URL(request.url);
    const entry = { pc, target: url.pathname + url.search, range: request.headers.get("range") };
    requests.push(entry);
    arrivals.dispatchEvent(new CustomEvent("request", { detail: entry }));
  };
  function nextRange(pc: string, path: string): Promise<{ pc: string; target: string; range: string | null }> {
    return bounded(new Promise((resolve) => {
      const receive = (event: Event): void => {
        if (!(event instanceof CustomEvent)) return;
        const entry = event.detail as typeof requests[number];
        if (entry.pc !== pc || !entry.target.includes(encodeURIComponent(path)) || !/^bytes=[1-9]\d*-/.test(entry.range ?? "")) return;
        arrivals.removeEventListener("request", receive);
        resolve(entry);
      };
      arrivals.addEventListener("request", receive);
    }), `positive Range on ${pc}`);
  }

  // Every full-page read opens a client/data pair, all from the same loopback address.
  const relay = startBunRelay({ port: 0 });
  const relayAddress = (address: string): string => {
    const url = new URL(address);
    return `ws://127.0.0.1:${relay.port}${url.pathname}${url.search}`;
  };
  const site = loadPagesSite(join(repo, "dist-shell"));
  let workerMode: "current" | "old" | "drop-csp" = "current";
  const shell = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const response = await pagesResponse(site, request);
    if (!new URL(request.url).pathname.endsWith("/sw.js")) return response;
    let source = await response.text();
    if (workerMode === "old") source = source.replace(/const RELAY_RESOURCES = .*;/, "const RELAY_RESOURCES = null;");
    if (workerMode === "drop-csp") {
      const enforcement = /headers.append\("content-security-policy", .*;\n/;
      assert.match(source, enforcement, "mutation must remove the worker-enforced policy");
      source = source.replace(enforcement, "");
    }
    return new Response(source, { headers: response.headers });
  } });
  const origin = `http://127.0.0.1:${shell.port}`;
  const pcs: Awaited<ReturnType<typeof pc>>[] = [];
  const workspaces: string[] = [];
  const contexts: BrowserContext[] = [];
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const png = readFileSync(join(repo, "public/icons/icon-192.png"));
  const video = join(root, "seek.mp4");
  const remoteId = "remote pc:한%";
  const remoteDir = join(root, "remote");
  mkdirSync(remoteDir);
  let remote: ReturnType<typeof Bun.serve> | undefined;

  /** Three independent blocked operations, reported only after the attempted fetch settles. */
  const attack = (id: string): string => `(async () => {
    if (document.body) document.body.dataset.ran = "1";
    const result = {};
    try { indexedDB.open("ovis-relay"); result.indexedDB = "allowed"; } catch (e) { result.indexedDB = e.name; }
    try { void parent.document.body; result.parent = "allowed"; } catch (e) { result.parent = e.name; }
    try { top.location.hash = "untrusted-navigation"; result.top = "allowed"; } catch (e) { result.top = e.name; }
    try { await fetch(${JSON.stringify(`/s/${id}/~/api/fs/file?path=/etc/hostname`)}); result.fetch = "allowed"; } catch (e) { result.fetch = e.name; }
    parent.postMessage({ type: "isolation", result }, "*");
  })();`;

  async function pc(name: string) {
    const dir = mkdtempSync(join(root, `${name}-`));
    const stateDir = mkdtempSync(join(root, `${name}-state-`));
    copyFileSync(join(repo, "public/icons/icon-192.png"), join(dir, "picture.png"));
    copyFileSync(video, join(dir, "seek.mp4"));
    writeFileSync(join(dir, "large.pdf"), Buffer.alloc(70 * 1024 * 1024));
    // A valid single-page PDF, generated in the same real browser rather than a fake PDF MIME.
    const pdfPage = await browser.newPage();
    await pdfPage.setContent(`<h1>${name}</h1>`);
    await pdfPage.pdf({ path: join(dir, "document.pdf") });
    await closePage(pdfPage);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, revert text, time_created integer, time_updated integer);
      CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);`);
    db.query("INSERT INTO session_v2 VALUES ('ses_media', 'global', NULL, 'media', ?, 'Media', '2.0.24', NULL, 1, 1)").run(dir);
    db.query("INSERT INTO session_message VALUES ('msg_media', 'ses_media', 'user', 1, 1, 1, ?)").run(JSON.stringify({
      text: name, files: [{ uri: `data:image/png;base64,${png.toString("base64")}` }], agents: [], time: { created: 1 },
    }));
    db.close();
    assert.ok(opencodeImage(dbPath, "ses_media", "opencode:msg_media:0"), "attachment is readable from the fixture store");
    const workspace = await workspaceCreate({ cwd: dir, label: name });
    workspaces.push(workspace.workspace.workspace_id);
    const pane = workspace.root_pane.pane_id;
    // A session report is accepted only while the actual foreground process holds the pane.
    const standIn = join(dir, "opencode");
    writeFileSync(standIn, "#!/bin/sh\nwhile read -r line; do :; done\n");
    chmodSync(standIn, 0o755);
    const watching = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.updated", pane_id: pane }, { type: "pane.agent_status_changed", pane_id: pane }], {
      onStarted: watching.resolve,
      onError: running.reject,
      onEvent: () => { void sessionSnapshot().then((snapshot) => {
        if (snapshot.panes.some((candidate) => candidate.pane_id === pane && candidate.agent === "opencode")) running.resolve();
      }, running.reject); },
    });
    try {
      await bounded(watching.promise, "agent event subscription");
      await herdrRpc("pane.send_text", { pane_id: pane, text: `exec ${JSON.stringify(standIn)}\n` });
      await bounded(running.promise, "stand-in OpenCode foreground process");
    } finally { subscription.close(); }
    await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:opencode", agent: "opencode",
      agent_session_id: "ses_media", session_start_source: "select" });
    const reported = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane);
    assert.equal(reported?.agent_session?.value, "ses_media", JSON.stringify(reported));
    assert.equal(reported?.agent_session?.source, "herdr:opencode", JSON.stringify(reported));
    const synced = Promise.withResolvers<void>();
    const service = new RelayService({ stateDir, relay: "wss://relay.test", connect: (url) => {
      const socket = new WebSocket(relayAddress(url));
      socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
      return socket;
    } });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service, opencodeDb: dbPath });
    const logger = app.context.services.requestLog;
    const handle = logger.handle.bind(logger);
    // Observe the real dispatcher, without changing any response or endpoint behavior.
    logger.handle = async (request, dispatch) => {
      record(name, request);
      let response = await handle(request, dispatch);
      const path = new URL(request.url).searchParams.get("path") ?? "";
      // A compromised PC omits all isolation headers, even for files advertised as PDFs.
      if (response && new URL(request.url).pathname.endsWith("/fs/file")
        && /(?:page\.html|evil\.svg|hostile-(?:html|svg)\.pdf)$/.test(path)) {
        const headers = new Headers(response.headers);
        headers.delete("content-security-policy");
        headers.delete("x-content-type-options");
        if (path.endsWith("hostile-html.pdf")) headers.set("content-type", "text/html");
        if (path.endsWith("hostile-svg.pdf")) headers.set("content-type", "image/svg+xml");
        response = new Response(response.body, { status: response.status, headers });
      }
      if (response && response.status >= 400 && request.url.includes("/fs/")) note(`${name} ${response.status}: ${request.url} ${await response.clone().text()}`);
      return response;
    };
    service.start();
    await bounded(synced.promise, `${name} relay synced`);
    const offer = decodeOffer(service.offer().url);
    assert.ok(offer);
    const id = offer.server_id;
    writeFileSync(join(dir, "page.html"), `<!doctype html><body><h1>${name} rendered</h1><script>${attack(id)}</script></body>`);
    writeFileSync(join(dir, "evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/><script><![CDATA[${attack(id)}]]></script></svg>`);
    copyFileSync(join(dir, "page.html"), join(dir, "hostile-html.pdf"));
    copyFileSync(join(dir, "evil.svg"), join(dir, "hostile-svg.pdf"));
    copyFileSync(join(dir, "page.html"), join(dir, "spoof.pdf"));
    return { name, dir, stateDir, app, service, offer: { ...offer, name }, id, pane };
  }

  async function context(blob = false): Promise<BrowserContext> {
    // Native WebViews expose no navigator.serviceWorker. Do not use Playwright's blocking init
    // script: it reads that property in opaque sandbox frames and throws there before our code.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => relayBrowserSocket(ws, () => relayAddress(ws.url())));
    await context.addInitScript(({ blob }) => {
      if (window !== window.top) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" }));
      if (blob) Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
      const results: unknown[] = [];
      Object.defineProperty(window, "isolationResults", { value: results });
      const sizes: number[] = [];
      Object.defineProperty(window, "blobSizes", { value: sizes });
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (value) => { if (value instanceof Blob) sizes.push(value.size); return create(value); };
      if (!blob) {
        const post = ServiceWorker.prototype.postMessage;
        ServiceWorker.prototype.postMessage = function (...args) {
          if (args[0]?.type === "ovis-relay-resources-v1") {
            Object.defineProperty(window, "resourceProbed", { configurable: true, value: true });
            dispatchEvent(new Event("resource-probe"));
          }
          return Reflect.apply(post, this, args);
        };
      }
      addEventListener("message", (event) => {
        if (event.data?.type === "isolation") { results.push(event.data.result); dispatchEvent(new Event("isolation-result")); }
      });
    }, { blob });
    return context;
  }
  async function mediaPage(context: BrowserContext): Promise<Page> {
    const opened = context.waitForEvent("page");
    const page = await context.newPage();
    assert.equal(await opened, page);
    page.on("pageerror", (error) => console.error("page error", error.stack));
    page.on("response", (response) => { if (response.status() >= 400) console.error("HTTP", response.status(), response.url()); });
    page.setDefaultTimeout(25_000);
    await page.clock.install({ time: new Date("2026-10-30T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-30T00:00:01Z"));
    return page;
  }
  async function closePage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const closed = page.waitForEvent("close");
    await bounded(Promise.all([closed, page.close()]), "page close");
  }
  async function closeContext(context: BrowserContext): Promise<void> {
    const closed = [context.waitForEvent("close"), ...context.pages().map((page) => page.waitForEvent("close"))];
    await bounded(Promise.all([...closed, context.close()]), "context close");
    contexts.splice(contexts.indexOf(context), 1);
  }
  async function navigate(page: Page, url: string): Promise<void> {
    const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() });
    await Promise.all([navigated, page.goto(url)]);
  }
  async function pair(context: BrowserContext, p: typeof pcs[number]): Promise<Page> {
    const page = await mediaPage(context);
    const offer = decodeOffer(p.service.offer().url);
    assert.ok(offer);
    await navigate(page, encodeOffer({ ...offer, name: p.name }, origin));
    // an admitted pairing enters the app by itself, with no Ready checkpoint before it (lib/relay/shell.tsx)
    const paired = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() && !frame.url().includes("#offer=") });
    await Promise.all([paired, page.getByRole("button", { name: "Pair", exact: true }).click({ force: true })]);
    await page.locator(".app").waitFor();
    assert.equal(await page.locator('[role=dialog][data-add-pc-phase="ready"]').count(), 0, "no Ready checkpoint after a pairing");
    return page;
  }
  async function controlled(page: Page): Promise<void> {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return;
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    });
  }
  async function read(page: Page, p: typeof pcs[number], name: string, machine = "local"): Promise<void> {
    const path = machine === "local" ? join(p.dir, name) : `/remote/${name}`;
    // each file is a load of its own, as a tab opened on its link is: the reader's address differs
    // from the page's only in its fragment (lib/pageQuery.ts), and a reader already up would take
    // a file of the same PC in place, leaving the last file's elements for a moment
    await page.goto("about:blank");
    await navigate(page, origin + readerHref(machine, path, `/s/${p.id}/`, "relay"));
    await page.locator(".file-reader").waitFor();
  }
  /**
   * A page over the relay is drawn without its scripts first: the render host puts it in a frame of its own that
   * runs none, and nothing in it has run. The press runs it in the render host itself.
   */
  async function runPageScripts(page: Page, heading: string): Promise<void> {
    const host = page.locator("iframe.file-viewer-page");
    await host.waitFor();
    assert.equal(await host.getAttribute("data-page-scripts"), "off");
    const still = page.frameLocator("iframe.file-viewer-page").locator("iframe");
    await still.waitFor();
    assert.equal(await still.getAttribute("sandbox"), "", "the page's own frame allows no script");
    assert.ok((await still.getAttribute("srcdoc") ?? "").includes(heading), "and holds the page");
    assert.equal(await page.evaluate(() => (window as Window & { isolationResults?: unknown[] }).isolationResults?.length ?? 0), 0, "no script of the page ran before the press");
    await page.getByRole("button", { name: "Run scripts", exact: true }).click();
    await page.locator('iframe.file-viewer-page[data-page-scripts="on"]').waitFor();
  }
  async function image(page: Page): Promise<void> {
    const picture = page.locator("img.file-viewer-media[src]");
    await picture.waitFor();
    const dimensions = await picture.evaluate(async (image: HTMLImageElement) => { await image.decode(); return image.naturalWidth; });
    assert.ok(dimensions > 0);
  }
  async function pdf(page: Page, p: typeof pcs[number], machine = "local", blob = false, name = "document.pdf"): Promise<void> {
    const viewer = page.waitForEvent("framenavigated", { predicate: (frame) => frame.url().startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/") });
    const response = blob ? null : page.waitForResponse((response) => response.url().includes("/~/api/")
      && new URL(response.url()).searchParams.get("path")?.endsWith(name) === true
      && new URL(response.url()).searchParams.get("download") !== "1");
    await read(page, p, name, machine);
    if (response) {
      const navigation = await response;
      assert.equal(navigation.status(), 200);
      assert.equal(navigation.headers()["content-type"], "application/pdf");
      assert.ok(navigation.fromServiceWorker());
      assert.equal(navigation.request().isNavigationRequest(), true);
    }
    await page.locator("iframe.file-viewer-pdf").waitFor();
    const frame = await viewer;
    const loaded = await bounded(frame.evaluate(async () => {
      await customElements.whenDefined("pdf-viewer");
      const loaded = new Promise<string>((resolve) => addEventListener("message", function receive(event) {
        if (event.data?.type !== "documentLoaded") return;
        removeEventListener("message", receive);
        resolve(event.data.load_state);
      }));
      // Chrome's viewer reports its completed parser/render state through its scripting API.
      postMessage({ type: "getSelectedText" }, "*");
      return loaded;
    }), "Chrome PDF viewer documentLoaded");
    assert.equal(loaded, name === "spoof.pdf" ? "failed" : "success", "Chrome reports the PDF parser state, not just iframe navigation");
    await shot(page, `${p.name}-${blob ? "blob" : machine === "local" ? "local" : "remote"}-${name}`);
    note(`PDF ${p.name}/${blob ? "blob" : machine}/${name}: Chrome documentLoaded=${loaded}`);
  }
  async function isolation(page: Page): Promise<Record<string, string>> {
    return bounded(page.evaluate(async () => {
      const state = window as Window & { isolationResults?: Record<string, string>[] };
      if (!state.isolationResults?.length) await new Promise<void>((resolve) => addEventListener("isolation-result", () => resolve(), { once: true }));
      const result = state.isolationResults?.at(-1);
      if (!result) throw new Error("no isolation result");
      return result;
    }), "all isolation attempts reported");
  }
  function isolated(result: Record<string, string>): void {
    assert.equal(result.indexedDB, "SecurityError");
    assert.equal(result.parent, "SecurityError");
    assert.equal(result.fetch, "TypeError");
    assert.equal(result.top, "SecurityError");
  }
  async function seek(page: Page, p: typeof pcs[number], machine = "local"): Promise<void> {
    const path = machine === "local" ? join(p.dir, "seek.mp4") : "/remote/seek.mp4";
    // Subscribe before navigation: Chrome can first ask for tail metadata at a positive offset.
    const ranged = nextRange(p.name, path);
    await read(page, p, "seek.mp4", machine);
    const media = page.locator("video");
    await media.waitFor();
    const times = await bounded(media.evaluate(async (video: HTMLVideoElement) => {
      if (video.readyState < 1) await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error(`media error ${video.error?.code}`)), { once: true });
      });
      const sought = new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
      const target = video.duration * 0.8;
      video.currentTime = target;
      await sought;
      const before = video.currentTime;
      const advanced = new Promise<void>((resolve) => video.addEventListener("timeupdate", function updated() {
        if (video.currentTime <= before) return;
        video.removeEventListener("timeupdate", updated);
        resolve();
      }));
      video.muted = true;
      await video.play();
      await advanced;
      video.pause();
      return { duration: video.duration, target, before, after: video.currentTime };
    }), "video sought and advanced");
    const entry = await ranged;
    assert.ok(times.after > times.before);
    assert.ok(!requests.some((r) => r.pc !== p.name && r.pc !== "remote" && r.target.includes(encodeURIComponent(path))));
    note(`video ${p.name}/${machine}: ${JSON.stringify({ ...times, range: entry.range })}`);
  }

  try {
    const ffmpeg = process.env["FFMPEG"] ?? "ffmpeg";
    const encode = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-t", "43", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "8000k", "-minrate", "8000k", "-maxrate", "8000k",
      "-bufsize", "8000k", "-x264-params", "nal-hrd=cbr:force-cfr=1", "-movflags", "+faststart", "-y", video], { stdout: "inherit", stderr: "inherit" });
    assert.equal(await encode.exited, 0);
    assert.ok(statSync(video).size >= 30 * 1024 * 1024, "video is at least 30 MiB");
    pcs.push(await pc("PC1"), await pc("PC2"));
    const [first, second] = pcs;
    assert.ok(first && second);
    assert.notEqual(first.stateDir, second.stateDir);
    for (const [p, other] of [[first, second], [second, first]]) {
      assert.ok(p && other);
      writeFileSync(join(p.dir, "hostile-html.pdf"), `<!doctype html><body><script>${attack(other.id)}</script></body>`);
      writeFileSync(join(p.dir, "hostile-svg.pdf"), `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[${attack(other.id)}]]></script></svg>`);
    }
    for (const name of ["picture.png", "seek.mp4", "document.pdf"]) copyFileSync(join(first.dir, name), join(remoteDir, name));
    remote = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      record("remote", request);
      assert.equal(request.headers.get("authorization"), "Bearer media-remote-token");
      const url = new URL(request.url);
      const path = url.searchParams.get("path") ?? "";
      assert.ok(/^\/remote\/(?:picture\.png|seek\.mp4|document\.pdf)$/.test(path));
      const info = fileInfo(join(remoteDir, path.slice("/remote/".length)));
      assert.ok(info);
      return url.pathname === "/api/fs/stat" ? Response.json({ ...info, path })
        : fileResponse(info, false, false, null, request);
    } });
    const manager = first.app.context.services.core.machines;
    assert.ok(manager);
    const endpoint = manager.endpoint.bind(manager);
    // machine-api selects by the literal path segment; the SW must not decode or re-encode it.
    manager.endpoint = (id) => id === encodeURIComponent(remoteId) ? { url: `http://127.0.0.1:${remote?.port}`, token: "media-remote-token" } : endpoint(id);
    const remoteProbe = await fetch(`http://127.0.0.1:${first.app.port}/api/machines/${encodeURIComponent(remoteId)}/fs/stat?path=%2Fremote%2Fpicture.png`);
    const remoteProbeBody = await remoteProbe.text();
    assert.equal(remoteProbe.status, 200, remoteProbeBody);

    const sw = await context();
    const tabs = [await pair(sw, first), await pair(sw, second)];
    for (let i = 0; i < pcs.length; i++) {
      const p = pcs[i], page = tabs[i];
      assert.ok(p && page);
      await controlled(page);
      await read(page, p, "picture.png");
      await image(page);
      note(`${p.name}: file image decoded`);
      assert.ok((await page.locator("img.file-viewer-media").getAttribute("src"))?.startsWith(`/s/${p.id}/~/api/`));
      const attachment = userGalleryImages("local", p.pane, [{ kind: "image", ref: "opencode:msg_media:0", media_type: "image/png" }], "", (text) => text)[0];
      assert.ok(attachment);
      await page.evaluate(async (src) => { const image = new Image(); image.src = src; document.body.append(image); await image.decode(); if (!image.naturalWidth) throw new Error("attachment empty"); }, relayResourcePath(p.id, attachment.src));
      note(`${p.name}: attachment image decoded`);
      await pdf(page, p);
      await read(page, p, "page.html");
      await runPageScripts(page, `${p.name} rendered`);
      isolated(await isolation(page));
      assert.equal(await page.frameLocator("iframe.file-viewer-page").locator("body").getAttribute("data-ran"), "1");
      assert.equal(await page.frameLocator("iframe.file-viewer-page").locator("h1").textContent(), `${p.name} rendered`);
      // document.write has completed but a frozen clock has not painted the child frame yet.
      await page.frameLocator("iframe.file-viewer-page").locator("body").evaluate(() => {
        Object.defineProperty(window, "painted", { value: new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) });
      });
      await page.clock.runFor(17);
      await page.frameLocator("iframe.file-viewer-page").locator("body").evaluate(() => (window as Window & { painted: Promise<void> }).painted);
      await shot(page, `${p.name}-render`);
      await seek(page, p);
      note(`${p.name}: image decoded, real transcript attachment decoded, PDF iframe navigated, rendered inline script ran`);
    }
    const page = tabs[0];
    assert.ok(page);
    for (const name of ["picture.png", "document.pdf"]) {
      if (name.endsWith(".png")) { await read(page, first, name, remoteId); await image(page); }
      else await pdf(page, first, remoteId);
    }
    await seek(page, first, remoteId);
    assert.ok(requests.some((r) => r.pc === "PC1" && r.target.startsWith(`/api/machines/${encodeURIComponent(remoteId)}/fs/file`) && /^bytes=[1-9]/.test(r.range ?? "")));
    assert.ok(requests.some((r) => r.pc === "remote" && r.target.includes("seek.mp4") && /^bytes=[1-9]/.test(r.range ?? "")));
    note("remote: image/PDF/video selected the encoded remote machine on PC1 and reached its authenticated bridge");

    for (const blob of [false, true]) {
      const ctx = blob ? await context(true) : sw;
      const paired = blob ? await pair(ctx, first) : tabs[0];
      assert.ok(paired);
      if (blob) await closePage(paired);
      // Pairing is shared in IndexedDB, but a download/PDF and its teardown own only their page.
      const check = async (run: (page: Page) => Promise<void>): Promise<void> => {
        const page = blob ? await mediaPage(ctx) : paired;
        try { await run(page); }
        finally { if (blob) await closePage(page); }
      };
      await check(async (page) => {
        await read(page, first, "page.html");
        await runPageScripts(page, `${first.name} rendered`);
        isolated(await isolation(page));
      });
      await check(async (page) => {
        await read(page, first, blob ? "picture.png" : "evil.svg");
        if (!blob) {
          await image(page);
          assert.equal(await page.evaluate(() => (window as Window & { isolationResults: unknown[] }).isolationResults.length), 0, "SVG image scripts never run");
        }
        // Execute the SVG's script inside the same opaque render host, proving its attempted APIs
        // fail too, rather than counting the image decoder's non-execution as those three attempts.
        const svg = readFileSync(join(first.dir, "evil.svg"), "utf8");
        const rendered = page.waitForEvent("framenavigated", { predicate: (frame) => frame.url().endsWith("~render") });
        await page.evaluate((html) => {
          const frame = document.createElement("iframe");
          frame.sandbox.add("allow-scripts");
          frame.onload = () => { frame.onload = null; frame.contentWindow?.postMessage({ type: "ovis-render", html, scripts: true }, "*"); };
          frame.src = `${location.pathname}~render`;
          document.body.append(frame);
        }, `<!doctype html><body>${svg}</body>`);
        await rendered;
        isolated(await isolation(page));
      });
      note(`isolation ${blob ? "blob" : "SW"}: rendered HTML and SVG attempts blocked for IndexedDB, relay fetch, parent.document and top navigation`);
      for (const name of ["hostile-html.pdf", "hostile-svg.pdf"]) {
        await check(async (page) => {
          const before = requests.length;
          if (blob) {
            const downloaded = page.waitForEvent("download");
            await read(page, first, name);
            const download = await downloaded;
            assert.equal(await download.failure(), null);
            assert.deepEqual(await page.evaluate(() => (window as Window & { isolationResults: unknown[] }).isolationResults), []);
            note(`blob no-CSP ${name}: octet-stream downloaded, no script or top navigation`);
          } else {
            const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame.url().includes(encodeURIComponent(name)) });
            await read(page, first, name);
            const frame = await navigated;
            await bounded(frame.evaluate(async () => {
              if (document.readyState === "complete") return;
              await new Promise<void>((resolve) => addEventListener("load", () => resolve(), { once: true }));
            }), "raw malicious frame loaded");
            assert.equal(await frame.evaluate(() => document.body?.dataset["ran"] ?? null), null);
            assert.deepEqual(await page.evaluate(() => (window as Window & { isolationResults: unknown[] }).isolationResults), []);
            note(`SW no-CSP ${name}: enforced sandbox prevents all script execution`);
          }
          assert.ok(!page.url().includes("#untrusted-navigation"));
          assert.ok(!requests.slice(before).some((entry) => entry.target.includes("path=/etc/hostname")), "no other-PC fetch reached either PC");
        });
      }
      await check(async (page) => {
        await pdf(page, first, "local", blob, "spoof.pdf");
        assert.deepEqual(await page.evaluate(() => (window as Window & { isolationResults: unknown[] }).isolationResults), [], "HTML claiming application/pdf never executes");
        assert.ok(!page.url().includes("#untrusted-navigation"));
      });
      if (blob) {
        await check(async (page) => {
          await read(page, first, "picture.png");
          await image(page);
        });
        await check(async (page) => { await pdf(page, first, "local", true); });
        await check(async (page) => {
          const metadata = Promise.withResolvers<void>();
          page.once("close", () => metadata.reject(new Error("Blob video page closed before metadata")));
          page.once("crash", () => metadata.reject(new Error("Blob video page crashed before metadata")));
          await page.exposeFunction("relayVideoMetadata", () => metadata.resolve());
          await page.addInitScript(() => {
            addEventListener("loadedmetadata", (event) => {
              if (event.target instanceof HTMLVideoElement && event.target.currentSrc.startsWith("blob:")) {
                const ready: () => Promise<void> = Reflect.get(window, "relayVideoMetadata");
                void ready();
              }
            }, { capture: true });
          });
          // The whole body may still be downloading at the locator deadline. Observe native
          // readiness before asserting its source; the command's timeout bounds the whole run.
          await Promise.all([metadata.promise, read(page, first, "seek.mp4")]);
          const video = page.locator('video[src^="blob:"]');
          await video.waitFor();
          const size = await video.evaluate((element: HTMLVideoElement) => {
            if (element.readyState < 1 || !(element.duration > 0)) throw new Error("blob video has no metadata");
            return Math.max(...(window as Window & { blobSizes: number[] }).blobSizes);
          });
          assert.ok(size > 32 * 1024 * 1024 && size < 64 * 1024 * 1024);
          note(`blob allowed: ${size} byte video loaded whole without overflowing the relay session`);
        });
        await check(async (page) => {
          await read(page, first, "large.pdf");
          await page.getByRole("alert").filter({ hasText: "Too large to open on the phone" }).waitFor();
          assert.equal(await page.locator('iframe[src^="blob:"]').count(), 0);
          assert.deepEqual(await page.evaluate(() => (window as Window & { blobSizes: number[] }).blobSizes), []);
          await shot(page, "too-large");
          for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate((theme) => { document.documentElement.dataset["theme"] = theme; }, theme);
            await shot(page, `too-large-${width}-${theme}`);
          }
          note("blob limit: 70 MiB refused with too-large state; no blob iframe created");
        });
        await closeContext(ctx);
      }
    }

    // The installed app's Copy link must survive the originating tab closing, in either mode.
    {
      const ctx = await context(true);
      await ctx.addInitScript(() => {
        if (window !== window.top) return;
        Object.defineProperty(navigator, "standalone", { value: true });
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => {
          Object.defineProperty(window, "copiedLink", { configurable: true, value: text });
          dispatchEvent(new Event("copied-link"));
        } } });
      });
      const page = await pair(ctx, first);
      await navigate(page, `${origin}/s/${first.id}/?${new URLSearchParams({ pane: first.pane, file: join(first.dir, "page.html") })}`);
      const copy = page.getByRole("button", { name: "Copy link", exact: true });
      await copy.waitFor();
      const copied = page.evaluate(async () => {
        const copied = () => (window as Window & { copiedLink?: string }).copiedLink;
        if (!copied()) await new Promise<void>((resolve) => addEventListener("copied-link", () => resolve(), { once: true }));
        return copied();
      });
      // the click goes to the button itself: a forced click is aimed at where the button was, and the
      // viewer still settling under a frozen clock can move it from there, so the copy never ran
      const [href] = await bounded(Promise.all([copied, copy.dispatchEvent("click")]), "copied-link clipboard event");
      assert.equal(href, origin + readerHref("local", join(first.dir, "page.html"), `/s/${first.id}/`, "relay"));
      await closePage(page);
      const opened = await mediaPage(ctx);
      assert.ok(href);
      await navigate(opened, href);
      // the reader is the same viewer: the page's scripts wait for the press there too
      await runPageScripts(opened, `${first.name} rendered`);
      isolated(await isolation(opened));
      note("copy link: installed blob-mode file viewer copied a stable reader URL; a new tab opened it with its own channel");
      await closeContext(ctx);
    }

    workerMode = "old";
    {
      const ctx = await context();
      const page = await pair(ctx, first);
      await controlled(page);
      await read(page, first, "picture.png");
      await bounded(page.evaluate(async () => {
        if ((window as Window & { resourceProbed?: boolean }).resourceProbed) return;
        await new Promise<void>((resolve) => addEventListener("resource-probe", () => resolve(), { once: true }));
      }), "old worker resource probe");
      await page.clock.runFor(1500);
      await image(page);
      assert.ok((await page.locator("img.file-viewer-media").getAttribute("src"))?.startsWith("blob:"));
      workerMode = "current";
      await bounded(page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const changed = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
        await registration.update();
        await changed;
      }), "worker controller update");
      await read(page, first, "picture.png");
      await image(page);
      assert.ok((await page.locator("img.file-viewer-media").getAttribute("src"))?.startsWith(`/s/${first.id}/~/`));
      note("stale worker: old protocol fell back to blob; after update the same PC used its scoped resource proxy");
      await closeContext(ctx);
    }

    // Removing the SW's CSP must make this negative control fail: no iframe sandbox attribute
    // here, so only the forwarded response policy is capable of isolating the navigation.
    for (const mutate of [false, true]) {
      workerMode = mutate ? "drop-csp" : "current";
      const ctx = await context();
      const page = await pair(ctx, first);
      await controlled(page);
      const src = relayResourcePath(first.id, fileUrl(join(first.dir, "hostile-html.pdf"), null));
      const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame.url() === origin + src });
      await page.evaluate(async (src) => {
        const frame = document.createElement("iframe");
        const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
        frame.src = src;
        document.body.append(frame);
        await loaded;
      }, src);
      await navigated;
      if (mutate) {
        const result = await isolation(page);
        assert.throws(() => isolated(result));
        assert.equal(result.indexedDB, "allowed");
        assert.equal(result.parent, "allowed");
        note(`mutation detected: removing SW-enforced CSP for no-CSP HTML breaks isolation: ${JSON.stringify(result)}`);
      } else {
        assert.deepEqual(await page.evaluate(() => (window as Window & { isolationResults: unknown[] }).isolationResults), []);
        note("SW no-CSP HTML negative-control baseline: no script executed");
      }
      await closeContext(ctx);
    }
    workerMode = "current";
    const policy = await fetch(`${origin}/s/${first.id}/~render`);
    assert.equal(policy.headers.get("content-security-policy"), pagePolicy(null));
    keep("video", log.filter((line) => line.startsWith("video")).join("\n"));
    keep("isolation", log.filter((line) => /isolation|mutation/.test(line)).join("\n"));
    keep("two-PC", JSON.stringify({ log, requests }, null, 2));
    note("PASS relay media browser QA");
  } catch (error) {
    keep("failure", `${String(error)}\n${log.join("\n")}\n${JSON.stringify(requests, null, 2)}`);
    for (const [index, ctx] of contexts.entries()) for (const [tab, page] of ctx.pages().entries()) {
      if (!page.isClosed()) await bounded(shot(page, `failure-${index}-${tab}`), "failure screenshot").catch(() => undefined);
    }
    throw error;
  } finally {
    for (const ctx of [...contexts]) await closeContext(ctx);
    const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
    await bounded(Promise.all([disconnected, browser.close()]), "browser close");
    assert.equal(browser.isConnected(), false);
    const ports = [shell.port, remote?.port, relay.port, ...pcs.map((p) => p.app.port)];
    shell.stop(true);
    remote?.stop(true);
    for (const p of pcs) { await bounded(p.service.shutdown(), `${p.name} relay service shutdown`); p.app.stop(); }
    await bounded(relay.stop(), "relay stop");
    for (const workspace of workspaces) await bounded(workspaceClose(workspace), `workspace ${workspace} close`);
    for (const port of ports) if (port !== undefined) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }), `port ${port} is still listening`);
    }
    keep("cleanup", `Browser disconnected; shell, both PCs, remote bridge and relay stopped. Ports ${ports.join(", ")} refuse connections; owned workspaces closed.\n`);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await relayMediaQa(await relayServerTree());
