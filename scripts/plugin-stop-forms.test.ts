import { expect, it } from "bun:test";
import { join } from "node:path";
import { startedByThisPlugin } from "./plugin.ts";

// After herdr plugin update moves a plugin from source to the compiled server (scripts/plugin-launch.ts), Stop runs as
// the binary while the server running is Bun's server/managed.ts, and the other way round: each form must recognise
// the other's server as this plugin's, and nothing else.
const checkout = join(import.meta.dir, "..", "plugin checkout");
const env = { OVIS_PLUGIN_CHECKOUT: checkout };
const bun = process.platform === "win32" ? "C:\\Users\\me\\.bun\\bin\\bun.exe" : "/home/me/.bun/bin/bun";
const binary = join(checkout, ".ovis", "server", "releases", "0.5.4-abcd", process.platform === "win32" ? "ovis-server.exe" : "ovis-server");

it("knows the source form's server and the binary's as this plugin's", () => {
  expect(startedByThisPlugin(bun, [bun, join(checkout, "server", "managed.ts")], env)).toBe(true);
  expect(startedByThisPlugin(binary, [binary, "managed"], env)).toBe(true);
});

it("takes nothing else for it: another program, another entry, another checkout's binary", () => {
  expect(startedByThisPlugin("/usr/bin/python3", ["/usr/bin/python3", join(checkout, "server", "managed.ts")], env)).toBe(false);
  expect(startedByThisPlugin(binary, [binary, "serve"], env)).toBe(false);
  const elsewhere = join(import.meta.dir, "..", "other", ".ovis", "server", "releases", "x", "ovis-server");
  expect(startedByThisPlugin(elsewhere, [elsewhere, "managed"], env)).toBe(false);
  expect(startedByThisPlugin(bun, [bun, join(checkout, "server", "managed.ts")], {})).toBe(false);
});
