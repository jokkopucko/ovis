import type { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { SIGN_IN_WAIT_MS } from "../account/mailbox.ts";
import type { RelaySessionOptions } from "./session.ts";

/** Unknown IDs and invalid proofs still take the limited pull path; only proved expired rows can rejoin. */
export async function pullForRefusedSignIn(
  options: Pick<RelaySessionOptions, "services" | "serverId">,
  proof: { readonly deviceId: string; readonly nonce: Uint8Array; readonly signature: string },
  mux: Pick<MuxEngine, "active" | "extendSetup">,
): Promise<boolean> {
  const { devices, accountMailbox } = options.services;
  if (devices.account() === null) return true;
  const { deviceId, nonce, signature } = proof;
  // a devices.json row still waiting for the first whole read (S22) takes the pull too, so its sign-in starts the read
  if (await devices.matchRelay(deviceId, nonce, signature, options.serverId) !== null && !devices.catchingUp(deviceId)) return mux.active;
  const joined = devices.opensAll() ? await devices.matchAccountRelay(deviceId, nonce, signature, options.serverId) : null;
  if ((devices.opensAll() && !mux.active) || (joined !== null && "match" in joined)) return mux.active;
  mux.extendSetup(SIGN_IN_WAIT_MS + 10_000);
  await accountMailbox.pullForRefusedSignIn(SIGN_IN_WAIT_MS, Date.now(), joined?.readmission);
  return mux.active;
}
