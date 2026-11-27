/** Probe results never imply account or version state. A sweep a minute while the list is shown, at most CHECK_PCS PCs each. */
import { checkPc, sweepOf } from "./pcStatus.ts";
import type { PcFinding, PcStatus, ProbeTarget } from "./pcStatus.ts";
import type { RelayDeviceStore } from "./device.ts";
import type { RelaySocket } from "./channel.ts";
import { OFFLINE_AFTER_MS } from "../account/myPcs.ts";

const CHECK_PCS = 8;
const CHECK_AT_ONCE = 2;
/** a minute: one sweep's CHECK_PCS connections (up to two each, with the global relay's fallback) stay well under the relay's 30 a minute */
export const CHECK_GAP_MS = 60_000;
const CHECK_KEY = "ovis-pc-check-at";
const CHECK_CURSOR_KEY = "ovis-pc-check-cursor";
/** "<stamp> <the stamp before it>": a stamp its sweep handed back, read as the one before it while no tab stamped since */
const CHECK_RETURNED_KEY = "ovis-pc-check-returned";

function localStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
}
/** when the last sweep of any tab began, a stamp handed back read as the one before it */
function stampedAt(): number {
  const stamp = localStorageGet(CHECK_KEY);
  const [returned, before] = localStorageGet(CHECK_RETURNED_KEY)?.split(" ") ?? [];
  const at = Number((stamp !== null && returned === stamp ? before : stamp) || NaN);
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * A sweep's place in the minute, stamped before its work starts (the relay's limit counts each connection as it opens).
 * One that opened none when its view stopped or its page went is handed back, so the next page sweeps at once: the
 * stamp is never taken off (another tab may have stamped since), it is marked handed back. The cursor moves on when
 * the sweep's first check starts.
 */
interface Ticket { readonly at: number; readonly before: number; cursor: number | null; opened: boolean; handedBack: boolean }

interface QueuedCheck { readonly device: ProbeTarget; readonly before: PcFinding | undefined; readonly settled: ReturnType<typeof Promise.withResolvers<void>>; readonly ticket?: Ticket }

/**
 * `pauseOutOfSight`: a view that is out of sight starts no queued check (the sidebar's list, ShellPcs.tsx) and goes on
 * from its queue on its next check; the front page's list keeps draining its queue while another screen is up, as before.
 */
export function createPcSweep(store: RelayDeviceStore, view: { readonly active: () => boolean; readonly redraw: () => void }, options: { readonly probe?: typeof checkPc; readonly directSocket?: (url: string) => RelaySocket; readonly pauseOutOfSight?: boolean } = {}) {
  const pcStatus = new Map<string, PcStatus>();
  const probe = options.probe ?? checkPc;
  const directSocket = options.directSocket;
  const sockets = { relay: (url: string) => new WebSocket(url), ...(directSocket ? { direct: directSocket } : {}) };
  let lastCheck = -Infinity;
  /** the last sweep's ticket while none of its checks has started, heard of by `pagehide` meanwhile */
  let unused: Ticket | null = null;
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  const queue: QueuedCheck[] = [];
  /** each PC's check queued or under way, until it settles: a check asked for meanwhile waits for that one */
  const running = new Map<string, Promise<void>>();
  let workers = 0;
  /** PCs whose last check the relay turned away (a 429, a dropped socket): the next sweep checks them first */
  const refused = new Set<string>();
  /** answers past OFFLINE_AFTER_MS, which a refused check must not put back */
  const lapsed = new WeakSet<PcStatus>();
  const redraw = (): void => { if (view.active()) view.redraw(); };
  const cursorNow = (): number => Number(localStorageGet(CHECK_CURSOR_KEY) ?? "0");

  const enqueue = (device: ProbeTarget, where: "front" | "back", ticket?: Ticket): Promise<void> => {
    const shown = pcStatus.get(device.server_id);
    const before = shown?.kind === "checking" ? shown.previous : shown;
    const entry: QueuedCheck = { device, before, settled: Promise.withResolvers<void>(), ...(ticket ? { ticket } : {}) };
    // a re-check keeps what the last one found on screen until it finishes: an off PC must not read Ready meanwhile
    pcStatus.set(device.server_id, before === undefined ? { kind: "checking" } : { kind: "checking", previous: before });
    if (where === "front") queue.unshift(entry); else queue.push(entry);
    running.set(device.server_id, entry.settled.promise);
    void entry.settled.promise.then(() => { if (running.get(device.server_id) === entry.settled.promise) running.delete(device.server_id); });
    return entry.settled.promise;
  };
  let stopped = false;
  const startsNow = (): boolean => !stopped && (options.pauseOutOfSight !== true || view.active());
  /** the timers that let an answer lapse, let go with the sweep */
  const expiries = new Set<ReturnType<typeof setTimeout>>();
  const probeNext = async (): Promise<void> => {
    // a view out of sight starts no new check: what is queued waits for the next time it is shown
    for (let next = startsNow() ? queue.shift() : undefined; next; next = startsNow() ? queue.shift() : undefined) {
      if (next.ticket) spend(next.ticket);
      const found = await probe(next.device, sockets).catch((): PcStatus => ({ kind: "offline", reason: "relay" }));
      // stopped while this check ran: its answer goes nowhere
      if (stopped) { next.settled.resolve(); return; }
      const serverId = next.device.server_id;
      // a relay that turned this device away, or that it could not reach, said nothing of the PC: the row keeps what it said
      // until a second such check in a row
      if (found.kind === "offline" && found.reason !== "pc" && !refused.has(serverId)) {
        refused.add(serverId);
        if (next.before === undefined || lapsed.has(next.before)) pcStatus.delete(serverId); else pcStatus.set(serverId, next.before);
      } else {
        refused.delete(serverId);
        pcStatus.set(serverId, found);
      }
      if (found.kind === "answered" && !stopped) {
        const expiry = setTimeout(() => {
        expiries.delete(expiry);
        lapsed.add(found);
        const shown = pcStatus.get(serverId);
        if (shown === found) pcStatus.delete(serverId);
        else if (shown?.kind === "checking" && shown.previous === found) pcStatus.set(serverId, { kind: "checking" });
        else return;
        redraw();
      }, OFFLINE_AFTER_MS);
        expiries.add(expiry);
      }
      redraw();
      next.settled.resolve();
    }
  };
  // only a view in sight starts checks; what waited for it starts here once it is shown again
  const drain = (): void => {
    if (!startsNow()) return;
    for (let spare = Math.min(CHECK_AT_ONCE - workers, queue.length); spare > 0; spare -= 1) {
      workers += 1;
      void probeNext().finally(() => { workers -= 1; });
    }
  };

  const later = (wait: number): void => {
    if (stopped) return;
    deferred ??= setTimeout(() => {
      deferred = undefined;
      if (view.active() && globalThis.document?.visibilityState !== "hidden") void checkPcs(); else later(CHECK_GAP_MS);
    }, wait);
  };
  const checkPcs = async (): Promise<void> => {
    if (stopped) return;
    // a sweep that paused while its view was out of sight goes on from its queue, before any wait on it
    drain();
    if (sweeping) { void sweeping.then(checkPcs); return; }
    const stored = stampedAt();
    const wait = CHECK_GAP_MS - (Date.now() - Math.max(lastCheck, stored));
    if (wait > 0) {
      later(wait);
      redraw();
      return;
    }
    // the work starts here, so the page is asked here: a timer or a sweep waited on may come due after it was hidden
    if (globalThis.document?.visibilityState === "hidden") { later(CHECK_GAP_MS); return; }
    const ticket: Ticket = { at: Date.now(), before: stored, cursor: null, opened: false, handedBack: false };
    lastCheck = ticket.at;
    localStorageSet(CHECK_KEY, String(lastCheck));
    if (unused === null) globalThis.addEventListener?.("pagehide", handBack);
    unused = ticket;
    later(CHECK_GAP_MS);
    sweeping = sweepPcs(ticket).finally(() => { sweeping = undefined; });
    await sweeping;
  };
  const sweepPcs = async (ticket: Ticket): Promise<void> => {
    const devices = await store.list();
    if (stopped || ticket.handedBack) return;
    const cursor = cursorNow();
    const again = sweepOf(devices, 0, devices.length).filter((device) => refused.has(device.server_id)).slice(0, CHECK_PCS);
    const turn = CHECK_PCS - again.length;
    const saved = [...again, ...sweepOf(devices, cursor, turn).filter((device) => !again.includes(device))]
      .filter((device) => pcStatus.get(device.server_id)?.kind !== "checking");
    ticket.cursor = cursor + turn;
    const settled = saved.map((device) => enqueue(device, "back", ticket));
    redraw();
    drain();
    await Promise.all(settled);
  };
  /**
   * `where`: ahead of the queue (a person's Check again), or after what is queued (a launch's checks, in its order).
   * `known`: a PC this device has no saved pairing for (an account PC), checked by its directory row.
   */
  const checkOne = async (serverId: string, where: "front" | "back" = "front", known?: ProbeTarget): Promise<void> => {
    if (stopped) return;
    const waiting = queue.findIndex((entry) => entry.device.server_id === serverId);
    if (waiting >= 0) {
      const [entry] = queue.splice(waiting, 1);
      // a launch's check keeps a queued one where it waits; a person's moves it to the front
      if (entry) { queue.splice(where === "front" ? 0 : waiting, 0, entry); drain(); return entry.settled.promise; }
    }
    const under = running.get(serverId);
    if (under !== undefined) return under;
    const device = known ?? await store.get(serverId);
    if (device === undefined || stopped) return;
    const settled = enqueue(device, where);
    redraw();
    drain();
    await settled;
  };

  const letGo = (): void => {
    unused = null;
    globalThis.removeEventListener?.("pagehide", handBack);
  };
  /** the sweep's first check starts: its minute is spent, and the rotation moves past what it took */
  function spend(ticket: Ticket): void {
    if (ticket.opened) return;
    ticket.opened = true;
    if (unused === ticket) letGo();
    if (ticket.cursor !== null) localStorageSet(CHECK_CURSOR_KEY, String(ticket.cursor));
  }
  /** a sweep none of whose checks started gives its minute back, and what it queued goes with it */
  function handBack(): void {
    const ticket = unused;
    if (ticket === null) return;
    letGo();
    ticket.handedBack = true;
    localStorageSet(CHECK_RETURNED_KEY, `${ticket.at} ${Number.isFinite(ticket.before) ? ticket.before : ""}`);
    if (lastCheck === ticket.at) lastCheck = -Infinity;
    for (const entry of queue.filter((queued) => queued.ticket === ticket)) {
      queue.splice(queue.indexOf(entry), 1);
      // the row says again what it said, unless that answer lapsed meanwhile
      if (entry.before === undefined || lapsed.has(entry.before)) pcStatus.delete(entry.device.server_id); else pcStatus.set(entry.device.server_id, entry.before);
      entry.settled.resolve();
    }
    redraw();
  }

  /** The view that used this sweep is gone: nothing more is scheduled or started, and what waited is let go. */
  const stop = (): void => {
    handBack();
    stopped = true;
    clearTimeout(deferred);
    deferred = undefined;
    for (const expiry of expiries) clearTimeout(expiry);
    expiries.clear();
    for (const entry of queue.splice(0)) entry.settled.resolve();
  };

  return { status: pcStatus, check: checkPcs, checkOne, stop };
}
