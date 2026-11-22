import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractedAppDir, othersRunFrom } from "./appimage.ts";

describe("extractedAppDir", () => {
  const dir = "/tmp/appimage_extracted_ee741acd1144844bf97841d03808ecdd";
  const env = { APPIMAGE: "/home/u/Ovis-linux-x64.AppImage", APPDIR: dir, APPIMAGE_EXTRACT_AND_RUN: "1" };

  it("names the folder this AppImage unpacked itself into to run without FUSE", () => {
    expect(extractedAppDir(env, `${dir}/ovis`)).toBe(dir);
    expect(extractedAppDir({ ...env, APPDIR: `${dir}/` }, `${dir}/ovis`)).toBe(dir);
  });

  it("leaves a FUSE mount, a .deb install and another AppImage's folder alone", () => {
    expect(extractedAppDir({ ...env, APPDIR: "/tmp/.mount_OvisAb" }, "/tmp/.mount_OvisAb/ovis")).toBeNull();
    expect(extractedAppDir({}, "/opt/Ovis/ovis")).toBeNull();
    // started from an unpacked AppImage of another program: its APPDIR is not where this one runs
    expect(extractedAppDir(env, "/opt/Ovis/ovis")).toBeNull();
    expect(extractedAppDir({ ...env, APPIMAGE: undefined }, `${dir}/ovis`)).toBeNull();
    expect(extractedAppDir({ ...env, APPDIR: "/tmp/appimage_extracted_x/../home" }, "/tmp/appimage_extracted_x/../home/ovis")).toBeNull();
  });

  it("leaves the folder to the runtime when NO_CLEANUP asks it to keep it", () => {
    expect(extractedAppDir({ ...env, NO_CLEANUP: "1" }, `${dir}/ovis`)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("othersRunFrom", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function proc(processes: Array<{ pid: number; ppid: number; exe: string }>): string {
    const root = mkdtempSync(join(tmpdir(), "ovis-proc-"));
    roots.push(root);
    for (const { pid, ppid, exe } of processes) {
      mkdirSync(join(root, String(pid)));
      symlinkSync(exe, join(root, String(pid), "exe"));
      writeFileSync(join(root, String(pid), "stat"), `${pid} (ovis (x) y) S ${ppid} 1 1 0 -1`);
    }
    mkdirSync(join(root, "self-net"));
    return root;
  }
  const dir = "/tmp/appimage_extracted_ab12";

  it("does not count this app's own processes (its renderers, the GPU process)", () => {
    const root = proc([{ pid: 100, ppid: 1, exe: `${dir}/ovis` }, { pid: 101, ppid: 100, exe: `${dir}/ovis` }, { pid: 102, ppid: 101, exe: `${dir}/ovis` }, { pid: 300, ppid: 1, exe: "/usr/bin/bash" }]);
    expect(othersRunFrom(dir, 100, root)).toBe(false);
  });

  it("sees another copy started from the same unpacked folder", () => {
    const root = proc([{ pid: 100, ppid: 1, exe: `${dir}/ovis` }, { pid: 200, ppid: 1, exe: `${dir}/ovis` }]);
    expect(othersRunFrom(dir, 100, root)).toBe(true);
    const nested = proc([{ pid: 100, ppid: 1, exe: `${dir}/ovis` }, { pid: 200, ppid: 1, exe: "/usr/bin/bash" }, { pid: 201, ppid: 200, exe: `${dir}/resources/ovis/bin/bun` }]);
    expect(othersRunFrom(dir, 100, nested)).toBe(true);
  });
});
