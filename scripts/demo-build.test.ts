import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDemoApp } from "./demo-build.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-demo-build-test-")); made.push(dir); return dir; };

describe("buildDemoApp with the lane's build", () => {
  it("copies it, and leaves the lane's own files as they were when the copy is changed", async () => {
    const shared = scratch();
    mkdirSync(join(shared, "assets"));
    writeFileSync(join(shared, "index.html"), "<script type=\"module\"></script>");
    writeFileSync(join(shared, "demo-transport.js"), "transport");
    writeFileSync(join(shared, "assets", "app.css"), "css");
    const app = scratch();
    await buildDemoApp(app, shared);
    expect(readFileSync(join(app, "assets", "app.css"), "utf8")).toBe("css");
    expect(readFileSync(join(app, "demo-transport.js"), "utf8")).toBe("transport");
    writeFileSync(join(app, "index.html"), "changed");
    expect(readFileSync(join(shared, "index.html"), "utf8")).toBe("<script type=\"module\"></script>");
  });

  it("refuses a directory that holds no finished build instead of serving half of one", async () => {
    const shared = scratch();
    writeFileSync(join(shared, "index.html"), "");
    await expect(buildDemoApp(scratch(), shared)).rejects.toThrow("holds no demo-transport.js");
  });
});
