import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browserBlockedSites, canonicalHost, type BrowserPolicy, type OvisEndpoint } from "../../../shared/browser-policy.ts";

export interface BrowserState {
  enabled: boolean;
  policy: BrowserPolicy;
}

const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The built-in browser as the server's state folder has it: on only when its shared setting is
 * (preferences.json, written by the server alone) and the app was not started with a debugging
 * port, which would hand every page of the app, the Ovis window's included, to whoever reaches it.
 * The policy refuses this PC's Ovis server on any loopback name at `serverPort`, and every PC added by its
 * address (address-pcs.json). This PC's other addresses are refused at every port by the tabs' guard, which
 * reads them anew on each request (BrowserTabs, `ownAddresses`).
 */
export function readBrowserState(stateDir: string, serverPort: number | null, debugging: boolean): BrowserState {
  const preferences = readJson(join(stateDir, "preferences.json"));
  const settings = typeof preferences === "object" && preferences !== null ? (preferences as { settings?: unknown }).settings : null;
  const shared = typeof settings === "object" && settings !== null ? settings as Record<string, unknown> : {};
  const blocked = browserBlockedSites(shared["browserBlockedSites"]);
  const ovis: OvisEndpoint[] = serverPort === null ? [] : [{ host: "localhost", port: serverPort }];
  const pcs = readJson(join(stateDir, "address-pcs.json"));
  for (const pc of Array.isArray(pcs) ? pcs : []) {
    const address = typeof pc === "object" && pc !== null ? (pc as { address?: unknown }).address : null;
    if (typeof address !== "string") continue;
    try {
      const url = new URL(address);
      ovis.push({ host: url.hostname, port: url.port === "" ? DEFAULT_PORT[url.protocol] ?? 443 : Number(url.port) });
    } catch {}
  }
  return { enabled: !debugging && shared["builtInBrowser"] === true, policy: { blocked, ovis } };
}

/** Chromium's switches that open the app's pages to a debugger from outside */
export function debuggingSwitch(has: (name: string) => boolean): boolean {
  return has("remote-debugging-port") || has("remote-debugging-pipe");
}

/** this PC's own addresses outside loopback, as `os.networkInterfaces()` lists them, in the host form the policy compares */
export function ownAddresses(interfaces: Record<string, { address: string; internal: boolean }[] | undefined>): string[] {
  return Object.values(interfaces).flatMap((entries) => (entries ?? []).filter((entry) => !entry.internal).map((entry) => hostForm(entry.address.replace(/%.*$/, ""))));
}

/** an address as a URL's hostname holds it: an IPv6 one in brackets, canonical */
export function hostForm(address: string): string {
  return canonicalHost(address.includes(":") ? `[${address}]` : address);
}

/**
 * Whether tabs nobody looks at may be drawn off the screen (browserTabs.ts's stage): Linux under X11 only so far. macOS
 * and Windows may list such a window (Mission Control, Alt+Tab) or stop painting it as occluded, until checked there;
 * Wayland does not place a window off the screen.
 */
export function stageSupported(platform: string, env: Record<string, string | undefined>): boolean {
  return platform === "linux" && env["XDG_SESSION_TYPE"] !== "wayland" && !env["WAYLAND_DISPLAY"];
}
