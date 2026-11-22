import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The built-in browser's guards in a real Electron: one test server answers both a.localhost and
 * b.localhost, b.localhost is blocked, and nothing the tabs try (a page, a redirect, a frame, a
 * fetch, a socket, an image, a new window, a link) may reach it, or reach the Ovis server beside it,
 * also by a name that resolves to it (`--host-resolver-rules` maps rebind.test to loopback).
 * Linux only: it runs Electron without a display (`--ozone-platform=headless`).
 */
const seen: { host: string; path: string }[] = [];
const ovisSeen: string[] = [];
let site: ReturnType<typeof Bun.serve>;
let ovis: ReturnType<typeof Bun.serve>;
let own: ReturnType<typeof Bun.serve>;
const ownSeen: string[] = [];
let build: string;

const page = (port: number, ovisPort: number) => `<!doctype html><body><script>
const B = "http://b.localhost:${port}";
const settle = (promise) => promise.then(() => "loaded", () => "refused");
const event = (start) => new Promise((done) => start(done));
window.attacks = async () => ({
  fetch: await settle(fetch(B + "/fetch", { mode: "no-cors" })),
  ownFetch: await settle(fetch("/own-fetch")),
  redirectedFetch: await settle(fetch("/redirect?to=" + encodeURIComponent(B + "/redirected-fetch"), { mode: "no-cors" })),
  socket: await event((done) => { const socket = new WebSocket("ws://b.localhost:${port}/socket"); socket.onopen = () => done("loaded"); socket.onerror = () => done("refused"); }),
  image: await event((done) => { const image = new Image(); image.onload = () => done("loaded"); image.onerror = () => done("refused"); image.src = B + "/image"; }),
  frame: await event((done) => { const frame = document.createElement("iframe"); frame.onload = () => done("settled"); frame.src = B + "/frame"; document.body.append(frame); }),
  rebound: await settle(fetch("http://rebind.test:${ovisPort}/", { mode: "no-cors" })),
  popup: window.open(B + "/popup") === null ? "none" : "window",
  ownPopup: window.open("/own-popup") === null ? "none" : "window",
});
</script></body>`;

const linux = process.platform === "linux";

beforeAll(async () => {
  if (!linux) return;
  ovis = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { ovisSeen.push(request.url); return new Response("ovis"); } });
  own = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: (request) => { ownSeen.push(request.url); return new Response("own"); } });
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      seen.push({ host: request.headers.get("host") ?? "", path: url.pathname });
      if (url.pathname === "/socket" && server.upgrade(request, { data: undefined })) return undefined;
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: url.searchParams.get("to") ?? "/" } });
      if (url.pathname === "/empty") return new Response(null, { status: 204 });
      if (url.pathname === "/small") return new Response("data", { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=small.bin" } });
      // past the harness's 1 KiB cap
      if (url.pathname === "/big") return new Response("x".repeat(4096), { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=big.bin" } });
      if (url.pathname === "/slow") return Bun.sleep(5_000).then(() => new Response("late"));
      return new Response(url.pathname === "/" ? page(site.port!, ovis.port!) : "ok", { headers: { "content-type": "text/html" } });
    },
    websocket: { message() {} },
  });
  build = mkdtempSync(join(tmpdir(), "ovis-browser-tabs-build-"));
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "browserTabs.harness.ts")], outdir: build, target: "node", format: "cjs", external: ["electron"] });
  if (!built.success) throw new Error(built.logs.join("\n"));
});

afterAll(() => {
  site?.stop(true);
  ovis?.stop(true);
  own?.stop(true);
  if (build) rmSync(build, { recursive: true, force: true });
});

describe.skipIf(!linux)("the built-in browser in Electron", () => {
  it("never lets a request reach a blocked site or an Ovis server, and lists a tab without its query", async () => {
    const electron = resolve(import.meta.dir, "..", "node_modules", "electron", "dist", "electron");
    if (!existsSync(electron)) throw new Error(`No Electron binary at ${electron}: bun install does not fetch it; run node node_modules/electron/install.js in app/electron`);
    const run = Bun.spawn([electron, "--no-sandbox", "--ozone-platform=headless", "--disable-gpu", "--host-resolver-rules=MAP rebind.test 127.0.0.1, MAP own.test 127.0.0.2, MAP late.test 127.0.0.1", join(build, "browserTabs.harness.js")], {
      env: { ...process.env, OVIS_TEST_PORT: String(site.port), OVIS_TEST_OVIS_PORT: String(ovis.port), OVIS_TEST_OWN_PORT: String(own.port), ELECTRON_ENABLE_LOGGING: "", XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" },
      stdout: "pipe",
      stderr: "ignore",
      timeout: 45_000,
    });
    const output = await new Response(run.stdout).text();
    await run.exited;
    const line = output.split("\n").find((text) => text.startsWith("RESULT "));
    if (line === undefined) throw new Error(`The harness printed no result:\n${output}`);
    const result = JSON.parse(line!.slice("RESULT ".length));
    if (result.error !== undefined) throw new Error(`The harness failed:\n${output}`);
    const port = site.port;
    expect(result.blockedTab).toBeNull();
    expect(result.ovisTab).toBeNull();
    expect(result.listed).toEqual([{ address: `http://a.localhost:${port}/`, profile: "agent" }]);
    expect(result.page).toEqual({ fetch: "refused", ownFetch: "loaded", redirectedFetch: "refused", socket: "refused", image: "refused", frame: "settled", rebound: "refused", popup: "none", ownPopup: "none" });
    expect(result.popupTabs).toBe(1);
    expect(result.direct).toBe("ERR_BLOCKED_BY_CLIENT");
    expect(result.redirect).not.toBe(`http://b.localhost:${port}/redirected`);
    expect(result.afterClose).toBe(0);
    expect(result.afterReenable).toEqual({ fetch: "refused", load: "ERR_BLOCKED_BY_CLIENT" });
    expect(result.listedBeforeCommit).toBe(0);
    expect(result.link).toEqual({ error: "net::ERR_BLOCKED_BY_CLIENT", url: `http://a.localhost:${port}/blank` });
    expect(result.afterEmpty).toEqual({ opened: true, listed: 0 });
    expect(result.ownIp).toBe("ERR_BLOCKED_BY_CLIENT");
    expect(result.ownName).toBe("ERR_BLOCKED_BY_CLIENT");
    expect(ownSeen).toEqual([]);
    expect(result.late).toBe("ERR_BLOCKED_BY_CLIENT");
    expect(result.bigDownload).toBe("cancelled");
    expect(result.smallDownload).toBe("completed");
    expect(result.hiddenThumbnail).toBe(true);
    expect(result.hiddenMine).toBeNull();
    expect(result.pictureResizes).toBe(0);
    expect(result.pictureColours).toEqual(["rgb(0, 200, 0)", "rgb(0, 0, 200)"]);
    expect(result.afterShown).toEqual({ picture: true, staged: false });
    expect(result.stageGivenUp).toEqual({ had: true, hidden: true, picture: null });
    // the kept download is listed for the page's right panel, the cancelled one is not
    expect(result.results).toEqual([{ kind: "download", name: "small.bin", done: true, fromTab: true, profile: "mine" }]);
    expect(result.resultPath).toBe(true);
    expect(result.afterBlock).toEqual({ listed: 0, destroyed: true });
    expect(result.atLimit).toBe(true);
    expect(result.overLimit).toBeNull();
    expect(result.agentLimit).toEqual({ atLimit: true, over: null });
    expect(seen.filter(({ host }) => host.startsWith("b.localhost") || host.startsWith("c.localhost"))).toEqual([]);
    expect(ovisSeen).toEqual([]);
    expect(seen.map(({ path }) => path)).toEqual(expect.arrayContaining(["/", "/own-fetch", "/redirect", "/own-popup", "/after", "/kept"]));
    expect(seen.filter(({ path }) => ["/own-ip", "/own-name", "/late"].includes(path))).toEqual([]);
  }, 60_000);
});
