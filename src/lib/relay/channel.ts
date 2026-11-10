import { openRelayChannel as openSharedChannel } from "../../../shared/relay-channel.ts";
import type { RelayChannel, RelayChannelOptions as SharedChannelOptions } from "../../../shared/relay-channel.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { indexedDeviceStore } from "./device.ts";
import type { RelayDeviceStore } from "./device.ts";

export { ADMISSION_MS, ASSIGNMENT_MS, PC_ANSWER_MS, RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayPcOfflineError, RelayUnreachableError, UnsafeRelayDestinationError } from "../../../shared/relay-channel.ts";
export type { RelayChannel, RelayServerInfo, RelaySocket } from "../../../shared/relay-channel.ts";

/** In the hosted app a PC's key is kept in this browser's IndexedDB unless another store is given. */
export type RelayChannelOptions = Omit<SharedChannelOptions, "store"> & { readonly store?: RelayDeviceStore };

/** Resolves only after protected Noise, WELCOME and device admission all succeeded. Never retries. */
export function openRelayChannel(offer: RelayOffer, options: RelayChannelOptions = {}): Promise<RelayChannel> {
  return openSharedChannel(offer, { ...options, store: options.store ?? indexedDeviceStore });
}
