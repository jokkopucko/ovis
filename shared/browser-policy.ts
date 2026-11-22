/**
 * Whether the desktop app's built-in browser may load an address: the one decision every request,
 * navigation, redirect, frame and socket of its tabs passes before it leaves the PC
 * (app/electron/src/browserViews.ts). It reads the address the browser is about to load, never one
 * polled or shown later: an address shown to anyone (the tab list, an agent's tool) is made from an
 * `Allowed` decision alone (`shownAddress`), so nothing is shown before it was allowed.
 *
 * - Only http(s) and ws(s) reach the network. `blob:` and `filesystem:` are decided by the origin
 *   inside them; `data:`, `about:` and `javascript:` by the origin of the frame they run in, and are
 *   refused with none. Every other scheme (`file:`, `chrome:`, `devtools:`, an OS handler) is refused.
 * - A blocked site blocks its subdomains too. Names are compared as the URL parser leaves them
 *   (lowercase, international names in punycode, an IPv4 address in any spelling as four numbers),
 *   without a trailing dot and an IPv4-mapped IPv6 address as its IPv4 address.
 * - An Ovis server (this PC's, another PC's) is refused at its port on any name of its host, every
 *   loopback name counting as one: a tab that could open one without a token reaches every terminal
 *   of that PC. The decision reads names, not where a name resolves: the caller refuses a name that
 *   resolves to one (`ovisAt` on each resolved address), and the server lets a loopback request in
 *   only under a name of its own (server/access.ts), so a rebinding name is asked to pair.
 */

export type BrowserRefusal = "invalid" | "scheme" | "opaque" | "blocked" | "ovis";

declare const allowedBrand: unique symbol;

export interface Allowed {
  readonly allowed: true;
  /** the address as the browser loads it */
  readonly url: string;
  /** the origin it was decided by: its own, the one inside a blob:, or the frame's for a data: */
  readonly origin: string;
  readonly [allowedBrand]: true;
}

export interface Refused {
  readonly allowed: false;
  readonly reason: BrowserRefusal;
}

export type BrowserDecision = Allowed | Refused;

/**
 * an Ovis server: a host by any of its names (`canonicalHost`) and the port it listens on. `ovisAt`
 * on a resolved address finds a server only by an address listed here, so the caller lists the
 * addresses a server is reached at as well as its names (this PC's own: loopback and each address of
 * its interfaces). A server listed by name alone (a PC added by its https address) is protected only
 * under that name: reached at an address not listed, what the tab may do there is that server's own
 * access policy (server/access.ts).
 */
export interface OvisEndpoint {
  host: string;
  port: number;
}

export interface BrowserPolicy {
  /** blocked sites as `blockedSite` keeps them */
  blocked: readonly string[];
  ovis: readonly OvisEndpoint[];
}

const NETWORK = new Set(["http:", "https:", "ws:", "wss:"]);
const DEFAULT_PORT: Record<string, number> = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 };
const FRAME_OWNED = new Set(["data:", "about:", "javascript:"]);
const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/;
const MAPPED_V4 = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/** A host name as the policy compares it: see the file's comment. Takes a hostname the URL parser gave. */
export function canonicalHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  const mapped = MAPPED_V4.exec(host);
  if (!mapped) return host;
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** The machine a canonical host names, every loopback name being this one. */
export function machineHost(host: string): string {
  return LOOPBACK.test(host) ? "localhost" : host;
}

/**
 * A site as the block list keeps it, from what a person typed (`bank.example`, `*.bank.example`,
 * `https://Bank.example/login`): its canonical host, or null when it names none.
 */
export function blockedSite(entry: string): string | null {
  const text = entry.trim().replace(/^\*\./, "");
  if (text === "" || /\s/.test(text)) return null;
  // a scheme, with or without `//` (`file:/x`, `mailto:a@b`), unless it is a host and its port (`localhost:5173`)
  const schemed = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:@]+:\d+(?:[/?#]|$)/.test(text);
  try {
    const url = new URL(schemed ? text : `http://${text}`);
    // another scheme leaves an international name as typed, which no web address would match
    if (!NETWORK.has(url.protocol)) return null;
    const host = canonicalHost(url.hostname);
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

export const BLOCKED_SITES_MAX = 200;

/** the block list as the shared setting `browserBlockedSites` keeps it: entries as `blockedSite` reads them, distinct, at most BLOCKED_SITES_MAX */
export function browserBlockedSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const sites = value.flatMap((entry) => typeof entry === "string" && entry.length <= 300 ? [blockedSite(entry)] : []);
  return [...new Set(sites.filter((site): site is string => site !== null))].slice(0, BLOCKED_SITES_MAX);
}

export function hostBlocked(host: string, blocked: readonly string[]): boolean {
  return blocked.some((site) => host === site || (!site.startsWith("[") && host.endsWith(`.${site}`)));
}

function refused(reason: BrowserRefusal): Refused {
  return { allowed: false, reason };
}

/** Whether `hostname` (a name or an address, as the URL parser gives it) at `port` is an Ovis server of the policy. */
export function ovisAt(hostname: string, port: number, policy: BrowserPolicy): boolean {
  const machine = machineHost(canonicalHost(hostname));
  return policy.ovis.some((server) => machineHost(canonicalHost(server.host)) === machine && server.port === port);
}

/** the port a network URL reaches */
export function urlPort(url: URL): number {
  return url.port === "" ? DEFAULT_PORT[url.protocol] ?? 0 : Number(url.port);
}

function networkDecision(url: URL, address: string, policy: BrowserPolicy): BrowserDecision {
  if (url.username !== "" || url.password !== "") return refused("invalid");
  const host = canonicalHost(url.hostname);
  if (host === "") return refused("invalid");
  if (ovisAt(host, urlPort(url), policy)) return refused("ovis");
  if (hostBlocked(host, policy.blocked)) return refused("blocked");
  return { allowed: true, url: address, origin: url.origin } as Allowed;
}

/**
 * The decision for `address`. `frameOrigin` is the origin of the frame it runs in or the page that
 * asked for it (a request's initiator), null when there is none: a new tab's first address.
 */
export function decide(address: string, policy: BrowserPolicy, frameOrigin: string | null = null): BrowserDecision {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return refused("invalid");
  }
  if (NETWORK.has(url.protocol)) return networkDecision(url, address, policy);
  if (url.protocol === "blob:" || url.protocol === "filesystem:") {
    // the parsed address, so a spelling the parser tidies (a leading space, upper case) is read the same
    let inner: URL;
    try {
      inner = new URL(url.href.slice(url.protocol.length));
    } catch {
      return refused("invalid");
    }
    // only a page has an origin to hold a blob: a socket's address makes an opaque one
    if (inner.protocol !== "http:" && inner.protocol !== "https:") return refused("scheme");
    const decision = networkDecision(inner, address, policy);
    return decision.allowed ? ({ ...decision, url: address } as Allowed) : decision;
  }
  if (FRAME_OWNED.has(url.protocol)) {
    if (frameOrigin === null || frameOrigin === "null") return refused("opaque");
    const frame = decide(frameOrigin, policy);
    return frame.allowed ? ({ allowed: true, url: address, origin: frame.origin } as Allowed) : frame;
  }
  return refused("scheme");
}

/**
 * What a tab's address shows: its origin and path, without the query and fragment that may carry a
 * token. Only an allowed address has one; a blob: or a data: shows the origin it was decided by.
 */
export function shownAddress(decision: Allowed): string {
  const url = new URL(decision.url);
  if (!NETWORK.has(url.protocol)) return decision.origin;
  return `${url.origin}${url.pathname}`;
}
