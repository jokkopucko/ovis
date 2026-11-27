/** Which saved PCs the hosted shell opens by itself (shell.tsx): a launch, and a move off a PC that went away. */
import { isNewAccountPc, type MyPc } from "../account/myPcs.ts";
import { newPcNoticeKey, pcNoticeClosed } from "../account/newPcNotice.ts";
import type { RelayDevice } from "./device.ts";
import type { ProbeTarget } from "./pcStatus.ts";

/**
 * The saved PCs this device opens without a press: a finished pairing (a row with no device id would ask to pair again)
 * made on this device by hand. Never one an account introduction alone saved (introduced_at): security-triage
 * condition 3, nothing this device did not choose opens by itself.
 */
export function openablePcs(devices: readonly RelayDevice[]): RelayDevice[] {
  return devices.filter((device) => device.device_id !== null && device.introduced_at === undefined);
}

/**
 * The account's PCs this device reaches only through the account that it may also open by itself (security-triage
 * t13r, ruling b), opened through the account key as a PC's own page does. All must hold:
 * - the PC trusts the account's device list for this device's registered key (`accountOpen`, with a verified `join`);
 * - its listing is confirmed: the PC itself pulled this account's mailbox with its server proof (`last_seen_at`), since
 *   anyone can list any PC in their directory; or this device's verified list holds the PC (`byList`), which no
 *   listing can make it do;
 * - it is past its new window (`new_until`): a PC inside its 24 hours, or whose window does not parse, stays under condition 3;
 * - no saved row here: a PC an introduction alone saved (introduction-only) or a pairing never finished is not one;
 * - no "added before you joined" notice for it is still open on this device (NewPcNotices.tsx);
 * - it is not a PC that this device's list of the account does not hold (`notInList`): such a row opens on a tap alone.
 */
export function accountOpenablePcs(pcs: readonly MyPc[], here: { readonly account: string; readonly devices: readonly RelayDevice[]; readonly now: number }): ProbeTarget[] {
  const saved = new Set(here.devices.map((device) => device.server_id));
  const noticeOpen = (pc: MyPc): boolean => pc.admitted_before_you === true
    && !pcNoticeClosed(newPcNoticeKey(here.account, { server_id: pc.server_id, admitted_at: pc.admitted_at ?? null, new_until: pc.new_until ?? null }));
  return pcs.flatMap((pc) => !pc.paired && pc.join !== undefined && pc.accountOpen === true
    && (pc.last_seen_at !== null || pc.byList === true)
    && pc.notInList !== true
    && !isNewAccountPc(pc, here.now)
    && !saved.has(pc.server_id)
    && !noticeOpen(pc)
    // checked by the key and relay its row carries, which myPcs kept only when the key is the one its id names
    ? [{ server_id: pc.server_id, server_public_key: pc.join.server_public_key, relay: pc.join.relay, name: pc.name }] : []);
}

export function lastFirst<T extends { readonly server_id: string }>(devices: readonly T[], last: string | null): T[] {
  return [...devices.filter((device) => device.server_id === last), ...devices.filter((device) => device.server_id !== last)];
}

/**
 * The PCs a launch opened in this tab that turned out off on their own page: the launch goes on with the others, and
 * never back to one of these, so it ends once every saved PC was tried.
 */
const LAUNCH_TRIED = "ovis-launch-tried";

export function launchTried(): string[] {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(LAUNCH_TRIED) ?? "[]");
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function keepLaunchTried(serverIds: readonly string[]): void {
  try {
    if (serverIds.length === 0) sessionStorage.removeItem(LAUNCH_TRIED);
    else sessionStorage.setItem(LAUNCH_TRIED, JSON.stringify([...new Set(serverIds)]));
  } catch { /* no storage: a launch that goes on may try a PC found off again, once per page */ }
}
