import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import * as fileView from "./file-view.ts";
import { crossSiteFileRead, fileInfo, fileResponse, forgetPageMedia, locateFile, locateFileInFolder, PAGE_MEDIA_LIFETIME_MS, PAGE_MEDIA_PER_RENDER, pageFileHooks, pageMediaResponse, pageMediaSource, resolveFilePath, STREAM_CHUNK_BYTES, watchPageMedia } from "./file-view.ts";
import { setFilePoolOptions } from "./file-pool.ts";
import { runFileTask } from "./file-tasks.ts";
import { clearFileCache, filesNamed } from "./files.ts";

// pageFileHooks reach the thread they are set on alone: the tasks here run on it, not on file threads
beforeAll(() => setFilePoolOptions({ inline: runFileTask }));
afterAll(() => setFilePoolOptions());

/** Every descriptor a page's file was read through: open now, and any closed twice. */
const live = new Set<number>();
const closedTwice: number[] = [];
/** Resolves when `fd` is next closed. */
let closeWaiters: { fd: number; done: () => void }[] = [];
const closing = (fd: number): Promise<void> => new Promise((done) => {
  if (!live.has(fd)) done();
  else closeWaiters.push({ fd, done });
});
const trackDescriptors = () => {
  for (const key of Object.keys(pageFileHooks)) delete pageFileHooks[key as keyof typeof pageFileHooks];
  pageFileHooks.opened = (fd) => { live.add(fd); };
  pageFileHooks.closed = (fd) => {
    if (!live.delete(fd)) closedTwice.push(fd);
    const ready = closeWaiters.filter((waiter) => waiter.fd === fd);
    closeWaiters = closeWaiters.filter((waiter) => waiter.fd !== fd);
    for (const waiter of ready) waiter.done();
  };
};
const descriptorsClosed = () => {
  expect([...live]).toEqual([]);
  expect(closedTwice).toEqual([]);
  live.clear();
  closedTwice.length = 0;
  closeWaiters = [];
  for (const key of Object.keys(pageFileHooks)) delete pageFileHooks[key as keyof typeof pageFileHooks];
};
/** Whether an address plays, its body let go of. */
const plays = async (token: string, client: string | null, now?: number): Promise<boolean> => {
  const response = pageMediaResponse(token, client, null, now);
  await response?.body?.cancel();
  return response !== null;
};

describe("file view", () => {
  const roots: string[] = [];
  beforeEach(trackDescriptors);
  afterEach(() => {
    descriptorsClosed();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-file-view-")); roots.push(root); return root; };

  it("streams relay files with a length and bounded chunks without Bun.serve sizing the body", async () => {
    const root = temp();
    const path = join(root, "relay.bin");
    writeFileSync(path, new Uint8Array(STREAM_CHUNK_BYTES * 3 + 1));
    const info = fileInfo(path);
    if (!info) throw new Error("fixture missing");
    const response = await fileResponse(info, false, false, null, null, undefined, null, true);
    expect(response.headers.get("content-length")).toBe(String(info.size));
    const reader = response.body?.getReader();
    if (!reader) throw new Error("file body missing");
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.byteLength).toBeLessThanOrEqual(STREAM_CHUNK_BYTES);
      bytes += next.value.byteLength;
    }
    reader.releaseLock();
    expect(bytes).toBe(info.size);
  });

  it("resolves absolute, ~ and pane-relative paths", () => {
    expect(resolveFilePath("/a/b.txt", "/work")).toBe("/a/b.txt");
    expect(resolveFilePath("~/x.png", null)).toBe(join(homedir(), "x.png"));
    expect(resolveFilePath("docs/demo.mp4", "/work/app")).toBe("/work/app/docs/demo.mp4");
    expect(resolveFilePath("docs/demo.mp4", null)).toBeNull();
    expect(resolveFilePath("  ", "/work")).toBeNull();
  });

  it("tells media, text and binary apart, and is null for a folder or nothing", () => {
    const root = temp();
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "run.log"), "line\n");
    writeFileSync(join(root, "blob"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "notes"), "plain words");
    expect(fileInfo(join(root, "a.png"))!.kind).toBe("image");
    expect(fileInfo(join(root, "run.log"))!.kind).toBe("text");
    expect(fileInfo(join(root, "blob"))!.kind).toBe("binary");
    expect(fileInfo(join(root, "notes"))!.kind).toBe("text");
    expect(fileInfo(root)).toBeNull();
    expect(fileInfo(join(root, "missing"))).toBeNull();
  });

  it("serves HTML as sandboxed plain text, and a download as an attachment", async () => {
    const root = temp();
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    const response = await fileResponse(fileInfo(join(root, "page.html"))!, true);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(response.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  it("streams a large file from a slow disk from its descriptor, and closes it once sent", async () => {
    const root = temp();
    const bytes = Buffer.from(Array.from({ length: 600 * 1024 }, (_, index) => index % 253));
    writeFileSync(join(root, "clip.bin"), bytes);
    // every disk counts as slow: the body is streamed, not sent as a file Bun reads on this thread
    pageFileHooks.fastDiskMs = -1;
    const whole = await fileResponse(fileInfo(join(root, "clip.bin"))!, false);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    const part = await fileResponse(fileInfo(join(root, "clip.bin"))!, false, false, null, new Request("http://x/", { headers: { range: "bytes=1000-400000" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 1000-400000/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(1000, 400001))).toBe(true);
    await closing([...live][0] ?? -1);
  });

  it("draws an HTML page only when asked to render it, with no origin and no network", async () => {
    const root = temp();
    writeFileSync(join(root, "report.html"), "<p>chart</p>");
    writeFileSync(join(root, "notes.txt"), "<p>not a page</p>");
    const page = await fileResponse(fileInfo(join(root, "report.html"))!, false, true);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    const policy = page.headers.get("content-security-policy")!;
    // its script runs, but never with this app's origin, cookie or storage
    expect(policy).toStartWith("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-same-origin");
    // nothing to fetch with: default-src stands in for connect-src
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("connect-src");
    // nor this server's files, whose loading would tell it which exist, nor the web, where a script could send what the page holds
    expect(policy.split("; ").filter((directive) => directive.includes("'self'"))).toEqual(["frame-ancestors 'self'"]);
    expect(policy).not.toContain("http");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(await page.text()).toBe("<p>chart</p>");
    // asked without render, or as a download, it stays the source; another text file never renders
    // (each body left unread is cancelled, which closes the descriptor it streams from)
    const source = await fileResponse(fileInfo(join(root, "report.html"))!, false);
    await source.body?.cancel();
    expect(source.headers.get("content-type")).toStartWith("text/plain");
    const download = await fileResponse(fileInfo(join(root, "report.html"))!, true, true);
    await download.body?.cancel();
    expect(download.headers.get("content-type")).toStartWith("text/plain");
    const text = await fileResponse(fileInfo(join(root, "notes.txt"))!, false, true);
    await text.body?.cancel();
    expect(text.headers.get("content-type")).toStartWith("text/plain");
    expect(text.headers.get("content-security-policy")).toStartWith("sandbox;");
  });

  it("puts a page's own pictures, stylesheet and script into it, and nothing from outside its folder", async () => {
    const root = temp();
    const site = join(root, "site");
    mkdirSync(join(site, "shots"), { recursive: true });
    mkdirSync(join(site, ".ssh"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(site, "shots", "a.png"), png);
    writeFileSync(join(site, "style.css"), "h1 { color: teal }");
    writeFileSync(join(site, "print.css"), "body { display: none }");
    writeFileSync(join(site, "chart.js"), "document.title = 'drawn'; '</script>';");
    writeFileSync(join(site, "config.js"), "const token = 'secret';");
    writeFileSync(join(site, ".ssh", "key.png"), png);
    writeFileSync(join(site, ".env"), "TOKEN=secret");
    writeFileSync(join(site, "notes.txt"), "private notes");
    writeFileSync(join(root, "outside.png"), png);
    symlinkSync(join(root, "outside.png"), join(site, "linked.png"));
    writeFileSync(join(site, "report.html"), [
      `<link rel="stylesheet" href="style.css"><link rel="stylesheet" media="print" href="print.css"><script defer src="./chart.js"></script>`,
      `<script type="text/plain" id="data" src="config.js"></script>`,
      `<img id="shot" src="shots/a.png?v=1">`,
      `<img id="up" src="../outside.png"><img id="link" src="linked.png"><img id="hidden" src=".ssh/key.png">`,
      `<img id="env" src=".env"><img id="text" src="notes.txt"><script id="notjs" src="notes.txt"></script>`,
      `<img id="cdn" src="https://example.com/a.png"><img id="rooted" src="/etc/hosts">`,
      `<img id="unc" src="%5C%5Chost%5Cshare%5Ca.png"><img id="drive" src="C%3A%5Ca.png"><img id="slash" src="%2Fetc%2Fhosts">`,
    ].join(""));
    const html = await (await fileResponse(fileInfo(join(site, "report.html"))!, false, true)).text();
    // its own files, in its folder or below, as the kind of file each element takes, with the element's attributes kept
    const data = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString("base64")}`;
    expect(html).toContain(`<link rel="stylesheet" href="${data("text/css", "h1 { color: teal }")}">`);
    expect(html).toContain(`<link rel="stylesheet" media="print" href="${data("text/css", "body { display: none }")}">`);
    expect(html).toContain(`<script defer src="${data("text/javascript", "document.title = 'drawn'; '</script>';")}"></script>`);
    expect(html).toContain(`<img id="shot" src="data:image/png;base64,${png.toString("base64")}">`);
    // a script that does not run is a data block: it takes no file, which its neighbour could read
    expect(html).toContain(`<script type="text/plain" id="data" src="config.js"></script>`);
    // nothing above its folder, through a symlink, under a hidden name, or of another kind
    for (const [id, src] of [["up", "../outside.png"], ["link", "linked.png"], ["hidden", ".ssh/key.png"], ["env", ".env"], ["text", "notes.txt"], ["cdn", "https://example.com/a.png"], ["rooted", "/etc/hosts"], ["unc", "%5C%5Chost%5Cshare%5Ca.png"], ["drive", "C%3A%5Ca.png"], ["slash", "%2Fetc%2Fhosts"]]) {
      expect(html).toContain(`<img id="${id}" src="${src}">`);
    }
    expect(html).toContain(`<script id="notjs" src="notes.txt"></script>`);
    expect(html).not.toContain("secret");
    expect(html).not.toContain("private notes");
  });

  it("plays a page's video too large to put into it from an address only its render gives out", async () => {
    const root = temp();
    const site = join(root, "site");
    mkdirSync(join(site, "clips"), { recursive: true });
    mkdirSync(join(site, ".cache"));
    const big = 8 * 1024 * 1024 + 1;
    const sized = (path: string, bytes: number) => { writeFileSync(path, ""); truncateSync(path, bytes); };
    sized(join(site, "big.mp4"), big);
    sized(join(site, "clips", "take.webm"), big);
    sized(join(site, ".cache", "hidden.mp4"), big);
    sized(join(site, "huge.png"), big);
    mkdirSync(join(root, "share", ".private"), { recursive: true });
    sized(join(root, "share", "take.m4a"), big);
    sized(join(root, "share", ".private", "take.mp4"), big);
    sized(join(root, "outside.mp4"), big);
    writeFileSync(join(site, "small.mp4"), "tiny");
    writeFileSync(join(site, "notes.txt"), "private notes");
    // recordings kept elsewhere (a network share), linked beside the report
    symlinkSync(join(root, "share", "take.m4a"), join(site, "linked.m4a"));
    symlinkSync(join(root, "share", ".private", "take.mp4"), join(site, "private.mp4"));
    symlinkSync(join(root, "outside.mp4"), join(site, "elsewhere.mp4"));
    symlinkSync(join(site, "notes.txt"), join(site, "notes.mp4.txt"));
    writeFileSync(join(site, "report.html"), [
      `<video id="big" src="big.mp4" poster="huge.png"></video><video id="again" src="./big.mp4"></video><video id="small" src="small.mp4"></video>`,
      `<video><source id="source" src="clips/take.webm" type="video/webm"></video><audio id="linked" src="linked.m4a"></audio>`,
      `<video id="private" src="private.mp4"></video><video id="elsewhere" src="elsewhere.mp4"></video>`,
      `<audio id="above" src="../share/take.m4a"></audio><video id="abovehidden" src="../share/.private/take.mp4"></video>`,
      `<video id="hidden" src=".cache/hidden.mp4"></video><video id="up" src="../outside.mp4"></video><video id="text" src="notes.mp4.txt"></video>`,
      `<img id="img" src="huge.png"><video id="rooted" src="/etc/hosts"></video>`,
    ].join(""));
    const source = "http://127.0.0.1:7317/api/fs/page-media/";
    const media = { source, client: "10.0.0.2", device: "phone" };
    const page = await fileResponse(fileInfo(join(site, "report.html"))!, false, true, media);
    const policy = page.headers.get("content-security-policy")!;
    // media from that one path, and still nothing else from this server or the web
    expect(policy).toContain(`media-src data: blob: ${source}`);
    expect(policy.split("; ").filter((directive) => directive.includes("http"))).toEqual([`media-src data: blob: ${source}`]);
    const html = await page.text();
    // absolute, from the same host as the policy's source, so the two always agree
    const address = (id: string) => new RegExp(`id="${id}" src="${source}([A-Za-z0-9_-]{32})"`).exec(html)?.[1];
    const played = address("big")!;
    expect(played).toBeDefined();
    // one address per file, however it is named
    expect(html).toContain(`<video id="again" src="${source}${played}">`);
    expect(address("source")).toBeDefined();
    // a symlink out of its folder plays nothing: the page could have brought it along to ask whether a file exists
    for (const [id, src] of [["linked", "linked.m4a"], ["private", "private.mp4"], ["elsewhere", "elsewhere.mp4"], ["above", "../share/take.m4a"], ["abovehidden", "../share/.private/take.mp4"]]) {
      expect(html).toContain(`id="${id}" src="${src}"`);
    }
    // what fits is still put into the page; a picture or poster is never played from here
    expect(html).toContain(`<video id="small" src="data:video/mp4;base64,${Buffer.from("tiny").toString("base64")}">`);
    expect(html).toContain(`poster="huge.png"`);
    expect(html).toContain(`<img id="img" src="huge.png">`);
    // nothing under a hidden name, above its folder, of another kind, or rooted
    for (const [id, src] of [["hidden", ".cache/hidden.mp4"], ["up", "../outside.mp4"], ["text", "notes.mp4.txt"], ["rooted", "/etc/hosts"]]) {
      expect(html).toContain(`<video id="${id}" src="${src}">`);
    }
    const served = pageMediaResponse(played, "10.0.0.2")!;
    expect(served.headers.get("content-type")).toBe("video/mp4");
    expect(served.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(served.headers.get("access-control-allow-origin")).toBeNull();
    expect((await served.arrayBuffer()).byteLength).toBe(big);
    // a new address on the next render (the first one stays its own), none for a guess
    const again = await (await fileResponse(fileInfo(join(site, "report.html"))!, false, true, media)).text();
    expect(again).toMatch(new RegExp(`<video id="big" src="${source}[A-Za-z0-9_-]{32}"`));
    expect(again).not.toContain(played);
    expect(pageMediaResponse("A".repeat(32), "10.0.0.2")).toBeNull();
    // the address serves the file its render checked, not what later took its place
    const swapped = address("source")!;
    expect(await plays(swapped, "10.0.0.2")).toBe(true);
    rmSync(join(site, "clips"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    sized(join(root, "elsewhere", "take.webm"), big);
    symlinkSync(join(root, "elsewhere"), join(site, "clips"));
    expect(pageMediaResponse(swapped, "10.0.0.2")).toBeNull();
    // ...unless it leads into a folder the operator named, and then not under a hidden name there
    const before = process.env["OVIS_MEDIA_ROOTS"];
    process.env["OVIS_MEDIA_ROOTS"] = ["/nonexistent-share", join(root, "share")].join(delimiter);
    try {
      const shared = await (await fileResponse(fileInfo(join(site, "report.html"))!, false, true, media)).text();
      expect(shared).toMatch(new RegExp(`<audio id="linked" src="${source}[A-Za-z0-9_-]{32}">`));
      // there it decides where the file lies, however the page reaches it, never under a hidden name or elsewhere above
      expect(shared).toMatch(new RegExp(`<audio id="above" src="${source}[A-Za-z0-9_-]{32}">`));
      expect(shared).toContain(`<video id="abovehidden" src="../share/.private/take.mp4">`);
      expect(shared).toContain(`<video id="up" src="../outside.mp4">`);
      expect(shared).toContain(`<video id="private" src="private.mp4">`);
      expect(shared).toContain(`<video id="elsewhere" src="elsewhere.mp4">`);
    } finally {
      if (before === undefined) delete process.env["OVIS_MEDIA_ROOTS"];
      else process.env["OVIS_MEDIA_ROOTS"] = before;
    }
    // without a media source (a PC's bridge, a Host that is not plain) the page is drawn as before
    expect(await (await fileResponse(fileInfo(join(site, "report.html"))!, false, true)).text()).toContain(`<video id="big" src="big.mp4"`);
  });

  it("seeks a page's video by Range", async () => {
    const root = temp();
    writeFileSync(join(root, "clip.mp4"), Buffer.alloc(9 * 1024 * 1024, 7));
    writeFileSync(join(root, "page.html"), `<video src="clip.mp4"></video>`);
    const html = await (await fileResponse(fileInfo(join(root, "page.html"))!, false, true, { source: "http://127.0.0.1:1/api/fs/page-media/", client: null, device: null })).text();
    const token = /page-media\/([A-Za-z0-9_-]{32})/.exec(html)![1]!;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => pageMediaResponse(token, null, request) ?? new Response(null, { status: 404 }) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { range: "bytes=100-109" } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes 100-109/${9 * 1024 * 1024}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(10).fill(7));
    } finally { server.stop(true); }
  });

  const streamedPage = (root: string, name = "page.html", files = 1): string => {
    const tags: string[] = [];
    for (let i = 0; i < files; i += 1) {
      writeFileSync(join(root, `clip-${i}.mp4`), "");
      truncateSync(join(root, `clip-${i}.mp4`), 9 * 1024 * 1024);
      tags.push(`<video id="v${i}" src="clip-${i}.mp4"></video>`);
    }
    writeFileSync(join(root, name), tags.join(""));
    return join(root, name);
  };
  const tokensOf = (html: string): string[] => [...html.matchAll(/page-media\/([A-Za-z0-9_-]{32})/g)].map((match) => match[1]!);
  const owner = (client: string | null, device: string | null = null) => ({ source: "https://pc.example.ts.net/api/fs/page-media/", client, device });

  it("ends a page's media address a fixed time after its render, however often it plays", async () => {
    const root = temp();
    const rendered = Date.now();
    const [token] = tokensOf(await (await fileResponse(fileInfo(streamedPage(root))!, false, true, owner("10.0.0.2"))).text());
    // playing it does not stretch its life: each play near the end still ends at the same moment
    for (const at of [1, PAGE_MEDIA_LIFETIME_MS / 2, PAGE_MEDIA_LIFETIME_MS - 60_000]) expect(await plays(token!, "10.0.0.2", rendered + at)).toBe(true);
    expect(pageMediaResponse(token!, "10.0.0.2", null, rendered + PAGE_MEDIA_LIFETIME_MS + 60_000)).toBeNull();
    // and once lapsed it is gone for good
    expect(pageMediaResponse(token!, "10.0.0.2")).toBeNull();
  });

  it("plays a page's media only to the client that rendered it", async () => {
    const root = temp();
    const [token] = tokensOf(await (await fileResponse(fileInfo(streamedPage(root))!, false, true, owner("10.0.0.2"))).text());
    // an address the page's script passed on, asked for from elsewhere
    expect(pageMediaResponse(token!, "203.0.113.9")).toBeNull();
    expect(pageMediaResponse(token!, "203.0.113.9 via 127.0.0.1")).toBeNull();
    expect(pageMediaResponse(token!, null)).toBeNull();
    expect(await plays(token!, "10.0.0.2")).toBe(true);
  });

  it("drops a device's page media when it is revoked, and a client's when it signs out", async () => {
    const root = temp();
    const page = fileInfo(streamedPage(root))!;
    const [phone] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.2", "phone"))).text());
    const [laptop] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.3", "laptop"))).text());
    const [shared] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.4"))).text());
    forgetPageMedia({ device: "phone" });
    expect(pageMediaResponse(phone!, "10.0.0.2")).toBeNull();
    expect(await plays(laptop!, "10.0.0.3")).toBe(true);
    forgetPageMedia({ client: "10.0.0.4" });
    expect(pageMediaResponse(shared!, "10.0.0.4")).toBeNull();
    expect(await plays(laptop!, "10.0.0.3")).toBe(true);
  });

  it("keeps no page media for a device or client forgotten while its page was being drawn", async () => {
    const root = temp();
    const page = fileInfo(streamedPage(root))!;
    // the render runs as a file task, after this turn: the device is revoked and the client signs out meanwhile
    const revoked = fileResponse(page, false, true, owner("10.0.0.2", "phone"));
    const signedOut = fileResponse(page, false, true, owner("10.0.0.4"));
    const kept = fileResponse(page, false, true, owner("10.0.0.3", "laptop"));
    forgetPageMedia({ device: "phone" });
    forgetPageMedia({ client: "10.0.0.4" });
    const [phone] = tokensOf(await (await revoked).text());
    const [shared] = tokensOf(await (await signedOut).text());
    const [laptop] = tokensOf(await (await kept).text());
    expect(pageMediaResponse(phone!, "10.0.0.2")).toBeNull();
    expect(pageMediaResponse(shared!, "10.0.0.4")).toBeNull();
    expect(await plays(laptop!, "10.0.0.3")).toBe(true);
  });

  it("keeps no page media for a device revoked while its request was still finding the page", async () => {
    const root = temp();
    const page = fileInfo(streamedPage(root))!;
    // the request notes the forgetting before it looks for the file; the revocation lands during that look
    const watch = watchPageMedia();
    forgetPageMedia({ device: "phone" });
    try {
      const [phone] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.2", "phone"), null, watch)).text());
      expect(pageMediaResponse(phone!, "10.0.0.2")).toBeNull();
    } finally { watch.done(); }
    // a request begun after it is not held to it
    const [later] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.2", "phone"))).text());
    expect(await plays(later!, "10.0.0.2")).toBe(true);
  });

  it("refuses a page's media once the file is written over in place", async () => {
    const root = temp();
    const page = fileInfo(streamedPage(root))!;
    const clip = join(root, "clip-0.mp4");
    const second = Math.floor(Date.now() / 1000) - 60;
    utimesSync(clip, second, second);
    const [touched] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.2"))).text());
    const [grown] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.2"))).text());
    const { ino } = statSync(clip);
    // grown in place (same inode), its modification time put back: only its size tells
    appendFileSync(clip, "more");
    utimesSync(clip, second, second);
    expect(statSync(clip).ino).toBe(ino);
    expect(pageMediaResponse(grown!, "10.0.0.2")).toBeNull();
    // rewritten at the same size: only its modification time tells
    const [rewritten] = tokensOf(await (await fileResponse(page, false, true, owner("10.0.0.2"))).text());
    expect(await plays(rewritten!, "10.0.0.2")).toBe(true);
    utimesSync(clip, second + 5, second + 5);
    expect(pageMediaResponse(rewritten!, "10.0.0.2")).toBeNull();
    expect(pageMediaResponse(touched!, "10.0.0.2")).toBeNull();
  });

  it("streams at most so many files from one render", async () => {
    const root = temp();
    const html = await (await fileResponse(fileInfo(streamedPage(root, "page.html", PAGE_MEDIA_PER_RENDER + 1))!, false, true, owner("10.0.0.2"))).text();
    expect(tokensOf(html)).toHaveLength(PAGE_MEDIA_PER_RENDER);
    // the one past the cap is left as the page wrote it
    expect(html).toContain(`<video id="v${PAGE_MEDIA_PER_RENDER}" src="clip-${PAGE_MEDIA_PER_RENDER}.mp4">`);
  });

  it("allows media only from the host the browser asked by", () => {
    expect(pageMediaSource("127.0.0.1:7317", false)).toBe("http://127.0.0.1:7317/api/fs/page-media/");
    expect(pageMediaSource("pc.tailnet.ts.net", true)).toBe("https://pc.tailnet.ts.net/api/fs/page-media/");
    expect(pageMediaSource("[::1]:7317", false)).toBe("http://[::1]:7317/api/fs/page-media/");
    // a Host that could write a directive of its own into the policy is no source at all
    for (const host of [null, "", "a b", "evil; script-src *", "host/path", "host:7317 'unsafe-inline'", "host,other"]) expect(pageMediaSource(host, false)).toBeNull();
    // behind a proxy that rewrites Host, the host the browser used is the one it forwards
    expect(pageMediaSource("127.0.0.1:7317", true, "pc.example.ts.net")).toBe("https://pc.example.ts.net/api/fs/page-media/");
    expect(pageMediaSource("127.0.0.1:7317", true, "pc.example.ts.net, inner.proxy")).toBe("https://pc.example.ts.net/api/fs/page-media/");
    expect(pageMediaSource("127.0.0.1:7317", true, "evil; script-src *")).toBeNull();
  });

  it("resolves a page's URLs once each, and only so many", async () => {
    const root = temp();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(root, "a.png"), png);
    const many = Array.from({ length: 1_000 }, (_, i) => `<img src="missing-${i}.png">`).join("");
    writeFileSync(join(root, "same.html"), `${"<img src=\"missing.png\">".repeat(5_000)}<img id="last" src="a.png">`);
    writeFileSync(join(root, "many.html"), `${many}<img id="last" src="a.png">`);
    const started = performance.now();
    expect(await (await fileResponse(fileInfo(join(root, "same.html"))!, false, true)).text()).toContain(`<img id="last" src="data:image/png;base64,`);
    expect(performance.now() - started).toBeLessThan(2_000);
    // the thousand-and-first URL is left as it is
    expect(await (await fileResponse(fileInfo(join(root, "many.html"))!, false, true)).text()).toContain(`<img id="last" src="a.png">`);
  });

  it("refuses another site's page loading a file, but not a navigation or this app", () => {
    const ask = (headers: Record<string, string>) => crossSiteFileRead(new Request("http://localhost/api/fs/file?path=/x", { headers }));
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).toBe(true);
    expect(ask({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" })).toBe(true);
    // a new tab, a download or Android's PDF "Open" button is a navigation from anywhere
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).toBe(false);
    expect(ask({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" })).toBe(false);
    expect(ask({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).toBe(false);
    // a browser that sends no Fetch Metadata is let through as before
    expect(ask({})).toBe(false);
  });
});

describe("page files read through the descriptor that was validated", () => {
  const roots: string[] = [];
  beforeEach(trackDescriptors);
  afterEach(() => {
    descriptorsClosed();
    delete process.env["OVIS_MEDIA_ROOTS"];
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const linux = process.platform === "linux";
  const windows = process.platform === "win32";
  const BIG = 9 * 1024 * 1024;
  const source = "http://127.0.0.1:1/api/fs/page-media/";
  const owner = (device: string | null = null) => ({ source, client: null, device });
  const tokensOf = (html: string): string[] => [...html.matchAll(/page-media\/([A-Za-z0-9_-]{32})/g)].map((match) => match[1]!);
  const render = async (page: string, media: ReturnType<typeof owner> | null = owner()) => (await (await fileResponse(fileInfo(page)!, false, true, media)).text());
  const png = (text: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(text)]);
  /** a file of `bytes` whose first bytes say which it is */
  const marked = (path: string, mark: string, bytes = BIG) => { writeFileSync(path, mark); truncateSync(path, bytes); };
  /**
   * A page folder whose `sub` folder holds the page's picture and video, and an `outside` folder
   * holding files of the same names: owned, mode 0755 from the page's folder down.
   */
  const layout = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-page-fd-")));
    roots.push(root);
    const site = join(root, "site");
    const sub = join(site, "sub");
    const outside = join(root, "outside");
    mkdirSync(sub, { recursive: true });
    mkdirSync(outside);
    for (const folder of [site, sub, outside]) chmodSync(folder, 0o755);
    writeFileSync(join(sub, "f.png"), png("INSIDE"));
    writeFileSync(join(outside, "f.png"), png("OUTSIDE-SECRET"));
    marked(join(sub, "clip.mp4"), "INSIDE");
    marked(join(outside, "clip.mp4"), "OUTSIDE-SECRET");
    writeFileSync(join(site, "page.html"), `<img id="pic" src="sub/f.png"><video id="clip" src="sub/clip.mp4"></video>`);
    return { root, site, sub, outside, page: join(site, "page.html") };
  };
  /** what a page drew: its picture put into it, and the addresses its video was given */
  const drawn = (html: string) => ({ picture: html.includes(`id="pic" src="data:image/png;base64,`), tokens: tokensOf(html), outsideBytes: html.includes(png("OUTSIDE-SECRET").toString("base64")) });

  /**
   * B1's schedule, at the hooks of each authorization: the path resolves to `sub/<file>`; `sub`
   * becomes a link outside before the open (so the descriptor is outside); `sub` is put back before
   * the second resolution (which reads in the page's folder); and after it, before its identity
   * check, `sub` is a link outside again (so the path's device and inode agree with the
   * descriptor's). Every pathname sample agrees; only the opened file is outside. `sub` is put back
   * whenever a descriptor closes, so each authorization meets the same schedule.
   */
  const threeSwap = (sub: string, outside: string) => {
    const parked = `${sub}.real`;
    const toOutside = () => { if (!lstatSync(sub).isSymbolicLink()) { renameSync(sub, parked); symlinkSync(outside, sub); } };
    const toInside = () => { if (lstatSync(sub).isSymbolicLink()) { unlinkSync(sub); renameSync(parked, sub); } };
    const seen = { schedules: 0, samplesAgreed: 0, authorized: 0 };
    let fd = -1;
    const opened = pageFileHooks.opened!;
    const closed = pageFileHooks.closed!;
    pageFileHooks.opened = (next) => { opened(next); fd = next; };
    pageFileHooks.closed = (gone) => { closed(gone); toInside(); };
    pageFileHooks.afterResolve = toOutside;
    pageFileHooks.afterOpen = toInside;
    pageFileHooks.beforeIdentity = (file) => {
      toOutside();
      seen.schedules += 1;
      // the second resolution was in the page's folder, and the path now names the descriptor's file
      const descriptor = fstatSync(fd);
      const named = statSync(file);
      if (file.startsWith(sub + "/") && named.ino === descriptor.ino && named.dev === descriptor.dev) seen.samplesAgreed += 1;
    };
    pageFileHooks.afterAuthorize = () => { seen.authorized += 1; };
    return seen;
  };

  it.skipIf(!linux)("rejects three-swap outside embed using Linux descriptor path", async () => {
    const { sub, outside, page } = layout();
    const seen = threeSwap(sub, outside);
    const html = await render(page, null);
    expect(seen.schedules).toBeGreaterThan(0);
    expect(seen.samplesAgreed).toBe(seen.schedules);
    expect(seen.authorized).toBe(0);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
    expect(html).toContain(`<img id="pic" src="sub/f.png">`);
  });

  it.skipIf(!linux)("does not mint a grant under three-swap path replacement", async () => {
    const { sub, outside, page } = layout();
    const seen = threeSwap(sub, outside);
    const html = await render(page);
    expect(seen.samplesAgreed).toBe(seen.schedules);
    expect(seen.schedules).toBe(3);
    expect(seen.authorized).toBe(0);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
    expect(html).toContain(`<video id="clip" src="sub/clip.mp4">`);
  });

  it.skipIf(!linux)("rejects three-swap media reopen", async () => {
    const { sub, outside, page } = layout();
    const [token] = drawn(await render(page)).tokens;
    expect(token).toBeDefined();
    const seen = threeSwap(sub, outside);
    expect(pageMediaResponse(token!, null)).toBeNull();
    expect(seen.schedules).toBe(1);
    expect(seen.samplesAgreed).toBe(1);
    expect(seen.authorized).toBe(0);
    // with the swaps over, the same address plays the file its render authorized
    for (const key of ["afterResolve", "afterOpen", "beforeIdentity", "afterAuthorize"] as const) delete pageFileHooks[key];
    const served = pageMediaResponse(token!, null, new Request("http://x/", { headers: { range: "bytes=0-5" } }))!;
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe("INSIDE");
  });

  it("reports the Windows single-user residual under three-swap", async () => {
    // documented, not defended: without a descriptor's own path, a writer of the folders on the way can race the path checks
    if (windows) return;
    const { sub, outside, page } = layout();
    pageFileHooks.platform = "win32";
    const seen = threeSwap(sub, outside);
    const html = await render(page, null);
    expect(seen.samplesAgreed).toBe(seen.schedules);
    expect(seen.authorized).toBe(seen.schedules);
    expect(drawn(html).outsideBytes).toBe(true);
  });

  it("fails closed on unreadable or deleted descriptor path", async () => {
    const { page } = layout();
    pageFileHooks.platform = "linux";
    // the page is looked at first and gets its own path; each of its files' looks fails
    let looks = 0;
    let asked: string[] = [];
    pageFileHooks.readlink = (path) => {
      looks += 1;
      if (looks === 1) return page;
      asked.push(path);
      throw Object.assign(new Error("no procfs"), { code: "ENOENT" });
    };
    let html = await render(page);
    expect(html).toContain(`<img id="pic" src="sub/f.png">`);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((path) => /^\/proc\/self\/fd\/\d+$/.test(path))).toBe(true);
    asked = [];
    // the descriptor's file deleted since: its kernel path ends in " (deleted)", in the page's folder or not
    let deletedPath = "";
    let authorized = 0;
    pageFileHooks.afterAuthorize = () => { authorized += 1; };
    pageFileHooks.beforeIdentity = (file) => { deletedPath = `${file} (deleted)`; };
    looks = 0;
    pageFileHooks.readlink = (path) => {
      looks += 1;
      if (looks === 1) return page;
      asked.push(path);
      return deletedPath;
    };
    html = await render(page);
    expect(html).toContain(`<img id="pic" src="sub/f.png">`);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
    expect(asked.length).toBeGreaterThan(0);
    expect(authorized).toBe(0);
    // and the same file, read through a real descriptor path, draws
    delete pageFileHooks.readlink;
    delete pageFileHooks.beforeIdentity;
    delete pageFileHooks.afterAuthorize;
    if (linux) expect(drawn(await render(page)).picture).toBe(true);
  });

  it.skipIf(windows)("rejects macOS group-writable chain directory", async () => {
    const { site, sub, outside, page } = layout();
    pageFileHooks.platform = "darwin";
    // owned, 0755 from the page's folder down: drawn and played
    expect(drawn(await render(page)).picture).toBe(true);
    for (const mode of [0o775, 0o757, 0o777]) {
      chmodSync(sub, mode);
      expect(drawn(await render(page))).toEqual({ picture: false, tokens: [], outsideBytes: false });
      chmodSync(sub, 0o755);
      chmodSync(site, mode);
      expect(drawn(await render(page))).toEqual({ picture: false, tokens: [], outsideBytes: false });
      chmodSync(site, 0o755);
    }
    // B1's schedule with a group-writable folder on the way: refused, never authorized
    chmodSync(sub, 0o775);
    const seen = threeSwap(sub, outside);
    expect(drawn(await render(page))).toEqual({ picture: false, tokens: [], outsideBytes: false });
    expect(seen.authorized).toBe(0);
  });

  it.skipIf(windows)("rejects macOS nonowner directory", async () => {
    const { site, sub, page } = layout();
    pageFileHooks.platform = "darwin";
    chmodSync(site, 0o700);
    chmodSync(sub, 0o700);
    expect(drawn(await render(page)).picture).toBe(true);
    expect(drawn(await render(page)).tokens).toHaveLength(1);
    const uid = process.getuid!();
    pageFileHooks.uid = () => uid + 1;
    expect(drawn(await render(page))).toEqual({ picture: false, tokens: [], outsideBytes: false });
    // no user to compare with is no proof either
    pageFileHooks.uid = () => undefined;
    expect(drawn(await render(page))).toEqual({ picture: false, tokens: [], outsideBytes: false });
  });

  it.skipIf(windows)("follows symlinks into permitted folders under the macOS folder rule", async () => {
    const { root, site, page } = layout();
    pageFileHooks.platform = "darwin";
    const share = join(root, "share");
    mkdirSync(share);
    chmodSync(share, 0o755);
    marked(join(share, "take.mp4"), "SHARED");
    symlinkSync(join(site, "sub"), join(site, "alias"));
    symlinkSync(join(share, "take.mp4"), join(site, "take.mp4"));
    writeFileSync(page, `<img id="pic" src="alias/f.png"><video id="clip" src="take.mp4"></video>`);
    // a link to its own folder draws; one to a folder the operator did not name plays nothing
    expect(drawn(await render(page))).toEqual({ picture: true, tokens: [], outsideBytes: false });
    process.env["OVIS_MEDIA_ROOTS"] = share;
    const [token] = drawn(await render(page)).tokens;
    expect(token).toBeDefined();
    const served = pageMediaResponse(token!, null, new Request("http://x/", { headers: { range: "bytes=0-5" } }))!;
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe("SHARED");
    // the share's own folder made writable to others since: no longer played
    chmodSync(share, 0o775);
    expect(pageMediaResponse(token!, null)).toBeNull();
  });

  it("retains Windows post-open identity rejection", async () => {
    const { sub, page } = layout();
    pageFileHooks.platform = "win32";
    expect(drawn(await render(page)).picture).toBe(true);
    // the file replaced between its open and the second look at its path
    pageFileHooks.afterOpen = (file) => {
      if (!file.endsWith("f.png")) return;
      renameSync(file, join(sub, "old.png"));
      writeFileSync(file, png("REPLACED"));
    };
    expect(drawn(await render(page)).picture).toBe(false);
  });

  it("answers 404 for a page gone or written over since it was found", async () => {
    const { page } = layout();
    const found = fileInfo(page)!;
    rmSync(page);
    const gone = await fileResponse(found, false, true);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: { code: "not_found", message: "no readable file at that path" } });
  });

  it("refuses a descriptor whose inode is 0", async () => {
    const { page } = layout();
    pageFileHooks.fstat = (fd) => {
      const stat = fstatSync(fd, { bigint: true });
      return new Proxy(stat, { get: (target, key) => key === "ino" ? 0n : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
    };
    expect(drawn(await render(page))).toEqual({ picture: false, tokens: [], outsideBytes: false });
  });

  it("refuses a failing fstat or stat", async () => {
    const { page } = layout();
    // the page's own read is the first look by descriptor; each of its files' looks fails
    let looks = 0;
    pageFileHooks.fstat = (fd) => {
      looks += 1;
      if (looks === 1) return fstatSync(fd, { bigint: true });
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    let html = await render(page);
    expect(looks).toBeGreaterThan(1);
    expect(html).toContain(`<img id="pic" src="sub/f.png">`);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
    delete pageFileHooks.fstat;
    // gone between the second resolution and its stat
    pageFileHooks.beforeIdentity = (file) => rmSync(file);
    html = await render(page);
    expect(html).toContain(`<img id="pic" src="sub/f.png">`);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
  });

  it.skipIf(windows)("sends an empty file whole, whatever range is asked", async () => {
    const { root, site, page } = layout();
    // an empty recording is put into no page: one from a share plays from an address
    const share = join(root, "share");
    mkdirSync(share);
    chmodSync(share, 0o755);
    writeFileSync(join(share, "take.mp4"), "");
    symlinkSync(join(share, "take.mp4"), join(site, "take.mp4"));
    writeFileSync(page, `<video id="clip" src="take.mp4"></video>`);
    process.env["OVIS_MEDIA_ROOTS"] = share;
    const [token] = drawn(await render(page)).tokens;
    expect(token).toBeDefined();
    for (const range of ["bytes=-1", "bytes=0-"]) {
      const response = pageMediaResponse(token!, null, new Request("http://x/", { headers: { range } }))!;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("0");
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it.skipIf(windows)("refuses a leaf swapped for a link before the open, or after it", async () => {
    const { sub, outside, page } = layout();
    // before the open: O_NOFOLLOW will not open the link
    pageFileHooks.afterResolve = (file) => { rmSync(file); symlinkSync(join(outside, "f.png"), file); };
    expect(drawn(await render(page, null)).picture).toBe(false);
    rmSync(join(sub, "f.png"));
    writeFileSync(join(sub, "f.png"), png("INSIDE"));
    // after the open, before its metadata is looked at again: the second resolution leads outside
    delete pageFileHooks.afterResolve;
    pageFileHooks.afterOpen = (file) => { if (lstatSync(file).isFile()) { rmSync(file); symlinkSync(join(outside, "f.png"), file); } };
    const html = await render(page, null);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
  });

  it.skipIf(windows)("refuses a FIFO put in place of the file", async () => {
    const { page } = layout();
    pageFileHooks.afterResolve = (file) => {
      if (!file.endsWith("f.png")) return;
      rmSync(file);
      expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    };
    // opened without waiting for a writer, and refused as no file
    expect(drawn(await render(page, null)).picture).toBe(false);
  });

  // Windows refuses to rename a folder while a file in it is open, so the swap cannot be staged there
  it.skipIf(windows)("keeps the page's folder as it was before the page was opened", async () => {
    const { root, site, page } = layout();
    // a folder elsewhere laid out as the page names its files
    const hidden = join(root, ".private");
    mkdirSync(join(hidden, "sub"), { recursive: true });
    writeFileSync(join(hidden, "sub", "f.png"), png("OUTSIDE-SECRET"));
    marked(join(hidden, "sub", "clip.mp4"), "OUTSIDE-SECRET");
    // the page's own folder swapped for a link to it while the page is read (its first look by descriptor)
    let swapped = false;
    pageFileHooks.fstat = (fd) => {
      if (!swapped) {
        swapped = true;
        renameSync(site, join(root, "parked"));
        symlinkSync(hidden, site);
      }
      return fstatSync(fd, { bigint: true });
    };
    const html = await render(page);
    expect(swapped).toBe(true);
    expect(drawn(html)).toEqual({ picture: false, tokens: [], outsideBytes: false });
  });

  it.skipIf(windows)("refuses a page whose folder becomes a link to another folder once it is resolved", async () => {
    // this platform's own proof, and the samples the others take
    for (const platform of [undefined, "darwin"] as const) {
      const { root, site, outside, page } = layout();
      writeFileSync(join(outside, "page.html"), "<p>OUTSIDE-PAGE-SECRET</p>");
      const found = fileInfo(page)!;
      if (platform) pageFileHooks.platform = platform;
      // swapped between the folder's one lookup and the page's open, and left so
      pageFileHooks.pageFolder = () => {
        renameSync(site, join(root, "parked"));
        symlinkSync(outside, site);
      };
      const response = await fileResponse(found, false, true, owner());
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("OUTSIDE-PAGE-SECRET");
      delete pageFileHooks.platform;
      delete pageFileHooks.pageFolder;
    }
  });

  it.skipIf(windows)("draws a page that is itself a link, taking its files from the folder it leads to", async () => {
    const { root, site } = layout();
    mkdirSync(join(root, "pages", "sub"), { recursive: true });
    writeFileSync(join(root, "pages", "real.html"), `<img id="pic" src="sub/f.png">`);
    writeFileSync(join(root, "pages", "sub", "f.png"), png("BESIDE-THE-TARGET"));
    const linked = join(site, "linked.html");
    symlinkSync(join(root, "pages", "real.html"), linked);
    const response = await fileResponse(fileInfo(linked)!, false, true, null);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`src="data:image/png;base64,${png("BESIDE-THE-TARGET").toString("base64")}"`);
  });

  it.skipIf(windows)("refuses a page opened through a folder that was a link only while it was opened", async () => {
    // this platform's own proof, and the samples the others take
    for (const platform of [undefined, "darwin"] as const) {
      const { root, site, outside, page } = layout();
      writeFileSync(join(outside, "page.html"), "<p>OUTSIDE-PAGE-SECRET</p>");
      const found = fileInfo(page)!;
      if (platform) pageFileHooks.platform = platform;
      // a link after the path's lookup, so the open goes through it, and the folder put back before any later look
      const parked = join(root, "parked");
      pageFileHooks.pageFolder = () => {
        renameSync(site, parked);
        symlinkSync(outside, site);
      };
      pageFileHooks.pageOpened = () => {
        unlinkSync(site);
        renameSync(parked, site);
      };
      const response = await fileResponse(found, false, true, owner());
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("OUTSIDE-PAGE-SECRET");
      delete pageFileHooks.platform;
      delete pageFileHooks.pageFolder;
      delete pageFileHooks.pageOpened;
    }
  });

  it.skipIf(windows)("refuses a page whose folder was a link only while its path was looked up", async () => {
    const { root, site, page } = layout();
    const hidden = join(root, ".private");
    mkdirSync(join(hidden, "sub"), { recursive: true });
    writeFileSync(join(hidden, "sub", "f.png"), png("OUTSIDE-SECRET"));
    marked(join(hidden, "sub", "clip.mp4"), "OUTSIDE-SECRET");
    // a page of the same name there: what the path meant when it was looked up
    writeFileSync(join(hidden, "page.html"), "<p>another page</p>");
    const found = fileInfo(page)!;
    // the page's folder is a link to that folder while it is resolved, and the page's own again once it is opened
    const parked = join(root, "parked");
    renameSync(site, parked);
    symlinkSync(hidden, site);
    let resolvedTo = "";
    pageFileHooks.pageFolder = (folder) => {
      resolvedTo = folder;
      unlinkSync(site);
      renameSync(parked, site);
    };
    const response = await fileResponse(found, false, true, owner());
    expect(resolvedTo).toBe(hidden);
    // neither that folder's page nor its files, nor the asked page drawn with them
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain("another page");
    expect(text).not.toContain(`id="clip"`);
    expect(drawn(text)).toEqual({ picture: false, tokens: [], outsideBytes: false });
  });

  // Windows refuses to rename a folder while a file in it is open, so the swap cannot be staged there
  it.skipIf(windows)("reads a page's file and plays its video from the authorized descriptor after its path is swapped", async () => {
    const { root, sub, outside, page } = layout();
    // embedded: the path swapped between authorization and the read
    let swapped = false;
    pageFileHooks.afterAuthorize = (requested) => {
      if (swapped || !requested.endsWith("f.png")) return;
      swapped = true;
      renameSync(sub, join(root, "parked"));
      symlinkSync(outside, sub);
    };
    const html = await render(page, null);
    expect(swapped).toBe(true);
    expect(html).toContain(`id="pic" src="data:image/png;base64,${png("INSIDE").toString("base64")}"`);
    expect(drawn(html).outsideBytes).toBe(false);
    delete pageFileHooks.afterAuthorize;
    unlinkSync(sub);
    renameSync(join(root, "parked"), sub);
    // played: authorized, then the path swapped before the body is read
    const [token] = drawn(await render(page)).tokens;
    const response = pageMediaResponse(token!, null)!;
    renameSync(sub, join(root, "parked"));
    symlinkSync(outside, sub);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(BIG);
    expect(body.subarray(0, 6).toString()).toBe("INSIDE");
    // a new request compares with what was minted, and refuses what took its place
    expect(pageMediaResponse(token!, null)).toBeNull();
  });

  it("refuses a file written over after its authorization, before minting an address or answering HEAD", async () => {
    const { sub, page } = layout();
    const clip = join(sub, "clip.mp4");
    let changes = 0;
    const change = (requested: string) => { if (requested === clip) { changes += 1; appendFileSync(clip, "more"); } };
    pageFileHooks.afterAuthorize = change;
    expect(drawn(await render(page)).tokens).toEqual([]);
    expect(changes).toBeGreaterThan(0);
    const minted = changes;
    delete pageFileHooks.afterAuthorize;
    const [token] = drawn(await render(page)).tokens;
    expect(token).toBeDefined();
    pageFileHooks.afterAuthorize = change;
    expect(pageMediaResponse(token!, null, new Request("http://x/", { method: "HEAD" }))).toBeNull();
    expect(changes).toBe(minted + 1);
    expect(live.size).toBe(0);
  });

  it("ends a stream once its file is written over in place", async () => {
    const { sub, page } = layout();
    const clip = join(sub, "clip.mp4");
    for (const change of [() => appendFileSync(clip, "more"), () => { const second = Math.floor(Date.now() / 1000) + 30; utimesSync(clip, second, second); }]) {
      const [token] = drawn(await render(page)).tokens;
      const response = pageMediaResponse(token!, null)!;
      const reader = response.body!.getReader();
      expect((await reader.read()).value!.byteLength).toBeGreaterThan(0);
      change();
      await expect(reader.read()).rejects.toThrow("the file changed while it was read");
      await reader.closed.catch(() => {});
    }
  });

  it("ends a stream whose read fails, and closes its descriptor once", async () => {
    const { page } = layout();
    const [token] = drawn(await render(page)).tokens;
    let reads = 0;
    pageFileHooks.read = async () => { reads += 1; throw Object.assign(new Error("EIO"), { code: "EIO" }); };
    const response = pageMediaResponse(token!, null)!;
    await expect(response.body!.getReader().read()).rejects.toThrow("EIO");
    expect(live.size).toBe(0);
    expect(reads).toBe(1);
  });

  describe("over HTTP", () => {
    /** With `cancelled`, the body passes through a stream that calls it once the server has cancelled the page's body. */
    const serve = async (cancelled?: () => void) => {
      const { sub, page } = layout();
      const bytes = Buffer.alloc(BIG);
      for (let index = 0; index < BIG; index += 1) bytes[index] = index % 251;
      writeFileSync(join(sub, "clip.mp4"), bytes);
      const [token] = drawn(await render(page, owner("phone"))).tokens;
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
        const response = pageMediaResponse(token!, null, request);
        if (response === null) return new Response(null, { status: 404 });
        if (cancelled === undefined || response.body === null) return response;
        const inner = response.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await inner.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          async cancel(reason) {
            const done = inner.cancel(reason);
            cancelled();
            await done;
          },
        }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
      } });
      const opened: number[] = [];
      const track = pageFileHooks.opened!;
      pageFileHooks.opened = (fd) => { track(fd); opened.push(fd); };
      return { bytes, token: token!, opened, url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
    };

    it("answers 200, HEAD and closed, open and suffix ranges with exact bytes", async () => {
      const { bytes, opened, url, stop } = await serve();
      try {
        const full = await fetch(url);
        expect(full.status).toBe(200);
        // Bun sends a body of more than one chunk as chunked, whatever length it was given; HEAD and a one-chunk range keep it
        expect(full.headers.get("accept-ranges")).toBe("bytes");
        expect(full.headers.get("content-type")).toBe("video/mp4");
        expect(full.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
        expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);
        await closing(opened.at(-1)!);
        const head = await fetch(url, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe(String(BIG));
        expect((await head.arrayBuffer()).byteLength).toBe(0);
        expect(live.size).toBe(0);
        for (const [range, start, end] of [["bytes=100-109", 100, 109], ["bytes=9437000-", 9437000, BIG - 1], ["bytes=-10", BIG - 10, BIG - 1], ["bytes=0-99999999", 0, BIG - 1], ["bytes=-99999999", 0, BIG - 1], [`bytes=0-${"9".repeat(30)}`, 0, BIG - 1], [`bytes=-${"9".repeat(30)}`, 0, BIG - 1], ["BYTES=0-9", 0, 9], ["bytes=262140-262150", 262140, 262150]] as const) {
          const part = await fetch(url, { headers: { range } });
          expect(part.status).toBe(206);
          expect(part.headers.get("content-range")).toBe(`bytes ${start}-${end}/${BIG}`);
          if (end - start < 256 * 1024) expect(part.headers.get("content-length")).toBe(String(end - start + 1));
          expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(start, end + 1))).toBe(true);
          await closing(opened.at(-1)!);
        }
        // a range is defined for GET alone: HEAD describes the whole file
        const headRange = await fetch(url, { method: "HEAD", headers: { range: "bytes=0-9" } });
        expect(headRange.status).toBe(200);
        expect(headRange.headers.get("content-length")).toBe(String(BIG));
        expect(headRange.headers.get("content-range")).toBeNull();
        expect(live.size).toBe(0);
      } finally { stop(); }
    });

    it("answers 416 to a range that starts past the end, and closes at once", async () => {
      const { opened, url, stop } = await serve();
      try {
        for (const range of [`bytes=${BIG}-`, "bytes=-0", `bytes=${"9".repeat(30)}-`]) {
          const refused = await fetch(url, { headers: { range } });
          expect(refused.status).toBe(416);
          expect(refused.headers.get("content-range")).toBe(`bytes */${BIG}`);
          expect((await refused.arrayBuffer()).byteLength).toBe(0);
          expect(live.size).toBe(0);
        }
        expect(opened).toHaveLength(3);
      } finally { stop(); }
    });

    it("sends the whole file for a Range it does not serve, or one with an If-Range it cannot match", async () => {
      const { bytes, opened, url, stop } = await serve();
      try {
        const asked: Record<string, string>[] = [{ range: "items=0-1" }, { range: "bytes=0-1,4-5" }, { range: "bytes=5-1" }, { range: "bytes=x-1" }, { range: "bytes=-" }, { range: "bytes=0-9", "if-range": '"an-old-tag"' }];
        for (const headers of asked) {
          const whole = await fetch(url, { headers });
          expect(whole.status).toBe(200);
          expect(whole.headers.get("content-range")).toBeNull();
          expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
          await closing(opened.at(-1)!);
        }
        expect(live.size).toBe(0);
      } finally { stop(); }
    });

    it("closes once when the client goes away during a read, after that read returns", async () => {
      let cancelled!: () => void;
      const gone = new Promise<void>((done) => { cancelled = done; });
      const { opened, url, stop } = await serve(() => cancelled());
      // every read past the first waits until it is let go, so the client leaves while one is under way
      let entered!: () => void;
      const reading = new Promise<void>((done) => { entered = done; });
      let release!: () => void;
      const gate = new Promise<void>((done) => { release = done; });
      let reads = 0;
      pageFileHooks.read = async (fd, buffer, position) => {
        reads += 1;
        if (reads > 1) {
          entered();
          await gate;
        }
        return readSync(fd, buffer, 0, buffer.length, position);
      };
      try {
        const controller = new AbortController();
        const response = await fetch(url, { signal: controller.signal });
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reading;
        const fd = opened.at(-1)!;
        controller.abort();
        await gone;
        // cancelled with a read under way: its descriptor stays open until that read returns
        expect(live.has(fd)).toBe(true);
        expect(fstatSync(fd).isFile()).toBe(true);
        const closed = closing(fd);
        release();
        await closed;
        expect(live.size).toBe(0);
        expect(closedTwice).toEqual([]);
      } finally {
        release();
        stop();
      }
    });

    it("plays nothing, and opens nothing, once its device is revoked", async () => {
      const { opened, url, stop } = await serve();
      try {
        const before = await fetch(url, { headers: { range: "bytes=0-0" } });
        expect(before.status).toBe(206);
        await before.arrayBuffer();
        await closing(opened.at(-1)!);
        const count = opened.length;
        forgetPageMedia({ device: "phone" });
        expect((await fetch(url)).status).toBe(404);
        expect(opened).toHaveLength(count);
      } finally { stop(); }
    });
  });
});

describe("locateFile", () => {
  const roots: string[] = [];
  afterEach(() => {
    clearFileCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root); return root; };

  it("(a) opens an NFD name from absolute and relative NFC paths", async () => {
    const root = temp();
    const path = join(root, "문서.md".normalize("NFD"));
    writeFileSync(path, "# nfd");
    const distinguishes = !existsSync(join(root, "문서.md"));
    for (const found of [
      await locateFile(join(root, "문서.md".normalize("NFC")), null, true),
      await locateFile("문서.md", root, true),
      await fileView.findFile("문서.md", root, async () => null),
    ]) {
      expect(found).not.toBeNull();
      if (found === null || !("info" in found)) throw new Error("expected one file");
      expect(found.info.name.normalize("NFC")).toBe("문서.md");
      expect(readFileSync(found.info.path, "utf8")).toBe("# nfd");
      if (distinguishes) expect(found.info.path).toBe(path);
    }
    if (distinguishes) expect(await locateFile("문서.md", root)).toBeNull();
  });

  it("(b) opens a path whose folder and filename use different forms", async () => {
    const root = temp();
    const folder = join(root, "회의자료".normalize("NFD"));
    mkdirSync(folder);
    const path = join(folder, "메모.md");
    writeFileSync(path, "mixed");
    const requested = join(root, "회의자료", "메모.md");
    for (const found of [
      await locateFile(requested, null, true),
      await fileView.findFile(requested, null, async () => null),
    ]) {
      expect(found).not.toBeNull();
      if (found === null || !("info" in found)) throw new Error("expected one file");
      expect(found.info.name.normalize("NFC")).toBe("메모.md");
      expect(readFileSync(found.info.path, "utf8")).toBe("mixed");
      if (!existsSync(requested)) expect(found.info.path).toBe(path);
    }
  });

  it("(c) opens a decomposed accented Latin name", async () => {
    const root = temp();
    writeFileSync(join(root, "café.txt".normalize("NFD")), "cafe");
    const found = await fileView.findFile(join(root, "café.txt"), null, async () => null);
    expect(found).not.toBeNull();
    if (found === null || !("info" in found)) throw new Error("expected one file");
    expect(found.info.name.normalize("NFC")).toBe("café.txt");
    expect(readFileSync(found.info.path, "utf8")).toBe("cafe");
  });

  it("(d) lists sorted candidates when several forms match without an exact hit", async () => {
    const root = temp();
    const first = join(root, "가".normalize("NFD") + "나".normalize("NFD") + ".md");
    const second = join(root, "가".normalize("NFD") + "나.md");
    writeFileSync(first, "first");
    const distinguishes = !existsSync(second);
    if (distinguishes) writeFileSync(second, "second");
    const found = await fileView.findFile(join(root, "가나.md"), null, async () => null);
    if (distinguishes) expect(found).toEqual({ candidates: [first, second].sort() });
    else {
      expect(found).not.toBeNull();
      if (found === null || !("info" in found)) throw new Error("expected one file");
      expect(found.info.name.normalize("NFC")).toBe("가나.md");
      expect(readFileSync(found.info.path, "utf8")).toBe("first");
    }
  });

  it("(e) keeps exact files and directories ahead of form variants", async () => {
    const root = temp();
    const path = join(root, "문서.md");
    writeFileSync(path, "exact");
    const variant = join(root, "문서.md".normalize("NFD"));
    const distinguishes = !existsSync(variant);
    if (distinguishes) writeFileSync(variant, "variant");
    expect(await fileView.findFile(path, null, async () => null)).toMatchObject({ info: { path } });
    rmSync(path);
    mkdirSync(path);
    expect(await fileView.findFile(path, null, async () => null)).toBeNull();
    expect(await locateFile(path, null, true)).toBeNull();
  });

  it("(f) resolves scratch names across forms without allowing symlink escapes", async () => {
    const root = temp();
    const folder = join(root, "scratch");
    mkdirSync(folder);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(folder, "링크.txt".normalize("NFD")));
    expect(await locateFileInFolder("링크.txt", folder, true)).toBeNull();
    const path = join(folder, "문서.md".normalize("NFD"));
    writeFileSync(path, "inside");
    const found = await locateFileInFolder("문서.md", folder, true);
    expect(found).not.toBeNull();
    if (found === null || !("info" in found)) throw new Error("expected one file");
    expect(found.info.name.normalize("NFC")).toBe("문서.md");
    expect(readFileSync(found.info.path, "utf8")).toBe("inside");
    if (!existsSync(join(folder, "문서.md"))) expect(await locateFileInFolder("문서.md", folder)).toBeNull();
  });

  it("(g) returns null for missing ASCII names even beneath a non-ASCII folder", async () => {
    const root = temp();
    mkdirSync(join(root, "자료".normalize("NFD")));
    for (const path of [join(root, "missing.txt"), join(root, "자료", "missing.txt")]) {
      expect(await locateFile(path, null, true)).toBeNull();
      expect(await fileView.findFile(path, null, async () => null)).toBeNull();
    }
  });

  it("(h) opens an exact suffix before a form variant at the pane root", async () => {
    const root = temp();
    mkdirSync(join(root, "docs"));
    const path = join(root, "docs", "문서.md");
    writeFileSync(path, "exact suffix");
    writeFileSync(join(root, "문서.md".normalize("NFD")), "variant");
    const distinguishes = !existsSync(join(root, "문서.md"));
    const found = await fileView.findFile("문서.md", root, async () => null);
    expect(found).toMatchObject({ info: { path: distinguishes ? path : join(root, "문서.md") } });
  });

  it("(i) keeps a unique exact suffix unambiguous while any-form suffixes include both", async () => {
    const root = temp();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    const exact = join(root, "a", "메모.md");
    const variant = "메모.md".normalize("NFD");
    writeFileSync(exact, "exact");
    writeFileSync(join(root, "b", variant), "variant");
    const distinguishes = !existsSync(join(root, "b", "메모.md"));
    const found = await fileView.findFile("메모.md", root, async () => null);
    if (distinguishes) {
      expect(found).toMatchObject({ info: { path: exact } });
      expect(await filesNamed(root, "메모.md")).toEqual(["a/메모.md"]);
    } else {
      expect(found).not.toBeNull();
    }
    const matches = (await filesNamed(root, "메모.md", 10, true)).sort();
    if (distinguishes) expect(matches).toEqual(["a/메모.md", `b/${variant}`].sort());
    else expect(matches.map((path) => path.normalize("NFC"))).toEqual(["a/메모.md", "b/메모.md"]);
  });

  it("(j) tries exact scratch files before any-form pane files and reuses the scratch lookup", async () => {
    const root = temp();
    const cwd = join(root, "pane");
    const scratch = join(root, "scratch");
    mkdirSync(cwd);
    mkdirSync(scratch);
    const panePath = join(cwd, "메모.md".normalize("NFD"));
    const scratchPath = join(scratch, "메모.md");
    writeFileSync(panePath, "pane");
    writeFileSync(scratchPath, "scratch");
    const distinguishes = !existsSync(join(cwd, "메모.md"));
    let calls = 0;
    const scratchFolder = async () => { calls += 1; return scratch; };
    expect(await fileView.findFile("메모.md", cwd, scratchFolder)).toMatchObject({
      info: { path: distinguishes ? scratchPath : join(cwd, "메모.md") },
    });
    expect(calls).toBe(distinguishes ? 1 : 0);
    rmSync(scratchPath);
    clearFileCache();
    calls = 0;
    const found = await fileView.findFile("메모.md", cwd, scratchFolder);
    expect(found).toMatchObject({ info: { path: distinguishes ? panePath : join(cwd, "메모.md") } });
    expect(calls).toBe(distinguishes ? 1 : 0);
    expect(await fileView.findFile("메모.md", cwd, async () => null)).toEqual(found);
  });

  it("refuses parent traversal outside the Claude scratch fallback folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    writeFileSync(join(root, "outside.txt"), "outside");
    expect(await locateFileInFolder("../outside.txt", folder)).toBeNull();
  });

  it("resolves an in-folder Claude scratch fallback link", async () => {
    const folder = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(folder);
    mkdirSync(join(folder, "scratchpad"));
    const path = join(folder, "scratchpad", "notes.txt");
    writeFileSync(path, "notes");
    expect(await locateFileInFolder("scratchpad/notes.txt", folder)).toMatchObject({ info: { path } });
  });

  it("refuses absolute paths and symlink escapes from the scratch fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(folder, "linked.txt"));
    expect(await locateFileInFolder(outside, folder)).toBeNull();
    expect(await locateFileInFolder("linked.txt", folder)).toBeNull();
  });

  it("finds a bare name deeper in the pane's folder, and lists several of that name", async () => {
    const { mkdirSync } = await import("node:fs");
    const { locateFile } = await import("./file-view.ts");
    const { clearFileCache } = await import("./files.ts");
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    mkdirSync(join(root, "docs/screenshots"), { recursive: true });
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "docs/screenshots/demo.mp4"), "x");
    writeFileSync(join(root, "a/notes.md"), "a");
    writeFileSync(join(root, "b/notes.md"), "b");
    clearFileCache();
    expect(await locateFile("demo.mp4", root)).toMatchObject({ info: { path: join(root, "docs/screenshots/demo.mp4") } });
    expect(await locateFile("screenshots/demo.mp4", root)).toMatchObject({ info: { name: "demo.mp4" } });
    expect(await locateFile("notes.md", root)).toEqual({ candidates: [join(root, "a/notes.md"), join(root, "b/notes.md")] });
    expect(await locateFile("missing.txt", root)).toBeNull();
    // an absolute or ~ path is taken as written, never searched for
    expect(await locateFile("/nowhere/demo.mp4", root)).toBeNull();
  });

  // the walk goes files first, then folders in name order, and stops at 5,000 entries
  const bigFolder = (root: string) => {
    mkdirSync(join(root, "a-data"));
    for (let index = 0; index < 5_100; index += 1) writeFileSync(join(root, "a-data", `page-${index}.txt`), "");
  };

  it("finds a tracked file past an ignored folder too large to walk", async () => {
    const root = temp();
    bigFolder(root);
    mkdirSync(join(root, "docs/design"), { recursive: true });
    writeFileSync(join(root, "docs/design/11_two-version-design.md"), "# design");
    writeFileSync(join(root, ".gitignore"), "a-data/\n");
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    clearFileCache();
    expect(await locateFile("11_two-version-design.md", root)).toMatchObject({ info: { path: join(root, "docs/design/11_two-version-design.md") } });
  });

  it("finds an ignored file past an ignored folder too large to walk", async () => {
    const root = temp();
    bigFolder(root);
    mkdirSync(join(root, "recordings"));
    writeFileSync(join(root, "recordings/demo.mp4"), "x");
    writeFileSync(join(root, ".gitignore"), "a-data/\nrecordings/\n");
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    clearFileCache();
    expect(await locateFile("demo.mp4", root)).toMatchObject({ info: { path: join(root, "recordings/demo.mp4") } });
  });

  it("opens an explicitly named ignored paste", async () => {
    const root = temp();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    mkdirSync(join(root, ".ovis"));
    writeFileSync(join(root, ".ovis/.gitignore"), "*\n");
    const path = join(root, ".ovis/notes-20261021-120000-0123abcd.json");
    writeFileSync(path, '{"a":1}');
    clearFileCache();
    // ignored keeps it out of Git status, not out of reach: the absolute path the upload answered
    // and the project-relative one both open it
    expect(Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", path]).exitCode).toBe(0);
    expect(await locateFile(path, root)).toMatchObject({ info: { path } });
    expect(await locateFile(".ovis/notes-20261021-120000-0123abcd.json", root)).toMatchObject({ info: { path } });
  });

  it("walks the subfolders of a folder holding thousands of files outside a repository", async () => {
    const root = temp();
    for (let index = 0; index < 1_500; index += 1) writeFileSync(join(root, `page-${index}.txt`), "");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/notes.md"), "notes");
    clearFileCache();
    expect(await locateFile("notes.md", root)).toMatchObject({ info: { path: join(root, "docs/notes.md") } });
  });

  it("finds a file past a folder too large to walk outside a repository", async () => {
    const root = temp();
    bigFolder(root);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/notes.md"), "notes");
    clearFileCache();
    expect(await locateFile("notes.md", root)).toMatchObject({ info: { path: join(root, "docs/notes.md") } });
  });
});

describe("Claude scratch fallback served from what it opened in its folder (#2259)", () => {
  const roots: string[] = [];
  beforeEach(trackDescriptors);
  afterEach(() => {
    descriptorsClosed();
    clearFileCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  /** A pane, its scratch folder holding `name` (`inside`), and `outside` beside that folder under the same name. */
  const fixture = (name: string, inside: string, outside: string) => {
    const root = mkdtempSync(join(tmpdir(), "herdr-scratch-open-"));
    roots.push(root);
    const cwd = join(root, "pane");
    const scratch = join(root, "scratch");
    mkdirSync(cwd);
    mkdirSync(scratch);
    writeFileSync(join(scratch, name), inside);
    writeFileSync(join(root, name), outside);
    /** the scratch file replaced by a link to the one outside */
    const swap = () => { unlinkSync(join(scratch, name)); symlinkSync(join(root, name), join(scratch, name)); };
    return { cwd, scratch, swap };
  };
  /** A body sent from its descriptor's own path keeps that descriptor until the body and its answer are collected: once both are gone, each is closed. */
  const bodiesCollected = async () => {
    // bounded by collections, not by time: a body still held fails here, with its descriptors named,
    // however slow the machine
    for (let collections = 0; live.size > 0; collections += 1) {
      if (collections === 50) throw new Error(`descriptors still open after ${collections} collections: ${[...live].join(", ")}`);
      Bun.gc(true);
      // the collected bodies' finalizers run on a later turn of the event loop: the next close they
      // bring, or that turn when this collection let none go
      await Promise.race([closing([...live][0]!), new Promise((resolve) => setImmediate(resolve))]);
    }
  };
  /** A server that sends `answer` once, holding it no longer than that: a handler that kept it would keep its descriptor past the collection. */
  const serveOnce = (answer: Response) => {
    const slot: { answer: Response | null } = { answer };
    return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      const sent = slot.answer;
      slot.answer = null;
      return sent ?? new Response(null, { status: 410 });
    } });
  };
  const fromScratch = async (name: string, cwd: string, scratch: string) => {
    const found = await fileView.findFile(name, cwd, async () => scratch);
    if (found === null || !("info" in found)) throw new Error("expected the scratch file");
    return found;
  };

  it("refuses a link swapped in after the file was found", async () => {
    const { cwd, scratch, swap } = fixture("note.txt", "INSIDE", "OUTSIDE-SECRET");
    const found = await fromScratch("note.txt", cwd, scratch);
    swap();
    const swapped = await fileResponse(found.info, false, false, null, null, undefined, found.within);
    expect(await swapped.text()).not.toContain("OUTSIDE-SECRET");
    expect(swapped.status).toBe(404);
  });

  it("refuses a link swapped in between the open's check and the open itself", async () => {
    const { cwd, scratch, swap } = fixture("note.txt", "INSIDE", "OUTSIDE-SECRET");
    const found = await fromScratch("note.txt", cwd, scratch);
    pageFileHooks.afterResolve = () => { delete pageFileHooks.afterResolve; swap(); };
    const swapped = await fileResponse(found.info, false, false, null, null, undefined, found.within);
    expect(pageFileHooks.afterResolve).toBeUndefined();
    expect(await swapped.text()).not.toContain("OUTSIDE-SECRET");
    expect(swapped.status).toBe(404);
  });

  it("describes the file only from what it opened in the folder", async () => {
    const { scratch, swap } = fixture("note.txt", "INSIDE", "OUTSIDE-SECRET");
    pageFileHooks.afterResolve = () => { delete pageFileHooks.afterResolve; swap(); };
    expect(await locateFileInFolder("note.txt", scratch)).toBeNull();
    expect(pageFileHooks.afterResolve).toBeUndefined();
  });

  it("renders a page only from what it opened in the folder", async () => {
    const { cwd, scratch, swap } = fixture("page.html", "<p>INSIDE</p>", "<p>OUTSIDE-SECRET</p>");
    const found = await fromScratch("page.html", cwd, scratch);
    expect(await (await fileResponse(found.info, false, true, null, null, undefined, found.within)).text()).toContain("INSIDE");
    swap();
    const swapped = await fileResponse(found.info, false, true, null, null, undefined, found.within);
    expect(await swapped.text()).not.toContain("OUTSIDE-SECRET");
    expect(swapped.status).toBe(404);
  });

  it("refuses a link swapped in before the viewer opens, by the path it was given, what it found", async () => {
    const { cwd, scratch, swap } = fixture("note.txt", "INSIDE", "OUTSIDE-SECRET");
    const mayBeScratch = (path: string) => path.startsWith(scratch);
    const stat = await fromScratch("note.txt", cwd, scratch);
    // the viewer's next request names the file by the path stat answered
    const byPath = await fileView.findFile(stat.info.path, cwd, async () => scratch, mayBeScratch);
    expect(byPath).toMatchObject({ info: { path: stat.info.path }, within: realpathSync(scratch) });
    if (byPath === null || !("info" in byPath)) throw new Error("expected the scratch file");
    expect(await (await fileResponse(byPath.info, false, false, null, null, undefined, byPath.within)).text()).toBe("INSIDE");
    swap();
    expect(await fileView.findFile(stat.info.path, cwd, async () => scratch, mayBeScratch)).toBeNull();
    // a path outside the pane's scratch folder is a direct link, as before
    const outside = join(scratch, "..", "note.txt");
    expect(await fileView.findFile(outside, cwd, async () => scratch, () => true)).toMatchObject({ info: { path: outside } });
  });

  it("finds a path in the folder only there, in any name form, never past it", async () => {
    for (const [stored, swapped] of [["NFD", "NFC"], ["NFC", "NFD"]] as const) {
      const name = "é.txt".normalize(stored);
      const { cwd, scratch } = fixture(name, "INSIDE", "OUTSIDE-SECRET");
      // a file system that stores one form for both cannot hold the swapped name beside it
      if (existsSync(join(scratch, name.normalize(swapped)))) return;
      const mayBeScratch = (path: string) => path.startsWith(scratch);
      const stat = await fromScratch(name, cwd, scratch);
      // the file the viewer was told of gone, and a link to the file outside put there under the other form of its name
      unlinkSync(join(scratch, name));
      symlinkSync(join(scratch, "..", name), join(scratch, name.normalize(swapped)));
      const byPath = await fileView.findFile(stat.info.path, cwd, async () => scratch, mayBeScratch);
      if (byPath !== null && "info" in byPath) expect(await (await fileResponse(byPath.info, false, false, null, null, undefined, byPath.within ?? null)).text()).not.toContain("OUTSIDE-SECRET");
      expect(byPath).toBeNull();
    }
  });

  it("finds a path given in full in the folder only where it points, never a file deeper whose path ends in it", async () => {
    const { cwd, scratch } = fixture("other.txt", "INSIDE", "OUTSIDE-SECRET");
    mkdirSync(join(scratch, "sub"));
    writeFileSync(join(scratch, "sub", "a.txt"), "DEEPER");
    const mayBeScratch = (path: string) => path.startsWith(scratch);
    // `<scratch>/a.txt` is not there: not found, as a missing path anywhere else
    expect(await fileView.findFile(join(scratch, "a.txt"), cwd, async () => scratch, mayBeScratch)).toBeNull();
    // a bare name is still found deeper in the scratch folder, as the fallback always did
    expect(await fileView.findFile("a.txt", cwd, async () => scratch, mayBeScratch)).toMatchObject({ info: { path: join(scratch, "sub", "a.txt") } });
  });

  it("keeps sending the file it opened when a link is swapped in while it is sent", async () => {
    // larger than one read too: such a body is sent after its headers, never from the path
    for (const inside of ["INSIDE", "I".repeat(STREAM_CHUNK_BYTES + 1)]) {
      const { cwd, scratch, swap } = fixture("note.txt", inside, "OUTSIDE-SECRET");
      await (async () => {
        const found = await fromScratch("note.txt", cwd, scratch);
        const responses = await Promise.all([false, true].map((download) => fileResponse(found.info, download, false, null, null, undefined, found.within)));
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        swap();
        for (const response of responses) expect(await response.text()).toBe(inside);
      })();
    }
    await bodiesCollected();
  });

  it("sends a file larger than one read with its exact length, whole and by range", async () => {
    // only Linux names an open file by its descriptor (`/proc/self/fd`); elsewhere it is streamed without one
    if (process.platform !== "linux") return;
    const size = 2 * STREAM_CHUNK_BYTES + 4096;
    // bytes that tell their own offset, so a range sent from the wrong place is seen
    const bytes = Buffer.from(Array.from({ length: size }, (_, at) => at % 251));
    const { cwd, scratch } = fixture("big.bin", "", "OUTSIDE-SECRET");
    writeFileSync(join(scratch, "big.bin"), bytes);
    // a disk that answers at once, whatever this machine's load: the case a file body is for
    pageFileHooks.fastDiskMs = 60_000;
    await (async () => {
      const found = await fromScratch("big.bin", cwd, scratch);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => fileResponse(found.info, true, false, null, request, undefined, found.within) });
      try {
        const whole = await fetch(server.url);
        expect(whole.headers.get("content-length")).toBe(String(size));
        expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
        // more than one read: sent as a file body, not read before the headers
        const [first, last] = [10, STREAM_CHUNK_BYTES + 5000];
        const part = await fetch(server.url, { headers: { range: `bytes=${first}-${last}` } });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe(`bytes ${first}-${last}/${size}`);
        expect(part.headers.get("content-length")).toBe(String(last - first + 1));
        expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(first, last + 1))).toBe(true);
      } finally { await server.stop(true); }
    })();
    await bodiesCollected();
  });

  it("keeps a large file's exact length while many answers let go of wait to be collected (#2286)", async () => {
    // only Linux names an open file by its descriptor (`/proc/self/fd`); elsewhere it is streamed without one
    if (process.platform !== "linux") return;
    const size = STREAM_CHUNK_BYTES + 4096;
    const bytes = Buffer.from(Array.from({ length: size }, (_, at) => at % 251));
    const { cwd, scratch } = fixture("big.bin", "", "OUTSIDE-SECRET");
    writeFileSync(join(scratch, "big.bin"), bytes);
    pageFileHooks.fastDiskMs = 60_000;
    // a host with room for them all, as most Linux systems are, whatever this one's limit
    pageFileHooks.openFiles = 524_288;
    await (async () => {
      const found = await fromScratch("big.bin", cwd, scratch);
      // answers already let go of, as a busy server's are before a collection: each still holds its
      // descriptor; more than the cap there once was (256), and well within any open-file limit
      for (let at = 0; at < 384; at += 1) await fileResponse(found.info, true, false, null, null, undefined, found.within);
      // the next answer made at once, before the event loop turns and a collection that happens to run lets any go
      const server = serveOnce(await fileResponse(found.info, true, false, null, null, undefined, found.within));
      try {
        const next = await fetch(server.url);
        expect(next.headers.get("content-length")).toBe(String(size));
        expect(Buffer.from(await next.arrayBuffer()).equals(bytes)).toBe(true);
      } finally { await server.stop(true); }
    })();
    await bodiesCollected();
  });

  it("holds no more such bodies than a quarter of this process's open files (#2286)", async () => {
    if (process.platform !== "linux") return;
    const size = STREAM_CHUNK_BYTES + 4096;
    const bytes = Buffer.from(Array.from({ length: size }, (_, at) => at % 251));
    const { cwd, scratch } = fixture("big.bin", "", "OUTSIDE-SECRET");
    writeFileSync(join(scratch, "big.bin"), bytes);
    pageFileHooks.fastDiskMs = 60_000;
    // a host whose hard limit is 1,024: the server's own sockets, terminals and file threads need the rest
    pageFileHooks.openFiles = 1024;
    await (async () => {
      const found = await fromScratch("big.bin", cwd, scratch);
      // downloads still under way, kept until the next answer is sent, so no collection lets one go
      const held: Response[] = [];
      for (let at = 0; at < 256; at += 1) held.push(await fileResponse(found.info, true, false, null, null, undefined, found.within));
      const server = serveOnce(await fileResponse(found.info, true, false, null, null, undefined, found.within));
      try {
        const next = await fetch(server.url);
        expect(held).toHaveLength(256);
        // past the cap: streamed from its descriptor, whole, rather than holding one more descriptor
        expect(next.headers.get("content-length")).toBeNull();
        expect(Buffer.from(await next.arrayBuffer()).equals(bytes)).toBe(true);
      } finally { await server.stop(true); }
    })();
    await bodiesCollected();
  });

  it("answers a burst of ranges while many bodies are held without stopping the event loop for a collection (#2286)", async () => {
    if (process.platform !== "linux") return;
    const size = 4 * STREAM_CHUNK_BYTES;
    const { cwd, scratch } = fixture("video.mp4", "", "OUTSIDE-SECRET");
    writeFileSync(join(scratch, "video.mp4"), Buffer.alloc(size, 7));
    pageFileHooks.fastDiskMs = 60_000;
    pageFileHooks.openFiles = 524_288;
    // a forced collection (`Bun.gc(true)`) holds every terminal and request on this thread for as long
    // as it takes on the whole heap: hundreds of milliseconds each on a large one
    const collect = Bun.gc;
    const forced: boolean[] = [];
    Bun.gc = (force?: boolean) => { forced.push(force === true); return collect(force); };
    try {
      await (async () => {
        const found = await fromScratch("video.mp4", cwd, scratch);
        // a player seeking through a long video: downloads still under way, then many more ranges
        const held: Response[] = [];
        // past where a collection is asked for (256), and well within any open-file limit
        for (let at = 0; at < 384; at += 1) {
          const first = (at * STREAM_CHUNK_BYTES) % (size - STREAM_CHUNK_BYTES - 1);
          const request = new Request("http://localhost/", { headers: { range: `bytes=${first}-${first + STREAM_CHUNK_BYTES}` } });
          const answer = await fileResponse(found.info, false, false, null, request, undefined, found.within);
          expect(answer.status).toBe(206);
          held.push(answer);
        }
        expect(forced.filter(Boolean)).toEqual([]);
        // the downloads end: a body streamed from its descriptor lets it go then
        for (const answer of held) await answer.body?.cancel();
      })();
    } finally { Bun.gc = collect; }
    await bodiesCollected();
  });

  it("names the descriptor a file thread opens in the folder in its cell, and takes back one it refuses", async () => {
    const { cwd, scratch, swap } = fixture("note.txt", "INSIDE", "OUTSIDE-SECRET");
    const found = await fromScratch("note.txt", cwd, scratch);
    const cell = () => { const opened = new Int32Array(new SharedArrayBuffer(4)); opened[0] = -1; return opened; };
    const kept = cell();
    let named = -1;
    pageFileHooks.afterAuthorize = () => { named = Atomics.load(kept, 0); };
    const opened = runFileTask({ op: "open", path: found.info.path, get: { range: null, ifRange: false }, opened: kept, within: found.within });
    // named before it was authorized, and handed back with the body read
    expect(named).toBeGreaterThanOrEqual(0);
    expect(opened).toMatchObject({ bytes: new TextEncoder().encode("INSIDE") });
    expect(Atomics.load(kept, 0)).toBe(-1);
    delete pageFileHooks.afterAuthorize;
    const refused = cell();
    pageFileHooks.afterOpen = () => { delete pageFileHooks.afterOpen; swap(); };
    expect(runFileTask({ op: "open", path: found.info.path, get: { range: null, ifRange: false }, opened: refused, within: found.within })).toBeNull();
    // taken back before it was closed: the pool never closes that number again (`abandon`)
    expect(Atomics.load(refused, 0)).toBe(-1);
  });

  it("names the descriptor a file thread describes a file in the folder from in its cell, and takes it back", async () => {
    const { scratch } = fixture("note.txt", "INSIDE", "OUTSIDE-SECRET");
    const described = new Int32Array(new SharedArrayBuffer(4));
    described[0] = -1;
    let named = -1;
    pageFileHooks.afterAuthorize = () => { named = Atomics.load(described, 0); };
    expect(runFileTask({ op: "describe", path: join(scratch, "note.txt"), folder: scratch, opened: described })).toMatchObject({ info: { size: 6 }, within: realpathSync(scratch) });
    delete pageFileHooks.afterAuthorize;
    expect(named).toBeGreaterThanOrEqual(0);
    expect(Atomics.load(described, 0)).toBe(-1);
  });

  it("still serves the file in the folder whole, by range and to a HEAD", async () => {
    const { cwd, scratch } = fixture("note.txt", "0123456789", "OUTSIDE-SECRET");
    const found = await fromScratch("note.txt", cwd, scratch);
    const whole = await fileResponse(found.info, false, false, null, null, undefined, found.within);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toStartWith("text/plain");
    expect(await whole.text()).toBe("0123456789");
    const range = await fileResponse(found.info, false, false, null, new Request("http://ovis/", { headers: { range: "bytes=2-4" } }), undefined, found.within);
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await range.text()).toBe("234");
    const head = await fileResponse(found.info, false, false, null, new Request("http://ovis/", { method: "HEAD" }), undefined, found.within);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.body).toBeNull();
  });
});
