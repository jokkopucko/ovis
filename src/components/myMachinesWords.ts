/**
 * The words of the "My machines" screens (DESIGN.md "My machines"): one state word, one reason and
 * one order per machine, so the list, the details and a notice never name one
 * thing two ways. Pure: a screen passes its `t` and the clock it draws from.
 */
import type { Translate } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { DeviceRef, Machine, MachineEngine, MachineOrigin, MachineRoute, MachineState } from "../lib/account/machinesView.ts";
import { askToJoinReason } from "./relayPcState.tsx";
import type { StatusDotState } from "./StatusDot.tsx";

/** The end of an exhaustive switch over a view-model union: a member it does not draw is a type error here. */
export function unreachableMember(member: never): never {
  throw new TypeError(`A view-model member is not drawn: ${JSON.stringify(member)}`);
}

/** The glyph beside a machine's state word: the shape says the category, the word says which. */
export function machineDot(state: MachineState): StatusDotState {
  switch (state.kind) {
    case "ready": return "ready";
    case "offline": case "removed": return "offline";
    case "unreachable": return "failed";
    case "joining": return "checking";
    // as today's dashboard draws a PC nobody checked: the still ring; the open arc only while a check runs
    case "unchecked": return state.checking ? "checking" : "offline";
    case "needs-update": case "needs-approval": return "needs-you";
  }
}

export function machineStateWord(state: MachineState, t: Translate): string {
  switch (state.kind) {
    case "ready": return t("Ready");
    case "offline": return t("Machine offline");
    case "unreachable": return t("Could not reach this machine");
    case "joining": return t("Joining");
    case "needs-update": return t("Needs an update");
    case "removed": return t("Removed|machine state");
    case "needs-approval": return t("Needs approval");
    case "unchecked": return state.checking ? t("Checking…") : t("Not checked|machine state");
  }
}

/** When something happened, as a sentence embeds it: the words of the time never part at a line's end ("3 min ago", "3분 전"). */
export function whenText(iso: string | null, now: number): string {
  return lastSeen(iso, now).replaceAll(" ", "\u00a0");
}

/** A signer's name, or what a key with no name is called. */
export function signerName(signer: DeviceRef, t: Translate): string {
  return signer.name ?? t("A key with no name");
}

/**
 * Whether Open is offered: a ready or unchecked machine, one that needs an update and still knows this device, and
 * one this device's check could not reach, since opening waits longer than a check does.
 */
export function opensFromHere(state: MachineState): boolean {
  switch (state.kind) {
    case "ready": case "unchecked": case "unreachable": return true;
    case "needs-update": return state.knowsThisDevice;
    case "offline": case "joining": case "removed": case "needs-approval": return false;
    default: return unreachableMember(state);
  }
}

/** Why a machine is in its state, in sentences; null for a ready one, whose route says it. */
export function machineReason(state: MachineState, t: Translate, now: number): string | null {
  switch (state.kind) {
    case "ready": return null;
    case "offline": {
      const seen = state.lastSeenAt === null ? t("It has not connected yet.") : t("Last seen {when}.", { when: whenText(state.lastSeenAt, now) });
      const cause = state.reason === "not-connected" ? t("It is off, has no network, or Ovis is not running on it.") : t("The relay had no place for it. It tries again by itself.");
      return `${seen} ${cause}`;
    }
    case "unreachable":
      return state.reason === "relay-unreachable" ? t("This device could not reach the relay. Check this device's network.") : t("It did not answer in time. It may be busy or restarting.");
    case "joining": return t("It joined a moment ago and is getting ready. It turns ready by itself.");
    case "needs-update": {
      const behind = t("It lets no new device in until Ovis is updated here. Devices it already knows still open it. A removal made by a device that this machine does not know may not reach it until then.");
      return state.knowsThisDevice ? behind : `${behind} ${t("This device is not one it knows, so it cannot open it until then.")}`;
    }
    case "removed": return t("Removed {when} on {device}. Its terminals keep running on the machine.", { when: whenText(state.removedAt, now), device: signerName(state.removedBy, t) });
    // today's sentence (relayPcState.tsx), for a PC whose directory entry gives the way in
    case "needs-approval": return state.canAsk ? askToJoinReason({ added_at: "listed", join: true }, t) : t("This device cannot open it yet, and your account names no way to join it from here.");
    case "unchecked": return state.checking ? t("This device is checking whether it answers.") : t("This device has not checked whether it answers yet.");
  }
}

/** What the machine says of its own copy of the list, when that needs saying: it cannot follow it, or it stopped at an entry. */
function listText(machine: Machine, t: Translate): string | null {
  const list = machine.list;
  if (list === undefined) return null;
  if (list.stuck) return t("The account service shows a list this machine cannot follow.");
  return list.stopped === null ? null : t("It stopped at entry {seq} of your account's list and asks again at every read.", { seq: list.stopped });
}

/** The reason, what it says of its list, then a setup that did not finish: opening the machine tries it again, so that is said where Open is offered. */
export function machineWhy(machine: Machine, t: Translate, now: number): string | null {
  const setup = machine.setupIncomplete !== true ? null
    : opensFromHere(machine.state) ? t("Account setup is incomplete. Open it to try again.|machine") : t("Account setup is incomplete.");
  const parts = [machineReason(machine.state, t, now), listText(machine, t), setup].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" ");
}

export function routeText(route: MachineRoute, t: Translate): string {
  return route.via === "direct" ? t("Direct · {n} ms", { n: route.delayMs }) : t("Relay · {n} ms", { n: route.delayMs });
}

/** herdr and herdr-core are names, the same in every language. */
export function engineText(engine: MachineEngine, t: Translate): string {
  switch (engine) {
    case "not-seen": return t("Engine not seen");
    case "not-known": return "—";
    case "herdr": case "herdr-core": return engine;
    default: return unreachableMember(engine);
  }
}

/** What needs the person first, then what is ready, then what is gone. */
const STATE_RANK: Record<MachineState["kind"], number> = { unreachable: 0, "needs-update": 1, "needs-approval": 1, joining: 2, unchecked: 2, offline: 3, ready: 4, removed: 5 };

/** A list's rows: what needs a look first, then by name, numbers in a name counted as numbers. */
export function machineOrder(machines: readonly Machine[]): Machine[] {
  return [...machines].sort((a, b) => STATE_RANK[a.state.kind] - STATE_RANK[b.state.kind] || a.name.localeCompare(b.name, undefined, { numeric: true }) || (a.id < b.id ? -1 : 1));
}

/** How a machine came in, as one sentence. */
export function machineOriginText(origin: MachineOrigin, t: Translate, now: number): string {
  switch (origin.kind) {
    case "invite": return t("Joined {when} with {invite}, {n} of {uses}, made on {device}.", { when: whenText(origin.joinedAt, now), invite: origin.invite.label, n: origin.nth, uses: origin.invite.uses, device: signerName(origin.madeBy, t) });
    case "paired": return t("Added {when} by {device}, which was already paired with it.", { when: whenText(origin.addedAt, now), device: signerName(origin.addedBy, t) });
    case "not-known": return origin.listedAt === null ? t("This device is paired with it. Your account does not list it yet.") : t("Listed in your account {when}.", { when: whenText(origin.listedAt, now) });
    default: return unreachableMember(origin);
  }
}

/** When a machine came in, or null when that is not known. */
export function machineOriginTime(origin: MachineOrigin): string | null {
  switch (origin.kind) {
    case "invite": return origin.joinedAt;
    case "paired": return origin.addedAt;
    case "not-known": return origin.listedAt;
    default: return unreachableMember(origin);
  }
}

export function fullTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
