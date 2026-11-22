import { afterEach, describe, expect, it } from "bun:test";
import ts from "typescript-api";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildXtermSource } from "./build-xterm.ts";

const repo = join(import.meta.dir, "..");
const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-build-xterm-test-"));
  made.push(root);
  cpSync(join(repo, "node_modules/@xterm/xterm"), join(root, "node_modules/@xterm/xterm"), { recursive: true, dereference: true });
  return root;
}

const module = "common/services/UnicodeService";
const written = (dir: string): { content: string; ino: bigint; mtimeNs: bigint } => {
  const file = join(dir, `${module}.js`);
  const { ino, mtimeNs } = statSync(file, { bigint: true });
  return { content: readFileSync(file, "utf8"), ino, mtimeNs };
};

describe("buildXtermSource", () => {
  it("hands a later build the finished directory without writing into it again", () => {
    const root = checkout();
    const first = buildXtermSource(root);
    const before = written(first);
    expect(before.content).toContain("export class UnicodeService");
    expect(buildXtermSource(root)).toBe(first);
    expect(written(first)).toEqual(before);
  }, 60_000);

  it("emits changed source into a new directory and leaves the old one as it was", () => {
    const root = checkout();
    const first = buildXtermSource(root);
    const before = written(first);
    appendFileSync(join(root, "node_modules/@xterm/xterm/src", `${module}.ts`), "\nexport const changedForTest = 1;\n");
    const second = buildXtermSource(root);
    expect(second).not.toBe(first);
    expect(written(second).content).toContain("changedForTest");
    expect(written(first)).toEqual(before);
  }, 60_000);

  it("publishes nothing when a module could not be written, so the next build emits it again", () => {
    const root = checkout();
    const cache = join(root, "node_modules/.cache/herdr-xterm");
    const writeFile = ts.sys.writeFile;
    ts.sys.writeFile = (path, ...rest) => {
      if (path.endsWith(`${module}.js`)) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      writeFile(path, ...rest);
    };
    try {
      expect(() => buildXtermSource(root)).toThrow("no space left on device");
    } finally {
      ts.sys.writeFile = writeFile;
    }
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
    expect(written(buildXtermSource(root)).content).toContain("export class UnicodeService");
  }, 60_000);

  it("compiles the source it hashed, even when the file changes while TypeScript reads", () => {
    const root = checkout();
    const file = join(root, "node_modules/@xterm/xterm/src", `${module}.ts`);
    const readFile = ts.sys.readFile;
    ts.sys.readFile = (path, encoding) => {
      ts.sys.readFile = readFile;
      appendFileSync(file, "\nexport const changedForTest = 1;\n");
      return readFile(path, encoding);
    };
    let first: string;
    try {
      first = buildXtermSource(root);
    } finally {
      ts.sys.readFile = readFile;
    }
    expect(written(first).content).not.toContain("changedForTest");
    const second = buildXtermSource(root);
    expect(second).not.toBe(first);
    expect(written(second).content).toContain("changedForTest");
  }, 60_000);

  // through a symlink, imports resolved out of the hashed copy to the disk (macOS's tmpdir is one)
  it("reads none of xterm's package from the disk while compiling, even through a symlinked checkout", () => {
    const linked = join(mkdtempSync(join(tmpdir(), "herdr-build-xterm-link-")), "checkout");
    made.push(dirname(linked));
    symlinkSync(checkout(), linked, "dir");
    const { readFile, fileExists } = ts.sys;
    const fromDisk: string[] = [];
    const xterm = (path: string) => path.replaceAll("\\", "/").includes("/@xterm/xterm/");
    ts.sys.readFile = (path, encoding) => { if (xterm(path)) fromDisk.push(path); return readFile(path, encoding); };
    ts.sys.fileExists = (path) => { if (xterm(path)) fromDisk.push(path); return fileExists(path); };
    try {
      expect(written(buildXtermSource(linked)).content).toContain("export class UnicodeService");
    } finally {
      Object.assign(ts.sys, { readFile, fileExists });
    }
    expect(fromDisk).toEqual([]);
  }, 60_000);

  it("publishes nothing when an emitted module vanishes from the staging directory before the rename", () => {
    const root = checkout();
    const cache = join(root, "node_modules/.cache/herdr-xterm");
    const writeFile = ts.sys.writeFile;
    ts.sys.writeFile = (path, ...rest) => {
      writeFile(path, ...rest);
      if (path.endsWith(`${module}.js`)) rmSync(path);
    };
    try {
      expect(() => buildXtermSource(root)).toThrow("lost");
    } finally {
      ts.sys.writeFile = writeFile;
    }
    expect(readdirSync(cache)).toEqual([]);
  }, 60_000);

  it("emits again when only the manifest's typings entry changes", () => {
    const root = checkout();
    const xterm = join(root, "node_modules/@xterm/xterm");
    cpSync(join(xterm, "typings/xterm.d.ts"), join(xterm, "typings/other.d.ts"));
    const first = buildXtermSource(root);
    const manifest = readFileSync(join(xterm, "package.json"), "utf8");
    expect(manifest).toContain("\"types\": \"typings/xterm.d.ts\"");
    writeFileSync(join(xterm, "package.json"), manifest.replace("typings/xterm.d.ts", "typings/other.d.ts"));
    expect(buildXtermSource(root)).not.toBe(first);
  }, 60_000);

  it("removes the staging directories killed builds left behind, not one a build may still write", () => {
    const root = checkout();
    const cache = join(root, "node_modules/.cache/herdr-xterm");
    const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
    const staging = (pid: number | "", suffix: string, minutesAgo: number) => {
      const name = `0123456789abcdef.tmp-${pid === "" ? "" : `${pid}-`}${suffix}`;
      mkdirSync(join(cache, name), { recursive: true });
      const at = new Date(Date.now() - minutesAgo * 60_000);
      utimesSync(join(cache, name), at, at);
      return name;
    };
    staging(dead, "Ab12Cd", 30);
    staging("", "Xy98Zw", 30);
    const running = staging(process.pid, "Ef34Gh", 30);
    // a dead-looking pid may be a build in another pid namespace: a fresh directory is still in use
    const fresh = staging(dead, "Ij56Kl", 1);
    const output = buildXtermSource(root);
    expect(readdirSync(cache).sort()).toEqual([basename(output), fresh, running].sort());
  }, 60_000);

  it.skipIf(process.platform === "win32")("publishes a build other users of the checkout can read", () => {
    expect(statSync(buildXtermSource(checkout())).mode & 0o777).toBe(0o755);
  }, 60_000);
});
