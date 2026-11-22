import { describe, expect, it } from "bun:test";
import { passingFolder, RecentDirectoryStore } from "./recent-directories.ts";

function fixture() {
  const data = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); writes++; },
  };
  return { data, storage, store: new RecentDirectoryStore(() => storage), writes: () => writes };
}

it("keeps folders after every workspace closes and a new store reloads", () => {
  const { store, storage } = fixture();
  store.remember("local", ["/projects/alpha", "/projects/beta"]);
  store.remember("local", []);
  expect(new RecentDirectoryStore(() => storage).read("local")).toEqual(["/projects/alpha", "/projects/beta"]);
});

it("keeps PC histories separate even when folder paths are identical", () => {
  const { store } = fixture();
  store.remember("local", ["/same", "/local-only"]);
  store.remember("remote", ["/same", "/remote-only"]);
  expect(store.read("local")).toEqual(["/same", "/local-only"]);
  expect(store.read("remote")).toEqual(["/same", "/remote-only"]);
});

it("deduplicates equivalent paths while keeping full paths with the same basename distinct", () => {
  const { store } = fixture();
  expect(store.remember("local", ["/one/app/", "/one/app", "/two/app", null, "", "~/app", "relative"])).toEqual([
    "/one/app", "/two/app",
  ]);
  expect(store.remember("windows", ["C:\\work\\app\\", "C:/work/app", "C:\\", "\\\\host\\share\\"])).toEqual([
    "C:/work/app", "C:/", "//host/share",
  ]);
});

it("promotes explicit opens but leaves polling order unchanged without repeated writes", () => {
  const { store, writes } = fixture();
  store.remember("local", ["/alpha", "/beta"]);
  store.remember("local", ["/beta", "/alpha"]);
  expect(writes()).toBe(1);
  expect(store.remember("local", ["/beta"], true)).toEqual(["/beta", "/alpha"]);
  expect(store.remember("local", ["/alpha", "/beta"])).toEqual(["/beta", "/alpha"]);
  expect(writes()).toBe(2);
});

it("puts a folder only seen in a pane behind the ones kept, until a workspace is started there", () => {
  const { store } = fixture();
  store.remember("local", ["/projects/alpha"], true);
  expect(store.remember("local", ["/tmp", "/projects/alpha/node_modules/left-pad"])).toEqual(["/projects/alpha", "/tmp", "/projects/alpha/node_modules/left-pad"]);
  expect(store.remember("local", ["/projects/beta"])).toEqual(["/projects/alpha", "/tmp", "/projects/alpha/node_modules/left-pad", "/projects/beta"]);
  expect(store.remember("local", ["/projects/beta"], true)).toEqual(["/projects/beta", "/projects/alpha", "/tmp", "/projects/alpha/node_modules/left-pad"]);
});

it("does not discard older folders as more projects are opened", () => {
  const { store } = fixture();
  for (let index = 0; index < 50; index++) store.remember("local", [`/project-${index}`], true);
  expect(store.read("local")).toHaveLength(50);
  expect(store.read("local").at(-1)).toBe("/project-0");
});

it("ignores malformed history and invalid entries at the storage boundary", () => {
  const { data, store } = fixture();
  data.set("ovis:recent-directories:local", "{broken");
  expect(store.read("local")).toEqual([]);
  data.set("ovis:recent-directories:local", '{"path":"/wrong-shape"}');
  expect(store.read("local")).toEqual([]);
  data.set("ovis:recent-directories:local", JSON.stringify([null, 1, {}, "/ok/", "/ok", ""]));
  expect(store.read("local")).toEqual(["/ok"]);
});

it("keeps this page's folder history when storage reads and writes are denied", () => {
  const store = new RecentDirectoryStore(() => { throw new Error("Storage denied"); });
  store.remember("local", ["/alpha"]);
  store.remember("local", ["/beta"]);
  expect(store.read("local")).toEqual(["/alpha", "/beta"]);
});

it("does not replace unsaved folders with an older value after a quota failure", () => {
  const store = new RecentDirectoryStore(() => ({
    getItem: () => '["/old"]',
    setItem: () => { throw new Error("Quota exceeded"); },
  }));
  store.remember("local", ["/new"]);
  expect(store.read("local")).toEqual(["/old", "/new"]);
});

describe("passingFolder", () => {
  it("compares a Windows linked root with backslashes to a candidate below it", () => {
    expect(passingFolder("C:\\work\\app-wt\\src", ["C:\\work\\app-wt"])).toBe(true);
    expect(passingFolder("C:/work/app-wt", ["C:\\work\\app-wt\\"])).toBe(true);
    expect(passingFolder("C:/work/app-wt-2", ["C:\\work\\app-wt"])).toBe(false);
  });

  it("leaves out herdr's worktrees, temporary folders and the PC's linked worktrees", () => {
    for (const path of ["/home/me/.herdr/worktrees/app/feat-x", "/home/me/.herdr/worktrees", "/tmp", "/tmp/scratch", "/private/tmp/a",
      "/var/tmp/b", "/var/folders/xy/T/c", "/private/var/folders/xy/T", "C:\\Users\\me\\AppData\\Local\\Temp\\d", "/work/app-wt/src"]) {
      expect(passingFolder(path, ["/work/app-wt"])).toBe(true);
    }
    for (const path of ["/home/me/app", "/home/me/tmpwork", "/srv/tmp-site", "/work/app-wt2", "C:/Users/me/projects/app", "/home/me/.herdr"]) {
      expect(passingFolder(path, ["/work/app-wt"])).toBe(false);
    }
  });
});
