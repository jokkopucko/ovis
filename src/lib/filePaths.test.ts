import { describe, expect, it } from "bun:test";
import { codeIsFilePath, fileLineTarget, pathParts, splitFilePaths } from "./filePaths.ts";

const paths = (text: string) => splitFilePaths(text).filter((part) => typeof part !== "string").map((part) => (part as { path: string }).path);

describe("file paths in chat text", () => {
  it("keeps line references whole in prose and code spans", () => {
    const targets = ["src/app.ts:12", "src/app.ts:12:8", "src/app.ts#L12", "src/app.ts#L12-L18", "src/app.ts#L12-18"];
    expect(paths(targets.join(" "))).toEqual(targets);
    for (const target of targets) expect(codeIsFilePath(target)).toBe(true);
    for (const target of ["Math.random:12", "tool.monitor#L12", "1.2.3:12"]) expect(codeIsFilePath(target)).toBe(false);
    expect(splitFilePaths("see src/app.ts:12:8.")).toEqual(["see ", { path: "src/app.ts:12:8" }, "."]);
  });
  it("finds paths with a folder and an extension, absolute, ~ or relative", () => {
    expect(paths("Saved to docs/screenshots/demo-mobile.mp4 and ~/out/shot.png, see /tmp/run.log.")).toEqual([
      "docs/screenshots/demo-mobile.mp4", "~/out/shot.png", "/tmp/run.log",
    ]);
    expect(paths("./scripts/capture.ts 에서 확인")).toEqual(["./scripts/capture.ts"]);
    // the text around a path is kept, whole
    expect(splitFilePaths("open src/a.ts now")).toEqual(["open ", { path: "src/a.ts" }, " now"]);
  });

  it("finds a path named in any script, and stops at a particle written onto it", () => {
    expect(paths("열면 docs/스플릿뷰-결과.html 이 보여요, ~/사진/화면.png")).toEqual(["docs/스플릿뷰-결과.html", "~/사진/화면.png"]);
    expect(paths("docs/a.md를 열고 src/앱.ts에서 확인")).toEqual(["docs/a.md", "src/앱.ts"]);
    expect(paths("한글/폴더/파일.txt:12")).toEqual(["한글/폴더/파일.txt:12"]);
    // a name with spaces in prose is not guessed at: only its last word would match
    expect(paths("docs/합치기 결과-mvck6xdy.html")).toEqual([]);
  });

  it("takes a Latin path written straight onto Chinese, Japanese or Korean words", () => {
    expect(paths("请打开src/app.ts文件")).toEqual(["src/app.ts"]);
    expect(paths("まずsrc/app.tsを開いて")).toEqual(["src/app.ts"]);
    expect(paths("파일src/a.ts를 열어")).toEqual(["src/a.ts"]);
    expect(paths("修改了src/lib/filePaths.ts和src/a.ts")).toEqual(["src/lib/filePaths.ts", "src/a.ts"]);
    expect(splitFilePaths("请打开src/app.ts文件")).toEqual(["请打开", { path: "src/app.ts" }, "文件"]);
    // a digit next to a Hangul name stays part of it
    expect(paths("docs/결과2.html")).toEqual(["docs/결과2.html"]);
  });

  it("splits only the text before an end, and leaves a path that end cuts as text", () => {
    const text = "see src/a.ts and src/thing.tsx now";
    const cut = text.indexOf("src/thing.tsx") + "src/thing.ts".length;
    // the path the end cuts is found in the whole text: the preview's "src/thing.ts" is no file of its own
    expect(splitFilePaths(text, cut)).toEqual(["see ", { path: "src/a.ts" }, " and src/thing.ts"]);
    // an end past every path splits as the whole text does, in that text's bounds
    expect(splitFilePaths(text, text.indexOf(" now"))).toEqual(["see ", { path: "src/a.ts" }, " and ", { path: "src/thing.tsx" }]);
    expect(splitFilePaths(text, 4)).toEqual(["see "]);
  });

  it("leaves words, versions and bare names as text", () => {
    expect(paths("and/or, e.g. v1.2.3, 1.0/2.5, README.md, TCP/IP")).toEqual([]);
  });

  it("starts a path once in a run of plus signs, not at every one", () => {
    // each `+` is a character a path may hold: tried from every one of them, a line of 48,000 takes half a second
    const start = performance.now();
    expect(splitFilePaths("+".repeat(48_000))).toEqual(["+".repeat(48_000)]);
    expect(splitFilePaths("+/".repeat(24_000))).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(250);
    // a plus sign before or inside a path reads as it did
    expect(paths("+src/app.ts and c++/x/y.cc, a+b/c.ts")).toEqual(["+src/app.ts", "c++/x/y.cc", "a+b/c.ts"]);
    expect(splitFilePaths("+~/notes/a.md")).toEqual(["+", { path: "~/notes/a.md" }]);
  });

  it("takes a code span named in any script, with spaces past its first folder", () => {
    for (const code of [".senpi/html-pages/스플릿뷰 한 줄 합치기 결과-mvck6xdy.html", "스플릿뷰.html", "/tmp/a b/x.html", "~/My Docs/notes v2.md:3", "docs/화면 캡처.png"]) expect(codeIsFilePath(code)).toBe(true);
    // a command, a phrase or two files in one span is not one path
    for (const code of ["bun scripts/check.ts", "run a.ts", "git add src/a.ts", "src/App.tsx src/styles.css", "a.ts b.ts", " /tmp/a.log", "/tmp/a  b/x.html", "my notes.md"]) expect(codeIsFilePath(code)).toBe(false);
  });

  it("takes a code span that is one file name or path", () => {
    for (const code of ["README.md", "src/app.ts", "~/x/y.png", "/tmp/a.log", "docs/demo.mp4"]) expect(codeIsFilePath(code)).toBe(true);
    for (const code of ["bun test", "1.2.3", "git log --oneline", "a/b", "foo()", "x.y()", "tool.monitor", "Math.random", "process.env", "os.path", "process.env.HOME", "console.log", "JSON.parse"]) expect(codeIsFilePath(code)).toBe(false);
    // a file of any language still opens: what is refused above is known code, not an unknown extension
    for (const code of ["main.c", "util.h", "App.vue", "go.mod", "Cargo.lock", "nginx.conf", "config.env", "src/process.env", "os.py", "std.rs", "tool.ts", "fmt.go", "app.dev", "tool.vue", "std.lock", "os.conf", "Math.js", "process.yml", "README.org", "notes.io", "example.com"]) expect(codeIsFilePath(code)).toBe(true);
  });
});

describe("fileLineTarget", () => {
  it("selects only the first line, not the column or range end", () => {
    for (const suffix of [":12", ":12:8", "#L12", "#L12-L18", "#L12-18"]) {
      expect(fileLineTarget(`src/app.ts${suffix}`)).toEqual({ path: "src/app.ts", line: 12 });
    }
    expect(fileLineTarget("C:\\repo\\app.ts:12:8")).toEqual({ path: "C:\\repo\\app.ts", line: 12 });
  });
  it("leaves ordinary names intact and ignores invalid line numbers", () => {
    expect(fileLineTarget("src/app.ts")).toEqual({ path: "src/app.ts", line: null });
    expect(fileLineTarget("docs/a.md#usage")).toEqual({ path: "docs/a.md#usage", line: null });
    for (const suffix of [":0", "#L0", ":99999999999999999999"]) {
      expect(fileLineTarget(`src/app.ts${suffix}`)).toEqual({ path: "src/app.ts", line: null });
    }
  });
});

describe("pathParts", () => {
  it("splits a path into its folder, the name's stem and its extension", () => {
    expect(pathParts("/a/b/c.md")).toEqual({ folder: "/a/b", stem: "c", extension: ".md" });
    expect(pathParts("C:\\repo\\a.tar.gz")).toEqual({ folder: "C:\\repo", stem: "a.tar", extension: ".gz" });
    expect(pathParts("~/notes.txt")).toEqual({ folder: "~", stem: "notes", extension: ".txt" });
  });

  it("keeps the root as the folder of a file directly in it", () => {
    expect(pathParts("/c.md").folder).toBe("/");
    expect(pathParts("C:\\c.md").folder).toBe("C:\\");
  });

  it("has no folder for a bare name", () => {
    expect(pathParts("notes.txt")).toEqual({ folder: "", stem: "notes", extension: ".txt" });
  });

  it("gives a dotfile, a name without a dot and a trailing dot no extension", () => {
    expect(pathParts("/x/.gitignore")).toEqual({ folder: "/x", stem: ".gitignore", extension: "" });
    expect(pathParts("/x/Dockerfile")).toEqual({ folder: "/x", stem: "Dockerfile", extension: "" });
    expect(pathParts("/x/name.")).toEqual({ folder: "/x", stem: "name.", extension: "" });
  });
});
