import type { Access } from "./access.ts";
import { sameBrowser } from "./devices.ts";
import type { ServerContext } from "./dispatch.ts";
import type { MachineEventDocument } from "./machine-events.ts";

/** Pairing events visible to this browser's authorized machine-event document. */
export function machinePairingEvents({ services, peer }: ServerContext, access: Access, keys: readonly string[]): NonNullable<MachineEventDocument["pairings"]> {
  const { devices, pendingRedemptions, relay } = services;
  const deviceId = access.level === "full" ? access.device?.id : undefined;
  const openAccess = access.level === "full" && access.via === "open";
  const driving = access.level === "full" && access.role === "drive" && access.via !== "open";
  return { subscribe(listener) {
    // An enrollment excludes its own device and asking browser. The enrollment closes the gate on the open LAN.
    const stopPaired = devices.onPaired((event, origin) => {
      if (!openAccess && event.device_id !== deviceId && !sameBrowser(origin, keys)) listener(event);
    });
    const stopRemoved = driving ? devices.onRemoved(listener) : undefined;
    // Direct approvers see the digits; drive account members on the relay get three candidates instead.
    const approver = driving && access.via !== "relay" && access.via !== "portal";
    const remoteApprover = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
    const stopRelay = approver ? relay.approvals.subscribe((list) => listener({ type: "relay-pairings", pairings: list }))
      : remoteApprover ? relay.approvals.subscribeRemote((list) => listener({ type: "remote-pairings", pairings: list })) : undefined;
    // A window that lost the right to approve needs to clear its prompts.
    if (!approver) listener({ type: "relay-pairings", pairings: [] });
    let stopPending: (() => void) | undefined;
    if (driving && pendingRedemptions !== undefined) {
      // Approval stays on the PC's screen. Read before registering: view() can itself expire keys.
      const tellPending = () => listener({ type: "pending-redemptions", pending: pendingRedemptions.view() });
      tellPending();
      stopPending = pendingRedemptions.onChange(tellPending);
    }
    return () => { stopPaired(); stopRemoved?.(); stopRelay?.(); stopPending?.(); };
  } };
}
