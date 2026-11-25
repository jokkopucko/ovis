/**
 * One press (docs/account.md, "One press"): this PC, in no account, takes the account service's word that `account` admitted
 * it, and binds itself to that account. Shared by the PC's own window (POST /api/account/one-press) and by another PC of
 * its owner that adds it over SSH, through this PC's recovery socket (docs/account.md, "Adding a PC over SSH").
 */
import type { AccountAddRelay } from "../../shared/machines.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayService } from "../relay/service.ts";
import type { JoinRefusal, ListFollow } from "./list-follow.ts";
import { AccountServiceRefusal, type AccountMailbox } from "./mailbox.ts";
import { LIST_REMOVED_FROM } from "./records.ts";
import type { ListTakeWaiting } from "./recovery-acts.ts";

export interface PressServices {
  readonly devices: DeviceStore;
  readonly relay: RelayService;
  readonly accountMailbox: AccountMailbox;
}

export interface PressRefusal { readonly code: string; readonly message: string; readonly status: number }

export type PressOutcome = { readonly account: string } | { readonly refused: PressRefusal };

/** A take over SSH: in `account`, with this PC's relay as it stood when the take answered. */
export type TakeOutcome = { readonly account: string; readonly relay: AccountAddRelay } | { readonly refused: PressRefusal };

/** How long a PC added over SSH waits for its relay to come online before it answers: as long as `ovis add` waits. */
export const ADDED_RELAY_ONLINE_MS = 30_000;
const RELAY_POLL_MS = 250;

const refuse = (code: string, message: string, status: number): { readonly refused: PressRefusal } => ({ refused: { code, message, status } });
/** Said where an account with a signed list is asked to take this PC on the account service's word. */
export const LIST_ADD_ONLY = "This account keeps a signed list of its devices, and takes a PC only by that list. Run ovis add on this PC, or ovis join with an invite made since the account has its list.";
const SET_UP_FOR_ANOTHER = "This PC was set up for another account. Sign in to that one, or add this PC again.";

export async function pressOnce(services: PressServices, account: string): Promise<PressOutcome> {
  const { devices, relay, accountMailbox } = services;
  // the account the owner's browser is signed in to must be the one named for this PC, which a press never sets
  if (relay.savedRelayAccount() !== account) return refuse("account_mismatch", SET_UP_FOR_ANOTHER, 409);
  if (devices.account() !== null) return refuse("in_account", "This PC is already in an account", 409);
  // an account whose signed list removed this PC takes it back on no path: only as a new PC, after a reset relay identity
  if (devices.listRemovedFrom(account)) return refuse("list_removed", LIST_REMOVED_FROM, 409);
  // a Revoke all, a reset or a denial while the service answers raises this: the press then binds nothing (PADD-1).
  // Read before the first thing this press asks of the account service, so one that ends while any of it is out counts
  const generation = devices.gen();
  // a relay identity reset meanwhile makes this another PC to the account service: its answer was for the old one
  const identity = relay.currentIdentity()?.server_id ?? null;
  // an account that keeps a signed list takes a PC by that list alone: never on the account service's word
  try {
    if (await accountMailbox.listNamed(account) !== null) return refuse("list_add", LIST_ADD_ONLY, 409);
  } catch (error) { return refuse("account_unavailable", error instanceof Error ? error.message : String(error), 503); }
  let admitted: Awaited<ReturnType<AccountMailbox["admission"]>>;
  try { admitted = await accountMailbox.admission(account); }
  catch (error) {
    // The account made its list after this PC last asked whether it keeps one: the account service takes no admission
    // for it, and what this PC remembered of "no list" is dropped, so its next ask goes by the list
    if (error instanceof AccountServiceRefusal && error.status === 409 && error.code === "list_add") {
      accountMailbox.forgetListNamed(account);
      return refuse("list_add", LIST_ADD_ONLY, 409);
    }
    // a listing an invite made is offered Add for ten minutes: asking again past them waits for nothing
    if (error instanceof AccountServiceRefusal && error.code === "listing_expired") return refuse("listing_expired", "Your devices no longer offer Add for this PC: its card ran out 10 minutes after it was listed", 409);
    return refuse("account_unavailable", error instanceof Error ? error.message : String(error), 503);
  }
  if (admitted === null) return refuse("no_admission", "The account service did not admit this PC in one press", 404);
  // the service's word counts only for the account named here (G1)
  if (admitted.account !== account) return refuse("account_mismatch", "The account service answered for another account", 502);
  // the listing is what this PC's place in the account is checked by from now on: an add that names none gives it no standing
  const listing = admitted.listing_id;
  if (listing === undefined) return refuse("listing_unnamed", "The account service named no listing for this add", 502);
  // what the PC was named for, or its account, may have changed while the service answered: decided again now
  if (relay.savedRelayAccount() !== account) return refuse("account_mismatch", SET_UP_FOR_ANOTHER, 409);
  if (devices.account() !== null) return refuse("in_account", "This PC is already in an account", 409);
  if ((relay.currentIdentity()?.server_id ?? null) !== identity) return refuse("identity_changed", "This PC's relay identity was reset while it was being added. Add it again.", 409);
  if (devices.gen() !== generation) return refuse("revoked", "Every device was revoked on this PC while it was being added. Add it again.", 409);
  devices.bindByService(account, listing);
  const binding = devices.serviceBinding();
  await accountMailbox.readSnapshot();
  // the account may have stopped listing this PC during that first read: then it is in no account, and says so
  if (devices.serviceBinding() !== binding) return refuse("not_listed", "The account removed this PC while it was being added", 409);
  // bound: the add is complete, on this PC's own scoped word (account#57), so the account never shows it only listed
  await accountMailbox.complete(account, listing);
  if (devices.serviceBinding() !== binding) return refuse("not_listed", "The account removed this PC while it was being added", 409);
  return { account };
}

/** How long after a one-press ask that found no admission yet this PC counts as waiting for an Add. */
export const WAITING_FOR_ADD_MS = 30_000;

/** When this PC's own window or CLI last asked for its one-press admission and was told to wait, by its device store. */
const lastWaits = new WeakMap<DeviceStore, number>();

/**
 * Notes what a one-press ask from this PC's window or CLI (`ovis add`, `ovis join`) got: no admission yet, or the
 * account service not answering, means it is still waiting for Add on a device of the account (they ask every 6 to 15
 * seconds); anything else ends that.
 */
export function notePressAsk(devices: DeviceStore, outcome: PressOutcome, now = Date.now()): void {
  if ("refused" in outcome && (outcome.refused.code === "no_admission" || outcome.refused.code === "account_unavailable")) lastWaits.set(devices, now);
  else lastWaits.delete(devices);
}

/** The same for an add by the account's signed list (POST /api/account/list/add): waiting while a number is to come, shows, or was confirmed. */
export function noteListAdd(devices: DeviceStore, waiting: boolean, now = Date.now()): void {
  if (waiting) lastWaits.set(devices, now);
  else lastWaits.delete(devices);
}

/** Whether something on this PC is waiting for Add on a device of its account right now (GET /api/account/status). */
export function waitingForAdd(devices: DeviceStore, now = Date.now()): boolean {
  const at = lastWaits.get(devices);
  return at !== undefined && now - at < WAITING_FOR_ADD_MS && devices.account() === null;
}

/**
 * Over SSH, another PC of the owner names only the account (its own binding's) and this PC's ID as it read it a moment
 * before: this PC names itself for that account and presses, on its own proof to the service. A PC already in that
 * account answers as added (a lost answer asked again); one in another account binds nothing. Once in the account it
 * turns its relay on (relayForAdd) and answers with it: within `onlineWithinMs` of that. A PC that left the account, or
 * whose relay identity was reset, while it waited for its relay answers as pressOnce does for those.
 */
export async function takeForAccount(services: PressServices, account: string, serverId: string, onlineWithinMs = ADDED_RELAY_ONLINE_MS): Promise<TakeOutcome> {
  if ((services.relay.currentIdentity()?.server_id ?? null) !== serverId) return refuse("identity_changed", "This PC's relay identity changed since it was read. Add it again.", 409);
  const bound = services.devices.account();
  if (bound !== null && bound !== account) return refuse("other_account", "This PC is in another account", 409);
  if (bound === null) {
    if (!services.relay.setRelayAccount(account)) return refuse("invalid_account", "Name the account", 400);
    const pressed = await pressOnce(services, account);
    if ("refused" in pressed) return pressed;
  }
  const binding = services.devices.serviceBinding();
  const relay = await relayForAdd(services.relay, account, onlineWithinMs, bound === null);
  if (services.devices.account() !== account || services.devices.serviceBinding() !== binding) return refuse("not_listed", "The account removed this PC while it was being added", 409);
  if ((services.relay.currentIdentity()?.server_id ?? null) !== serverId) return refuse("identity_changed", "This PC's relay identity was reset while it was being added. Add it again.", 409);
  return { account, relay };
}

/** What a take that named a list says when this PC does not join by it, by the join's refusal: its code, words and status. */
const LIST_TAKE_REFUSALS: Readonly<Record<JoinRefusal, readonly [string, string, number]>> = {
  other_account: ["other_account", "This PC is in another account", 409],
  other_keys: ["other_keys", "Your account's list holds this PC by an entry with other keys than the ones it posted, so this PC follows no list by this add.", 409],
  other_adder: ["other_adder", "Your account's list holds this PC by an entry another key signed than the PC that adds it over SSH, so this PC follows no list by this add.", 409],
  pinned: ["pinned", "This PC already follows another list. Revoke all on this PC to leave its account first.", 409],
  removed: ["list_removed", LIST_REMOVED_FROM, 409],
  invalid_list: ["invalid_list", "Name the account and its list by their ids", 400],
  not_in_account: ["unavailable", "This PC's account could not be read", 503],
  unavailable: ["unavailable", "This PC's relay identity, its list or its keys cannot be read or written.", 503],
  ended: ["identity_changed", "This PC's relay identity was reset while it was being added. Add it again.", 409],
  line_unproven: ["unavailable", "This PC could not join the account's list", 503],
  invite_unknown: ["unavailable", "This PC could not join the account's list", 503],
};

/**
 * Over SSH, another PC of the owner adds this one to an account that keeps a signed list (docs/account.md, "Adding a PC
 * over SSH to an account that keeps a list"): it names the account, the list and its own list key, `adder`. That take,
 * on this PC's owner socket over the owner's own SSH session, is the act at this PC that names the list: nothing the
 * account service says names one here, and no number is compared. Until the list holds an entry that adds this PC, it
 * answers its card for that list (posting its keys at the account service meanwhile, the second lock of that entry),
 * which the adding PC signs into a `pc` entry. Once the list holds it, signed by `adder` and no other key, this PC joins
 * the account by the list, pinned from its first moment (ListFollow.joinList), and its relay comes on as for a take. A
 * PC already in that account names the list as its own window would; one in another account, or that the account's
 * list removed, names nothing.
 */
export async function takeByList(services: PressServices & { readonly accountList: ListFollow | null }, account: string, serverId: string,
  named: { readonly list: string; readonly adder: string }, onlineWithinMs = ADDED_RELAY_ONLINE_MS): Promise<(TakeOutcome & { readonly list_joined?: true }) | ListTakeWaiting> {
  const { devices, relay, accountMailbox, accountList } = services;
  const identity = () => relay.currentIdentity()?.server_id ?? null;
  if (identity() !== serverId) return refuse("identity_changed", "This PC's relay identity changed since it was read. Add it again.", 409);
  if (accountList === null) return refuse("unavailable", "This PC follows no list", 503);
  const bound = devices.account();
  if (bound !== null && bound !== account) return refuse("other_account", "This PC is in another account", 409);
  // an account whose signed list removed this PC takes it back on no path: only as a new PC, after a reset relay identity
  if (devices.listRemovedFrom(account)) return refuse("list_removed", LIST_REMOVED_FROM, 409);
  // in no account: named for that account, as a take names it before it presses, so its relay pass is asked under it
  if (bound === null && !relay.setRelayAccount(account)) return refuse("invalid_account", "Name the account", 400);
  // following that very list before this take: the take found it there, and joined it to nothing
  const before = bound !== null && accountList.status().pinned_list === named.list;
  // A Revoke all, a reset or a denial at this PC while the join reads the list moves this counter: the join's binding
  // write asks `live` in the very step it writes, so one that ends while the list is read binds nothing (as pressOnce)
  const generation = devices.gen();
  const joined = await accountList.joinList({ account, list: named.list, by: named.adder, live: () => identity() === serverId && devices.gen() === generation });
  if ("refused" in joined && joined.refused === "ended" && identity() === serverId) return refuse("revoked", "Every device was revoked on this PC while it was being added. Add it again.", 409);
  if ("refused" in joined) {
    const [code, message, status] = LIST_TAKE_REFUSALS[joined.refused];
    return refuse(code, message, status);
  }
  if ("waiting" in joined) {
    // its card for that list, for the adding PC to sign: the keys it just posted, for this list and its own relay key
    const card = await accountList.cardFor(named.list);
    if (card === null) return refuse("unavailable", "This PC's relay identity, its list or its keys cannot be read or written.", 503);
    return { state: "waiting", standing: joined.waiting, ...card };
  }
  // in the account by its list: the receipt it owes the account service goes out with its next pull
  accountMailbox.joinedByList();
  const relayNow = await relayForAdd(relay, account, onlineWithinMs, bound === null);
  if (devices.account() !== account) return refuse("not_listed", "The account removed this PC while it was being added", 409);
  // still following the list this take named, after the relay wait: one that left it, or another list, is no add by it
  if (accountList.status().pinned_list !== named.list) return refuse("not_listed", "This PC no longer follows your account's list. Add it again.", 409);
  if (identity() !== serverId) return refuse("identity_changed", "This PC's relay identity was reset while it was being added. Add it again.", 409);
  return { account, relay: relayNow, ...(before ? {} : { list_joined: true as const }) };
}

/**
 * A PC added over SSH is opened through its relay, and one installed over SSH never had it turned on (its own page was
 * never opened), so the add ends as `ovis add` ends: named for the account again (a relay pass refused while this PC was
 * unlisted is asked for again), its relay turned on when it is off, as its own Settings switch does (RelayService.start:
 * the switch's state is saved, and a device gate still open closes), then waited for until it is online, `within` at most.
 * A PC already in the account (`firstBind` false) whose owner set that switch keeps it as set: only one whose switch was
 * never set is turned on. Nothing else is turned on, and a relay that may not run here is reported as it stands; nothing
 * here throws, so a bind already made is never answered as a failure.
 */
async function relayForAdd(relay: RelayService, account: string, within: number, firstBind: boolean): Promise<AccountAddRelay> {
  try { relay.setRelayAccount(account); }
  catch (error) { console.warn("[account] the account an added PC asks its relay pass under was not saved", error instanceof Error ? error.message : error); }
  let status = relay.status();
  // a shutdown or an identity reset under way refuses the start: the relay is reported as it is
  if (status.phase === "off" && (firstBind || !relay.switchSet())) {
    try { status = relay.start(); }
    catch { status = relay.status(); }
  }
  const deadline = Date.now() + within;
  while (status.phase !== "online" && status.phase !== "off" && status.blocked === null && Date.now() < deadline) {
    await Bun.sleep(Math.min(RELAY_POLL_MS, Math.max(0, deadline - Date.now())));
    status = relay.status();
  }
  return { phase: status.phase, blocked: status.blocked };
}
