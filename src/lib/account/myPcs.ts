/**
 * My PCs: the account's directory, which this client does not trust, merged with the PCs this
 * client is paired with, which it does. The directory cannot admit a device; the PC decides
 * whether it accepts its registered sign-in key or requires pairing.
 */
import type { RelayDevice } from "../relay/device.ts";
import { enrollmentOf, type EnrollmentState } from "../relay/device.ts";
import { exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { keyIdOf } from "../relay/shellState.ts";
import type { DirectoryPc } from "./service.ts";

function joinRoute(pc: DirectoryPc): MyPc["join"] {
  if (pc.public_key === null || pc.relay === null) return undefined;
  const bytes = Uint8Array.from(pc.public_key.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const server_public_key = exportPublicKey(bytes);
  return keyIdOf(server_public_key) === pc.server_id ? { server_public_key, relay: pc.relay } : undefined;
}

export const NEW_PC_MS = 10 * 60_000;
export const ACCOUNT_PCS_CHANGED_EVENT = "ovis:account-pcs-changed";

/** A one-press admission has its own lifetime, independent of the pairing-window freshness. */
export function isNewAccountPc(pc: { readonly new_until?: string | null | undefined; readonly new_until_unreadable?: true }, now: number): boolean {
  // a window that does not parse may still be open: every caller fails closed (security-triage condition 3)
  if (pc.new_until_unreadable === true) return true;
  return pc.new_until != null && !(Date.parse(pc.new_until) <= now);
}

export function invitationEndsAt(pc: Pick<MyPc, "invited_at" | "added_at">): number | null {
  const invited = Date.parse(pc.invited_at ?? pc.added_at ?? "");
  return Number.isFinite(invited) ? invited + NEW_PC_MS : null;
}

export function newPcs(pcs: readonly MyPc[], now: number): MyPc[] {
  return pcs.filter((pc) => pc.state === "needs-approval" && pc.join !== undefined && pc.last_seen_at === null && (invitationEndsAt(pc) ?? -Infinity) > now && !isNewAccountPc(pc, now));
}

/** The PC pulls its mailbox every five minutes while it belongs to the account; three missed pulls and it is called off. */
export const OFFLINE_AFTER_MS = 15 * 60_000;

export type MyPcState = "paired" | "needs-approval" | "offline" | "needs-update";

export interface MyPc {
  readonly server_id: string;
  readonly name: string;
  readonly state: MyPcState;
  readonly last_seen_at: string | null;
  readonly added_at: string | null;
  readonly invited_at?: string;
  readonly new_until?: string | null;
  /** the directory gave a new window that does not parse: it may still be inside it */
  readonly new_until_unreadable?: true;
  /** a PC this device is not paired with: when it was added in one press */
  readonly admitted_at?: string;
  /** added before this device joined, paired here or not (#29: told once in the main area, never tagged in the sidebar) */
  readonly admitted_before_you?: true;
  readonly listed: boolean;
  /**
   * The PC took its place in the account: it completed its add (the directory's `completed_at`) or has pulled the
   * account's mailbox (`last_seen_at`), which only a PC in the account does, or the signed list holds it.
   * A directory listing or an admission alone is neither (docs/account.md, "Adding a PC over SSH").
   */
  readonly joined?: true;
  /** The signed list holds it, but the target PC has not reported completing its add or pulling its mailbox. */
  readonly awaitingCheckIn?: true;
  /** this device holds an admitted key for it, so it can open; whatever its state says */
  readonly paired: boolean;
  readonly accountOpen?: true;
  /** this device's verified list holds the PC (listPcs.ts): the account service only said how to reach it */
  readonly byList?: true;
  /** the account has a list and this device does not find the PC in it (listPcs.ts): the row says so, and only a tap opens it */
  readonly notInList?: true;
  /**
   * this device signs in to it with the account key, so removing the device through the account
   * reaches it; a pairing from before the account is not covered until it is linked
   */
  readonly linked: boolean;
  readonly enrollment?: EnrollmentState;
  /**
   * For a PC this device is not paired with: its relay key (base64, as an offer carries it) and
   * relay, to compare digits with it. Only when the key is the one the PC's id is derived from,
   * so the directory cannot point this device at another PC (docs/account.md, rule 6).
   */
  readonly join?: { readonly server_public_key: string; readonly relay: string };
}

const ORDER: Record<MyPcState, number> = { paired: 0, "needs-update": 1, "needs-approval": 2, offline: 3 };

function joinedOf(pc: DirectoryPc | undefined): Pick<MyPc, "joined" | "byList" | "awaitingCheckIn"> {
  if (pc === undefined) return {};
  const checkedIn = pc.completed_at != null || pc.last_seen_at !== null;
  if (pc.by_list === true) return checkedIn ? { joined: true, byList: true } : { joined: true, byList: true, awaitingCheckIn: true };
  return checkedIn ? { joined: true } : {};
}
const outsideOf = (pc: DirectoryPc): { notInList?: true } => pc.not_in_list === true ? { notInList: true } : {};

export function myPcs(directory: readonly DirectoryPc[], paired: readonly RelayDevice[], options: { now: number; outdated?: ReadonlySet<string>; accountKey?: string; account?: string; registered?: boolean }): MyPc[] {
  const listed = new Map(directory.map((pc) => [pc.server_id, pc]));
  const rows: MyPc[] = [];
  const stateOf = (serverId: string, isPaired: boolean, lastSeen: string | null): MyPcState => {
    if (options.outdated?.has(serverId)) return "needs-update";
    if (lastSeen !== null && options.now - Date.parse(lastSeen) > OFFLINE_AFTER_MS) return "offline";
    return isPaired ? "paired" : "needs-approval";
  };
  for (const device of paired) {
    if (device.device_id === null) continue;
    const entry = listed.get(device.server_id);
    listed.delete(device.server_id);
    const lastSeen = entry?.last_seen_at ?? null;
    const enrollment = enrollmentOf(device, options.account);
    rows.push({ server_id: device.server_id, name: device.name ?? device.server_id.slice(0, 8), state: stateOf(device.server_id, true, lastSeen), last_seen_at: lastSeen, added_at: entry?.added_at ?? null, ...(entry === undefined ? {} : { new_until: entry.new_until, ...(entry.new_until_unreadable ? { new_until_unreadable: true as const } : {}), ...(entry.admitted_before_you ? { admitted_before_you: true as const } : {}) }), listed: entry !== undefined, ...joinedOf(entry), paired: true, linked: enrollment !== "pending" && enrollment !== "failed" && entry !== undefined && device.public_spki === options.accountKey && device.account !== undefined && device.account === (options.account ?? device.account), ...(enrollment ? { enrollment } : {}) });
  }
  for (const pc of listed.values()) {
    const join = joinRoute(pc);
    rows.push({ server_id: pc.server_id, name: pc.label, state: stateOf(pc.server_id, false, pc.last_seen_at), last_seen_at: pc.last_seen_at, added_at: pc.added_at, ...(pc.invited_at === undefined ? {} : { invited_at: pc.invited_at }), new_until: pc.new_until, ...(pc.new_until_unreadable ? { new_until_unreadable: true as const } : {}), ...(pc.admitted_at == null ? {} : { admitted_at: pc.admitted_at }), ...(pc.admitted_before_you ? { admitted_before_you: true as const } : {}), listed: true, ...joinedOf(pc), ...outsideOf(pc), paired: false, linked: false, ...(join ? { join, ...(options.registered || pc.by_list === true ? { accountOpen: true as const } : {}) } : {}) });
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
