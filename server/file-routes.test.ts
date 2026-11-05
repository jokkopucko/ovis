import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { setFilePoolOptions } from "./file-pool.ts";
import { createServer } from "./index.ts";

describe("file routes", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let folder: string;
  let notes: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const q = (value: string) => encodeURIComponent(value);
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-file-routes-"));
    folder = join(stateDir, "project");
    mkdirSync(join(folder, "public"), { recursive: true });
    mkdirSync(join(folder, "docs"));
    notes = join(folder, "notes.txt");
    writeFileSync(notes, "hello");
    writeFileSync(join(folder, "public", "favicon.ico"), new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET or HEAD, and no other site's page", async () => {
    expect(await error(await fetch(url(`/api/fs/stat?path=${q(notes)}`), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url(`/api/fs/file?path=${q(notes)}`), { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } }))).toEqual([403, "cross_site"]);
    expect((await fetch(url(`/api/fs/file?path=${q(notes)}`), { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).status).toBe(200);
    expect((await fetch(url(`/api/fs/file?path=${q(notes)}`), { method: "HEAD" })).status).toBe(200);
  });

  it("describes and serves a file by its absolute path, and says when there is none", async () => {
    const stat = await fetch(url(`/api/fs/stat?path=${q(notes)}`));
    expect(stat.status).toBe(200);
    expect(await stat.json()).toMatchObject({ name: "notes.txt", kind: "text", size: 5 });
    const file = await fetch(url(`/api/fs/file?path=${q(notes)}`));
    expect(await file.text()).toBe("hello");
    expect(file.headers.get("content-disposition")).toStartWith("inline;");
    expect((await fetch(url(`/api/fs/file?path=${q(notes)}&download=1`))).headers.get("content-disposition")).toStartWith("attachment;");
    expect(await error(await fetch(url(`/api/fs/stat?path=${q(join(folder, "missing.txt"))}`)))).toEqual([404, "not_found"]);
  });

  it("finds a relative path in the named pane's folder, and none when herdr cannot say it", async () => {
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => ({ pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", cwd: folder, agent_status: "idle" }) as unknown as Awaited<ReturnType<typeof herdr.paneGet>>);
    try {
      const found = await fetch(url("/api/fs/stat?pane_id=w1:p1&path=notes.txt"));
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({ name: "notes.txt", size: 5 });
      get.mockImplementation(async (paneId) => { throw new HerdrError("pane_not_found", `pane ${paneId} not found`); });
      expect(await error(await fetch(url("/api/fs/stat?pane_id=w1:p1&path=notes.txt")))).toEqual([404, "not_found"]);
      expect((await fetch(url(`/api/fs/stat?pane_id=w1:p1&path=${q(notes)}`))).status).toBe(200);
    } finally {
      get.mockRestore();
    }
  });

  it("prefers foreground_cwd for relative images even when pane.cwd has another copy", async () => {
    const foreground = join(folder, "subproject");
    mkdirSync(join(folder, "out"), { recursive: true });
    mkdirSync(join(foreground, "out"), { recursive: true });
    const parentImage = join(folder, "out", "diagram.svg");
    const foregroundImage = join(foreground, "out", "diagram.svg");
    const image = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>`;
    writeFileSync(parentImage, image("pane cwd"));
    writeFileSync(foregroundImage, image("foreground cwd"));
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => ({ pane_id: paneId, cwd: folder, foreground_cwd: foreground }) as unknown as Awaited<ReturnType<typeof herdr.paneGet>>);
    try {
      const stat = await fetch(url(`/api/fs/stat?pane_id=w1:p1&path=${q("./out/diagram.svg")}`));
      expect(stat.status).toBe(200);
      const info = await stat.json() as { path: string };
      expect(info.path).toBe(foregroundImage);
      const bytes = await fetch(url(`/api/fs/file?pane_id=w1:p1&path=${q(info.path)}`));
      expect(await bytes.text()).toBe(image("foreground cwd"));
    } finally {
      get.mockRestore();
    }
  });

  it("answers a folder's project icon, or none", async () => {
    expect(await error(await fetch(url("/api/fs/favicon")))).toEqual([400, "missing_root"]);
    expect(await (await fetch(url(`/api/fs/favicon?root=${q(folder)}`))).json()).toMatchObject({ icon: { name: "favicon.ico", kind: "image" } });
    expect(await (await fetch(url(`/api/fs/favicon?root=${q(join(folder, "docs"))}`))).json()).toEqual({ icon: null });
  });

  it("plays no page media it never gave out", async () => {
    expect(await error(await fetch(url("/api/fs/page-media/not-a-token")))).toEqual([404, "not_found"]);
    expect(await error(await fetch(url("/api/fs/page-media/not-a-token"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
  });

  it("answers 503 while its file thread is stuck, and every other request meanwhile", async () => {
    setFilePoolOptions({ worker: new URL("./file-worker.fake.ts", import.meta.url), workers: 1, waiting: 0, deadlineMs: 500 });
    try {
      const stuck = fetch(url(`/api/fs/stat?path=${q(join(folder, "stuck"))}`));
      // the stat waits on its thread, not on the server's: the server answers the rest
      const health = await fetch(url("/api/health?scope=bridge"));
      expect(health.status).toBe(200);
      const refused = await stuck;
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(await error(refused)).toEqual([503, "file_busy"]);
      // that thread is still in its call, so the one there is stays taken
      expect(await error(await fetch(url(`/api/fs/stat?path=${q(notes)}`)))).toEqual([503, "file_busy"]);
    } finally {
      setFilePoolOptions();
    }
    // found and described, then held while it is opened and read: the headers wait no longer than the deadline
    const heldOpen = join(folder, "held-open");
    writeFileSync(heldOpen, "small");
    setFilePoolOptions({ worker: new URL("./file-worker.fake.ts", import.meta.url), workers: 2, waiting: 0, deadlineMs: 500 });
    try {
      const started = performance.now();
      expect(await error(await fetch(url(`/api/fs/file?path=${q(heldOpen)}`)))).toEqual([503, "file_busy"]);
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      setFilePoolOptions();
    }
    expect((await fetch(url(`/api/fs/stat?path=${q(notes)}`))).status).toBe(200);
  });

  it("streams a file in the range asked for, describes it to HEAD, and refuses a range past its end", async () => {
    const big = join(folder, "clip.bin");
    const bytes = Buffer.from(Array.from({ length: 300 * 1024 }, (_, index) => index % 251));
    writeFileSync(big, bytes);
    const whole = await fetch(url(`/api/fs/file?path=${q(big)}`));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    // larger than one read, from a disk that answers at once: sent with its length, as a download shows it
    expect(whole.headers.get("content-length")).toBe(String(bytes.length));
    const large = await fetch(url(`/api/fs/file?path=${q(big)}`), { headers: { range: "bytes=1000-299999" } });
    expect(large.status).toBe(206);
    expect(large.headers.get("content-length")).toBe("299000");
    expect(large.headers.get("content-range")).toBe(`bytes 1000-299999/${bytes.length}`);
    expect(Buffer.from(await large.arrayBuffer()).equals(bytes.subarray(1000, 300000))).toBe(true);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    const part = await fetch(url(`/api/fs/file?path=${q(big)}`), { headers: { range: "bytes=100-109" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-109/${bytes.length}`);
    // a body that fits in one read keeps its length; a longer one streams without it
    expect(part.headers.get("content-length")).toBe("10");
    const small = join(folder, "small.bin");
    writeFileSync(small, bytes.subarray(0, 1000));
    const smallAnswer = await fetch(url(`/api/fs/file?path=${q(small)}`));
    expect(smallAnswer.headers.get("content-length")).toBe("1000");
    expect(Buffer.from(await smallAnswer.arrayBuffer()).equals(bytes.subarray(0, 1000))).toBe(true);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 110))).toBe(true);
    const head = await fetch(url(`/api/fs/file?path=${q(big)}`), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    const past = await fetch(url(`/api/fs/file?path=${q(big)}`), { headers: { range: `bytes=${bytes.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
  });

  it("renders a page on a file thread, and plays its video from the address that render gave out", async () => {
    const site = join(folder, "site");
    mkdirSync(site);
    writeFileSync(join(site, "clip.mp4"), Buffer.alloc(9 * 1024 * 1024, 7));
    writeFileSync(join(site, "report.html"), `<img src="dot.png"><video src="clip.mp4"></video>`);
    writeFileSync(join(site, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const page = await fetch(url(`/api/fs/file?path=${q(join(site, "report.html"))}&render=1`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`<img src="data:image/png;base64,iVBORw==">`);
    const address = /src="(http:\/\/[^"]+\/api\/fs\/page-media\/[A-Za-z0-9_-]{32})"/.exec(html)?.[1];
    expect(address).toBeDefined();
    const played = await fetch(address!, { headers: { range: "bytes=0-3" } });
    expect(played.status).toBe(206);
    expect(new Uint8Array(await played.arrayBuffer())).toEqual(new Uint8Array(4).fill(7));
  });
});
