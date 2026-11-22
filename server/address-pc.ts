/**
 * Another PC's own Ovis added by its address (Add a connection → Direct, docs/remote-pcs.md). This server pairs with it
 * the way a script does (#2744): that PC shows a six-digit code, its POST /api/devices/pair answers this server's device
 * token in JSON, and every later request carries it as `Authorization: Device <token>`. That PC lists this one as one
 * more paired device that drives it, which it can revoke. A loopback forward then gives the PC the same `{ url, token }`
 * endpoint an SSH local forward or a relay tunnel gives (machines.ts), so everything that reads a remote PC through its
 * endpoint (its roster, status socket, API routes and terminals) runs unchanged.
 *
 * Nothing of this server's own callers crosses to that PC: requests and answers pass only the relay's header allowlists
 * (shared/relay-mux.ts), so no cookie, Authorization or forwarding header goes either way, and the device token is
 * read from its 0600 file only into the forward's upstream requests.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { BlockList, isIP } from "node:net";

import type { AddressPcFailure } from "../shared/machines.ts";
import { MAX_LARGE_WS_MESSAGE_BYTES, REQUEST_HEADERS, RESPONSE_HEADERS } from "../shared/relay-mux.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import { OUTPUT_HARD_BYTES } from "./output-window.ts";
import { writePrivateState } from "./private-state.ts";
import { readCappedJson, REMOTE_LIMITS } from "./remote-json.ts";

/** Why no PC was added by its address (POST /api/machines/address answers `address_pc_<failure>`, the app words each one). */
export class AddressPcError extends Error {
  constructor(readonly failure: AddressPcFailure) {
    super(ADDRESS_PC_WORDS[failure][0]);
    this.name = "AddressPcError";
  }
}
export const ADDRESS_PC_WORDS: Record<AddressPcFailure, [string, number]> = {
  address: ["Enter only that PC's Ovis address, starting with https://", 400],
  target: ["That address cannot be another PC's Ovis.", 400],
  code: ["Type the six-digit code that PC shows.", 400],
  wrong_code: ["That code is wrong, spent or expired. Show a new code on that PC and type it.", 400],
  waiting: ["That PC refuses codes for a while after wrong ones. Wait a minute, then try again.", 429],
  unreachable: ["No PC answered at that address. Check it, and that Ovis runs there.", 502],
  not_ovis: ["No Ovis that pairs devices answered at that address. Update Ovis there, or check the address.", 502],
  added: ["That PC is already added.", 409],
  self: ["That address is this PC's own Ovis.", 400],
};

/** That PC turned this one away for good (revoked it): trying again could only fail the same way. */
export class AddressPcRefused extends Error {
  constructor(message = "That PC no longer accepts this one. Remove it here and add it again with a new code from that PC.") {
    super(message);
    this.name = "AddressPcRefused";
  }
}

const PAIR_MS = 15_000;
const WAITING_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Addresses an Ovis address may not lead to. The point is the owner's other PCs, so a public address, the LAN and
 * Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) are all taken; what is never a PC's Ovis is refused: link-local (a
 * cloud's metadata service lives there), unspecified, multicast and broadcast addresses.
 */
const NEVER = new BlockList();
NEVER.addSubnet("0.0.0.0", 8, "ipv4");
NEVER.addSubnet("169.254.0.0", 16, "ipv4");
NEVER.addSubnet("224.0.0.0", 4, "ipv4");
NEVER.addAddress("255.255.255.255", "ipv4");
NEVER.addAddress("::", "ipv6");
NEVER.addSubnet("fe80::", 10, "ipv6");
NEVER.addSubnet("ff00::", 8, "ipv6");

/** BlockList matches an IPv4-mapped IPv6 address (::ffff:a.b.c.d) against the IPv4 rules itself. */
function refusedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || NEVER.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The origin an address names: https, or plain http only to this PC itself (a pairing code and the device token cross
 * it). Only an origin: a path, query, fragment or user name is refused rather than dropped.
 */
export function addressOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new AddressPcError("address");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AddressPcError("address"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) throw new AddressPcError("address");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new AddressPcError("address");
  return url.origin;
}

export async function checkAddressTarget(origin: string, resolve: typeof lookup = lookup): Promise<void> {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try { addresses = (await resolve(host, { all: true })).map((entry) => entry.address); }
    catch { throw new AddressPcError("unreachable"); }
  }
  if (addresses.length === 0 || addresses.some(refusedAddress)) throw new AddressPcError("target");
}

/** The boot id of the Ovis at `origin` (its open health answer), or null: this server's own says the address is itself. */
export async function addressBootId(origin: string): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/api/health?scope=bridge`, { redirect: "error", signal: AbortSignal.timeout(PAIR_MS) });
    const health = await readCappedJson<{ web_ui?: { boot_id?: unknown } } | null>(response, REMOTE_LIMITS.health);
    return typeof health?.web_ui?.boot_id === "string" ? health.web_ui.boot_id : null;
  } catch { return null; }
}

/**
 * Pairs this server with the PC at `origin` with the code that PC shows, and answers the device token it gave. Only the
 * code and this server's label are sent; that PC's own words are not passed on, only what they mean.
 */
export async function pairAddressPc(origin: string, code: string, label: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api/devices/pair`, {
      method: "POST", redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code, label }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PAIR_MS)]) : AbortSignal.timeout(PAIR_MS),
    });
  } catch { throw new AddressPcError("unreachable"); }
  const answer = await readCappedJson<{ token?: unknown; error?: { code?: unknown } } | null>(response, REMOTE_LIMITS.bridgeError).catch(() => null);
  if (response.status === 401 && answer?.error?.code === "invalid_code") throw new AddressPcError("wrong_code");
  if (response.status === 429) throw new AddressPcError("waiting");
  if (response.ok && typeof answer?.token === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(answer.token)) return answer.token;
  throw new AddressPcError("not_ovis");
}

export function saveAddressPcToken(path: string, token: string): void { writePrivateState(path, { v: 1, token }); }

/**
 * The saved device token. A file that is gone or holds no token is lost for good (AddressPcRefused); any other read
 * failure (permissions, I/O) may pass, so it is thrown as it is and the PC is tried again, as a relay PC's key is.
 */
export function loadAddressPcToken(path: string): string {
  const lost = () => new AddressPcRefused("This PC's pairing could not be read. Remove it here and add it again with a new code from that PC.");
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw lost();
    throw error;
  }
  let token: unknown;
  try { token = (JSON.parse(text) as { token?: unknown } | null)?.token; } catch { throw lost(); }
  if (typeof token !== "string") throw lost();
  return token;
}

export function removeAddressPcToken(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface AddressPcForward {
  readonly endpoint: { url: string; token: string };
  close(): void;
}

type Forwarded = { target: string; upstream?: WebSocket; opened: boolean; waiting: (string | Uint8Array<ArrayBuffer>)[]; waitingBytes: number };
/** frames a socket may send before that PC's end is open, whatever their size */
const WAITING_FRAMES = 1024;

/**
 * The loopback endpoint for the PC at `origin`: 127.0.0.1 on a free port, behind a bearer made fresh for this forward,
 * whose requests and sockets go to that PC with this server's device token. A 401 there is that PC refusing this one
 * (revoked): `onLost` hears AddressPcRefused and the forward closes.
 */
export function openAddressPcForward(origin: string, deviceToken: string, onLost: (error: Error) => void): AddressPcForward {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (request: Request): boolean => {
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const upstreamHeaders = (from: Headers): Headers => {
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = from.get(name);
      if (value !== null && name !== "content-length") headers.set(name, value);
    }
    headers.set("authorization", `Device ${deviceToken}`);
    return headers;
  };
  let closed = false;
  let forced = false;
  // the forward stops taking requests at once; what is still in flight ends when the manager disconnects the PC on
  // hearing the refusal (close), which stops the listener outright
  const refused = (): void => {
    if (closed) return;
    close(false);
    onLost(new AddressPcRefused());
  };
  // a 401 from one of that PC's routes, or a socket that never opened, may be that route's own answer: that PC is
  // asked once whether it still takes this one, and only a 401 there too is a revocation. It is answered before the
  // 401 or the socket's close is passed on, so the manager hears the refusal before the failure
  const checkRefused = async (): Promise<void> => {
    if (closed) return;
    try {
      const response = await fetch(`${origin}/api/session`, { headers: { authorization: `Device ${deviceToken}` }, redirect: "error", signal: AbortSignal.timeout(PAIR_MS) });
      void response.body?.cancel();
      if (response.status === 401) refused();
    } catch { }
  };

  const sockets = new Set<Bun.ServerWebSocket<Forwarded>>();
  const server = Bun.serve<Forwarded>({
    // no idle cut of its own (Bun's default is 10 s): a slow answer from the PC is bounded by the one asking
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request, bun) {
      if (!authorized(request)) return new Response(null, { status: 401 });
      if (closed) return new Response(null, { status: 502 });
      const url = new URL(request.url);
      const target = url.pathname + url.search;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return bun.upgrade(request, { data: { target, opened: false, waiting: [], waitingBytes: 0 } }) ? undefined : new Response(null, { status: 400 });
      }
      let response: Response;
      try {
        response = await fetch(origin + target, {
          method: request.method, headers: upstreamHeaders(request.headers), redirect: "error", signal: request.signal,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        });
      } catch { return new Response(null, { status: 502 }); }
      if (response.status === 401) await checkRefused();
      // the body arrives decoded, so its encoding and length are this server's to frame again
      const headers = new Headers();
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null && name !== "content-length") headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    },
    websocket: {
      open(local) {
        sockets.add(local);
        const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
        const upstream = new RuntimeSocket(origin.replace(/^http/, "ws") + local.data.target, { headers: { authorization: `Device ${deviceToken}` } });
        upstream.binaryType = "arraybuffer";
        local.data.upstream = upstream;
        upstream.onopen = () => {
          local.data.opened = true;
          for (const message of local.data.waiting) upstream.send(message);
          local.data.waiting = []; local.data.waitingBytes = 0;
        };
        // as this PC's own sockets: output that cannot be delivered, or backs up past the budget, ends the socket (4008)
        upstream.onmessage = (event) => {
          const sent = local.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
          if (sent === 0 || local.getBufferedAmount() > OUTPUT_HARD_BYTES + MAX_LARGE_WS_MESSAGE_BYTES) local.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
        };
        upstream.onclose = async (event) => {
          if (!local.data.opened) await checkRefused();
          local.close(event.code >= 3000 && event.code <= 4999 || event.code === 1000 ? event.code : 1011, event.reason.slice(0, 100));
        };
      },
      message(local, message) {
        const data = typeof message === "string" ? message : new Uint8Array(message);
        const upstream = local.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) {
          // input that piles up toward that PC is not dropped quietly either: the socket ends and the app reconnects
          if (upstream.bufferedAmount > OUTPUT_HARD_BYTES) { local.close(1009, "input to the PC backed up"); return; }
          upstream.send(data);
          return;
        }
        local.data.waitingBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (local.data.waitingBytes > WAITING_BYTES || local.data.waiting.length >= WAITING_FRAMES) { local.close(1009, "too much sent before the PC answered"); return; }
        local.data.waiting.push(data);
      },
      close(local, code, reason) {
        sockets.delete(local);
        local.data.waiting = [];
        local.data.upstream?.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason.slice(0, 100));
      },
    },
  });
  function close(force = true): void {
    if (closed && (forced || !force)) return;
    if (!closed) for (const socket of sockets) socket.close(1012, "PC connection lost");
    closed = true;
    forced = force;
    void server.stop(force);
  }
  return { endpoint: { url: `http://127.0.0.1:${server.port}`, token }, close: () => close() };
}
