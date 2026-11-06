import { useCallback, useRef, useSyncExternalStore } from "react";
import { Globe, Monitor, Network, RadioTower, Wifi, type LucideIcon } from "lucide-react";

import type { ObservedIngress } from "../../shared/protocol.ts";
import { connectionRoute } from "../lib/connectionRoute.ts";
import { useT } from "../lib/i18n.ts";
import { getTransport } from "../lib/transport.ts";
import { inRelayShell } from "../lib/useRelay.ts";

const noRoute = (): (() => void) => () => {};

/** Whether the hosted shell's relay transport reaches the PC on one of its direct carriers now (the phone apps, at home). */
function useDirectCarrier(relay: boolean): boolean {
  const transport = relay ? getTransport() as { route?: unknown; onRouteChange?: (listener: () => void) => () => void } : null;
  // one subscription per transport, not one per render
  const subscribe = useCallback((listener: () => void) => transport?.onRouteChange ? transport.onRouteChange(listener) : noRoute(), [transport]);
  return useSyncExternalStore(subscribe, () => transport?.route === "direct");
}

/**
 * How this device reaches the Ovis it shows (lib/connectionRoute.ts), in the header at all times:
 * one glyph and one short word, the route said in its title whatever the connection's state (the
 * chip beside it tells that). It is about the page's own connection, which every PC the sidebar
 * lists shares, so it sits with the chip, not on a PC. Tailscale and LAN are names, the same in
 * every language. Nothing in the phone app's demo, which reaches no PC.
 */
export function ConnectionRouteMark({ portal, ingress }: { portal: boolean; ingress: ObservedIngress | null }) {
  const t = useT();
  // the server's word on this page's requests holds through a failed health read, which clears the
  // facts it brought: a missing answer is no evidence of another route
  const known = useRef<ObservedIngress | null>(null);
  if (ingress !== null) known.current = ingress;
  const relay = inRelayShell();
  const directCarrier = useDirectCarrier(relay);
  const route = connectionRoute({ relay, portal, ingress: known.current, protocol: window.location.protocol, hostname: window.location.hostname });
  if (route === null) return null;
  const shown = route === "relay" && directCarrier ? "relay-direct" : route;
  const [Icon, word, title]: [LucideIcon, string, string] =
    shown === "relay-direct" ? [Wifi, t("direct"), t("Directly on the same network, not through the relay")]
    : route === "relay" ? [RadioTower, t("relay"), t("Via the Ovis relay")]
    : route === "portal" ? [RadioTower, t("relay"), t("Via the Portal relay")]
    : route === "tailscale" ? [Network, "Tailscale", t("Via Tailscale")]
    : route === "tailscale-name" ? [Network, "Tailscale", t("Via Tailscale, or Funnel from the internet")]
    : route === "lan" ? [Wifi, "LAN", t("Via the local network")]
    : route === "direct" ? [Globe, t("direct"), t("Straight to this address")]
    : [Monitor, t("local"), t("Via a loopback address: this PC, or a tunnel to it")];
  return (
    <span className="conn-route" data-route={shown} title={title}>
      <Icon aria-hidden="true" />
      <span className="conn-route-word" aria-hidden="true">{word}</span>
      <span className="visually-hidden">{title}</span>
    </span>
  );
}
