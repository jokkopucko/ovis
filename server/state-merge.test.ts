import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { DeviceStore, type StoredDevice } from "./devices.ts";
import { PreferenceStore } from "./preferences.ts";
import { privateStateFs, writePrivateState } from "./private-state.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";
import { createPushService, PUSH_EXTRA_KEYS } from "./push.ts";
import { mergeSiblingState, siblingStateDir } from "./state-merge.ts";

const roots: string[] = [];
const fakes: FakePushService[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The two state dirs of one install: `active` is the one the server runs on. */
function install(): { root: string; active: string; sibling: string } {
  const root = mkdtempSync(join(tmpdir(), "ovis-state-merge-"));
  roots.push(root);
  const active = join(root, "herdr-web-ui");
  const sibling = join(root, "ovis");
  mkdirSync(active);
  mkdirSync(sibling);
  return { root, active, sibling };
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const device = (id: string, created = "2026-10-25T05:20:00.000Z"): StoredDevice =>
  ({ id: id.padStart(16, "0"), label: `Phone ${id}`, role: "drive", token_hash: hash(`token-${id}`), created_at: created, last_seen_at: null });
const writeDevices = (dir: string, devices: StoredDevice[], gate: string | null = devices[0]?.created_at ?? null) =>
  writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: gate, devices }), { mode: 0o600 });
const registry = (dir: string) => JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: StoredDevice[] };
/** Runs a merge in a process that ends (77), as a crash or a power loss would, right before or after a rename onto `at`. */
async function crashAt(root: string, active: string, sibling: string, at: string, when: "before" | "after"): Promise<number> {
  const script = join(root, `crash-${when}.ts`);
  writeFileSync(script, `
    import { privateStateFs } from ${JSON.stringify(join(import.meta.dir, "private-state.ts"))};
    import { mergeSiblingState } from ${JSON.stringify(join(import.meta.dir, "state-merge.ts"))};
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = ((from: string, to: string) => {
      if (to === ${JSON.stringify(at)} && ${JSON.stringify(when)} === "before") process.exit(77);
      rename(from, to);
      if (to === ${JSON.stringify(at)}) process.exit(77);
    }) as typeof rename;
    mergeSiblingState(${JSON.stringify(active)}, ${JSON.stringify(sibling)});
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
  return child.exited;
}
const ids = (dir: string) => registry(dir).devices.map((held) => held.id.replace(/^0+/, "")).sort();
const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 6, minute));
const writeJson = (path: string, value: unknown, mtime?: Date) => {
  writeFileSync(path, JSON.stringify(value));
  if (mtime) utimesSync(path, mtime, mtime);
};

describe("paired devices of the install's other state dir", () => {
  it("are all kept at the first merge, the gate closed from the earliest evidence, both dirs ending alike", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a", "2026-10-25T05:22:00.000Z")]);
    writeDevices(sibling, [device("b")], "2026-10-25T05:19:00.000Z");
    const before = readFileSync(join(active, "devices.json"), "utf8");
    expect(mergeSiblingState(active, sibling, at(0)).devicesBlocked).toBeNull();
    expect(ids(active)).toEqual(["a", "b"]);
    expect(registry(active)).toEqual(registry(sibling));
    expect(registry(active).gate_closed_at).toBe("2026-10-25T05:19:00.000Z");
    // the device paired in the other dir gets in with its own cookie
    expect(new DeviceStore(active).match("token-b")?.id).toBe(device("b").id);
    const [backup] = readdirSync(join(active, "state-merge-backups"));
    expect(readFileSync(join(active, "state-merge-backups", backup!, "devices.json"), "utf8")).toBe(before);
  });

  it("keep the narrower role of a device whose credential differs between the dirs", () => {
    const { active, sibling } = install();
    writeDevices(active, [{ ...device("a"), last_seen_at: "2026-10-25T05:30:00.000Z" }]);
    writeDevices(sibling, [{ ...device("a", "2026-10-25T05:10:00.000Z"), role: "watch", token_hash: hash("another"), last_seen_at: "2026-10-25T05:40:00.000Z" }]);
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(0)); } finally { said.mockRestore(); }
    const [held] = registry(active).devices;
    expect(held).toMatchObject({ role: "watch", token_hash: hash("token-a"), created_at: "2026-10-25T05:10:00.000Z", last_seen_at: "2026-10-25T05:40:00.000Z" });
  });

  it("keep the gate closed when both registries are gone after a merge that knew them", () => {
    for (const paired of [[device("a")], []]) {
      const { active, sibling } = install();
      // a paired install, and one whose every device was revoked (its gate stays closed)
      writeDevices(active, paired, "2026-10-25T05:19:00.000Z");
      mergeSiblingState(active, sibling, at(0));
      for (const dir of [active, sibling]) rmSync(join(dir, "devices.json"));
      const said = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { devicesBlocked } = mergeSiblingState(active, sibling, at(1));
        expect(devicesBlocked).not.toBeNull();
        expect(new DeviceStore(active, devicesBlocked).gated).toBe(true);
      } finally { said.mockRestore(); }
      // and for a release before this one, on disk
      expect(new DeviceStore(active).gated).toBe(true);
    }
  });

  it("keep the gate closed when the other dir holds only the evidence that it was", () => {
    const { active, sibling } = install();
    writeDevices(sibling, [], "2026-10-25T05:19:00.000Z");
    mergeSiblingState(active, sibling, at(0));
    expect(new DeviceStore(active).gated).toBe(true);
  });

  it("stay revoked on either side, and paired on either side, after the last merge", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("b")]);
    mergeSiblingState(active, sibling, at(0));
    // revoked here and paired here; revoked there and paired there, by a release reading that dir
    writeDevices(active, [device("b"), device("d")], registry(active).gate_closed_at);
    writeDevices(sibling, [device("a"), device("c")], registry(sibling).gate_closed_at);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["c", "d"]);
    expect(ids(sibling)).toEqual(["c", "d"]);
  });

  it("are not taken for revoked where the other dir never got them", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("b")]);
    const rename = privateStateFs.renameSync;
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(sibling, "devices.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      rename(from, to);
    });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(0)); } finally { failing.mockRestore(); said.mockRestore(); }
    expect(ids(sibling)).toEqual(["b"]);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["a", "b"]);
    expect(ids(sibling)).toEqual(["a", "b"]);
  });

  it("stay revoked after a merge that could not write the other dir", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a"), device("b")]);
    writeDevices(sibling, [device("a"), device("b")]);
    mergeSiblingState(active, sibling, at(0));
    writeDevices(active, [device("a")], registry(active).gate_closed_at);
    const rename = privateStateFs.renameSync;
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(sibling, "devices.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      rename(from, to);
    });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(1)); } finally { failing.mockRestore(); said.mockRestore(); }
    mergeSiblingState(active, sibling, at(2));
    expect(ids(active)).toEqual(["a"]);
    expect(ids(sibling)).toEqual(["a"]);
  });

  it("leave a closed gate in the other dir when it could not take them, or keep this store gated", () => {
    for (const failures of [1, Infinity]) {
      const { active, sibling } = install();
      writeDevices(active, [device("a")]);
      let left = failures;
      const rename = privateStateFs.renameSync;
      const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
        if (to === join(sibling, "devices.json") && left-- > 0) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        rename(from, to);
      });
      const said = spyOn(console, "error").mockImplementation(() => {});
      let blocked: string | null;
      try { blocked = mergeSiblingState(active, sibling, at(0)).devicesBlocked; } finally { failing.mockRestore(); said.mockRestore(); }
      if (failures === 1) {
        // the copy failed, the closed placeholder did not: a release before this one on that dir is gated
        expect(blocked).toBeNull();
        expect(new DeviceStore(sibling).gated).toBe(true);
      } else {
        // nothing could be written there: this server says so and stays gated
        expect(blocked).toContain(sibling);
        expect(new DeviceStore(active, blocked).gated).toBe(true);
      }
    }
  });

  it("stay revoked after a first merge that could not write the other dir", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("b")]);
    const rename = privateStateFs.renameSync;
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(sibling, "devices.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      rename(from, to);
    });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(0)); } finally { failing.mockRestore(); said.mockRestore(); }
    expect(new DeviceStore(active).revoke(device("b").id)).toBe(true);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["a"]);
    expect(ids(sibling)).toEqual(["a"]);
  });

  it("are kept when the gate closed over a missing registry, once the other dir is repaired", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("a")]);
    mergeSiblingState(active, sibling, at(0));
    const repaired = readFileSync(join(sibling, "devices.json"), "utf8");
    rmSync(join(active, "devices.json"));
    writeFileSync(join(sibling, "devices.json"), "{ not json");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { expect(mergeSiblingState(active, sibling, at(1)).devicesBlocked).not.toBeNull(); } finally { said.mockRestore(); }
    expect(new DeviceStore(active).gated).toBe(true);
    writeFileSync(join(sibling, "devices.json"), repaired);
    mergeSiblingState(active, sibling, at(2));
    expect(ids(active)).toEqual(["a"]);
    expect(ids(sibling)).toEqual(["a"]);
  });

  it("keep the gate closed by a placeholder in the other dir, whatever this dir holds", () => {
    for (const mine of [null, { gate_closed_at: null, devices: [] }]) {
      const { active, sibling } = install();
      // written where a failed merge closed the gate, before the install switched dirs
      writeJson(join(sibling, "devices.json"), { gate_closed_at: "2026-10-25T05:19:00.000Z", devices: [], placeholder: true });
      if (mine) writeJson(join(active, "devices.json"), mine);
      expect(mergeSiblingState(active, sibling, at(0)).devicesBlocked).toBeNull();
      expect(new DeviceStore(active).gated).toBe(true);
      expect(new DeviceStore(sibling).gated).toBe(true);
    }
  });

  it("are kept when a release before this one saved over the placeholder before the other dir was repaired", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("x")]);
    writeDevices(sibling, [device("x")]);
    mergeSiblingState(active, sibling, at(0));
    const repaired = readFileSync(join(sibling, "devices.json"), "utf8");
    rmSync(join(active, "devices.json"));
    writeFileSync(join(sibling, "devices.json"), "{ not json");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(1)); } finally { said.mockRestore(); }
    // an older release pairs y on the placeholder and saves the registry its own way, without the mark
    writeDevices(active, [device("y")], "2026-10-25T06:00:00.000Z");
    writeFileSync(join(sibling, "devices.json"), repaired);
    mergeSiblingState(active, sibling, at(2));
    expect(ids(active)).toEqual(["x", "y"]);
    expect(ids(sibling)).toEqual(["x", "y"]);
  });

  it("stay revoked when the merge crashed after publishing the registries, before its record", async () => {
    const { root, active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("b")]);
    // a process that ends the moment the second registry is in place, as a crash or a power loss would
    const script = join(root, "crash.ts");
    writeFileSync(script, `
      import { privateStateFs } from ${JSON.stringify(join(import.meta.dir, "private-state.ts"))};
      import { mergeSiblingState } from ${JSON.stringify(join(import.meta.dir, "state-merge.ts"))};
      const rename = privateStateFs.renameSync;
      privateStateFs.renameSync = ((from: string, to: string) => { rename(from, to); if (to === ${JSON.stringify(join(sibling, "devices.json"))}) process.exit(77); }) as typeof rename;
      mergeSiblingState(${JSON.stringify(active)}, ${JSON.stringify(sibling)});
    `);
    const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(77);
    expect(ids(sibling)).toEqual(["a", "b"]);
    // a release before this one, on the active dir, revokes b
    expect(new DeviceStore(active).revoke(device("b").id)).toBe(true);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["a"]);
    expect(ids(sibling)).toEqual(["a"]);
    expect(new DeviceStore(active).match("token-b")).toBeNull();
  });

  it("stay as they were when the merge crashed before publishing anything", async () => {
    const { root, active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("b")]);
    const script = join(root, "crash.ts");
    writeFileSync(script, `
      import { privateStateFs } from ${JSON.stringify(join(import.meta.dir, "private-state.ts"))};
      import { mergeSiblingState } from ${JSON.stringify(join(import.meta.dir, "state-merge.ts"))};
      const rename = privateStateFs.renameSync;
      privateStateFs.renameSync = ((from: string, to: string) => { if (to === ${JSON.stringify(join(active, "devices.json"))}) process.exit(77); rename(from, to); }) as typeof rename;
      mergeSiblingState(${JSON.stringify(active)}, ${JSON.stringify(sibling)});
    `);
    const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(77);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["a", "b"]);
    expect(ids(sibling)).toEqual(["a", "b"]);
  });

  it("stay revoked when the merge crashed after publishing, and the revocation left the registry's first bytes", async () => {
    const { root, active, sibling } = install();
    // written as the store writes them, so revoking the device the merge brought gives back the same bytes
    writePrivateState(join(active, "devices.json"), { gate_closed_at: "2026-10-25T05:20:00.000Z", devices: [device("a")] });
    writePrivateState(join(sibling, "devices.json"), { gate_closed_at: "2026-10-25T05:20:00.000Z", devices: [device("b")] });
    const original = readFileSync(join(active, "devices.json"), "utf8");
    expect(await crashAt(root, active, sibling, join(sibling, "devices.json"), "after")).toBe(77);
    expect(new DeviceStore(active).revoke(device("b").id)).toBe(true);
    expect(readFileSync(join(active, "devices.json"), "utf8")).toBe(original);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["a"]);
    expect(new DeviceStore(active).match("token-b")).toBeNull();
  });

  it("keep a device paired when the merge crashed before publishing, and an older release then saved a sighting", async () => {
    const { root, active, sibling } = install();
    writePrivateState(join(active, "devices.json"), { gate_closed_at: "2026-10-25T05:20:00.000Z", devices: [device("a")] });
    writePrivateState(join(sibling, "devices.json"), { gate_closed_at: "2026-10-25T05:20:00.000Z", devices: [device("b")] });
    expect(await crashAt(root, active, sibling, join(active, "devices.json"), "before")).toBe(77);
    // its last-seen save changes the bytes, though this dir never got the merge
    expect(new DeviceStore(active).match("token-a")?.id).toBe(device("a").id);
    mergeSiblingState(active, sibling, at(1));
    expect(ids(active)).toEqual(["a", "b"]);
    expect(ids(sibling)).toEqual(["a", "b"]);
    // the prepared files the crash left are gone once the merge is recorded
    expect(readdirSync(active).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(sibling).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("stay revoked when the clock went back between merges", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("a")]);
    mergeSiblingState(active, sibling, at(10));
    writeDevices(active, [device("a"), device("b")], registry(active).gate_closed_at);
    const rename = privateStateFs.renameSync;
    const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(sibling, "state-merge.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      rename(from, to);
    });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(5)); } finally { failing.mockRestore(); said.mockRestore(); }
    writeDevices(active, [device("a")], registry(active).gate_closed_at);
    mergeSiblingState(active, sibling, at(11));
    expect(ids(active)).toEqual(["a"]);
    expect(ids(sibling)).toEqual(["a"]);
  });

  it("keep the old dir gated for older launchers when it could not be linked", () => {
    // the old name still holds only the bridge registry: a launcher from before the fix starts on it
    const { active: legacy, sibling: next } = install();
    mkdirSync(join(legacy, "bridges"));
    writeDevices(next, [device("a")]);
    mergeSiblingState(next, legacy, at(0));
    expect(new DeviceStore(legacy).gated).toBe(true);
    expect(new DeviceStore(legacy).match("token-a")?.id).toBe(device("a").id);
  });

  it("fail closed on disk too, for a release before this one, when they cannot be merged", () => {
    const { active, sibling } = install();
    writeDevices(sibling, [device("b")]);
    // valid JSON, of the wrong shape inside: the record of this very pair of dirs
    const dirs = [realpathSync(active), realpathSync(sibling)].sort();
    writeJson(join(active, "state-merge.json"), { version: 1, seq: 1, at: "2026", dirs, devices: [], preferences: { [realpathSync(sibling)]: { settings: null, muted_panes: [] } }, push: {} });
    writeJson(join(sibling, "preferences.json"), { revision: 1, settings: { language: "ko" } });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { devicesBlocked } = mergeSiblingState(active, sibling, at(0));
      expect(devicesBlocked).toContain("state-merge.json");
      expect(new DeviceStore(active, devicesBlocked).gated).toBe(true);
    } finally { said.mockRestore(); }
    expect(new DeviceStore(active).gated).toBe(true);
  });

  it("fail closed on a registry or merge record that cannot be read, writing neither registry", () => {
    for (const damage of ["registry", "record"] as const) {
      const { active, sibling } = install();
      writeDevices(active, [device("a")]);
      if (damage === "registry") writeFileSync(join(sibling, "devices.json"), "{ not json");
      else {
        writeDevices(sibling, [device("b")]);
        writeFileSync(join(active, "state-merge.json"), "[]");
      }
      const files = [readFileSync(join(active, "devices.json"), "utf8"), readFileSync(join(sibling, "devices.json"), "utf8")];
      const said = spyOn(console, "error").mockImplementation(() => {});
      try {
        const { devicesBlocked } = mergeSiblingState(active, sibling, at(0));
        expect(devicesBlocked).toContain(damage === "registry" ? join(sibling, "devices.json") : join(active, "state-merge.json"));
        expect([readFileSync(join(active, "devices.json"), "utf8"), readFileSync(join(sibling, "devices.json"), "utf8")]).toEqual(files);
        const store = new DeviceStore(active, devicesBlocked);
        expect(store.gated).toBe(true);
        expect(() => store.startPairing()).toThrow();
        // the devices it holds still get in
        expect(store.match("token-a")?.id).toBe(device("a").id);
      } finally { said.mockRestore(); }
    }
  });

  it("change nothing more when merged again with nothing new", () => {
    const { active, sibling } = install();
    writeDevices(active, [device("a")]);
    writeDevices(sibling, [device("b")]);
    mergeSiblingState(active, sibling, at(0));
    const after = [readFileSync(join(active, "devices.json"), "utf8"), readFileSync(join(sibling, "devices.json"), "utf8")];
    mergeSiblingState(active, sibling, at(1));
    expect([readFileSync(join(active, "devices.json"), "utf8"), readFileSync(join(sibling, "devices.json"), "utf8")]).toEqual(after);
    expect(readdirSync(join(active, "state-merge-backups"))).toHaveLength(1);
  });
});

describe("shared preferences of the install's other state dir", () => {
  it("are laid over this dir's at the first merge, mutes joined", () => {
    const { active, sibling } = install();
    writeJson(join(sibling, "preferences.json"), { revision: 1, settings: { language: "en", sidebarRows: "two" }, pins: ["local:w1"] });
    writeJson(join(sibling, "muted-panes.json"), { muted_panes: ["local:p1"] });
    writeJson(join(active, "muted-panes.json"), { muted_panes: ["local:p2"] });
    mergeSiblingState(active, sibling, at(0));
    expect(new PreferenceStore(active).get()).toEqual({ revision: 2, settings: { language: "en", sidebarRows: "two" }, pins: ["local:w1"], muted_panes: ["local:p2", "local:p1"] });
  });

  it("keep each side's changes since the last merge, the later document winning a setting both changed", () => {
    const { active, sibling } = install();
    writeJson(join(sibling, "preferences.json"), { revision: 1, settings: { language: "en", sidebarRows: "two", theme: "dark" } }, at(0));
    writeJson(join(sibling, "muted-panes.json"), { muted_panes: ["local:p1"] });
    mergeSiblingState(active, sibling, at(1));
    // there: language and theme changed, p1 unmuted; here, later: sidebarRows and theme changed
    for (const dir of [active, sibling]) utimesSync(join(dir, "muted-panes.json"), at(1), at(1));
    writeJson(join(sibling, "preferences.json"), { revision: 2, settings: { language: "ko", sidebarRows: "two", theme: "light" } }, at(2));
    writeJson(join(sibling, "muted-panes.json"), { muted_panes: [] }, at(2));
    writeJson(join(active, "preferences.json"), { revision: 3, settings: { language: "en", sidebarRows: "one", theme: "solar" } }, at(3));
    mergeSiblingState(active, sibling, at(4));
    expect(new PreferenceStore(active).get()).toMatchObject({ settings: { language: "ko", sidebarRows: "one", theme: "solar" }, muted_panes: [] });
  });

  it("end alike in both dirs, so a later start on either keeps every setting", () => {
    const { active, sibling } = install();
    writeJson(join(active, "preferences.json"), { revision: 1, settings: { language: "ko" } });
    writeJson(join(sibling, "preferences.json"), { revision: 1, settings: { sidebarRows: "two" } });
    mergeSiblingState(active, sibling, at(0));
    mergeSiblingState(sibling, active, at(1));
    for (const dir of [active, sibling]) expect(new PreferenceStore(dir).get().settings).toEqual({ language: "ko", sidebarRows: "two" });
  });

  it("reach the other dir when it could not be written, whichever dir a later start uses", () => {
    const { active, sibling } = install();
    for (const dir of [active, sibling]) {
      writeJson(join(dir, "preferences.json"), { revision: 1, settings: { language: "en" } });
      writeJson(join(dir, "muted-panes.json"), { muted_panes: ["local:p"] });
    }
    mergeSiblingState(active, sibling, at(0));
    writeJson(join(active, "preferences.json"), { revision: 2, settings: { language: "ko" } });
    writeJson(join(active, "muted-panes.json"), { muted_panes: [] });
    // a dir where the temporary file goes: the other dir's preferences cannot be replaced
    const blocker = join(sibling, `preferences.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(1)); } finally { said.mockRestore(); rmSync(blocker, { recursive: true }); }
    mergeSiblingState(sibling, active, at(2));
    for (const dir of [active, sibling]) expect(new PreferenceStore(dir).get()).toMatchObject({ settings: { language: "ko" }, muted_panes: [] });
  });

  it("give way to a change made after they were taken in, though the other dir could not take it", () => {
    const { active, sibling } = install();
    for (const dir of [active, sibling]) {
      writeJson(join(dir, "preferences.json"), { revision: 1, settings: { language: "en" } });
      writeJson(join(dir, "muted-panes.json"), { muted_panes: [] });
    }
    mergeSiblingState(active, sibling, at(0));
    writeJson(join(sibling, "preferences.json"), { revision: 2, settings: { language: "ko" } }, at(1));
    writeJson(join(active, "muted-panes.json"), { muted_panes: ["local:p"] });
    // this dir takes "ko" in; the other dir's mutes cannot be replaced
    const blocker = join(sibling, `muted-panes.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(2)); } finally { said.mockRestore(); rmSync(blocker, { recursive: true }); }
    expect(new PreferenceStore(active).get().settings).toEqual({ language: "ko" });
    // the user sets it back here, later
    writeJson(join(active, "preferences.json"), { revision: 3, settings: { language: "en" } }, at(3));
    mergeSiblingState(active, sibling, at(4));
    for (const dir of [active, sibling]) expect(new PreferenceStore(dir).get()).toMatchObject({ settings: { language: "en" }, muted_panes: ["local:p"] });
  });

  it("conflict by the preferences document's own time, never by the mutes'", () => {
    const { active, sibling } = install();
    for (const dir of [active, sibling]) {
      writeJson(join(dir, "preferences.json"), { revision: 1, settings: { language: "en" } });
      writeJson(join(dir, "muted-panes.json"), { muted_panes: ["local:p"] });
    }
    mergeSiblingState(active, sibling, at(0));
    utimesSync(join(active, "muted-panes.json"), at(30), at(30));
    utimesSync(join(sibling, "muted-panes.json"), at(31), at(31));
    writeJson(join(sibling, "preferences.json"), { revision: 2, settings: { language: "de" } }, at(10));
    writeJson(join(active, "preferences.json"), { revision: 2, settings: { language: "ko" } }, at(20));
    mergeSiblingState(active, sibling, at(40));
    expect(new PreferenceStore(active).get().settings).toEqual({ language: "ko" });
  });

  it("keep this dir's mutes when both lists together are over the limit", () => {
    const { active, sibling } = install();
    const mine = Array.from({ length: 300 }, (_, i) => `local:a${i}`);
    writeJson(join(active, "muted-panes.json"), { muted_panes: mine });
    writeJson(join(sibling, "muted-panes.json"), { muted_panes: Array.from({ length: 300 }, (_, i) => `local:s${i}`) });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(0)); } finally { said.mockRestore(); }
    expect(new PreferenceStore(active).get().muted_panes).toEqual(mine);
  });

  it("are not merged from a damaged document, which stays as it is", () => {
    const { active, sibling } = install();
    writeFileSync(join(sibling, "preferences.json"), "{ not json");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(0)); } finally { said.mockRestore(); }
    expect(existsSync(join(active, "preferences.json"))).toBe(false);
    expect(readFileSync(join(sibling, "preferences.json"), "utf8")).toBe("{ not json");
  });

  it("end with one state folder id, this dir's or, while it has none, the other's", () => {
    const id = (dir: string) => (JSON.parse(readFileSync(join(dir, "preferences-id.json"), "utf8")) as { state_id: string }).state_id;
    const name = (dir: string, value: string) => writeFileSync(join(dir, "preferences-id.json"), JSON.stringify({ state_id: value }));
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    {
      const { active, sibling } = install();
      name(active, a);
      mergeSiblingState(active, sibling, at(0));
      expect([id(active), id(sibling)]).toEqual([a, a]);
    }
    {
      const { active, sibling } = install();
      name(sibling, b);
      mergeSiblingState(active, sibling, at(0));
      expect([id(active), id(sibling)]).toEqual([b, b]);
      expect(new PreferenceStore(active).get().state_id).toBe(b);
    }
    {
      const { active, sibling } = install();
      name(active, a);
      name(sibling, b);
      mergeSiblingState(active, sibling, at(0));
      expect([id(active), id(sibling)]).toEqual([a, a]);
    }
  });
});

describe("push subscriptions of the install's other state dir", () => {
  const subscribe = async (dir: string, key: { publicKey: string; privateKey: string } | null) => {
    const fake = await startFakePushService();
    fakes.push(fake);
    if (key) writeJson(join(dir, "vapid.json"), key);
    writeJson(join(dir, "push-subscriptions.json"), [{ ...fake.subscription, device_id: null }]);
    return fake;
  };

  // regression: the merge compared raw spellings, so another spelling of an endpoint retired here came back registered (#2012)
  it("leave out another spelling of an endpoint retired here", async () => {
    const { active, sibling } = install();
    const key = webpush.generateVAPIDKeys();
    const fake = await subscribe(sibling, key);
    writeJson(join(sibling, "push-subscriptions.json"), [{ ...fake.subscription, endpoint: `${fake.subscription.endpoint}#other`, device_id: null }]);
    const retiredHash = createHash("sha256").update(fake.subscription.endpoint).digest("base64url");
    writeJson(join(active, "push-retired.json"), [{ hash: retiredHash, at: 1, owner: "device-a" }]);
    mergeSiblingState(active, sibling, at(0));
    const held = existsSync(join(active, "push-subscriptions.json")) ? JSON.parse(readFileSync(join(active, "push-subscriptions.json"), "utf8")) as unknown[] : [];
    expect(held).toEqual([]);
  });

  // regression: storing endpoints normalized let the other dir's next write respell one taken over, and the next merge took it again
  it("do not come back after a goodbye here when the other dir writes its list again", async () => {
    const { active, sibling } = install();
    const fake = await subscribe(sibling, webpush.generateVAPIDKeys());
    const legacy = `${fake.subscription.endpoint}#legacy`;
    writeJson(join(sibling, "push-subscriptions.json"), [{ ...fake.subscription, endpoint: legacy, device_id: null }]);
    mergeSiblingState(active, sibling, at(0));
    createPushService({ stateDir: active, loopbackHttp: true }).unsubscribe(legacy);
    // the other dir writes its list again, for a subscription of its own
    createPushService({ stateDir: sibling, loopbackHttp: true }).subscribe({ ...fake.subscription, endpoint: `${fake.subscription.endpoint}-other` }, undefined, null);
    mergeSiblingState(active, sibling, at(1));
    const held = JSON.parse(readFileSync(join(active, "push-subscriptions.json"), "utf8")) as { endpoint: string }[];
    expect(held.map((subscription) => subscription.endpoint)).toEqual([`${fake.subscription.endpoint}-other`]);
  });

  it("bring their key along where this dir has none", async () => {
    const { active, sibling } = install();
    const key = webpush.generateVAPIDKeys();
    const fake = await subscribe(sibling, key);
    mergeSiblingState(active, sibling, at(0));
    expect(JSON.parse(readFileSync(join(active, "vapid.json"), "utf8"))).toEqual(key);
    const push = createPushService({ stateDir: active, loopbackHttp: true });
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received[0]).toMatchObject({ vapidKey: key.publicKey, vapidValid: true });
  });

  it("are signed with the key they were made for beside this dir's own, and taken over once", async () => {
    const { active, sibling } = install();
    const theirs = webpush.generateVAPIDKeys();
    const mine = webpush.generateVAPIDKeys();
    const there = await subscribe(sibling, theirs);
    const here = await subscribe(active, mine);
    mergeSiblingState(active, sibling, at(0));
    expect(JSON.parse(readFileSync(join(active, "vapid.json"), "utf8"))).toEqual(mine);
    expect(JSON.parse(readFileSync(join(active, PUSH_EXTRA_KEYS), "utf8")).keys).toEqual([{ ...theirs, endpoints: [there.subscription.endpoint] }]);
    const push = createPushService({ stateDir: active, loopbackHttp: true });
    await push.sendTest(there.subscription.endpoint);
    await push.sendTest(here.subscription.endpoint);
    expect(there.received[0]).toMatchObject({ vapidKey: theirs.publicKey, vapidValid: true });
    expect(here.received[0]).toMatchObject({ vapidKey: mine.publicKey, vapidValid: true });
    // unsubscribed here since: the next merge does not bring it back
    push.unsubscribe(there.subscription.endpoint);
    mergeSiblingState(active, sibling, at(1));
    const held = JSON.parse(readFileSync(join(active, "push-subscriptions.json"), "utf8")) as { endpoint: string }[];
    expect(held.map((subscription) => subscription.endpoint)).toEqual([here.subscription.endpoint]);
  });
});

describe("push keys of the install's other state dir", () => {
  it("never replace a damaged key file of this dir", async () => {
    const { active, sibling } = install();
    const fake = await startFakePushService();
    fakes.push(fake);
    writeFileSync(join(active, "vapid.json"), "{}\n");
    writeJson(join(sibling, "vapid.json"), webpush.generateVAPIDKeys());
    writeJson(join(sibling, "push-subscriptions.json"), [{ ...fake.subscription, device_id: null }]);
    const said = spyOn(console, "error").mockImplementation(() => {});
    try { mergeSiblingState(active, sibling, at(0)); } finally { said.mockRestore(); }
    expect(readFileSync(join(active, "vapid.json"), "utf8")).toBe("{}\n");
  });

  it("leave a subscription whose key is missing to a later merge, once the key is back", () => {
    const { active, sibling } = install();
    const subscription = { endpoint: "https://push.example/e", keys: { p256dh: "p", auth: "a" }, device_id: null };
    writeJson(join(sibling, "push-subscriptions.json"), [subscription]);
    writeFileSync(join(sibling, "vapid.json"), "{}\n");
    mergeSiblingState(active, sibling, at(0));
    expect(existsSync(join(active, "push-subscriptions.json"))).toBe(false);
    writeJson(join(sibling, "vapid.json"), webpush.generateVAPIDKeys());
    mergeSiblingState(active, sibling, at(1));
    const held = JSON.parse(readFileSync(join(active, "push-subscriptions.json"), "utf8")) as { endpoint: string }[];
    expect(held.map((entry) => entry.endpoint)).toEqual([subscription.endpoint]);
  });

  it("stay with each subscription when it moves on again, from a dir that took it over", async () => {
    const { active, sibling } = install();
    const first = webpush.generateVAPIDKeys();
    const own = webpush.generateVAPIDKeys();
    const fake = await startFakePushService();
    fakes.push(fake);
    // the other dir once took this subscription over, made for a key that is not its own
    writeJson(join(sibling, "vapid.json"), webpush.generateVAPIDKeys());
    writeJson(join(sibling, PUSH_EXTRA_KEYS), { keys: [{ ...first, endpoints: [fake.subscription.endpoint] }] });
    writeJson(join(sibling, "push-subscriptions.json"), [{ ...fake.subscription, device_id: null }]);
    writeJson(join(active, "vapid.json"), own);
    mergeSiblingState(active, sibling, at(0));
    await createPushService({ stateDir: active, loopbackHttp: true }).sendTest(fake.subscription.endpoint);
    expect(fake.received[0]).toMatchObject({ vapidKey: first.publicKey, vapidValid: true });
  });
});

describe("the install's other state dir", () => {
  it("is the other default dir, unless it is a link to this one or this one is a custom dir", () => {
    const { root, active: legacy, sibling: next } = install();
    const env = { XDG_CONFIG_HOME: root };
    expect(siblingStateDir(legacy, env)).toBe(next);
    expect(siblingStateDir(next, env)).toBe(legacy);
    expect(siblingStateDir(join(root, "custom"), env)).toBeNull();
    // the config dir behind a link, named by its real path as a supervisor started from it finds it
    const linked = join(root, "linked-config");
    symlinkSync(root, linked);
    expect(realpathSync(siblingStateDir(realpathSync(legacy), { XDG_CONFIG_HOME: linked })!)).toBe(realpathSync(next));
    rmSync(legacy, { recursive: true });
    expect(siblingStateDir(next, env)).toBeNull();
    symlinkSync(next, legacy);
    expect(siblingStateDir(next, env)).toBeNull();
  });
});
