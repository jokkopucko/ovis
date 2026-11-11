import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { win32 } from "node:path";
import { expandedDirectory, expandedPath, resolveFolder } from "./directories.ts";
import { resolveFilePath } from "./file-view.ts";
import { notePaneFolders, otherHostsShare } from "./windows-share.ts";

afterEach(() => notePaneFolders([]));

const HOME = "C:\\Users\\me";

describe("a network share on a Windows PC", () => {
  it("is the PC's own to read once one of its panes works on it, whichever route asks", () => {
    // the folder browser, a folder's skills and a workspace's icon name no pane: before a pane is known to work there,
    // the share is another host's
    const asked = "\\\\nas\\work\\proj\\docs";
    expect(otherHostsShare(asked, [])).toBe(true);
    expect(resolveFolder(asked, HOME, undefined, win32)).toBeNull();
    expect(resolveFilePath(`${asked}\\a.md`, null, win32, HOME)).toBeNull();
    expect(expandedPath(asked, [], win32, HOME)).toBeNull();
    // herdr's snapshot names a pane in a folder on that share, as herdr writes it or with the other slashes
    for (const folder of ["\\\\nas\\work\\proj", "//NAS/Work/proj"]) {
      notePaneFolders(["C:\\code", null, undefined, folder]);
      expect(otherHostsShare(asked, []), folder).toBe(false);
      expect(resolveFolder(asked, HOME, undefined, win32), folder).toBe(asked);
      expect(resolveFolder("//nas/work/other", HOME, undefined, win32), folder).toBe("\\\\nas\\work\\other");
      expect(resolveFilePath(`${asked}\\a.md`, null, win32, HOME), folder).toBe(`${asked}\\a.md`);
      expect(expandedPath(asked, [], win32, HOME), folder).toBe(asked);
      // another share of that host, and another host, are not
      for (const other of ["\\\\nas\\private\\a", "\\\\nas2\\work\\a", "\\\\?\\UNC\\nas\\private\\a", "\\\\.\\UNC\\nas\\work\\a", "\\\\?\\GLOBALROOT\\Device\\Mup\\nas\\work\\a"]) expect(otherHostsShare(other, []), other).toBe(true);
      notePaneFolders([]);
    }
    // a pane's folder told in the long form of a share is that share
    notePaneFolders(["\\\\?\\UNC\\nas\\work\\proj"]);
    expect(otherHostsShare(asked, [])).toBe(false);
    expect(otherHostsShare("\\\\?\\UNC\\nas\\work\\proj\\a.md", [])).toBe(false);
    expect(otherHostsShare("\\\\?\\UNC\\nas\\private\\a.md", [])).toBe(true);
    expect(otherHostsShare("\\\\?\\UNC\\wsl$\\Ubuntu\\a.md", [])).toBe(false);
    notePaneFolders([]);
    expect(otherHostsShare("\\\\?\\UNC\\nas\\work\\proj\\a.md", [])).toBe(true);
    expect(otherHostsShare("\\\\?\\UNC\\nas\\work\\proj\\a.md", ["\\\\?\\UNC\\nas\\work\\proj"])).toBe(false);
    expect(resolveFilePath("a.md", "\\\\?\\UNC\\nas\\work\\proj", win32, HOME)).toBe("\\\\?\\UNC\\nas\\work\\proj\\a.md");
    // the pane left: the next snapshot names no folder there
    notePaneFolders(["\\\\nas\\work\\proj"]);
    notePaneFolders(["C:\\code"]);
    expect(otherHostsShare(asked, [])).toBe(true);
  });
});

// the New workspace dialog asks for a folder's skills by itself, 300 ms after it opens with the folder an address
// named (`?new=workspace&cwd=//host/share&agent=claude`), and the repository routes read a folder the page names
describe("a folder a route is asked to read", () => {
  const windows = (value: string, own: ReadonlyArray<string | null> | "chosen" = []) => expandedPath(value, own, win32, HOME);
  it("is no other host's share on a Windows PC, however it is written", () => {
    for (const share of ["//host/share", "\\\\host\\share\\repo", "~///host/share", "/\\host/share", "\\\\?\\UNC\\host\\share", "\\\\wsl$evil\\share"]) expect(windows(share), share).toBeNull();
    expect(windows("C:\\code\\repo")).toBe("C:\\code\\repo");
    expect(windows("~")).toBe(HOME);
    expect(windows("~/code")).toBe("C:\\Users\\me\\code");
    expect(windows("\\\\wsl$\\Ubuntu\\home\\u")).toBe("\\\\wsl$\\Ubuntu\\home\\u");
    // the pane a repository route names works on its own share
    expect(windows("\\\\nas\\work\\proj\\sub", ["\\\\nas\\work\\proj"])).toBe("\\\\nas\\work\\proj\\sub");
    expect(windows("\\\\nas\\private", ["\\\\nas\\work\\proj"])).toBeNull();
    // a home folder kept on a share: that share is the PC's own
    const onShare = "\\\\files\\users\\me";
    expect(expandedPath("~/code", [], win32, onShare)).toBe("\\\\files\\users\\me\\code");
    expect(expandedPath("\\\\files\\users\\other", [], win32, onShare)).toBe("\\\\files\\users\\other");
    expect(expandedPath("\\\\files\\projects", [], win32, onShare)).toBeNull();
    // and so is the share the server itself was started from, for a path written without a drive
    const started = { resolve: (...parts: string[]) => win32.resolve("\\\\srv\\apps\\ovis", ...parts), sep: win32.sep };
    expect(expandedPath("proj", [], started, HOME)).toBe("\\\\srv\\apps\\ovis\\proj");
    expect(expandedPath("/code", [], started, HOME)).toBe("\\\\srv\\apps\\code");
    expect(expandedPath("\\\\srv\\other\\x", [], started, HOME)).toBeNull();
  });
  it("is not read at all when it is another host's share: the refusal comes before the filesystem is asked", () => {
    const stat = spyOn(fs, "statSync");
    try {
      expect(expandedDirectory("//host/share", [], win32, HOME)).toBeNull();
      expect(expandedDirectory("//host/share", ["\\\\nas\\work\\proj"], win32, HOME)).toBeNull();
      expect(stat.mock.calls).toEqual([]);
      // one the user chose, and one on its pane's own share, are asked of the filesystem (which has neither here)
      expect(expandedDirectory("//host/share", "chosen", win32, HOME)).toBeNull();
      expect(expandedDirectory("//nas/work/other", ["\\\\nas\\work\\proj"], win32, HOME)).toBeNull();
      expect(stat.mock.calls.map(([path]) => path)).toEqual(["\\\\host\\share\\", "\\\\nas\\work\\other"]);
    } finally { stat.mockRestore(); }
  });

  it("is any folder the user chose and sees: a workspace is made on a share by naming it", () => {
    expect(windows("//nas/work/proj", "chosen")).toBe("\\\\nas\\work\\proj");
    expect(windows("~/code", "chosen")).toBe("C:\\Users\\me\\code");
  });
  it("is the local folder on this system, as before", () => {
    if (process.platform !== "win32") expect(expandedPath("//host/share")).toBe("/host/share");
  });
});
