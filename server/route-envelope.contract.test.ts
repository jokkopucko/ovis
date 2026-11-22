import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import type { DirectoryListing, FileInfo, ProjectFavicon } from "../shared/protocol.ts";

/**
 * The answer every JSON route gives before it reaches herdr: the wrong method, a body that is not
 * JSON or not an object, a watching device and another site. Nothing here calls an RPC, so the
 * table holds for every route that reads a JSON body, wherever its handler lives.
 */
const JSON_ROUTES = [
  "/api/workspace/directories", "/api/workspace/create", "/api/tab/create",
  "/api/worktree/remove", "/api/worktree/create", "/api/worktree/open",
  "/api/workspace/rename", "/api/workspace/move", "/api/workspace/close",
  "/api/tab/rename", "/api/tab/close", "/api/tab/move", "/api/tab/move-to-workspace", "/api/plugin/action",
  "/api/pane/rename", "/api/agent/rename", "/api/pane/find", "/api/pane/scroll",
  "/api/pane/input", "/api/pane/keys", "/api/pane/close", "/api/layout/ratio",
  "/api/pane/split", "/api/pane/zoom", "/api/pane/swap", "/api/pane/move", "/api/pane/resize",
  "/api/pane/clear", "/api/pane/focus", "/api/pane/image",
] as const;

const OWN_GET: Partial<Record<(typeof JSON_ROUTES)[number], [number, string | null]>> = {
  "/api/workspace/directories": [200, null],
  "/api/plugin/action": [400, "missing_plugin_id"],
  "/api/pane/scroll": [400, "missing_pane_id"],
};

const root = mkdtempSync(join(tmpdir(), "ovis-route-envelope-"));
let owner: ReturnType<typeof createServer>;
let watched: ReturnType<typeof createServer>;
let ownBase = "";
let watchBase = "";
let watchCookie = "";

beforeAll(() => {
  owner = createServer({ port: 0, stateDir: join(root, "owner") });
  ownBase = `http://127.0.0.1:${owner.port}`;
  const watchState = join(root, "watch");
  const devices = new DeviceStore(watchState);
  const paired = devices.pair(devices.startPairing().code, "Watch", "watch")!;
  // a first pairing is dropped unless the device is seen once
  expect(devices.match(paired.token)).not.toBeNull();
  watchCookie = `ovis_device=${encodeURIComponent(paired.token)}`;
  watched = createServer({ port: 0, stateDir: watchState });
  watchBase = `http://127.0.0.1:${watched.port}`;
});

afterAll(() => {
  owner?.stop();
  watched?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function answer(response: Response): Promise<[number, string | null]> {
  const text = await response.text();
  try {
    return [response.status, (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null];
  } catch {
    return [response.status, null];
  }
}

const post = (base: string, route: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${route}`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json", ...headers }, body });

describe("a JSON route's answer before herdr", () => {
  it("answers the wrong method", async () => {
    for (const route of JSON_ROUTES) {
      const expected = OWN_GET[route] ?? [400, "method_not_allowed"];
      expect([route, await answer(await fetch(`${ownBase}${route}`, { headers: { origin: ownBase } }))]).toEqual([route, expected]);
    }
  });

  it("refuses a body that is not JSON, then one that is not an object", async () => {
    for (const route of JSON_ROUTES) {
      expect([route, await answer(await post(ownBase, route, "not json"))]).toEqual([route, [400, "invalid_json"]]);
      for (const body of ["[]", "null"]) {
        expect([route, body, await answer(await post(ownBase, route, body))]).toEqual([route, body, [400, "invalid_body"]]);
      }
    }
  });

  it("refuses every one to a watching device", async () => {
    for (const route of JSON_ROUTES) {
      expect([route, await answer(await post(watchBase, route, "not json", { cookie: watchCookie }))]).toEqual([route, [403, "read_only"]]);
    }
  });

  it("refuses every one to another site", async () => {
    for (const route of JSON_ROUTES) {
      const response = await fetch(`${ownBase}${route}`, { method: "POST", headers: { origin: "http://other.example", "content-type": "text/plain" }, body: "not json" });
      expect([route, await answer(response)]).toEqual([route, [403, "invalid_origin"]]);
    }
  });
});

describe("a read that succeeds on this PC", () => {
  it("states a file by its absolute path", async () => {
    const file = join(root, "note.txt");
    writeFileSync(file, "hello");
    const response = await fetch(`${ownBase}/api/fs/stat?path=${encodeURIComponent(file)}`);
    expect(response.status).toBe(200);
    expect(await response.json() as FileInfo).toMatchObject({ path: realpathSync(file), name: "note.txt", size: 5, kind: "text" });
  });

  it("answers a folder's project icon in one request, and a folder without one with null rather than a 404", async () => {
    const site = join(root, "site");
    mkdirSync(join(site, "public"), { recursive: true });
    writeFileSync(join(site, "public", "favicon.svg"), "<svg/>");
    writeFileSync(join(site, "logo.png"), "png");
    const found = await fetch(`${ownBase}/api/fs/favicon?root=${encodeURIComponent(site)}`);
    expect(found.status).toBe(200);
    expect(await found.json() as ProjectFavicon).toMatchObject({ icon: { path: join(site, "public", "favicon.svg"), name: "favicon.svg", kind: "image" } });
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    for (const folder of [plain, join(root, "absent")]) {
      const missing = await fetch(`${ownBase}/api/fs/favicon?root=${encodeURIComponent(folder)}`);
      expect(missing.status).toBe(200);
      expect(await missing.json() as ProjectFavicon).toEqual({ icon: null });
    }
    expect(await answer(await fetch(`${ownBase}/api/fs/favicon?root=`))).toEqual([400, "missing_root"]);
  });

  it("keeps a project icon to the rules of a file read", async () => {
    const query = `/api/fs/favicon?root=${encodeURIComponent(root)}`;
    expect(await answer(await fetch(`${ownBase}${query}`, { method: "POST", headers: { origin: ownBase, "x-herdr-machine": "1" } }))).toEqual([400, "method_not_allowed"]);
    // another site's page may not use it to learn which files exist
    expect(await answer(await fetch(`${ownBase}${query}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } }))).toEqual([403, "cross_site"]);
    // nor a watching device, on this PC or through a PC's route
    for (const path of [query, `/api/machines/pc1${query.slice("/api".length)}`]) {
      expect([path, await answer(await fetch(`${watchBase}${path}`, { headers: { cookie: watchCookie } }))]).toEqual([path, [403, "read_only"]]);
    }
  });

  it("lists a folder's folders, and its files when asked", async () => {
    const folder = join(root, "listing");
    mkdirSync(join(folder, "child"), { recursive: true });
    writeFileSync(join(folder, "a.txt"), "abc");
    const response = await fetch(`${ownBase}/api/workspace/directories?path=${encodeURIComponent(folder)}&files=1`);
    expect(response.status).toBe(200);
    expect(await response.json() as DirectoryListing).toMatchObject({ path: realpathSync(folder), directories: ["child"], files: [{ name: "a.txt", size: 3 }] });
  });
});
