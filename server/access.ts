/**
 * Who a request is and whether it gets in. There is no user database: a request is trusted
 * for where it comes from (this PC, with no proxy in front), for who Tailscale says it is
 * (the PC's own login, which `tailscale serve` states in a header it strips from what it
 * receives), or for what it holds (a paired device's cookie, or the shared token). A token,
 * when one is configured, is required of everything but a paired device, this PC and its own
 * Tailscale login included: a plain local connection, since the remote-PC bridge runs on a
 * loopback port of a PC other people may use, and the login, since any other proxy on this PC
 * (nginx, Caddy, a tunnel) passes a visitor's copy of that header on unless told to drop it.
 * Without a token, and until the first device is paired, anything that reaches the server is
 * let in as it always was, except through a proxy
 * on a PC whose Tailscale login is known: there, a request with no login header is a tagged
 * node (tailscale serve states no person for it), and a tailnet can hold many of those. The
 * exception is an install whose operator declared `tailscale serve` the only way in
 * (OVIS_TAILSCALE_SERVE_ONLY) on a tailnet Tailscale says holds no tagged node and no second
 * login: no stranger exists there to be mistaken for, so a serve-proxied request with no login is
 * the owner, and the owner's own phone opens the address without a code. On that path, and only
 * there, the request's Host must name this PC's own Tailscale name or address: `tailscale serve`
 * passes the client's Host through, and under the declaration no other ingress exists to forge it
 * through, while a rebinding page can only ever present its own origin.
 * A PC whose own node is tagged has no login to compare with: its proxied requests pair, the
 * owner's included, unless OVIS_TAILSCALE_OWNER names the login to let in.
 *
 * A proxy on this PC connects from loopback like a local client does, so it is known only by
 * what it sends: a forwarding header, or a Host that is not a name for this machine. A proxy
 * that sends neither (nginx's bare `proxy_pass` rewrites Host to the upstream address and adds
 * nothing) cannot be told from a local client: only a token closes that setup.
 *
 * Portal's own sign-in (a private link, an Ethereum wallet, an OIDC account) is one more way in,
 * and the one exception to "a token is required of everything but a paired device": a visitor it let
 * in may watch by default, with no token asked. The owner's app token and paired-device role still
 * take precedence; a Portal identity alone does not identify the owner. Invites store their role
 * server-side, never in a visitor-supplied header. Its X-Portal-User and
 * X-Portal-Auth are believed only with the proof Portal sends beside them (`portalLogin`).
 */
import { BlockList, isIP } from "node:net";
import { PORTAL_SIGN_INS } from "../shared/portal.ts";
import type { AccessRefusal, AccessVia, BindScope, DeviceRole, ObservedIngress, PortalLogin } from "../shared/protocol.ts";
import type { DeviceMatch } from "./devices.ts";

export interface AccessInput {
  /** Authenticated by the relay transport, never derived from request headers or cookies. */
  relayPeer?: DeviceMatch;
  /** the connection came from this machine: 127/8, ::1 or their IPv4-mapped forms */
  loopback: boolean;
  /** a proxy in front shows in the request (`cameThroughProxy`): tailscale serve and most reverse proxies do */
  forwarded: boolean;
  /** Tailscale-Funnel-Request: the request came from the public internet through Funnel */
  funnel: boolean;
  /** Tailscale-User-Login: set by tailscale serve for a person's device, absent for tagged nodes */
  tailscaleLogin: string | null;
  /** X-Forwarded-For: Serve replaces this with one source address, never a proxy chain */
  forwardedFor?: string | null;
  /** the request's Host header, as sent */
  host: string | null;
  /** the shared token matched (cookie or bearer) */
  tokenMatched: boolean;
  /** the device the cookie belongs to */
  device: DeviceMatch | null;
  /** the PC's own Tailscale login, when known */
  owner: string | null;
  /** this PC's Tailscale node is tagged: Tailscale runs here, and names no person as its owner */
  tagged: boolean;
  /** the one login `tailscale status` proves owns every node of this tailnet, none tagged (`parseSoleTailnetLogin`), or null */
  soleLogin: string | null;
  /** this PC's MagicDNS name from `tailscale status`, without its trailing dot */
  dnsName: string | null;
  /** this PC's IPv4 address on the tailnet from `tailscale status` */
  tailnetIp: string | null;
  /** the operator declared `tailscale serve` as this install's only ingress (OVIS_TAILSCALE_SERVE_ONLY) */
  serveOnly: boolean;
  tokenConfigured: boolean;
  /** a device cookie was confirmed by DeviceStore.match: the gate is closed to strangers */
  gated: boolean;
  /** Portal's sign-in, when this server's Portal runs one; unset is as if it did not */
  portal?: {
    /** the request's X-Portal-Proof is the proof of the Portal running with a sign-in (`PortalService.vouches`) */
    proven: boolean;
    /** the request's X-Portal-User, as sent */
    user: string | null;
    /** the request's X-Portal-Auth, as sent */
    auth: string | null;
    /** the server's stored invitation role, never a request header; absent means watch */
    role?: DeviceRole;
  };
}

export type Access =
  | { level: "full"; via: AccessVia; role: DeviceRole; device?: DeviceMatch; login?: string; portal?: PortalLogin }
  | { level: "none"; reason: AccessRefusal };

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * Is this bind address one only this machine can reach, so an unset token is nobody else's
 * business? Any spelling of loopback counts: `127.0.0.2`, `[::1]`, `LOCALHOST`, `::ffff:127.0.0.1`.
 * A name that merely resolves to loopback is not recognised; the bind address is what Bun was
 * given, not what DNS says of it.
 */
export function isLoopbackBind(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  // the address tests apply to an address: a DNS name such as 127.devbox.example may point anywhere
  const literal = /^[\d.]+$/.test(name) || name.includes(":");
  return name === "localhost" || name.endsWith(".localhost") || (literal && isLoopbackAddress(name));
}

/**
 * Is the server answering beyond this PC and its tailnet while no access token is set and no
 * device has ever been paired? Every client that can reach that address is let in as `open`
 * (see `decideAccess`), so this is the state a warning belongs to — told to whoever already
 * got in, never used to change a default.
 *
 * `hostname` is the address the server is bound to, not the one the request arrived on: a
 * loopback bind is local, and a Tailscale-only bind is reachable only within the tailnet.
 */
export function lanExposed(input: { hostname: string; tokenConfigured: boolean; gated: boolean }): boolean {
  return bindScope(input.hostname) === "other" && !input.tokenConfigured && !input.gated;
}

/**
 * Where the configured bind address answers, read from the address literal alone: any spelling of
 * loopback (`isLoopbackBind`), a Tailscale address, or anything else (a LAN address, a wildcard, a
 * DNS name). A name is never resolved, and nothing here says what a proxy in front forwards.
 */
export function bindScope(hostname: string): BindScope {
  if (isLoopbackBind(hostname)) return "loopback";
  const address = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const family = isIP(address);
  return (family === 4 ? tailnetIpv4.check(address, "ipv4") : family === 6 && tailnetIpv6.check(address, "ipv6")) ? "tailnet" : "other";
}

/** Is this one address (never a list) in Tailscale's assigned ranges? */
export const inTailnet = (address: string | null | undefined): boolean => {
  const family = isIP(address ?? "");
  return family === 4 ? tailnetIpv4.check(address!, "ipv4") : family === 6 && tailnetIpv6.check(address!, "ipv6");
};

/**
 * How this one request reached the server, as far as the request proves it; never how every
 * device reaches it. Tailscale's headers are only evidence where the operator declared serve the
 * only ingress (OVIS_TAILSCALE_SERVE_ONLY): elsewhere any client on this PC, or another proxy
 * passing a visitor's copy on, can send the same shape. So Tailscale and Funnel are labelled only
 * on that declared install, from loopback, while Tailscale runs here, and (Tailscale) with the
 * tailnet source address it writes. A Tailscale header that fails those checks is `unknown`,
 * other forwarding is `proxy`, and an unforwarded request is `direct` (a proxy that adds nothing,
 * nginx's bare `proxy_pass`, looks the same: see `cameThroughProxy`).
 */
export function observedIngress(input: Pick<AccessInput, "loopback" | "forwarded" | "funnel" | "tailscaleLogin" | "forwardedFor" | "owner" | "tagged" | "serveOnly"> & {
  /** the connection's source address is known at all */
  peerKnown: boolean;
  /** a forwarding header (`forwardingHeaders`) came with the request */
  forwardingHeaders: boolean;
}): Exclude<ObservedIngress, "relay" | "portal"> {
  if (!input.peerKnown) return "unknown";
  const tailscaleHere = input.owner !== null || input.tagged;
  const throughServe = input.serveOnly && input.loopback && tailscaleHere;
  const fromTailscale = throughServe && inTailnet(input.forwardedFor ?? null);
  if (input.funnel) return throughServe ? "funnel" : "unknown";
  if (input.tailscaleLogin !== null) return fromTailscale ? "tailscale" : "unknown";
  // a request with no login: a tagged node, or the owner's own grant
  if (fromTailscale && input.forwarded) return "tailscale";
  if (input.forwardingHeaders) return "proxy";
  // from this PC, a Host that does not name it is a proxy rewriting nothing but the address
  return input.loopback && input.forwarded ? "proxy" : "direct";
}

/** Is there a forwarding header on the request, whoever sent it? Unlike `cameThroughProxy`, a Host header alone does not count. */
export function forwardingHeaders(headers: Headers): boolean {
  return PROXY_HEADERS.some((name) => headers.has(name)) || headers.has("tailscale-funnel-request");
}

/** Headers a proxy adds and a browser or CLI on this PC has no reason to send; a Tailscale login is stated by a proxy too. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "tailscale-user-login"];

/**
 * The name a Host header addresses, lower-cased, without its port or its DNS root dot. It is read
 * as a bare authority, a name or a bracketed address with an optional port, and nothing else:
 * handed to a URL parser, `public.example@localhost` and `localhost/x@public.example` both came
 * out as localhost.
 */
export function hostName(host: string): string | null {
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host);
  // one trailing dot is the DNS root, the same name
  return authority ? authority[1]!.toLowerCase().replace(/\.$/, "") : null;
}

/** Is this Host header a name for this machine itself? */
export function isLoopbackHost(host: string): boolean {
  const name = hostName(host);
  return name !== null && (name === "localhost" || name.endsWith(".localhost") || name === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(name) || /^\[::ffff:127(?:\.\d{1,3}){3}\]$/.test(name));
}

/**
 * Evidence that a request reached this server through a proxy. Claiming it only ever costs the
 * sender the trust a local connection has, so a forged header gains nothing.
 */
export function cameThroughProxy(headers: Headers): boolean {
  if (PROXY_HEADERS.some((name) => headers.has(name))) return true;
  // no Host at all is not how a browser or a CLI on this PC asks (HTTP/1.0 through a proxy is)
  const host = headers.get("host");
  return host === null || !isLoopbackHost(host);
}

/** Does the request's Host name this PC on the tailnet, by its MagicDNS name or its IPv4 address? */
export function addressesNode(input: Pick<AccessInput, "host" | "dnsName" | "tailnetIp">): boolean {
  const name = input.host === null ? null : hostName(input.host);
  if (name === null) return false;
  return (input.dnsName !== null && name === input.dnsName.toLowerCase()) || (input.tailnetIp !== null && name === input.tailnetIp);
}

/** The request shape of the owner's no-login grant: a serve-only install, a forwarded request from loopback with no login, not Funnel. */
export function isServeOwnerRequest(input: Pick<AccessInput, "serveOnly" | "loopback" | "forwarded" | "funnel" | "tailscaleLogin">): boolean {
  return input.serveOnly && input.loopback && input.forwarded && !input.funnel && input.tailscaleLogin === null;
}

// Tailscale v1.102.3: ipn/ipnlocal/serve.go:1068-1106 replaces XFF and strips incoming identity.
// net/tsaddr/tsaddr.go defines the assigned address ranges. This filters ordinary forwarding
// proxies, not a raw tunnel whose sender can forge both the login and the address.
const tailnetIpv4 = new BlockList();
tailnetIpv4.addSubnet("100.64.0.0", 10, "ipv4");
const tailnetIpv6 = new BlockList();
tailnetIpv6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * Who Portal's sign-in let in. A header proves nothing by itself: any other way to this port
 * (`tailscale serve`, another proxy, a local client) lets a visitor type X-Portal-User and
 * X-Portal-Auth. So Portal also sends X-Portal-Proof, a secret made for each of its launches that
 * only this server and that Portal have (it is in the Portal's environment), and drops a visitor's
 * copy; the identity counts only with it (`portal.proven`). Without it, or with a wrong one, the
 * headers are ignored and the request meets the token rules like any other. The values must also be
 * shaped as Portal makes them.
 *
 * The proof is as private as the token: a process that can read this server's or Portal's
 * environment can read OVIS_TOKEN too.
 */
export function portalLogin(input: Pick<AccessInput, "portal">): PortalLogin | null {
  const { portal } = input;
  if (portal === undefined || !portal.proven) return null;
  const { user, auth } = portal;
  const method = PORTAL_SIGN_INS.find((candidate) => candidate === auth);
  if (user === null || method === undefined || !/^[\x20-\x7e]{1,260}$/.test(user) || user !== user.trim()) return null;
  // a wallet is its address; an OIDC account is an email or sub:<id>; a link is whatever its name is
  if (method === "siwe" ? !/^0x[0-9a-f]{40}$/i.test(user) : method === "oidc" && !user.startsWith("sub:") && !user.includes("@")) return null;
  return { user, method };
}

export function decideAccess(input: AccessInput): Access {
  if (input.relayPeer !== undefined) return { level: "full", via: "relay", role: input.relayPeer.role, device: input.relayPeer };
  if (input.tokenMatched) return { level: "full", via: "token", role: "drive" };
  if (input.device !== null) return { level: "full", via: "device", role: input.device.role, device: input.device };
  // before the token gate below, which holds every other way in: Portal's sign-in replaces the token
  const portal = portalLogin(input);
  if (portal !== null) return { level: "full", via: "portal", role: input.portal?.role ?? "watch", portal };
  // before the login header: a token must hold against a header a visitor can send through another proxy
  if (input.tokenConfigured) return { level: "none", reason: "token_required" };
  // the identity header is only worth something from the local tailscaled, never from a LAN client
  if (input.loopback && input.tailscaleLogin !== null && input.owner !== null) {
    const address = input.forwardedFor ?? "";
    const family = isIP(address);
    if (!(family === 4 ? tailnetIpv4.check(address, "ipv4") : family === 6 && tailnetIpv6.check(address, "ipv6"))) {
      return { level: "none", reason: "pairing_required" };
    }
    if (input.tailscaleLogin.toLowerCase() === input.owner.toLowerCase()) return { level: "full", via: "tailscale", role: "drive", login: input.tailscaleLogin };
    return { level: "none", reason: "other_user" };
  }
  // A proxied request with no login is a tagged node, which a tailnet can hold many of. Where the
  // operator declared tailscale serve the only ingress, Tailscale says one login owns every node on
  // this tailnet, none tagged, and the request is addressed to this PC, there is nobody for it to be
  // but the owner. Funnel is the public internet, which that proof says nothing about.
  const sole = input.soleLogin;
  if (sole !== null && input.owner?.toLowerCase() === sole.toLowerCase() && isServeOwnerRequest(input) && addressesNode(input)) {
    return { level: "full", via: "tailscale", role: "drive", login: sole };
  }
  if (input.loopback && !input.forwarded) return { level: "full", via: "local", role: "drive" };
  if (input.loopback && input.forwarded && (input.owner !== null || input.tagged || input.serveOnly)) return { level: "none", reason: "pairing_required" };
  // the public internet is never "open", whatever is paired
  if (!input.gated && !input.funnel) return { level: "full", via: "open", role: "drive" };
  return { level: "none", reason: "pairing_required" };
}
