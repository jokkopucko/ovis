import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../../../shared/browser-policy.ts";
import { debuggingSwitch, ownAddresses, readBrowserState, stageSupported } from "./browserState.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-browser-state-"));
  dirs.push(dir);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

describe("the built-in browser's state", () => {
  it("is off until the shared setting is on, and on a debugging port whatever it says", () => {
    expect(readBrowserState(stateDir({}), 7317, false).enabled).toBe(false);
    expect(readBrowserState(stateDir({ "preferences.json": "{ not json" }), 7317, false).enabled).toBe(false);
    expect(readBrowserState(stateDir({ "preferences.json": { revision: 1, settings: { builtInBrowser: "yes" } } }), 7317, false).enabled).toBe(false);
    const on = stateDir({ "preferences.json": { revision: 1, settings: { builtInBrowser: true } } });
    expect(readBrowserState(on, 7317, false).enabled).toBe(true);
    expect(readBrowserState(on, 7317, true).enabled).toBe(false);
  });

  it("blocks the listed sites as typed, and keeps this PC's server and every address PC out", () => {
    const dir = stateDir({
      "preferences.json": { revision: 2, settings: { builtInBrowser: true, browserBlockedSites: ["Bank.example.", 7, "two words", "*.mail.example"] } },
      "address-pcs.json": [{ id: "a", kind: "address", address: "https://desk.example.ts.net" }, { id: "b", kind: "address", address: "http://10.0.0.5:7317" }, { id: "c", address: "not an address" }],
    });
    const { policy } = readBrowserState(dir, 7317, false);
    expect(policy.blocked).toEqual(["bank.example", "mail.example"]);
    const refused = (address: string) => { const decision = decide(address, policy); return decision.allowed ? null : decision.reason; };
    expect(refused("https://www.bank.example/")).toBe("blocked");
    expect(refused("http://127.0.0.1:7317/")).toBe("ovis");
    expect(refused("https://desk.example.ts.net/")).toBe("ovis");
    expect(refused("http://10.0.0.5:7317/api/terminal")).toBe("ovis");
    expect(refused("https://desk.example.ts.net:8443/")).toBeNull();
  });

  it("names this PC's own addresses as the policy compares hosts, and keeps the server out on loopback alone", () => {
    const own = ownAddresses({ lo: [{ address: "127.0.0.1", internal: true }], eth0: [{ address: "192.168.1.20", internal: false }, { address: "FE80::1%eth0", internal: false }], tailscale0: [{ address: "100.70.1.2", internal: false }] });
    expect(own).toEqual(["192.168.1.20", "[fe80::1]", "100.70.1.2"]);
    const { policy } = readBrowserState(stateDir({}), 7317, false);
    expect(policy.ovis).toEqual([{ host: "localhost", port: 7317 }]);
  });


  it("names both of Chromium's switches that open the app to a debugger", () => {
    expect(debuggingSwitch((name) => name === "remote-debugging-port")).toBe(true);
    expect(debuggingSwitch((name) => name === "remote-debugging-pipe")).toBe(true);
    expect(debuggingSwitch(() => false)).toBe(false);
  });
});

describe("drawing tabs nobody looks at off the screen", () => {
  it("is done on Linux under X11 only", () => {
    expect(stageSupported("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe(true);
    expect(stageSupported("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(false);
    expect(stageSupported("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
    expect(stageSupported("darwin", {})).toBe(false);
    expect(stageSupported("win32", {})).toBe(false);
  });
});
