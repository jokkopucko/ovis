import type { DeviceRoute } from "../../../shared/access.ts";
import { probePc } from "../../../shared/relay-channel.ts";
import type { PcProbe, RelaySocket } from "../../../shared/relay-channel.ts";
import type { RelayDevice } from "../../../shared/relay-device.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { isTailnetCarrier } from "../../../shared/relay-mux.ts";
import { relayFallback } from "../../../shared/relay-regions.ts";
import { keyIdOf } from "./shellState.ts";

export type PcStatus =
  /** `previous`: what the last finished check found, which the row keeps showing while this one runs */
  | { readonly kind: "checking"; readonly previous?: PcFinding }
  /** the PC finished the encrypted handshake on `route`; the check stops before signing in, so this device's own admission is not known */
  | { readonly kind: "answered"; readonly route: DeviceRoute; readonly relay?: string; readonly rttMs: number }
  /** `pc`: the relay had nobody for it; `refused`: the relay turned this device away; `relay`: no relay was reached, or one failed saying nothing */
  | { readonly kind: "offline"; readonly reason: "pc" | "refused" | "relay" };

/** A finished check's result. */
export type PcFinding = Exclude<PcStatus, { kind: "checking" }>;

/** Every direct carrier together gets this long, as a connection gives them (transport.ts DIRECT_BUDGET_MS). */
export const DIRECT_PROBE_MS = 1_500;
export const RELAY_PROBE_MS = 8_000;

export interface PcCheckSockets {
  readonly relay: (url: string) => RelaySocket;
  readonly direct?: (url: string) => RelaySocket;
}

/**
 * The saved PCs one sweep probes: paired ones whose key is the one their id names (a mismatch is the
 * identity-changed screen's to handle), at most `max`, starting at `cursor` so that past `max` every
 * PC gets its turn. The rows marked as being checked are exactly these.
 */
export function sweepOf(devices: readonly RelayDevice[], cursor: number, max: number): RelayDevice[] {
  const paired = devices.filter((device) => device.device_id !== null && keyIdOf(device.server_public_key) === device.server_id);
  const start = paired.length > max && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor % paired.length : 0;
  return [...paired.slice(start), ...paired.slice(0, start)].slice(0, max);
}

export async function checkPc(device: RelayDevice, sockets: PcCheckSockets, probe: typeof probePc = probePc): Promise<PcFinding> {
  const offer: RelayOffer = { v: 1, server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay };
  const carriers = sockets.direct ? device.direct ?? [] : [];
  const deadline = Date.now() + DIRECT_PROBE_MS;
  for (const [index, direct] of carriers.entries()) {
    const found = await probe(offer, { direct }, sockets.direct!, Math.max(0, deadline - Date.now()) / (carriers.length - index));
    if (found.kind === "answered") return { kind: "answered", route: isTailnetCarrier(direct) ? "tailscale" : "lan", rttMs: found.ms };
  }
  let relay = device.relay;
  let found: PcProbe = await probe(offer, { relay }, sockets.relay, RELAY_PROBE_MS);
  const fallback = relayFallback(relay);
  if (found.kind !== "answered" && fallback !== null) {
    const first: PcProbe = found;
    found = await probe(offer, { relay: fallback }, sockets.relay, RELAY_PROBE_MS);
    if (found.kind === "answered") relay = fallback;
    else if (first.kind === "silent" && found.kind === "silent") found = first;
  }
  return found.kind === "answered" ? { kind: "answered", route: "relay", relay, rttMs: found.ms }
    : { kind: "offline", reason: found.kind === "silent" ? "pc" : found.kind === "refused" ? "refused" : "relay" };
}
