import type { PairedDevice } from "../../shared/protocol.ts";
import { pcAccountStatus } from "./account/join.ts";
import { fetchDevices } from "./api.ts";
import { apiFetch } from "./api-request-id.ts";

/**
 * What the relay tab's QR code (ConnectPhoneDialog `AccountQr`) let in after it was taken down. A device that
 * redeemed the code just before it was ended links itself seconds later (lib/relay/accountController.ts), when the
 * tab, the dialog or all of Settings may be gone. So the watch lives here, outside any component: it reads the PC's
 * account and devices until it knows nobody got in, and what it finds waits as a notice for the relay tab, which
 * Devices and PCs opens again for it. A notice nobody answered waits here too (holdAccountQrNotice).
 * Who is vouched for is decided here as `ovis add` decides it (scripts/plugin-link.ts): only a member of the PC's
 * account is named as the one that added it, and every other device that came since the code is asked about.
 */

/** how often the PC is asked which account it is in and which devices it has */
export const ACCOUNT_QR_POLL_MS = 3000;
/** how long a device that just paired gets to put the PC in its account before it is named as paired with the PC alone */
export const ACCOUNT_QR_ALONE_MS = 10_000;
/** how long the PC is watched after its QR code came down: as long as a pairing code lives (server/devices.ts) */
export const ACCOUNT_QR_LATE_MS = 10 * 60_000;

/**
 * The PC's devices as the press on Show the QR code found them, on a PC in no account (the QR code is shown for no
 * other): a device the person kept since counts in `ids`. `seen`: when each device that came since was first seen,
 * filled in by every read (dueStrays). It travels with the press, to the watch and to a notice that waits, so a notice
 * drawn again later does not give a device its ten seconds anew.
 */
export interface AccountQrBaseline { readonly ids: ReadonlySet<string>; readonly seen: Map<string, number> }

/** a device the QR code's code let in that nobody vouched for; `relay`: it came through the relay, not at the PC's own address */
export interface AccountQrStray { readonly id: string; readonly label: string; readonly relay: boolean }

/**
 * What there is to tell of a PC that was in no account when its QR code was made (`known`), and to ask: `strays` are
 * removed unless the person keeps them, and `checking` are the devices still in their ten seconds, asked about once
 * those end. The relay tab reads the PC on from `known`, so what changed while the notice waited is told as well.
 */
export type AccountQrNotice =
  /** the PC is still in no account, and those devices paired with it */
  | { readonly kind: "alone"; readonly strays: readonly AccountQrStray[]; readonly checking: readonly AccountQrStray[]; readonly known: AccountQrBaseline }
  /** the PC joined `account`; `device` is the member of that account that added it, null when no row is one */
  | { readonly kind: "joined"; readonly account: string; readonly device: string | null; readonly strays: readonly AccountQrStray[]; readonly checking: readonly AccountQrStray[]; readonly known: AccountQrBaseline };

/**
 * Fired on `window` when the watch starts or ends, and with `detail.notice` true when a notice waits
 * (takeAccountQrNotice).
 */
export const ACCOUNT_QR_WATCH_EVENT = "ovis:account-qr-watch";

const newest = (devices: readonly PairedDevice[]): PairedDevice | null => devices.reduce<PairedDevice | null>((latest, device) => latest === null || device.created_at > latest.created_at ? device : latest, null);

/**
 * Who put the PC in `account`: a member of that account (its row carries the account, whose key signed its link), never
 * a device that only holds the code. The newest member that came since `known` was read; without one, the account's
 * newest member on the PC (a device paired before that linked itself meanwhile). Null when no row is a member: then
 * nobody is named. The same rule as `ovis add` (scripts/plugin-link.ts `addedBy`).
 */
export function addedBy(devices: readonly PairedDevice[], known: ReadonlySet<string>, account: string): PairedDevice | null {
  const members = devices.filter((device) => device.account === account);
  return newest(members.filter((device) => !known.has(device.id))) ?? newest(members);
}

/**
 * The devices the code let in that nobody vouched for: every one that came since `known` was read, through the relay
 * or at the PC's own address, and is no member of the account the PC is in (`account`; null: in none, so none is one).
 */
export function unvouched(devices: readonly PairedDevice[], known: ReadonlySet<string>, account: string | null): PairedDevice[] {
  return devices.filter((device) => !known.has(device.id) && (account === null || device.account !== account));
}

export const strayOf = (device: PairedDevice): AccountQrStray => ({ id: device.id, label: device.label, relay: device.via_relay === true });

/**
 * Which of the unvouched devices are asked about now. One that came through the relay gets ACCOUNT_QR_ALONE_MS from
 * when it was first seen (`seen`, filled in here) to become a member: a signed-in device links itself within seconds.
 * One that paired at the PC's own address cannot become a member, and is asked about at once.
 */
export function dueStrays(strays: readonly PairedDevice[], seen: Map<string, number>, now: number): AccountQrStray[] {
  return strays.filter((device) => {
    if (!seen.has(device.id)) seen.set(device.id, now);
    return device.via_relay !== true || now - seen.get(device.id)! >= ACCOUNT_QR_ALONE_MS;
  }).map(strayOf);
}

/**
 * What one read of the PC says of the devices that came since `known`: `due` are asked about now, `checking` are still
 * in their ten seconds. While either is not empty somebody the code let in is unanswered, and no notice may go.
 */
export function accountQrFindings(devices: readonly PairedDevice[], account: string | null, known: AccountQrBaseline, now: number): { due: AccountQrStray[]; checking: AccountQrStray[] } {
  const strays = unvouched(devices, known.ids, account);
  const due = dueStrays(strays, known.seen, now);
  const asked = new Set(due.map((stray) => stray.id));
  return { due, checking: strays.filter((device) => !asked.has(device.id)).map(strayOf) };
}

let watch: { readonly known: AccountQrBaseline; readonly lingering: boolean; stop: () => void } | null = null;
let notice: AccountQrNotice | null = null;

const changed = (noticed: boolean): void => { window.dispatchEvent(new CustomEvent(ACCOUNT_QR_WATCH_EVENT, { detail: { notice: noticed } })); };

/** a QR code that came down is still being checked for a device it may have let in a moment before */
export const accountQrPending = (): boolean => watch !== null && !watch.lingering;
export const accountQrNoticeWaiting = (): boolean => notice !== null;

/** The waiting notice, once: whoever takes it shows it. */
export function takeAccountQrNotice(): AccountQrNotice | null {
  const taken = notice;
  notice = null;
  return taken;
}

/**
 * A notice that went from the screen with no answer (the dialog closed over it): it waits again, with no event, so it
 * is shown the next time Devices and PCs or Add a connection opens, not put back over the dialog's own closing.
 */
export function holdAccountQrNotice(held: AccountQrNotice): void {
  notice = held;
}

/** Ends the watch; the baseline it compared with, for a QR code shown again to go on from. */
export function stopAccountQrWatch(): AccountQrBaseline | null {
  const known = watch?.known ?? null;
  watch?.stop();
  return known;
}

function publish(next: AccountQrNotice): void {
  notice = next;
  changed(true);
}

/** Forgets the watch and any waiting notice: every device was revoked, or a test starts over. */
export function resetAccountQrWatch(): void {
  stopAccountQrWatch();
  notice = null;
}

/**
 * Watches a PC that was in no account (`known`) after its QR code came down, and ends with the first thing to tell:
 * the PC joined an account, or a device nobody vouched for is due to be asked about.
 * `ended` settles once the code's end was asked of the PC: true when the PC answered, so a read begun after it that
 * finds no new device proves nobody got in, and the watch ends there. Otherwise (the request failed, or the code
 * was never known) it lasts as long as the code can (ACCOUNT_QR_LATE_MS).
 * `linger`: the devices that got in were kept (and count in `known`), so only the PC joining an account, or a device
 * that came through the relay, is left to tell, and no read ends the watch early.
 */
export function watchEndedAccountQr(known: AccountQrBaseline, ended: Promise<boolean>, linger = false): void {
  stopAccountQrWatch();
  let live = true;
  let asking = false;
  let confirmed = false;
  const started = Date.now();
  const stop = () => {
    if (!live) return;
    live = false;
    window.clearInterval(poll);
    window.clearTimeout(limit);
    if (watch !== mine) return;
    watch = null;
    changed(false);
  };
  const mine = { known, lingering: linger, stop };
  const ask = async () => {
    if (!live || asking) return;
    if (Date.now() - started >= ACCOUNT_QR_LATE_MS) { stop(); return; }
    asking = true;
    const conclusive = confirmed;
    try {
      const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
      if (!live) return;
      const found = accountQrFindings(devices, status.account, known, Date.now());
      const { checking } = found;
      // lingering, the code ended long ago: a device that paired at the PC's own address since then came by another
      // code (Phones and devices), not by this QR code, and is nobody to ask about
      const due = linger ? found.due.filter((stray) => stray.relay) : found.due;
      if (status.account !== null) {
        stop();
        publish({ kind: "joined", account: status.account, device: addedBy(devices, known.ids, status.account)?.label ?? null, strays: due, checking, known });
        return;
      }
      if (due.length > 0) {
        stop();
        publish({ kind: "alone", strays: due, checking, known });
        return;
      }
      // nobody came: with the code's end confirmed before this read began, nobody will
      if (checking.length === 0 && conclusive && !linger) stop();
    } catch { /* the next round asks again */ } finally { asking = false; }
  };
  const poll = window.setInterval(() => void ask(), ACCOUNT_QR_POLL_MS);
  // by the timer, and in each round by the clock: a device that slept ran no timer
  const limit = window.setTimeout(stop, ACCOUNT_QR_LATE_MS);
  watch = mine;
  changed(false);
  void ended.then((answered) => { confirmed = answered; }, () => undefined).then(ask);
}
