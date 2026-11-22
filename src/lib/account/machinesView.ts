/**
 * The view and actions for the My machines list, details and add sheet. Times are ISO 8601
 * instants and IDs are opaque. The screens draw these values without reading the network.
 */

/** A signer named by another entry (who made an invite, who approved a device). It may be gone since. */
export interface DeviceRef {
  /** the signer's id */
  readonly id: string;
  /** the name it had when that entry was made; null for a key with no name */
  readonly name: string | null;
}

/** A machine named by another entry (the machines an invite brought in). */
export interface MachineRef {
  /** the machine's id */
  readonly id: string;
  /** the name it joined with */
  readonly name: string;
}

/** A server or VM with no screen ("machine"), or one of the person's PCs ("pc"). One list holds both. */
export type MachineKind = "machine" | "pc";

/** The terminal engine the machine keeps; "not-seen" while none has been seen on it. */
export type MachineEngine = "herdr" | "herdr-core" | "not-seen"
  /** the source does not learn which engine a machine keeps; only today's source gives it (its checks stop before signing in) */
  | "not-known";

/** How this device reaches a ready machine. */
export interface MachineRoute {
  /** "direct": straight to the machine; "relay": through a relay */
  readonly via: "direct" | "relay";
  /** the round trip this device measured, in milliseconds */
  readonly delayMs: number;
}

/** Why a machine is offline. */
export type OfflineReason =
  /** it is off, has no network, or Ovis is not running on it */
  | "not-connected"
  /** the relay had no place for it; the machine tries again by itself */
  | "no-relay-place";

/** Why this device could not reach a machine. */
export type UnreachableReason =
  /** this device could not reach the relay: its own network is the likely cause */
  | "relay-unreachable"
  /** the machine did not answer in time */
  | "no-answer";

/** A machine's state, each with what the screens need to say why. */
export type MachineState =
  /** this device can open it now, by `route` */
  | { readonly kind: "ready"; readonly route: MachineRoute }
  /** "Machine offline": it is not connected; `lastSeenAt` is when it last was, or null when never */
  | { readonly kind: "offline"; readonly reason: OfflineReason; readonly lastSeenAt: string | null }
  /** "Could not reach this machine": this device tried at `triedAt` and failed; a new try may work */
  | { readonly kind: "unreachable"; readonly reason: UnreachableReason; readonly triedAt: string }
  /** it joined and is getting ready: it cannot be opened yet and becomes ready by itself */
  | { readonly kind: "joining" }
  /**
   * "Needs an update": its Ovis is older than the list needs, or it says it is behind. It lets no new
   * device in until Ovis is updated there; `knowsThisDevice`: it knows this device, which still opens it
   */
  | { readonly kind: "needs-update"; readonly knowsThisDevice: boolean }
  /** its access ended for good; kept in the view so every device reads who removed it and when */
  | { readonly kind: "removed"; readonly removedBy: DeviceRef; readonly removedAt: string }
  /** THIS DEVICE is not let in to it yet; `canAsk`: the device side can start the way in (`joinMachine`). Only today's source gives it */
  | { readonly kind: "needs-approval"; readonly canAsk: boolean }
  /** no settled result yet of whether this device reaches it; `checking` while a try is under way. The list's source gives it too */
  | { readonly kind: "unchecked"; readonly checking: boolean; readonly lastSeenAt: string | null };

/** An invite as a machine that joined with it names it. */
export interface InviteRef {
  /** the invite's id */
  readonly id: string;
  /** its label */
  readonly label: string;
  /** how many machines it lets in: 1 for a single-use one */
  readonly uses: number;
}

/** How a machine came in. */
export type MachineOrigin =
  /** it ran a join line: which invite, its `nth` counted join, who made that invite and when, and when the machine joined */
  | { readonly kind: "invite"; readonly invite: InviteRef; readonly nth: number; readonly madeBy: DeviceRef; readonly madeAt: string; readonly joinedAt: string }
  /** a device that was already paired with this PC added it, without an invite */
  | { readonly kind: "paired"; readonly addedBy: DeviceRef; readonly addedAt: string }
  /** who or what added it is not known; `listedAt`: when the account listed it, null when it does not list it. The list's source gives it too */
  | { readonly kind: "not-known"; readonly listedAt: string | null };

/** What a machine says of its own copy of the account's list (`GET /api/account/list` on it). */
export interface MachineListState {
  /** it was shown another history under the entries it holds: "The account service shows a list this machine cannot follow". No removal reaches it while it lasts */
  readonly stuck: boolean;
  /** the place of the entry it stopped at (an entry that does not hold), or null; it asks again at every read */
  readonly stopped: number | null;
  /** when its last read was answered in full, or null when none was */
  readonly polledAt: string | null;
}

/** One entry of "My machines". A machine that also runs its own Ovis is still one entry. */
export interface Machine {
  /** the id of the machine's key, 32 hex characters; details show it in groups of four */
  readonly id: string;
  /** the name it joined with */
  readonly name: string;
  /** a machine or a PC */
  readonly kind: MachineKind;
  /** the terminal engine it keeps */
  readonly engine: MachineEngine;
  /** its state, with why */
  readonly state: MachineState;
  /** how it came in */
  readonly cameIn: MachineOrigin;
  /** whether it also serves an Ovis page of its own */
  readonly runsOwnOvis: boolean;
  /** joining the account did not finish: this device opens it, the account's other devices are not let in; opening it tries again. Only today's source gives it */
  readonly setupIncomplete?: true;
  /** its own list state, as it last told this device; absent while this device has not read it */
  readonly list?: MachineListState;
}

/** How many machines an invite lets in. */
export type InviteUse =
  /** one machine */
  | { readonly kind: "single-use" }
  /** up to `limit` machines, of which `used` joined already */
  | { readonly kind: "reusable"; readonly limit: number; readonly used: number };

/** What the person chooses in Add a machine before the line is made. */
export interface InviteChoice {
  /** one machine, or up to `limit` machines */
  readonly use: { readonly kind: "single-use" } | { readonly kind: "reusable"; readonly limit: number };
  /** how many hours the line works: an hour, four hours, a day or seven days */
  readonly hours: 1 | 4 | 24 | 168;
}

/** The commands Add a machine shows above the line: each asks for the line and reads it from the terminal. */
export interface JoinCommands {
  /** for a machine that has Ovis: `ovis join` */
  readonly withOvis: string;
  /** for one that has not: the installer with `--join` */
  readonly withoutOvis: string;
}

/** An invite just made on this device, while Add a machine is open. */
export interface NewInvite {
  /** its label */
  readonly label: string;
  /** what to run on the machine; the line is never part of it */
  readonly commands: JoinCommands;
  /** the join line alone, `ovis-join:1:` and its four members, pasted when the command asks; a secret, shown once and never stored */
  readonly line: string;
  /** single-use, or reusable with its limit and how many used */
  readonly use: InviteUse;
  /** when the line stops working */
  readonly endsAt: string;
  /** the machines that joined with it since it was made; empty while waiting for the first */
  readonly joined: readonly MachineRef[];
}

/** What a device may do: "drive" sees and types; "watch" only sees, and changes nothing in the account. */
export type DeviceRole = "drive" | "watch";

/** A machine that got in without this device, shown until acknowledged. */
export interface MachineNotice {
  readonly id: string;
  readonly machine: MachineRef;
  readonly how: MachineOrigin;
}

export interface MachinesView {
  readonly machines: readonly Machine[];
  readonly notices?: readonly MachineNotice[];
  readonly role: DeviceRole;
  /** A device whose copy needs a newer Ovis cannot add machines. */
  readonly thisDeviceBehind?: true;
}

export interface MachineInviteFlow {
  readonly invite: NewInvite | null;
  makeInvite(choice: InviteChoice): Promise<void>;
  dropLine(): void;
}

/** What the screens ask the device side to do. A promise settles once the view reflects the deed; a rejection's message is shown as it is. */
export interface MachinesActions {
  /** opens a machine's terminals: a ready one, an unchecked one, or one that needs an update and knows this device */
  openMachine(machineId: string): void;
  /** tries to reach a machine again */
  retryMachine(machineId: string): void;
  /** starts the way in to a machine this device is not let in to (state "needs-approval", canAsk); only today's source offers it */
  joinMachine?(machineId: string): void;
  /** When absent, a machine is added from a terminal on it. */
  readonly inviteFlow?: MachineInviteFlow;
  dismissNotice?(noticeId: string): void;
}
