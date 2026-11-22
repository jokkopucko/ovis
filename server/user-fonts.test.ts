import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserFontList } from "../shared/user-fonts.ts";
import { createServer } from "./index.ts";
import { USER_FONT_MAX_BYTES } from "./user-fonts.ts";

const TOKEN = "user-fonts-token";

describe("GET /api/fonts", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const signedIn = (path: string, init: RequestInit = {}) => fetch(url(path), { ...init, headers: { authorization: `Bearer ${TOKEN}` } });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-user-fonts-"));
    const state = join(root, "state");
    const fonts = join(state, "fonts");
    mkdirSync(fonts, { recursive: true });
    writeFileSync(join(fonts, "QA Mono-Regular.ttf"), "regular face");
    writeFileSync(join(fonts, "QA Mono-BoldItalic.woff2"), "bold italic face");
    writeFileSync(join(fonts, "D2Coding.otf"), "plain name");
    writeFileSync(join(fonts, "Mono-constructor.ttf"), "no face suffix");
    writeFileSync(join(fonts, "notes.txt"), "not a font");
    writeFileSync(join(fonts, ".hidden.ttf"), "hidden");
    writeFileSync(join(fonts, 'Odd"Name.ttf'), "a name CSS would need escaped");
    writeFileSync(join(fonts, "Huge.ttf"), "");
    truncateSync(join(fonts, "Huge.ttf"), USER_FONT_MAX_BYTES + 1);
    // a link could name any file this user may read
    writeFileSync(join(root, "secret.ttf"), "outside the folder");
    if (process.platform !== "win32") symlinkSync(join(root, "secret.ttf"), join(fonts, "Linked.ttf"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: TOKEN, machines: false, sidecar: false, tailscaleOwner: null });
  });
  afterAll(() => {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists the font files of the state folder's fonts/, with the family, weight and style their names give", async () => {
    const response = await signedIn("/api/fonts");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { fonts } = await response.json() as UserFontList;
    expect(fonts.map(({ file, family, weight, style, bytes }) => ({ file, family, weight, style, bytes }))).toEqual([
      { file: "D2Coding.otf", family: "D2Coding", weight: 400, style: "normal", bytes: 10 },
      { file: "Mono-constructor.ttf", family: "Mono-constructor", weight: 400, style: "normal", bytes: 14 },
      { file: "QA Mono-BoldItalic.woff2", family: "QA Mono", weight: 700, style: "italic", bytes: 16 },
      { file: "QA Mono-Regular.ttf", family: "QA Mono", weight: 400, style: "normal", bytes: 12 },
    ]);
    expect(fonts.every((font) => font.version.length > 0)).toBe(true);
  });

  it("serves a listed file as a font the browser may keep, and nothing it does not list", async () => {
    const { fonts } = await (await signedIn("/api/fonts")).json() as UserFontList;
    const version = fonts.find((font) => font.file === "QA Mono-Regular.ttf")!.version;
    const served = await signedIn(`/api/fonts/${encodeURIComponent("QA Mono-Regular.ttf")}?v=${encodeURIComponent(version)}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("font/ttf");
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await signedIn(`/api/fonts/${encodeURIComponent("QA Mono-Regular.ttf")}?v=old`)).headers.get("cache-control")).toBe("private, no-cache");
    expect(await served.text()).toBe("regular face");
    for (const name of ["notes.txt", "Huge.ttf", ".hidden.ttf", "Linked.ttf", "missing.ttf"]) {
      expect((await signedIn(`/api/fonts/${encodeURIComponent(name)}`)).status, name).toBe(404);
    }
    expect((await signedIn("/api/fonts/%E0.ttf")).status).toBe(404);
    expect((await signedIn("/api/fonts", { method: "POST" })).status).toBe(405);
  });

  it("answers no one who is not signed in", async () => {
    expect((await fetch(url("/api/fonts"))).status).toBe(401);
    expect((await fetch(url(`/api/fonts/${encodeURIComponent("QA Mono-Regular.ttf")}`))).status).toBe(401);
  });

  it("lists nothing while the folder does not exist", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-user-fonts-none-"));
    const bare = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: TOKEN, machines: false, sidecar: false, tailscaleOwner: null });
    try {
      const response = await fetch(`http://127.0.0.1:${bare.port}/api/fonts`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ fonts: [] });
    } finally {
      bare.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });
});
