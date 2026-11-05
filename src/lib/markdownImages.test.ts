import { afterEach, describe, expect, it } from "bun:test";
import type { FileInfo } from "../../shared/protocol.ts";

import { MAX_INLINE_IMAGE_BYTES, markdownImagePath, markdownImagePreview } from "./markdownImages.ts";
import { nativeTransport, setTransport } from "./transport.ts";

afterEach(() => { setTransport(nativeTransport); });

describe("markdownImagePath", () => {
  it("reads a relative path from the markdown file's folder", () => {
    expect(markdownImagePath("img/a.png", "/tmp/doc/README.md")).toBe("/tmp/doc/img/a.png");
    expect(markdownImagePath("./a.png?raw=1#x", "/tmp/doc/README.md")).toBe("/tmp/doc/a.png");
    expect(markdownImagePath("../a%20b.png", "/tmp/doc/README.md")).toBe("/tmp/a b.png");
  });
  it("keeps an absolute path and a file URI", () => {
    expect(markdownImagePath("/var/x.png", "/tmp/doc/README.md")).toBe("/var/x.png");
    expect(markdownImagePath("file:///var/x.png", "/tmp/doc/README.md")).toBe("/var/x.png");
    // decoded once: the `%` that `%25` stands for is not read as an escape again
    expect(markdownImagePath("file:///tmp/100%25.png", "/tmp/a.md")).toBe("/tmp/100%.png");
  });
  it("refuses what the page cannot load or place", () => {
    expect(markdownImagePath("https://x.dev/a.png", "/tmp/a.md")).toBeNull();
    expect(markdownImagePath("data:image/png;base64,AA", "/tmp/a.md")).toBeNull();
    expect(markdownImagePath("a.png", "a.md")).toBeNull();
    expect(markdownImagePath("~/a.png", "/tmp/a.md")).toBeNull();
  });
  it("places images without a document path only when the reference is absolute", () => {
    expect(markdownImagePath("a.png", "")).toBeNull();
    expect(markdownImagePath("/tmp/a.png", "")).toBe("/tmp/a.png");
    expect(markdownImagePath("file:///tmp/a%20b.png", "")).toBe("/tmp/a b.png");
    expect(markdownImagePath("./a.png", "/.ovis-chat.md")).toBe("/a.png");
    expect(markdownImagePath("../a.png", "/tmp/project/.ovis-chat.md")).toBe("/tmp/a.png");
  });
  it("decodes reserved filename characters once, after removing URL suffixes", () => {
    expect(markdownImagePath("./chart%20%23%3F%20%25%20%ED%95%9C%EA%B8%80.png?raw=1#view", "/tmp/.ovis-chat.md")).toBe("/tmp/chart #? % 한글.png");
    expect(markdownImagePath("./literal%2523.png", "/tmp/.ovis-chat.md")).toBe("/tmp/literal%23.png");
  });
  it("does not stat malformed, nonlocal or control-character references", () => {
    for (const src of ["file://other/tmp/a.png", "file:///tmp/a%00.png", "./a%00b.png", "./bad%.png", "javascript:bad", "ftp://other/a.png", "blob:local", "//other/a.png", "%2F%2Fother/a.png", "./a%5Cb.png", "C:/a.png", "file:///C:/a.png"]) {
      expect(markdownImagePath(src, "/tmp/.ovis-chat.md")).toBeNull();
    }
  });
});

it("stats markdown images before loading them and offers oversized ones as downloads", async () => {
  let size = MAX_INLINE_IMAGE_BYTES;
  const statPaths: string[] = [];
  const urls: Array<{ path: string; download: boolean }> = [];
  const fetchInfo = async (path: string): Promise<FileInfo> => {
    statPaths.push(path);
    return { path, name: "a.png", size, modified: "2026-10-11T00:00:00Z", mime: "image/png", kind: "image" };
  };
  const fileUrl = (path: string, download: boolean): string => {
    urls.push({ path, download });
    return download ? "download-url" : "inline-url";
  };

  expect(await markdownImagePreview("img/a.png", "/tmp/doc/README.md", fetchInfo, fileUrl)).toEqual({ kind: "inline", url: "inline-url", name: "a.png" });
  size++;
  expect(await markdownImagePreview("img/a.png", "/tmp/doc/README.md", fetchInfo, fileUrl)).toEqual({
    kind: "too-large", size, downloadUrl: "download-url",
  });
  expect(statPaths).toEqual(["/tmp/doc/img/a.png", "/tmp/doc/img/a.png"]);
  expect(urls).toEqual([
    { path: "/tmp/doc/img/a.png", download: false },
    { path: "/tmp/doc/img/a.png", download: true },
  ]);
  expect(await markdownImagePreview("https://example.com/a.png", "/tmp/doc/README.md", fetchInfo, fileUrl)).toBeNull();
  expect(statPaths).toHaveLength(2);
});

it("leaves missing, ambiguous and non-image files as links without requesting their bytes", async () => {
  const filePaths: string[] = [];
  const fileUrl = (path: string) => { filePaths.push(path); return "unexpected-url"; };
  for (const fetchInfo of [
    async () => { throw new Error("not found or denied"); },
    async () => ({ candidates: ["/tmp/a.png", "/tmp/other/a.png"] }),
    async (): Promise<FileInfo> => ({ path: "/tmp/a.png", name: "a.png", size: 20, modified: "", mime: "text/plain", kind: "text" }),
  ]) {
    expect(await markdownImagePreview("a.png", "/tmp/.ovis-chat.md", fetchInfo, fileUrl)).toBeNull();
  }
  expect(filePaths).toEqual([]);
});

it("leaves relative Chat targets for the pane API and uses its canonical result for bytes", async () => {
  const paths: string[] = [];
  const preview = await markdownImagePreview("./out/a%20b.png", null, async (path) => {
    paths.push(path);
    return { path: "/repo/subproject/out/a b.png", name: "a b.png", size: 2, modified: "", mime: "image/png", kind: "image" };
  }, (path) => path);
  expect(paths).toEqual(["./out/a b.png"]);
  expect(preview).toEqual({ kind: "inline", url: "/repo/subproject/out/a b.png", name: "a b.png" });
});

it("distinguishes failed Chat lookups from permanently unsupported references", async () => {
  const url = () => "must-not-load";
  for (const status of [404, 408, 429, 500, 503]) {
    expect(await markdownImagePreview("./late.png", null, async () => { throw Object.assign(new Error("lookup failed"), { status }); }, url)).toEqual({ kind: "unavailable" });
  }
  for (const status of [400, 401, 403]) {
    expect(await markdownImagePreview("./late.png", null, async () => { throw Object.assign(new Error("rejected"), { status }); }, url)).toBeNull();
  }
  let stats = 0;
  expect(await markdownImagePreview("https://example.com/a.png", null, async () => { stats++; throw new Error(); }, url)).toBeNull();
  expect(stats).toBe(0);
});

it("leaves the inline address for ReservedImage to resolve once and resolves only the download link", async () => {
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: async (path) => `mapped:${path}` });
  let size = 1;
  const fetchInfo = async (path: string): Promise<FileInfo> => ({ path, name: "a.png", size, modified: "2026-10-11T00:00:00Z", mime: "image/png", kind: "image" });
  const fileUrl = (path: string, download: boolean): string => `/api/fs/file?path=${path}${download ? "&download=1" : ""}`;

  expect(await markdownImagePreview("a.png", "/tmp/README.md", fetchInfo, fileUrl)).toEqual({ kind: "inline", url: "/api/fs/file?path=/tmp/a.png", name: "a.png" });
  size = MAX_INLINE_IMAGE_BYTES + 1;
  expect(await markdownImagePreview("a.png", "/tmp/README.md", fetchInfo, fileUrl)).toEqual({
    kind: "too-large", size, downloadUrl: "mapped:/api/fs/file?path=/tmp/a.png&download=1",
  });
});
