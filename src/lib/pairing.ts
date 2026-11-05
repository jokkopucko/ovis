/**
 * This browser pairing itself, from the setup guide's Connect your phone or Settings → Phone's Pair
 * this device now: a code, used at once by this browser, so the gate closes to everyone else and the
 * phone paired next does not shut it out. One at a time across both views: two at once could leave
 * the later, already void, cookie in place of the good one (server/devices.ts confirms one per gate).
 */
import type { PairedDevice } from "../../shared/protocol.ts";
import { fetchDevices, pairDevice, startPairing } from "./api.ts";
import { deviceLabel } from "./phone.ts";

/** One run at a time: a call while one runs joins it; one after it finished starts another. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let out: Promise<T> | null = null;
  return () => out ??= run().finally(() => { out = null; });
}

/** the pairing went through but no listed device is this browser (its cookie did not stick) */
export class UnconfirmedPairing extends Error {}

/** This browser paired, unless the server already lists it; the device list after it (lib/pairing.ts). */
export const pairThisBrowser: () => Promise<PairedDevice[]> = singleFlight(async () => {
  // the server's word, not the app's access facts (they can be behind, or it paired in Settings):
  // a browser already paired gets no second device and keeps its cookie
  const known = await fetchDevices();
  if (known.some((device) => device.current)) return known;
  const fresh = await startPairing();
  await pairDevice(fresh.code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  const list = await fetchDevices();
  if (!list.some((device) => device.current)) throw new UnconfirmedPairing();
  return list;
});
