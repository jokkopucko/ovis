import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHc } from "./discovery.ts";
import { coreConnection, HC_MOVED, hcBin, hcRecovery, NoAltRuntimeError, startRuntime } from "./runtime.ts";
import { capabilities, HERDR, HERDR_CORE } from "../runtime/capabilities.ts";
import { socketAddress } from "../herdr/client.ts";

/** an hc stand-in found, so no test looks at the developer's own PATH, shell or hc */
const standIn = async () => ({ bin: "/nonexistent/hc", version: "0.1.17" });
/** nor the developer's login shell: the terminal environment it would read, none */
const noLogin = async () => ({});

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

/** where a stand-in hc is found at all: discovery runs one only when every folder above it is safe, which a shared TMPDIR need not be */
const checkedTmp = platform === "win32" ? tmpdir() : "/tmp";

it.skipIf(platform === "win32")("runs the hc it found, not an unrelated one named first", async () => {
  const dir = mkdtempSync(join(checkedTmp, "ovis-hc-found-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const script = (name: string, output: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    return join(dir, "bin", name);
  };
  process.env["OVIS_RUNTIME"] = "herdr-core";
  process.env["OVIS_HC_BIN"] = script("hc", "herbstclient 0.9.5");
  const core = script("herdr-core", "hc 0.1.17");
  process.env["PATH"] = join(dir, "bin");
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: process.env, home: dir, loginShellPath: async () => null, usualDirs: [] }), noLogin);
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(core);
  } finally {
    adapter.stop();
  }
});

/** a stand-in hc in `folder` that answers --version with `says` */
function hcIn(dir: string, folder: string, says: string): string {
  mkdirSync(join(dir, folder), { recursive: true, mode: 0o755 });
  const path = join(dir, folder, "herdr-core");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${says}'\n`, { mode: 0o755 });
  return path;
}

it.skipIf(platform === "win32")("finds a moved hc again where only the login shell's PATH shows it, as the start did", async () => {
  const dir = mkdtempSync(join(checkedTmp, "ovis-hc-moved-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const old = hcIn(dir, "old", "hc 0.1.17");
  let login = join(dir, "old");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: { PATH: join(dir, "empty") }, home: dir, loginShellPath: async () => login, usualDirs: [] }), noLogin);
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
  const dir = mkdtempSync(join(checkedTmp, "ovis-hc-replaced-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const old = hcIn(dir, "old", "hc 0.1.17");
  hcIn(dir, "other", "hc 0.1.16");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: { PATH: join(dir, "empty") }, home: dir, loginShellPath: async () => null, usualDirs: [join(dir, "old"), join(dir, "other")] }), noLogin);
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
  await expect(startRuntime(join(dir, "state"), async () => null, noLogin)).rejects.toThrow(/no herdr-core found/);
  // a search that throws leaves no read of the terminals' environment running behind it
  let read = false;
  const reading = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); read = true; return {}; };
  await expect(startRuntime(join(dir, "state"), async () => { throw new Error("search failed"); }, reading)).rejects.toThrow("search failed");
  expect(read).toBeTrue();
  expect(existsSync(join(dir, "state"))).toBe(false);
});

it.skipIf(platform === "win32")("names each hc it passed over, and why, when none is found", async () => {
  const dir = mkdtempSync(join(checkedTmp, "ovis-hc-refused-"));
  cleanup = () => { chmodSync(join(dir, "open"), 0o755); rmSync(dir, { recursive: true, force: true }); };
  const refused = hcIn(dir, "open", "hc 0.1.17");
  chmodSync(join(dir, "open"), 0o777);
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const start = startRuntime(join(dir, "state"), (onRefused) => findHc({ env: { PATH: join(dir, "open") }, home: dir, loginShellPath: async () => null, usualDirs: [], ...(onRefused ? { onRefused } : {}) }), noLogin);
  const error = await start.then(() => null, (failure: unknown) => failure as Error);
  expect(error?.message).toContain(`${refused}: ${join(dir, "open")} is writable by everyone`);
  expect(error?.message).toContain("OVIS_HC_BIN");
});

it.skipIf(platform === "win32")("tightens an existing state directory and socket on every start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-mode-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  for (let start = 0; start < 2; start++) {
    chmodSync(dir, 0o755);
    const adapter = await startRuntime(dir, standIn, noLogin);
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

it.skipIf(platform === "win32")("runs hc connect with HERDR_SOCKET as it was before the adapter took it", async () => {
  // regression (#3336 follow-up): a core hc connect starts would aim every pane's herdr at Ovis's own adapter
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-herdr-socket-"));
  const previousHcSocket = process.env["HC_SOCKET"];
  cleanup = () => {
    if (previousHcSocket === undefined) delete process.env["HC_SOCKET"]; else process.env["HC_SOCKET"] = previousHcSocket;
    rmSync(dir, { recursive: true, force: true });
  };
  const out = join(dir, "connect-env");
  const bin = join(dir, "herdr-core");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'hc 0.1.17'; else env > '${out}'; fi\n`, { mode: 0o755 });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  process.env["HC_SOCKET"] = join(dir, "hc.sock");
  process.env["HERDR_SOCKET"] = join(dir, "herdr.sock");
  const adapter = await startRuntime(join(dir, "state"), async () => ({ bin, version: "0.1.17" }), noLogin);
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(process.env["HERDR_SOCKET"]).toBe(adapter.socketPath);
    await coreConnection().hello().catch(() => null);
    const env = readFileSync(out, "utf8").split("\n");
    expect(env.filter((line) => line.startsWith("HERDR_SOCKET="))).toEqual([`HERDR_SOCKET=${join(dir, "herdr.sock")}`]);
  } finally {
    adapter.stop();
  }
});

it.skipIf(platform === "win32")("runs hc connect in the user's terminal environment, so a core it starts hands that to every pane", async () => {
  // regression: a core started from a service or an agent's shell gave panes no profile tokens, and the agent's NO_COLOR
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-terminal-env-"));
  const previous = { HC_SOCKET: process.env["HC_SOCKET"], NO_COLOR: process.env["NO_COLOR"] };
  cleanup = () => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  };
  const out = join(dir, "connect-env");
  const bin = join(dir, "herdr-core");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'hc 0.1.17'; else env > '${out}'; fi\n`, { mode: 0o755 });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  process.env["HC_SOCKET"] = join(dir, "hc.sock");
  process.env["NO_COLOR"] = "1";
  const terminal = { NO_COLOR: "", GH_TOKEN: "from-profile", HC_SOCKET: join(dir, "elsewhere.sock") };
  const adapter = await startRuntime(join(dir, "state"), async () => ({ bin, version: "0.1.17" }), async () => terminal);
  if (!adapter) throw new Error("runtime did not start");
  try {
    await coreConnection().hello().catch(() => null);
    const env = readFileSync(out, "utf8").split("\n");
    expect(env.filter((line) => /^(NO_COLOR|GH_TOKEN|HC_SOCKET)=/.test(line)).sort()).toEqual(["GH_TOKEN=from-profile", `HC_SOCKET=${join(dir, "hc.sock")}`, "NO_COLOR="]);
  } finally {
    adapter.stop();
  }
});

it.skipIf(platform === "win32")("refuses another user's state directory before changing its mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-owner-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  chmodSync(dir, 0o755);
  process.env["OVIS_RUNTIME"] = "herdr-core";
  spyOn(process, "geteuid").mockReturnValue(statSync(dir).uid + 1);
  await expect(startRuntime(dir, standIn, noLogin)).rejects.toThrow();
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  expect(existsSync(join(dir, "herdr-core.sock"))).toBe(false);
});

it("rejects herdr-core on an OS it is not served on before creating state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-freebsd-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  Object.defineProperty(process, "platform", { value: "freebsd" });
  await expect(startRuntime(state, standIn, noLogin)).rejects.toThrow(/not freebsd/);
  expect(existsSync(state)).toBe(false);
  // a start that failed serves nothing: the gates still read herdr
  expect(capabilities()).toBe(HERDR);
});

it("refuses alt-runtime with its own error, and never serves herdr in its place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-alt-runtime-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  process.env["OVIS_RUNTIME"] = "alt-runtime";
  process.env["HERDR_SOCKET"] = "default-socket";
  // the error a saved choice falls back to herdr from (server/index.ts), not a start that ran and failed
  await expect(startRuntime(state, standIn, noLogin)).rejects.toBeInstanceOf(NoAltRuntimeError);
  expect(existsSync(state)).toBe(false);
  expect(capabilities()).toBe(HERDR);
  expect(process.env["HERDR_SOCKET"]).toBe("default-socket");
});

it("names herdr-core as the runtime served while it runs, and herdr again once it stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-served-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  // choosing the runtime serves nothing yet: a bridge that inherits OVIS_RUNTIME and starts none stays on herdr
  expect(capabilities()).toBe(HERDR);
  const adapter = await startRuntime(join(dir, "state"), standIn, noLogin);
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(capabilities()).toBe(HERDR_CORE);
  } finally {
    adapter.stop();
  }
  expect(capabilities()).toBe(HERDR);
});

it.skipIf(platform !== "win32")("serves herdr-core on Windows through a named pipe the herdr client reaches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-windows-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), standIn, noLogin);
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(adapter.socketPath).toMatch(/^\\\\\.\\pipe\\ovis-herdr-core-[0-9a-f]{32}$/);
    expect(process.env["HERDR_SOCKET"]).toBe(adapter.socketPath);
    // the client's own address for it: a pipe name is used as it is
    expect(socketAddress(adapter.socketPath)).toBe(adapter.socketPath);
    // a second server on the same state folder is refused while this one listens
    await expect(startRuntime(join(dir, "state"), standIn, noLogin)).rejects.toThrow(/Another Ovis owns this state directory/);
    // and through a junction to the same folder, which names the same pipe
    symlinkSync(join(dir, "state"), join(dir, "alias"), "junction");
    await expect(startRuntime(join(dir, "alias"), standIn, noLogin)).rejects.toThrow(/Another Ovis owns this state directory/);
  } finally {
    adapter.stop();
  }
  // and the pipe went with it: a server started afterwards takes the same name
  const again = await startRuntime(join(dir, "state"), standIn, noLogin);
  if (!again) throw new Error("runtime did not start again");
  again.stop();
});

it("leaves the default runtime's state and socket unchanged even on Windows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-default-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  delete process.env["OVIS_RUNTIME"];
  process.env["HERDR_SOCKET"] = "default-socket";
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(await startRuntime(state, standIn, noLogin)).toBeNull();
  expect(existsSync(state)).toBe(false);
  expect(capabilities()).toBe(HERDR);
  expect(process.env["HERDR_SOCKET"]).toBe("default-socket");
});
