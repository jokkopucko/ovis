import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildFiles, buildId, stampServiceWorker } from "./service-worker-build.ts";

const source = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");

describe("service worker build stamp", () => {
  it("names a build after its hashed files only, in any order", () => {
    const files = ["assets/index-a1.js", "assets/katex-b2.js", "index.html", "sw.js"];
    expect(buildId(files)).toMatch(/^[0-9a-f]{12}$/);
    expect(buildId([...files].reverse())).toBe(buildId(files));
    expect(buildId([...files, "THIRD_PARTY_NOTICES.md"])).toBe(buildId(files));
    expect(buildId(["assets/index-c3.js", "assets/katex-b2.js"])).not.toBe(buildId(files));
  });

  it("stamps the one BUILD line of public/sw.js and nothing else", () => {
    const stamped = stampServiceWorker(source, "0123456789ab");
    expect(stamped).toContain('const BUILD = "0123456789ab";');
    expect(stamped.replace('const BUILD = "0123456789ab";', 'const BUILD = "";')).toBe(source);
  });

  it("refuses a worker it cannot stamp, and a build id that is not one", () => {
    expect(() => stampServiceWorker(source.replace('const BUILD = "";', ""), "0123456789ab")).toThrow("exactly one");
    expect(() => stampServiceWorker(source.replace("const BUILD_FILES = null;", ""), "0123456789ab")).toThrow("exactly one");
    expect(() => stampServiceWorker(source, 'x"; evil()')).toThrow("not a build id");
    expect(() => stampServiceWorker(source, "0123456789ab", ['/assets/a.js"]; evil(); //'])).toThrow("not a build file");
    expect(() => stampServiceWorker(source, "0123456789ab", ["/assets/../sw.js"])).toThrow("not a build file");
    expect(stampServiceWorker(source, "0123456789ab", ["/assets/nested/index-a1.js"])).toContain('["/assets/nested/index-a1.js"]');
  });

  it("lists the build's own files the page asks for, without typefaces or precompressed copies", () => {
    const files = buildFiles(["assets/katex-b2.js", "assets/index-a1.js", "assets/index-a1.css", "assets/index-a1.js.br", "assets/index-a1.js.gz",
      "assets/PretendardVariable.subset.40-abc.woff2", "assets/KaTeX_Main-Regular-x.woff", "assets/KaTeX_Main-Regular-x.ttf", "index.html", "sw.js"]);
    expect(files).toEqual(["/assets/index-a1.css", "/assets/index-a1.js", "/assets/katex-b2.js"]);
    const stamped = stampServiceWorker(source, "0123456789ab", files);
    expect(stamped).toContain(`const BUILD_FILES = ${JSON.stringify(files)};`);
    expect(stamped).toContain('const BUILD = "0123456789ab";');
    expect(stamped).not.toContain("const BUILD_FILES = null;");
  });
});
