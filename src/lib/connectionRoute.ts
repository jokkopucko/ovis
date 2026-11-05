/**
 * How this device reaches the Ovis it shows, from facts the page owns: the hosted shell's relay
 * transport, a Portal sign-in, the server's word on how this request came (Portal, Tailscale Funnel,
 * the public internet, or Tailscale serve), or the address the browser loaded the app from. Nothing guesses what lies
 * behind a name: an address that is none of the known kinds, a bare machine name included (a LAN
 * host, or a Tailscale MagicDNS short name), is "direct". A loopback address is "local": this PC, or
 * a tunnel to another one, which neither the page nor the server can tell apart.
 */
import type { ObservedIngress } from "../../shared/protocol.ts";

export type ConnectionRoute = "relay" | "portal" | "local" | "tailscale" | "tailscale-name" | "lan" | "direct";

/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48 */
function tailnetHost(host: string): boolean {
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) { const second = Number(v4[1]); return second >= 64 && second <= 127; }
  return host.startsWith("fd7a:115c:a1e0:");
}

/** A private network's addresses (RFC 1918, link-local, IPv6 unique-local) and names only it answers */
function lanHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) {
    const [first, second] = [Number(v4[1]), Number(v4[2])];
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
  }
  if (host.includes(":")) return /^f[cd]/.test(host) || host.startsWith("fe80:");
  return host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa");
}

/** The route, or null in the phone app's bundled demo, which reaches no PC at all. */
export function connectionRoute(page: { relay: boolean; portal: boolean; ingress: ObservedIngress | null; protocol: string; hostname: string }): ConnectionRoute | null {
  if (page.protocol === "capacitor:") return null;
  if (page.relay) return "relay";
  if (page.portal || page.ingress === "portal") return "portal";
  if (page.ingress === "funnel") return "direct";
  if (page.ingress === "tailscale") return "tailscale";
  // a trailing root dot names the same host (the server's own host check drops it too)
  const host = page.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (/^127(?:\.\d{1,3}){3}$/.test(host) || host === "localhost" || host.endsWith(".localhost") || host === "::1") return "local";
  if (tailnetHost(host)) return "tailscale";
  // a MagicDNS name is served to the tailnet and, through Funnel, to the internet: unless the server
  // proved this request's way in (above), the name alone cannot tell which
  if (host.endsWith(".ts.net")) return "tailscale-name";
  if (lanHost(host)) return "lan";
  return "direct";
}
