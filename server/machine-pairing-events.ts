import type { Access } from "./access.ts";
import { sameBrowser } from "./devices.ts";
import type { ServerContext } from "./dispatch.ts";
import type { MachineEventDocument } from "./machine-events.ts";
import type { RemotePairingRequest, RemotePairingsEvent } from "../shared/machines.ts";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import { shownTo, type JoinViewer } from "./join-notices.ts";

/**
 * The joins that wait at this PC, as a device on the relay is told them (`remote-pairings`): a member of this PC's
 * own devices that may approve, or a device of the account's list that may add devices to it (on a PC pinned to
 * that list). Whether it is told is asked for again at every telling, as its read of them is (relay/routes.ts), from
 * what this PC holds at that moment: its devices' word for a member, its copy of the list's for a device of the
 * list. The right it had when it subscribed (before this PC pinned its list, say) gives it nothing once it is gone:
 * it is then told, once, that nothing waits. Anybody else is told nothing, and subscribes to nothing.
 */
export function remotePairingEvents({ services, peer }: ServerContext): (listener: (event: RemotePairingsEvent) => void) => () => void {
  const { devices, relay, accountList } = services;
  return (listener) => {
    const remote = peer.kind === "relay" ? peer : null;
    const member = () => remote !== null && devices.isAccountApproverSession(remote.device.id, remote.key);
    const listed = () => remote !== null && remote.key !== "" && accountList?.allowsJoins(remote.key) === true;
    let shown = false;
    const tell = (as: "member" | "listed") => (list: RemotePairingRequest[]) => {
      const now = member() ? "member" : listed() ? "listed" : null;
      if (now === null) {
        if (shown) listener({ type: "remote-pairings", pairings: [] });
        shown = false;
        return;
      }
      shown = true;
      listener({ type: "remote-pairings", pairings: now === as ? list : now === "member" ? relay.approvals.remoteList() : relay.approvals.listJoins() });
    };
    const stopJoins = member() ? relay.approvals.subscribeRemote(tell("member")) : listed() ? relay.approvals.subscribeList(tell("listed")) : undefined;
    if (stopJoins === undefined) return () => {};
    // the list itself changed what it lets in: a device that lost the right is told so then, not at the next join
    const stopRights = devices.onListedChange(() => {
      if (!shown || member() || listed()) return;
      shown = false;
      listener({ type: "remote-pairings", pairings: [] });
    });
    return () => { stopJoins(); stopRights(); };
  };
}

/** Pairing events visible to this browser's authorized machine-event document. */
export function machinePairingEvents(ctx: ServerContext, access: Access, keys: readonly string[], viewer: JoinViewer): NonNullable<MachineEventDocument["pairings"]> {
  const { services, peer } = ctx;
  const { devices, joins, pendingRedemptions, relay } = services;
  const deviceId = access.level === "full" ? access.device?.id : undefined;
  const openAccess = access.level === "full" && access.via === "open";
  const driving = access.level === "full" && access.role === "drive" && access.via !== "open";
  return { subscribe(listener) {
    // An enrollment excludes its own device (by row, and by key: another row of the same key is that device too) and
    // asking browser. The enrollment closes the gate on the open LAN; this PC's own window is local, never open.
    const ownKey = peer.kind === "relay" ? peer.key : undefined;
    const tells = (event: DevicePairedEvent, origin: readonly string[]) => !openAccess && event.device_id !== deviceId
      && !(ownKey !== undefined && devices.relayKeyOf(event.device_id) === ownKey) && !sameBrowser(origin, keys);
    const stopPaired = devices.onPaired((event, origin) => { if (tells(event, origin)) listener(event); });
    // the devices the account's list let in: this PC's own window alone, as their notice waits for it (shownTo)
    const stopListed = viewer.ownWindow ? joins.onListed((event) => { if (tells(event, [])) listener(event); }) : undefined;
    // a join nobody has seen yet waits on the PC for the next window to open, until one window marks it seen for all: this
    // PC's own window, or a device that was here before the join (shownTo)
    for (const join of joins.waiting()) if (shownTo(join, viewer) && tells(join.event, join.origin)) listener(join.event);
    const stopSeen = openAccess ? undefined : joins.onSeen((eventId) => listener({ type: "device-paired-seen", event_id: eventId }));
    const stopRemoved = driving ? devices.onRemoved(listener) : undefined;
    // Direct approvers see the digits; drive account members on the relay get three candidates instead.
    const approver = driving && access.via !== "relay" && access.via !== "portal";
    const stopRelay = approver ? relay.approvals.subscribe((list) => listener({ type: "relay-pairings", pairings: list })) : remotePairingEvents(ctx)(listener);
    // A window that lost the right to approve needs to clear its prompts.
    if (!approver) listener({ type: "relay-pairings", pairings: [] });
    let stopPending: (() => void) | undefined;
    if (driving && pendingRedemptions !== undefined) {
      // Approval stays on the PC's screen. Read before registering: view() can itself expire keys.
      const tellPending = () => listener({ type: "pending-redemptions", pending: pendingRedemptions.view() });
      tellPending();
      stopPending = pendingRedemptions.onChange(tellPending);
    }
    return () => { stopPaired(); stopListed?.(); stopSeen?.(); stopRemoved?.(); stopRelay(); stopPending?.(); };
  } };
}
