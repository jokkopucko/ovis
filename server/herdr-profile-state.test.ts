import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrProfileState } from "./herdr-profile-state.ts";
import { privateStateFs } from "./private-state.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "herdr-profile-state-")); dirs.push(dir); return dir; }
it("restores target-bound approval and cached panes without copying catalog fields", () => {
  const dir = directory(), target = { destination: "BuildBox", port: 2222, session: "agents" };
  const store = new HerdrProfileState(dir);
  store.approve("id", target);
  store.saveSnapshot("id", { panes: [{ pane_id: "test-pane" }] } as SessionSnapshot);
  store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.approved("id", { session: "agents", port: 2222, destination: "BuildBox" })).toBe(true);
  expect(restored.snapshot("id")?.panes[0]?.pane_id).toBe("test-pane");
  const text = readFileSync(join(dir, "herdr-profile-state.json"), "utf8");
  expect(text).not.toContain("BuildBox");
  expect(text).not.toContain('"enabled"');
  if (process.platform !== "win32") expect(statSync(join(dir, "herdr-profile-state.json")).mode & 0o777).toBe(0o600);
  expect(restored.reconcile("id", { ...target, session: "other" })).toBe(true);
  expect(restored.approved("id", target)).toBe(false);
  expect(restored.snapshot("id")).toBeNull();
  restored.flush();
  expect(new HerdrProfileState(dir).approved("id", target)).toBe(false);
});
it("treats default as the unnamed session but does not merge ports or aliases", () => {
  const store = new HerdrProfileState(directory());
  store.approve("id", { destination: "BuildBox" });
  expect(store.approved("id", { destination: "BuildBox", session: "default" })).toBe(true);
  expect(store.approved("id", { destination: "BuildBox", port: 22 })).toBe(false);
  expect(store.approved("id", { destination: "buildbox" })).toBe(false);
  expect(store.prune(new Set())).toEqual(["id"]);
  expect(store.approved("id", { destination: "BuildBox" })).toBe(false);
});

it("restores a saved Ovis choice without changing catalog approval", () => {
  const dir = directory();
  const store = new HerdrProfileState(dir);
  const target = { destination: "BuildBox", session: "agents", own_ovis: "/home/u/.config/ovis/hc.sock" };
  store.allowConnection("id", target); store.approve("id", target); store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.approved("id", target)).toBe(true);
  expect(restored.target("id", { destination: "BuildBox", session: "agents" })).toEqual(target);
});
it("rejects corrupt approval state without overwriting it", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json");
  for (const data of ['{}', '[{"profile_id":"id","binding":"bad","approved":true,"snapshot":null}]']) {
    writeFileSync(path, data);
    expect(() => new HerdrProfileState(dir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(data);
  }
});

it("connection consent is separate from installation approval and survives restart", () => {
  const dir = directory(), target = { destination: "BuildBox" };
  const store = new HerdrProfileState(dir);
  store.allowConnection("id", target); store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.connectionApproved("id", target)).toBe(true);
  expect(restored.approved("id", target)).toBe(false);
  expect(() => restored.reconcile("id", { destination: "new" }, () => { throw new Error("cleanup"); })).toThrow("cleanup");
  restored.flush();
  expect(new HerdrProfileState(dir).connectionApproved("id", target)).toBe(false);
});

it("retries a failed key removal when the old target returns, after a restart and after a re-add", () => {
  const dir = directory(), target = { destination: "BuildBox" };
  const failing = () => { throw new Error("cleanup"); };
  let retired = 0;
  const store = new HerdrProfileState(dir);
  store.approve("id", target);
  expect(() => store.reconcile("id", { destination: "new" }, failing)).toThrow("cleanup");
  store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.reconcile("id", target, () => { retired++; })).toBe(true);
  expect(retired).toBe(1);
  expect(restored.reconcile("id", target, () => { retired++; })).toBe(false);
  expect(retired).toBe(1);
  restored.approve("id", target);
  expect(() => restored.prune(new Set(), failing)).toThrow("cleanup will retry");
  restored.flush();
  const readded = new HerdrProfileState(dir);
  expect(readded.reconcile("id", target, () => { retired++; })).toBe(true);
  expect(retired).toBe(2);
  expect(readded.approved("id", target)).toBe(false);
  readded.flush();
  expect(readFileSync(join(dir, "herdr-profile-state.json"), "utf8")).not.toContain("retiring");
});
it("sets aside approvals that are not JSON, bytes untouched, and starts without them", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json");
  const zeros = Buffer.alloc(120);
  writeFileSync(path, zeros);
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const store = new HerdrProfileState(dir);
    expect(store.setAside).toMatch(/herdr-profile-state\.json\.corrupt-[^:]+$/);
    expect(readFileSync(store.setAside!)).toEqual(zeros);
    expect(existsSync(path)).toBe(false);
    expect(store.approved("id", { destination: "BuildBox" })).toBe(false);
    store.approve("id", { destination: "BuildBox" });
    store.flush();
    expect(new HerdrProfileState(dir).approved("id", { destination: "BuildBox" })).toBe(true);
  } finally { error.mockRestore(); }
});
it("writes unchanged approvals again when their file was deleted or replaced on disk", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json");
  const store = new HerdrProfileState(dir);
  store.approve("id", { destination: "BuildBox" });
  store.flush();
  const saved = readFileSync(path, "utf8");
  rmSync(path);
  store.approve("id", { destination: "BuildBox" });
  store.flush();
  expect(readFileSync(path, "utf8")).toBe(saved);
  writeFileSync(path, "[]");
  store.approve("id", { destination: "BuildBox" });
  store.flush();
  expect(readFileSync(path, "utf8")).toBe(saved);
  writeFileSync(path, saved.replace('"id"', '"xx"'));
  store.approve("id", { destination: "BuildBox" });
  store.flush();
  expect(readFileSync(path, "utf8")).toBe(saved);
});
it("writes durably, and only when the document changed", () => {
  const dir = directory();
  const temporaries: string[] = [];
  const open = spyOn(privateStateFs, "openSync").mockImplementation(((path: string, flags: string, mode?: number) => {
    if (flags === "wx") temporaries.push(path);
    return openSync(path, flags, mode);
  }) as typeof openSync);
  try {
    const store = new HerdrProfileState(dir);
    store.approve("id", { destination: "BuildBox" });
    store.saveSnapshot("id", { panes: [{ pane_id: "test-pane" }] } as SessionSnapshot);
    store.flush();
    expect(temporaries).toHaveLength(1);
    store.saveSnapshot("id", { panes: [{ pane_id: "test-pane" }] } as SessionSnapshot);
    store.flush();
    expect(temporaries).toHaveLength(1);
    store.saveSnapshot("id", { panes: [{ pane_id: "other-pane" }] } as SessionSnapshot);
    store.flush();
    expect(temporaries).toHaveLength(2);
    expect(new HerdrProfileState(dir).snapshot("id")?.panes[0]?.pane_id).toBe("other-pane");
  } finally { open.mockRestore(); }
});
