import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DeviceStore } from "./devices.ts";
import { mergeSiblingState, siblingStateDir } from "./state-merge.ts";
import { adoptLegacyDir, defaultStateDir, linkLegacyRegistry, moveLegacyStateDir, releaseIn, updateStateDir } from "./update-state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const configHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ovis-state-dir-"));
  roots.push(root);
  return root;
};
const withDevices = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "devices.json"), "{\"paired\":1}");
  return dir;
};
const withRegistry = (dir: string): string => {
  mkdirSync(join(dir, "bridges", "remote.json.state"), { recursive: true });
  writeFileSync(join(dir, "bridges", "local.json"), "{\"port\":7317}");
  writeFileSync(join(dir, "bridges", "local.json.guard"), "");
  writeFileSync(join(dir, "bridges", "remote.json.state", "devices.json"), "{\"remote\":1}");
  return dir;
};

describe("the state dir from before the rename", () => {
  it("keeps an installed supervisor on its checkout and port's state when both names hold files", () => {
    const config = configHome();
    const root = join(config, "checkout");
    const next = withDevices(join(config, "ovis"));
    const legacy = withDevices(join(config, "herdr-web-ui"));
    writeFileSync(join(legacy, "devices.json"), "{\"paired\":2}");
    const port = 7317;
    const directory = join(updateStateDir(root, port, next), "release-next");
    mkdirSync(directory, { recursive: true });
    const supervisor = { root, port, directory };
    expect(defaultStateDir({ XDG_CONFIG_HOME: config }, supervisor)).toBe(next);
    moveLegacyStateDir({ XDG_CONFIG_HOME: config }, supervisor);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "devices.json"), "utf8")).toBe("{\"paired\":2}");
    expect(defaultStateDir({ XDG_CONFIG_HOME: config }, { ...supervisor, port: port + 1 })).toBe(legacy);
    expect(defaultStateDir({ XDG_CONFIG_HOME: config }, { ...supervisor, root: join(config, "other") })).toBe(legacy);
    expect(defaultStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: "/srv/ovis" }, supervisor)).toBe("/srv/ovis");
  });

  it("is not the state when it holds only the bridge registry, and is linked to the new dir for older launchers", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(next);
    moveLegacyStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: next });
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(realpathSync(legacy)).toBe(realpathSync(next));
    expect(readFileSync(join(legacy, "bridges", "local.json"), "utf8")).toBe("{\"port\":7317}");
    expect(readFileSync(join(next, "bridges", "remote.json.state", "devices.json"), "utf8")).toBe("{\"remote\":1}");
    expect(readFileSync(join(next, "devices.json"), "utf8")).toBe("{\"paired\":1}");
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(next);
  });

  it("joins a registry left in the new dir by a link that did not finish, the old name's files winning", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    mkdirSync(join(next, "bridges"));
    writeFileSync(join(next, "bridges", "local.json"), "{\"port\":1}");
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    adoptLegacyDir(legacy, next);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(next, "bridges", "local.json"), "utf8")).toBe("{\"port\":7317}");
    expect(readFileSync(join(next, "bridges", "remote.json.state", "devices.json"), "utf8")).toBe("{\"remote\":1}");
  });

  it("is left alone by a process told to use a dir apart from the default ones", () => {
    const config = configHome();
    withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    moveLegacyStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: join(config, "elsewhere") });
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "bridges", "local.json"), "utf8")).toBe("{\"port\":7317}");
  });

  it("moves nothing where the link cannot be made", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    const denied = spyOn(fs, "symlinkSync").mockImplementation(() => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { linkLegacyRegistry(legacy, next); } finally { denied.mockRestore(); said.mockRestore(); }
    // the old dir is still there with its registry, where the server merge leaves a closed copy of the devices
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "bridges", "local.json"), "utf8")).toBe("{\"port\":7317}");
    expect(existsSync(join(next, "bridges"))).toBe(false);
  });

  it("keeps the old name a dir of its own when the link cannot take it at the end", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    const rename = fs.renameSync;
    const denied = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === legacy) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      rename(from, to);
    });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { linkLegacyRegistry(legacy, next); } finally { denied.mockRestore(); said.mockRestore(); }
    // still there, empty, so the server's merge finds it (and leaves its closed copy of the devices in it)
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(fs.readdirSync(legacy)).toEqual([]);
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(next);
    expect(fs.readdirSync(config).filter((entry) => entry.includes(".link-"))).toEqual([]);
    // the server's merge then finds it, and a bridge registering there after it leaves it gated
    const sibling = siblingStateDir(next, { XDG_CONFIG_HOME: config });
    expect(sibling).toBe(legacy);
    writeFileSync(join(next, "devices.json"), JSON.stringify({ gate_closed_at: "2026-10-25T05:20:00.000Z", devices: [] }));
    mergeSiblingState(next, sibling!);
    withRegistry(legacy);
    expect(new DeviceStore(legacy).gated).toBe(true);
  });

  it("finishes a link that a process made and stopped before it took the old name", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    mkdirSync(join(next, "bridges"));
    const legacy = join(config, "herdr-web-ui");
    // left by a process that is gone: no pid that high runs
    symlinkSync(next, `${legacy}.link-999999999`);
    linkLegacyRegistry(legacy, next);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(realpathSync(legacy)).toBe(realpathSync(next));
    expect(existsSync(`${legacy}.link-999999999`)).toBe(false);
  });

  it("keeps the old name a dir of its own when an interrupted link cannot take it either", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    writeFileSync(join(next, "devices.json"), JSON.stringify({ gate_closed_at: "2026-10-25T05:20:00.000Z", devices: [] }));
    mkdirSync(join(next, "bridges"));
    const legacy = join(config, "herdr-web-ui");
    symlinkSync(next, `${legacy}.link-999999999`);
    const rename = fs.renameSync;
    const denied = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === legacy) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      rename(from, to);
    });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { linkLegacyRegistry(legacy, next); } finally { denied.mockRestore(); said.mockRestore(); }
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(next);
    // the server's merge finds it, and a bridge registering there after it leaves it gated
    const sibling = siblingStateDir(next, { XDG_CONFIG_HOME: config });
    expect(sibling).toBe(legacy);
    mergeSiblingState(next, sibling!);
    withRegistry(legacy);
    expect(new DeviceStore(legacy).gated).toBe(true);
  });

  it("waits while a bridge registered under the old name runs", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    writeFileSync(join(legacy, "bridges", "remote.json"), JSON.stringify({ pid: process.ppid }));
    linkLegacyRegistry(legacy, next);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "bridges", "remote.json.state", "devices.json"), "utf8")).toBe("{\"remote\":1}");
  });

  it("takes in what a writer put back under the old name while the registry moved", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    const rename = fs.renameSync;
    const writer = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (from === join(legacy, "bridges") && to === join(next, "bridges")) {
        mkdirSync(join(legacy, "bridges", "remote.json.state"), { recursive: true });
        writeFileSync(join(legacy, "bridges", "remote.json.state", "devices.json"), "{\"renamed\":1}");
      }
    });
    try { linkLegacyRegistry(legacy, next); } finally { writer.mockRestore(); }
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(next, "bridges", "remote.json.state", "devices.json"), "utf8")).toBe("{\"renamed\":1}");
  });

  it("merges a bridge's state dir held under both names by a move that did not finish", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    mkdirSync(join(next, "bridges", "remote.json.state"), { recursive: true });
    writeFileSync(join(next, "bridges", "remote.json.state", "preferences.json"), "{\"language\":\"ko\"}");
    const legacy = join(config, "herdr-web-ui");
    mkdirSync(join(legacy, "bridges", "remote.json.state"), { recursive: true });
    writeFileSync(join(legacy, "bridges", "remote.json.state", "devices.json"), "{\"renamed\":1}");
    linkLegacyRegistry(legacy, next);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(next, "bridges", "remote.json.state", "preferences.json"), "utf8")).toBe("{\"language\":\"ko\"}");
    expect(readFileSync(join(next, "bridges", "remote.json.state", "devices.json"), "utf8")).toBe("{\"renamed\":1}");
  });

  it("is linked when it holds only the merge's copies of the new dir's files and its backups", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    writeFileSync(join(next, "state-merge.json"), "{\"seq\":2}");
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    for (const name of ["devices.json", "state-merge.json"]) writeFileSync(join(legacy, name), readFileSync(join(next, name)));
    mkdirSync(join(legacy, "state-merge-backups", "t0"), { recursive: true });
    writeFileSync(join(legacy, "state-merge-backups", "t0", "devices.json"), "{\"before\":1}");
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(next);
    linkLegacyRegistry(legacy, next);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(next, "state-merge-backups", "t0", "devices.json"), "utf8")).toBe("{\"before\":1}");
    expect(readFileSync(join(next, "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("stays a dir of its own while a copy differs from the new dir's file", () => {
    const config = configHome();
    const next = withDevices(join(config, "ovis"));
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    writeFileSync(join(legacy, "devices.json"), "{\"paired\":2}");
    linkLegacyRegistry(legacy, next);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "devices.json"), "utf8")).toBe("{\"paired\":2}");
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(legacy);
  });

  it("leaves the registry alone without a new dir, under OVIS_STATE_DIR", () => {
    const config = configHome();
    const legacy = withRegistry(join(config, "herdr-web-ui"));
    moveLegacyStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: "/srv/ovis" });
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(existsSync(join(config, "ovis"))).toBe(false);
  });

  it("stays where it is until its owner moves it, so resolving the dir never moves anything", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
    expect(existsSync(join(config, "ovis"))).toBe(false);
  });

  it("moves to its new name, leaving a link at the old name, and a second move changes nothing", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(readFileSync(join(config, "ovis", "devices.json"), "utf8")).toBe("{\"paired\":1}");
    expect(lstatSync(join(config, "herdr-web-ui")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(config, "herdr-web-ui", "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("is followed when it is a link to state kept elsewhere", () => {
    const config = configHome();
    const elsewhere = withDevices(join(config, "elsewhere"));
    symlinkSync(elsewhere, join(config, "herdr-web-ui"));
    expect(readFileSync(join(defaultStateDir({ XDG_CONFIG_HOME: config }), "devices.json"), "utf8")).toBe("{\"paired\":1}");
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(readFileSync(join(defaultStateDir({ XDG_CONFIG_HOME: config }), "devices.json"), "utf8")).toBe("{\"paired\":1}");
    expect(readFileSync(join(elsewhere, "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("is not left behind for an empty new dir", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    mkdirSync(join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(readFileSync(join(defaultStateDir({ XDG_CONFIG_HOME: config }), "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("stays in use, and says so, when the new dir already holds other files", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    mkdirSync(join(config, "ovis"));
    writeFileSync(join(config, "ovis", "other.json"), "{}");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
      expect(said).toHaveBeenCalledTimes(1);
    } finally { said.mockRestore(); }
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
  });

  it("is not created for a fresh install", () => {
    const config = configHome();
    adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(existsSync(join(config, "herdr-web-ui"))).toBe(false);
  });

  it("is moved once per process, and not at all under OVIS_STATE_DIR", () => {
    const [skipped, first, later] = [configHome(), configHome(), configHome()];
    for (const config of [skipped, first, later]) withDevices(join(config, "herdr-web-ui"));
    moveLegacyStateDir({ XDG_CONFIG_HOME: skipped, OVIS_STATE_DIR: "/srv/ovis" });
    moveLegacyStateDir({ XDG_CONFIG_HOME: first });
    moveLegacyStateDir({ XDG_CONFIG_HOME: later });
    expect(lstatSync(join(skipped, "herdr-web-ui")).isDirectory()).toBe(true);
    expect(lstatSync(join(first, "herdr-web-ui")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(later, "herdr-web-ui")).isDirectory()).toBe(true);
  });

  it("gives way to OVIS_STATE_DIR", () => {
    const config = configHome();
    withDevices(join(config, "herdr-web-ui"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: "/srv/ovis" })).toBe("/srv/ovis");
  });
});

describe("a state dir reached through a symlink", () => {
  // $HOME as /home/<user> -> /data00/home/<user>: the launcher names the state dir through the
  // link, and Bun runs the installed release's supervisor from the real path (#2029)
  it("is named by an installed release's supervisor as the launcher names it", () => {
    const base = realpathSync(configHome());
    const volume = join(base, "volume", "home");
    mkdirSync(volume, { recursive: true });
    const home = join(base, "home");
    symlinkSync(volume, home);
    const config = join(home, ".config");
    const next = join(config, "ovis");
    const root = join(base, "checkout");
    const port = 7317;
    const release = join(updateStateDir(root, port, next), "release-next");
    mkdirSync(release, { recursive: true });
    // what the release's supervisor gets from import.meta.dir
    const directory = realpathSync(release);
    expect(directory).not.toBe(release);
    expect(defaultStateDir({ XDG_CONFIG_HOME: config }, { root, port, directory })).toBe(next);
  });

  it("holds a release recorded under either of its names, named as the state dir is", () => {
    const base = realpathSync(configHome());
    const state = join(base, "volume", "state");
    mkdirSync(join(state, "release-a"), { recursive: true });
    const linked = join(base, "state");
    symlinkSync(state, linked);
    expect(releaseIn(linked, join(state, "release-a"))).toBe(join(linked, "release-a"));
    expect(releaseIn(state, join(linked, "release-a"))).toBe(join(state, "release-a"));
    expect(releaseIn(state, join(state, "release-a"))).toBe(join(state, "release-a"));
  });

  it("holds no directory outside it, however the recorded name reaches it", () => {
    const base = realpathSync(configHome());
    const state = join(base, "state");
    const outside = join(base, "outside");
    for (const dir of [join(state, "release-good"), join(outside, "release-good"), join(outside, "child"), join(`${state}-other`, "release-x")]) mkdirSync(dir, { recursive: true });
    // a release-* name that links outside
    symlinkSync(join(outside, "release-good"), join(state, "release-link"));
    expect(releaseIn(state, join(state, "release-link"))).toBeNull();
    // a link and then `..`: a process started there runs in outside/release-good, not state/release-good
    symlinkSync(join(outside, "child"), join(state, "alias"));
    expect(releaseIn(state, [state, "alias", "..", "release-good"].join(sep))).toBeNull();
    expect(releaseIn(state, [state, ".", "release-good"].join(sep))).toBeNull();
    expect(releaseIn(state, relative(process.cwd(), join(state, "release-good")))).toBeNull();
    expect(releaseIn(state, join(`${state}-other`, "release-x"))).toBeNull();
    expect(releaseIn(state, join(state, "release-missing"))).toBeNull();
    expect(releaseIn(state, join(state, "release-good"))).toBe(join(state, "release-good"));
  });
});
