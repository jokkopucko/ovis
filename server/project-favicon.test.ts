import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { FAVICON_CANDIDATES, findProjectFavicon } from "./project-favicon.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-project-favicon-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, files: string[]): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  for (const file of files) {
    mkdirSync(join(folder, file, ".."), { recursive: true });
    writeFileSync(join(folder, file), "<svg/>");
  }
  return folder;
}

describe("a project's favicon", () => {
  it("is the best place that holds an image", async () => {
    const folder = project("site", ["public/favicon.ico", "assets/logo.png", "README.md"]);
    expect(await findProjectFavicon(folder)).toMatchObject({ path: join(folder, "public/favicon.ico"), name: "favicon.ico", kind: "image" });
    expect(await findProjectFavicon(`${folder}/`)).toMatchObject({ path: join(folder, "public/favicon.ico") });
  });

  it("falls back to an app icon, then a logo", async () => {
    const app = project("electron", ["build/icon.png", "logo.svg"]);
    expect((await findProjectFavicon(app))?.path).toBe(join(app, "build/icon.png"));
    const logo = project("library", [".github/logo.png"]);
    expect((await findProjectFavicon(logo))?.path).toBe(join(logo, ".github/logo.png"));
  });

  it("passes over a place that is not an image file", async () => {
    const folder = project("odd", ["favicon.svg/inner.txt", "favicon.png"]);
    expect((await findProjectFavicon(folder))?.path).toBe(join(folder, "favicon.png"));
  });

  it("is null for a folder without one, a missing folder and a relative one", async () => {
    expect(await findProjectFavicon(project("plain", ["index.ts"]))).toBeNull();
    expect(await findProjectFavicon(join(root, "absent"))).toBeNull();
    // a relative path has no pane folder to be relative to, as with /api/fs/stat and no pane: it
    // is never read against the server's own folder
    const near = project("relative", ["favicon.svg"]);
    expect(await findProjectFavicon(relative(process.cwd(), near))).toBeNull();
  });

  it("lists the places best first: a favicon before an app icon before a logo", () => {
    const at = (candidate: (typeof FAVICON_CANDIDATES)[number]) => FAVICON_CANDIDATES.indexOf(candidate);
    expect(at("favicon.svg")).toBe(0);
    expect(at("public/favicon.ico")).toBeLessThan(at("app/icon.svg"));
    expect(at("build/icon.png")).toBeLessThan(at("logo.svg"));
    expect(new Set(FAVICON_CANDIDATES).size).toBe(FAVICON_CANDIDATES.length);
  });
});
