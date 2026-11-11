import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { createDirectory, listDirectories, MAX_DIRECTORY_ENTRIES, resolveFolder } from "./directories.ts";

// the file viewer lists a path it found no file at, and the folder browser one its dialog was opened with: both can be
// a link's (`?file=//host/share/`, `?new=1&cwd=//host/share`), and listing a network share asks its host
describe("the folder a path names", () => {
  const windows = (path: string, base?: string, home = "C:\\Users\\me") => resolveFolder(path, home, base, win32);
  it("is no network share on a Windows PC but the pane's own, the home folder's and WSL's", () => {
    for (const share of ["//host/share", "\\\\host\\share\\docs", "~///host/share", "\\\\?\\UNC\\host\\share", "\\\\wsl$evil\\share"]) {
      expect(windows(share), share).toBeNull();
      expect(windows(share, "C:\\work"), share).toBeNull();
    }
    expect(windows("")).toBe("C:\\Users\\me");
    expect(windows("~/code")).toBe("C:\\Users\\me\\code");
    expect(windows("docs", "C:\\work")).toBe("C:\\work\\docs");
    expect(windows("\\\\wsl$\\Ubuntu\\home\\u")).toBe("\\\\wsl$\\Ubuntu\\home\\u");
    expect(windows("//wsl.localhost/Ubuntu/home/u")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u");
    expect(windows("docs", "\\\\nas\\work\\proj")).toBe("\\\\nas\\work\\proj\\docs");
    expect(windows("\\\\nas\\work\\other", "\\\\nas\\work\\proj")).toBe("\\\\nas\\work\\other");
    expect(windows("\\\\nas\\private", "\\\\nas\\work\\proj")).toBeNull();
    expect(windows("~/code", undefined, "\\\\files\\home\\me")).toBe("\\\\files\\home\\me\\code");
  });
});

describe("listDirectories", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-dirs-")); roots.push(root); return root; };

  it("lists folders only, sorted naturally, with links to folders and without hidden ones", () => {
    const root = temp();
    for (const name of ["web", "api10", "api2", ".git", "Docs"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "README.md"), "");
    symlinkSync(join(root, "web"), join(root, "web-link"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    const listing = listDirectories(root)!;
    expect(listing.directories).toEqual(["api2", "api10", "Docs", "web", "web-link"]);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(tmpdir());
    expect(listing.truncated).toBe(false);
    expect(listDirectories(root, true)!.directories).toContain(".git");
  });

  it("reads ~ and an empty path as home, and has no parent at the root", () => {
    expect(listDirectories("")!.path).toBe(homedir());
    expect(listDirectories("~")!.path).toBe(homedir());
    expect(listDirectories("/")!.parent).toBeNull();
  });

  it("answers null for a file or a missing path, and stops at the cap", () => {
    const root = temp();
    writeFileSync(join(root, "file"), "");
    expect(listDirectories(join(root, "file"))).toBeNull();
    expect(listDirectories(join(root, "nope"))).toBeNull();
    for (let n = 0; n <= MAX_DIRECTORY_ENTRIES; n++) mkdirSync(join(root, `d${n}`));
    const listing = listDirectories(root)!;
    expect(listing.directories).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(listing.truncated).toBe(true);
  });
});

describe("createDirectory", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-mkdir-")); roots.push(root); return root; };

  it("makes one folder inside the one shown and answers its path, the name trimmed", () => {
    const root = temp();
    expect(createDirectory(root, "  new-one ")).toEqual({ path: join(root, "new-one") });
    expect(statSync(join(root, "new-one")).isDirectory()).toBe(true);
  });

  it("refuses a name that is not one path segment, and makes nothing", () => {
    const root = temp();
    mkdirSync(join(root, "a"));
    for (const name of ["", "  ", ".", "..", "a/b", "../escape", "a\\b", "a\0b", "x".repeat(256)]) {
      expect(createDirectory(root, name)).toEqual({ error: "invalid_name" });
    }
    expect(readdirSync(root)).toEqual(["a"]);
    expect(readdirSync(join(root, "a"))).toEqual([]);
  });

  it("never overwrites, and needs a folder to make it in", () => {
    const root = temp();
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "file"), "");
    expect(createDirectory(root, "taken")).toEqual({ error: "folder_exists" });
    expect(createDirectory(root, "file")).toEqual({ error: "folder_exists" });
    expect(createDirectory(join(root, "file"), "x")).toEqual({ error: "invalid_cwd" });
    expect(createDirectory(join(root, "missing"), "x")).toEqual({ error: "invalid_cwd" });
  });
});
