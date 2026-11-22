import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { privateStateFs } from "./private-state.ts";
import { readStateDocument, setAsideDamaged, writeStateDocument } from "./state-document.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-state-document-")); dirs.push(dir); return dir; };

describe("setAsideDamaged", () => {
  it("moves a file of NULs aside, bytes untouched, under a name a Windows file may have", () => {
    const dir = directory(), path = join(dir, "machines.json");
    const zeros = Buffer.alloc(353);
    writeFileSync(path, zeros);
    expect(readStateDocument(path)).toEqual({ kind: "malformed" });
    const aside = setAsideDamaged(path, new Date("2026-10-26T07:06:23.123Z"));
    expect(basename(aside)).toBe("machines.json.corrupt-2026-10-26T07-06-23-123Z");
    expect(readFileSync(aside)).toEqual(zeros);
    expect(readStateDocument(path)).toEqual({ kind: "missing" });
  });

  it("keeps every damaged copy: a later one never replaces an earlier one", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "first");
    setAsideDamaged(path, new Date("2026-10-24T01:00:00.000Z"));
    writeFileSync(path, "second");
    setAsideDamaged(path, new Date("2026-10-26T01:00:00.000Z"));
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(2);
    expect(kept.map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(["first", "second"]);
  });

  it("never replaces an earlier copy set aside at the same moment", () => {
    const dir = directory(), path = join(dir, "machines.json");
    const now = new Date("2026-10-26T07:06:23.123Z");
    writeFileSync(path, "first");
    const first = setAsideDamaged(path, now);
    writeFileSync(path, "second");
    const second = setAsideDamaged(path, now);
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(readStateDocument(path)).toEqual({ kind: "missing" });
  });

  const withoutLinks = () => spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("no links"), { code: "EPERM" }); });

  it("flushes a copy to disk before the damaged original goes", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const steps: string[] = [];
    const links = withoutLinks();
    const opened = new Map<number, string>();
    const realOpen = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(target, flags, mode);
      opened.set(fd, basename(String(target)));
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => { steps.push(`fsync ${opened.get(fd)}`); });
    const unlink = spyOn(fs, "unlinkSync");
    unlink.mockImplementation(((target: fs.PathLike) => { steps.push(`unlink ${basename(String(target))}`); unlink.mockRestore(); fs.unlinkSync(target); }) as typeof fs.unlinkSync);
    try {
      const aside = setAsideDamaged(path, new Date("2026-10-26T07:06:23.123Z"));
      expect(readFileSync(aside, "utf8")).toBe("damaged");
      const synced = `fsync ${basename(aside)}`;
      expect(steps.indexOf(synced)).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf(synced)).toBeLessThan(steps.indexOf("unlink machines.json"));
    } finally { links.mockRestore(); open.mockRestore(); fsync.mockRestore(); unlink.mockRestore(); }
  });

  it("removes a copy that cannot be flushed, leaving the original where it was", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("I/O error"), { code: "EIO" }); });
    try {
      expect(() => setAsideDamaged(path)).toThrow(/\(EIO\)$/);
      expect(readdirSync(dir)).toEqual(["machines.json"]);
      expect(readFileSync(path, "utf8")).toBe("damaged");
    } finally { fsync.mockRestore(); }
  });

  it("removes a copy that cannot be made private, leaving the original where it was", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const links = withoutLinks();
    const chmod = spyOn(fs, "chmodSync");
    chmod.mockImplementation(((target: fs.PathLike, mode: fs.Mode) => {
      if (String(target).includes(".corrupt-")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    }) as typeof fs.chmodSync);
    try {
      expect(() => setAsideDamaged(path)).toThrow(/\(EACCES\)$/);
      expect(readdirSync(dir)).toEqual(["machines.json"]);
      expect(readFileSync(path, "utf8")).toBe("damaged");
    } finally { links.mockRestore(); chmod.mockRestore(); }
  });

  it("reports why the original could not be removed, even when the spare copy cannot be either", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const unlink = spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    const rm = spyOn(fs, "rmSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    try {
      expect(() => setAsideDamaged(path)).toThrow(/\(EBUSY\)$/);
      expect(readFileSync(path, "utf8")).toBe("damaged");
    } finally { unlink.mockRestore(); rm.mockRestore(); }
  });

  it("throws, naming the file and why, when it cannot be moved", () => {
    const dir = directory();
    expect(() => setAsideDamaged(join(dir, "machines.json"))).toThrow(/^machines\.json is not JSON and cannot be set aside as machines\.json\.corrupt-\S+ \(ENOENT\)$/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("writeStateDocument", () => {
  it("writes through a fresh private file, never through a link left at a guessable name (#3437)", () => {
    const dir = directory(), path = join(dir, "preferences.json"), elsewhere = join(dir, "elsewhere");
    writeFileSync(elsewhere, "", { mode: 0o644 });
    symlinkSync(elsewhere, `${path}.${process.pid}.tmp`);
    writeStateDocument(path, "{\"revision\":1}", false);
    expect(readFileSync(elsewhere, "utf8")).toBe("");
    expect(readFileSync(path, "utf8")).toBe("{\"revision\":1}");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it("flushes the temporary file before the rename and the directory after it (#3437)", () => {
    const dir = directory(), path = join(dir, "usage-removed.json");
    const order: string[] = [];
    const flush = ((fd: number) => { order.push(`fsync ${fs.fstatSync(fd).isDirectory() ? "directory" : "file"}`); }) as never;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(flush);
    const directoryFsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(flush);
    const rename = spyOn(fs, "renameSync");
    rename.mockImplementation(((from: string, to: string) => { order.push("rename"); rename.mockRestore(); fs.renameSync(from, to); }) as never);
    try { writeStateDocument(path, "[]", false); }
    finally { fsync.mockRestore(); directoryFsync.mockRestore(); rename.mockRestore(); }
    expect(order).toEqual(process.platform === "win32" ? ["fsync file", "rename"] : ["fsync file", "rename", "fsync directory"]);
    expect(readFileSync(path, "utf8")).toBe("[]");
  });

  it.each([
    ["the write", "writeFileSync", "ENOSPC"],
    ["the flush", "fsyncSync", "EIO"],
    ["the rename", "renameSync", "EIO"],
    ["the close", "closeSync", "EIO"],
  ] as const)("leaves no temporary file when %s fails (#3437)", (_name, call, code) => {
    const dir = directory(), path = join(dir, "seen.json");
    const spy = spyOn(fs, call).mockImplementation((() => { throw Object.assign(new Error(code), { code }); }) as never);
    try { expect(() => writeStateDocument(path, "[]", false)).toThrow(code); }
    finally { spy.mockRestore(); }
    expect(readdirSync(dir)).toEqual([]);
  });
});
