import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHc } from "./discovery.ts";
import { HC_MOVED, hcBin, hcRecovery, startRuntime } from "./runtime.ts";

/** an hc stand-in found, so no test looks at the developer's own PATH, shell or hc */
const standIn = async () => ({ bin: "/nonexistent/hc", version: "0.1.17" });

const platform = process.platform;
const previousRuntime = process.env["OVIS_RUNTIME"];
const previousSocket = process.env["HERDR_SOCKET"];
const previousPath = process.env["PATH"];
const previousHcBin = process.env["OVIS_HC_BIN"];
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  mock.restore();
  Object.defineProperty(process, "platform", { value: platform });
  if (previousRuntime === undefined) delete process.env["OVIS_RUNTIME"];
  else process.env["OVIS_RUNTIME"] = previousRuntime;
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previousSocket;
  process.env["PATH"] = previousPath;
  if (previousHcBin === undefined) delete process.env["OVIS_HC_BIN"];
  else process.env["OVIS_HC_BIN"] = previousHcBin;
});

it.skipIf(platform === "win32")("runs the hc it found, not an unrelated one named first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-found-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const script = (name: string, output: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    return join(dir, "bin", name);
  };
  process.env["OVIS_RUNTIME"] = "herdr-core";
  process.env["OVIS_HC_BIN"] = script("hc", "herbstclient 0.9.5");
  const core = script("herdr-core", "hc 0.1.17");
  process.env["PATH"] = join(dir, "bin");
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: process.env, home: dir, loginShellPath: async () => null, usualDirs: [] }));
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(core);
  } finally {
    adapter.stop();
  }
});

/** a stand-in hc in `folder` that answers --version with `says` */
function hcIn(dir: string, folder: string, says: string): string {
  mkdirSync(join(dir, folder), { recursive: true });
  const path = join(dir, folder, "herdr-core");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${says}'\n`, { mode: 0o755 });
  return path;
}

it.skipIf(platform === "win32")("finds a moved hc again where only the login shell's PATH shows it, as the start did", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-moved-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const old = hcIn(dir, "old", "hc 0.1.17");
  let login = join(dir, "old");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: { PATH: join(dir, "empty") }, home: dir, loginShellPath: async () => login, usualDirs: [] }));
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(old);
    rmSync(old);
    const moved = hcIn(dir, "new", "hc 0.1.18");
    login = join(dir, "new");
    hcBin();
    await hcRecovery();
    expect(hcBin()).toBe(moved);
  } finally {
    adapter.stop();
  }
});

it.skipIf(platform === "win32")("never runs a file the search did not just verify: one that fails --version is passed over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-replaced-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const old = hcIn(dir, "old", "hc 0.1.17");
  hcIn(dir, "other", "hc 0.1.16");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: { PATH: join(dir, "empty") }, home: dir, loginShellPath: async () => null, usualDirs: [join(dir, "old"), join(dir, "other")] }));
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(old);
    rmSync(old);
    // the file an earlier look found was replaced with one that is not herdr-core
    const replaced = hcIn(dir, "other", "herbstclient 0.9.5");
    hcBin();
    await hcRecovery();
    expect(hcBin()).not.toBe(replaced);
    // nothing verified: not even a file that reappears at the old path is handed out
    hcIn(dir, "old", "herbstclient 0.9.5");
    expect(hcBin()).toBe(HC_MOVED);
    await hcRecovery();
    expect(hcBin()).toBe(HC_MOVED);
  } finally {
    adapter.stop();
  }
});

it.skipIf(platform === "win32")("starts nothing, and runs no other hc, when none answers as herdr-core's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-none-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  await expect(startRuntime(join(dir, "state"), async () => null)).rejects.toThrow(/no herdr-core found/);
  expect(existsSync(join(dir, "state"))).toBe(false);
});

it.skipIf(platform === "win32")("tightens an existing state directory and socket on every start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-mode-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  for (let start = 0; start < 2; start++) {
    chmodSync(dir, 0o755);
    const adapter = await startRuntime(dir, standIn);
    if (!adapter) throw new Error("runtime did not start");
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(adapter.socketPath).mode & 0o777).toBe(0o600);
      expect(process.env["HERDR_SOCKET"]).toBe(adapter.socketPath);
    } finally {
      adapter.stop();
    }
  }
});

it.skipIf(platform === "win32")("refuses another user's state directory before changing its mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-owner-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  chmodSync(dir, 0o755);
  process.env["OVIS_RUNTIME"] = "herdr-core";
  spyOn(process, "geteuid").mockReturnValue(statSync(dir).uid + 1);
  await expect(startRuntime(dir, standIn)).rejects.toThrow();
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  expect(existsSync(join(dir, "herdr-core.sock"))).toBe(false);
});

it("rejects herdr-core on Windows before creating state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-windows-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  Object.defineProperty(process, "platform", { value: "win32" });
  await expect(startRuntime(state, standIn)).rejects.toThrow();
  expect(existsSync(state)).toBe(false);
});

it("leaves the default runtime's state and socket unchanged even on Windows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-default-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  delete process.env["OVIS_RUNTIME"];
  process.env["HERDR_SOCKET"] = "default-socket";
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(await startRuntime(state, standIn)).toBeNull();
  expect(existsSync(state)).toBe(false);
  expect(process.env["HERDR_SOCKET"]).toBe("default-socket");
});
