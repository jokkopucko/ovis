import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layout } from "../app/electron/src/children.ts";
import { BUNDLE_DIR, WINDOWS_BUNDLE_BASE } from "./remote-host.ts";
import { INSTALLED_BINARY_REASON, installedBinaryAt, PLUGIN_BINARY_REASON, pluginBinaryOf, Updater } from "./updater.ts";

// A herdr plugin checkout that scripts/plugin-launch.ts runs as the release's binary: the server's root is the release
// folder inside the checkout's .ovis/server, where git still finds the checkout. Settings must say the update runs
// through herdr, never that the source checkout should switch to main (following that builds a release the binary
// never runs), and nothing may be installed from the app.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function pluginCheckout(): { checkout: string; root: string; stateDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-binary-"));
  dirs.push(scratch);
  const checkout = join(scratch, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), '{"version":"0.5.4"}\n');
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", checkout, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdout: "ignore", stderr: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "release"); git("checkout", "-q", "--detach");
  const root = join(checkout, ".ovis", "server", "releases", "0.5.4-abcd");
  mkdirSync(root, { recursive: true });
  return { checkout, root, stateDir: join(scratch, "state") };
}

it("marks only a compiled server under the plugin's launcher as the plugin's binary", () => {
  const { checkout } = pluginCheckout();
  expect(pluginBinaryOf(checkout, true)).toEqual({ checkout, version: "0.5.4" });
  expect(pluginBinaryOf(checkout, false)).toBeUndefined();
  expect(pluginBinaryOf(undefined, true)).toBeUndefined();
});

it("tells a plugin's compiled server to update through herdr, and offers no in-app update", async () => {
  const { checkout, root, stateDir } = pluginCheckout();
  const updater = new Updater({ root, stateDir, autoUpdate: false, pluginBinary: { checkout, version: "0.5.4" }, publish() {}, activate: async () => {} });
  await updater.initialize();
  expect(updater.status.managed).toBe(false);
  expect(updater.status.current_version).toBe("0.5.4");
  expect(updater.status.blocked_reason).toBe(PLUGIN_BINARY_REASON);
  expect(PLUGIN_BINARY_REASON).toContain("herdr plugin update");
  expect(updater.status.blocked_reason).not.toContain("main");
});

it("tells a compiled server the installers put in place to run the installer again, never to switch to a Git checkout", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ovis-installed-binary-"));
  dirs.push(scratch);
  const root = join(scratch, ".local", "share", "ovis", "releases", "0.5.4-abcd");
  mkdirSync(root, { recursive: true });
  // the signed manifest the installer checked the binary against stays beside it, and names the version
  writeFileSync(join(root, "ovis-server.json"), '{\n  "schema": 1,\n  "version": "0.5.4"\n}\n');
  const updater = new Updater({ root, stateDir: join(scratch, "state"), autoUpdate: false, installedBinary: installedBinaryAt(root, true), publish() {}, activate: async () => {} });
  await updater.initialize();
  expect(updater.status.managed).toBe(false);
  expect(updater.status.current_version).toBe("0.5.4");
  expect(updater.status.blocked_reason).toBe(INSTALLED_BINARY_REASON);
  expect(INSTALLED_BINARY_REASON).toContain("curl -fsSL https://ovis.sh/install.sh | sh");
  expect(INSTALLED_BINARY_REASON).toContain("irm https://ovis.sh/install.ps1 | iex");
});

it("takes an installed server's version only from a small regular ovis-server.json that names a release's", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ovis-installed-manifest-"));
  dirs.push(scratch);
  const valid = '{"schema":1,"version":"0.5.4"}\n';
  const versionOf = async (name: string, place: (manifest: string) => void) => {
    const root = join(scratch, name, ".local", "share", "ovis", "releases", "0.5.4-abcd");
    mkdirSync(root, { recursive: true });
    place(join(root, "ovis-server.json"));
    const updater = new Updater({ root, stateDir: join(scratch, name, "state"), autoUpdate: false, installedBinary: installedBinaryAt(root, true), publish() {}, activate: async () => {} });
    await updater.initialize();
    return updater.status.current_version;
  };
  // larger than any manifest: read whole, it would bloat the server at every start
  expect(await versionOf("huge", (manifest) => writeFileSync(manifest, `{"schema":1,"version":"0.5.4","pad":"${"x".repeat(3_000_000)}"}`))).toBeNull();
  // whatever string the file holds would otherwise be reported as the version
  expect(await versionOf("garbage", (manifest) => writeFileSync(manifest, '{"schema":1,"version":"<img src=x onerror=alert(1)>"}'))).toBeNull();
  // a FIFO holds a synchronous read until a writer comes: this one has a writer, so a read that waits takes its version
  const writers: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const fifo = await versionOf("fifo", (manifest) => {
      if (spawnSync("mkfifo", [manifest]).status === 0) writers.push(Bun.spawn(["sh", "-c", 'printf "%s" "$1" > "$2"', "sh", valid, manifest], { stdout: "ignore", stderr: "ignore" }));
    });
    if (writers.length > 0) expect(fifo).toBeNull();
  } finally { for (const writer of writers) writer.kill(); }
  expect(await versionOf("release", (manifest) => writeFileSync(manifest, valid))).toBe("0.5.4");
});

it("knows where the installers put a compiled server, and nothing else for one", () => {
  expect(installedBinaryAt("/home/me/.local/share/ovis/releases/0.5.4-abcd", true)).toBe(true);
  expect(installedBinaryAt("C:\\Users\\me\\AppData\\Local\\ovis\\bin", true)).toBe(true);
  expect(installedBinaryAt("/home/me/.local/share/ovis/releases/0.5.4-abcd", false)).toBe(false);
  expect(installedBinaryAt("/home/me/plugins/checkout/.ovis/server/releases/0.5.4-abcd", true)).toBe(false);
  expect(installedBinaryAt("/Applications/Ovis.app/Contents/Resources/server", true)).toBe(false);
  // the desktop app runs <resources>/server/ovis-server (app/electron/src/children.ts layout), on every platform
  for (const resources of ["/opt/Ovis/resources", "C:\\Users\\me\\AppData\\Local\\Programs\\Ovis\\resources", "/tmp/.mount_OvisAb12/resources"]) {
    expect(installedBinaryAt(layout(resources).server, true)).toBe(false);
  }
  // a remote bundle runs from ~/<BUNDLE_DIR>, or %LOCALAPPDATA%\herdr-web-ui\remote-v<N> on Windows (server/remote-host.ts)
  expect(installedBinaryAt(join("/home/me", BUNDLE_DIR), true)).toBe(false);
  expect(installedBinaryAt(`${WINDOWS_BUNDLE_BASE.replace("$env:LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local")}\\remote-v47`, true)).toBe(false);
});
