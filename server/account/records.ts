/**
 * Applying account records to this PC's devices.json (docs/account.md, "Account members" and
 * "Records"). The device list stays the only authority: a record changes it only when its signer is
 * a drive member of this PC's account, and never lets a removed key back in.
 */
import { accountDeviceId, AccountRecordError, ACCOUNT_RECORDS_MAX, parseAccountRecord, verifyAccountRecord, type AccountRecord, type LinkRecord } from "../../shared/account-records.ts";
import { AdmissionRefusedError, ReplacementNeedsAppError, type DeviceStore, type LinkArrival } from "../devices.ts";
import type { PairedDevice } from "../../shared/protocol.ts";
import type { Vouch } from "./mailbox.ts";

import type { SafetyLog } from "./safety-log.ts";

/** `list_followed`: this PC lets its account's devices in by the account's signed list alone, so no record adds one. */
export type RecordRefusal = "record_invalid" | "signature_invalid" | "account_mismatch" | "signer_not_member" | "tombstoned" | "link_not_owner" | "account_unavailable" | "enrolling" | "removal_pending" | "closed" | "read_pending" | "older_device" | "list_followed";

/** What holds an `add` back on this PC (mailbox.ts `gates`, docs/account.md "Enrolling a PC"). */
export interface AddGates {
  /** A flag-on mailbox keeps signed adds pending until its whole snapshot commits. */
  readonly deferAdd?: (record: AccountRecord) => boolean;
  /** the PC waits for the member that linked it first to hand it the account's devices */
  enrolling(): boolean;
  /** T36: a self-leave is not held by a queued remove for its own key. */
  held(key: string, includeWaiting?: boolean): boolean;
  /** a remove waiting here names `key` (an add it signed waits until that settles) */
  removing?(key: string): boolean;
}
export type RecordOutcome = { id: string | null; outcome: "applied" | "unchanged" } | { id: string | null; outcome: "refused"; code: RecordRefusal };

async function read(value: unknown): Promise<AccountRecord | { refused: RecordRefusal; id: string | null }> {
  const id = typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;
  let record: AccountRecord;
  try { record = parseAccountRecord(value); } catch (error) {
    if (error instanceof AccountRecordError) return { refused: "record_invalid", id };
    throw error;
  }
  return await verifyAccountRecord(record) ? record : { refused: "signature_invalid", id: record.id };
}

/** One `add` or `remove`, after its signature held. A `link` never applies here: only its own row's session sends it. */
function apply(store: DeviceStore, record: AccountRecord, serverId: string | null, now: number, gates?: AddGates): RecordOutcome {
  const refused = (code: RecordRefusal): RecordOutcome => ({ id: record.id, outcome: "refused", code });
  if (record.kind === "link") return refused("link_not_owner");
  if (store.accountError !== null) return refused("account_unavailable");
  // a PC pinned to the account's signed list takes its devices from that list: a record still removes one, and adds none
  if (record.kind === "add" && store.listFollowed()) return refused("list_followed");
  const account = store.account();
  if (account !== null && account !== record.account) return refused("account_mismatch");
  // A lock can hide the signer as well. It is a final refusal, not a missing signer to retry.
  const closed = record.kind === "add" && !store.admits(record.key);
  // a member of any role may sign the remove of its own key: that is how a device leaves (docs/account.md)
  const leaving = record.kind === "remove" && record.signer === record.key;
  const signer = store.accountSigner(record.signer, record.account, leaving);
  if (!signer) return refused(closed ? "closed" : "signer_not_member");
  if (record.kind === "remove" && store.opensAll()) {
    if (gates?.held(record.signer, !leaving)) return refused("removal_pending");
    if (!store.removeAuthority(record.signer, record.key, record.account)) return refused("older_device");
  }
  if (record.kind === "remove") return { id: record.id, outcome: store.removeAccountKey(record.key, record.account, { id: record.id, issuedAt: record.issued_at, by: { device_id: signer.id, label: signer.label }, signed: record }, now) ? "applied" : "unchanged" };
  // the signature covers the signer only: a key off the curve would leave a devices.json no store can read
  if (!store.acceptsRelayKey(record.key)) return refused("record_invalid");
  if (store.isTombstoned(record.key)) return refused("tombstoned");
  if (closed) return refused("closed");
  if (store.hasKey(record.key)) {
    store.keepAccountAdd(record, signer.id);
    return { id: record.id, outcome: "unchanged" };
  }
  if (gates?.enrolling()) return refused("enrolling");
  // a key this PC holds back, or a signer it holds back (a remove for it waits here): the add waits for that to settle
  if (gates?.held(record.key) || gates?.removing?.(record.signer)) return refused("removal_pending");
  if (serverId === null) return refused("account_unavailable");
  const id = accountDeviceId(serverId, record.key);
  if (!store.canAddAt(id, record.key)) return refused("record_invalid");
  try { store.addAccountDevice({ id, key: record.key, label: record.label, role: record.role, account: record.account, addedBy: signer.id, record }, now); }
  catch (error) {
    if (error instanceof AdmissionRefusedError) return refused("removal_pending");
    throw error;
  }
  return { id: record.id, outcome: "applied" };
}

/**
 * A remove refused only because its signer is not a member here yet, handed to `wait` before the next
 * record applies, so an add for the same key later in the batch already meets it (AddGates.held).
 * One `wait` could not keep is undecided (`account_unavailable`): its sender tries again.
 */
function waited(outcome: RecordOutcome, record: AccountRecord, value: unknown, wait: ((record: unknown) => boolean) | undefined, undecided: Set<string>): RecordOutcome {
  if (wait === undefined || record.kind !== "remove" || outcome.outcome !== "refused" || outcome.code !== "signer_not_member") return outcome;
  if (wait(value)) return outcome;
  // not kept anywhere: the rest of the batch still treats its key as removed
  undecided.add(record.key);
  return { id: outcome.id, outcome: "refused", code: "account_unavailable" };
}

/** `gates` with the keys of this batch's removes that could not be kept: an add for one is held back too. */
function withUndecided(gates: AddGates | undefined, undecided: ReadonlySet<string>): AddGates {
  return { enrolling: () => gates?.enrolling() ?? false, held: (key, includeWaiting = true) => (includeWaiting && undecided.has(key)) || (gates?.held(key, includeWaiting) ?? false), removing: (key) => undecided.has(key) || (gates?.removing?.(key) ?? false) };
}

function deferAdd(record: AccountRecord, keep?: (record: AccountRecord) => boolean): RecordOutcome {
  return { id: record.id, outcome: "refused", code: keep?.(record) === false ? "account_unavailable" : "removal_pending" };
}

export async function applyAccountRecords(store: DeviceStore, values: readonly unknown[], serverId: string | null, now = Date.now(), gates?: AddGates & { safetyLog?: SafetyLog | null; requestRead?(): void }, wait?: (record: unknown) => boolean): Promise<RecordOutcome[]> {
  if (values.length > ACCOUNT_RECORDS_MAX) throw new RangeError(`At most ${ACCOUNT_RECORDS_MAX} records at once`);
  const outcomes: RecordOutcome[] = [];
  const undecided = new Set<string>();
  const batchGates = withUndecided(gates, undecided);
  for (const value of values) {
    // a denial while this record is verified means its add no longer stands on what was checked (P14)
    if (gates?.safetyLog && typeof value === "object" && value !== null && "kind" in value && value.kind === "lift") {
      outcomes.push(await store.handedLifts.receive(value, store, gates.safetyLog));
      continue;
    }
    const noted = store.gen();
    const record = await read(value);
    if (!("refused" in record) && record.kind === "add" && store.listFollowed()) {
      // not kept for a later read either: nothing a read brings makes this add count
      outcomes.push({ id: record.id, outcome: "refused", code: "list_followed" });
      continue;
    }
    if (!("refused" in record) && record.kind === "add" && (gates?.deferAdd || store.gen() !== noted)) {
      outcomes.push(deferAdd(record, gates?.deferAdd));
      continue;
    }
    outcomes.push("refused" in record ? { id: record.id, outcome: "refused", code: record.refused } : waited(apply(store, record, serverId, now, batchGates), record, value, wait, undecided));
  }
  if (outcomes.some((result) => result.outcome === "refused" && result.code === "read_pending")) gates?.requestRead?.();
  return outcomes;
}

/**
 * An enrollment (POST /api/account/enroll, docs/account.md "Enrolling a PC"), in the server's order
 * whatever the client's: every `remove` first, in the order signed, then the `add`s in rounds, so an
 * add whose signer another add of the batch lets in applies in the next round. After each round
 * `settle` retries what waits here, so a remove whose signer just became a member applies before the
 * next round's adds. `wait` keeps a remove refused only for its signer; false when it could not.
 */
export async function applyEnrollment(store: DeviceStore, values: readonly unknown[], serverId: string | null, options: {
  gates: AddGates; wait: (record: unknown) => boolean; settle: () => Promise<unknown>; now?: number;
}): Promise<RecordOutcome[]> {
  const now = options.now ?? Date.now();
  const undecided = new Set<string>();
  const gates = withUndecided(options.gates, undecided);
  const outcomes: (RecordOutcome | undefined)[] = values.map(() => undefined);
  const noted = store.gen();
  const records = await Promise.all(values.map(read));
  // a denial while the batch was verified: its removes still apply, and none of its adds (P14)
  const moved = store.gen() !== noted;
  const removes: number[] = [];
  let adds: number[] = [];
  records.forEach((record, index) => {
    if ("refused" in record) outcomes[index] = { id: record.id, outcome: "refused", code: record.refused };
    else if (record.kind === "remove") removes.push(index);
    else adds.push(index);
  });
  const record = (index: number): AccountRecord => {
    const value = records[index];
    if (value === undefined || "refused" in value) throw new Error("Only a record that verified is applied");
    return value;
  };
  const signed = (index: number) => record(index).issued_at;
  // issued_at met ISO_MS at parse: a four-digit year, so string order is time order
  for (const index of removes.sort((a, b) => signed(a) < signed(b) ? -1 : signed(a) > signed(b) ? 1 : 0)) {
    outcomes[index] = waited(apply(store, record(index), serverId, now, gates), record(index), values[index], options.wait, undecided);
  }
  for (let progress = true; progress && adds.length;) {
    progress = false;
    const next: number[] = [];
    for (const index of adds) {
      const verified = record(index);
      const heldBack = moved || (store.opensAll() && verified.kind === "add" && (undecided.has(verified.signer) || undecided.has(verified.key)));
      const outcome: RecordOutcome = verified.kind === "add" && store.listFollowed() ? { id: verified.id, outcome: "refused", code: "list_followed" }
        : heldBack ? deferAdd(verified) : verified.kind === "add" && store.opensAll()
        ? deferAdd(verified, options.wait) : apply(store, verified, serverId, now, gates);
      outcomes[index] = outcome;
      if (outcome.outcome === "refused" && outcome.code === "signer_not_member") next.push(index);
      else if (outcome.outcome === "applied") progress = true;
    }
    adds = next;
    if (progress) await options.settle();
  }
  return outcomes.map((outcome) => {
    if (outcome === undefined) throw new Error("Every record of an enrollment has an outcome");
    return outcome;
  });
}

/** Verify mailbox signatures before the whole read; local authority is checked only by the returned commit. */
export async function stageMailboxAdds(values: readonly unknown[]) {
  const staged = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "add") continue;
    const record = await read(value);
    if (!("refused" in record) && record.kind === "add") staged.push({ value, key: record.key,
      commit: (store: DeviceStore, serverId: string, gates: AddGates) => apply(store, record, serverId, Date.now(), gates),
    });
  }
  return staged;
}

/** `list_removed`: this PC's relay identity was removed from that account by its signed list. */
export type LinkRefusal = RecordRefusal | "key_in_use" | "link_required" | "unverified_device" | "pairing_ended" | "replacement_needs_app" | "list_removed" | "list_named";

/** What a link is held to on this PC besides its devices (server/account/routes.ts). */
export interface LinkRules {
  /** what holds a key back here (mailbox.ts `gates`) */
  gates?: AddGates;
  /**
   * For a row that waits to link: called once its link has passed every check, in the turn that writes its row and
   * before that write. It puts on disk what must be there first (the enrollment barrier), and returns what takes
   * that back, should the row not be written.
   */
  barrier?: () => () => void;
  /**
   * the account this PC's signed-in owner named for it, read when the link is judged; null for none. A row that
   * waits to link is taken into that account alone, so with none named it is taken into none
   */
  setUpFor?: () => string | null;
  /**
   * The account service's word on `key` for `account` (mailbox.ts `vouch`), asked for every link made while a code made
   * for a PC in no account lives; `firstLink`: the link of a device that paired with that code. Without it no such link
   * passes
   */
  vouch?: (account: string, key: string, firstLink: boolean) => Promise<Vouch>;
}

/**
 * A link that was refused: by which check, and in words of its own where the code alone does not say what to do.
 * `retryAfter`: in how many seconds the account service may be asked again, when it could not be.
 */
export interface LinkRefused { refused: LinkRefusal; message?: string; retryAfter?: number }

/** What a device reads when its link names another account than the one this PC was set up for: the way out is on the PC. */
const SET_UP_FOR_ANOTHER_ACCOUNT = "This PC was set up for another Ovis account than the one this device is signed in to. To add it to this device's account instead, run `ovis add` on the PC again and sign in there with that account.";

/**
 * As SET_UP_FOR_ANOTHER_ACCOUNT, for a device that waited to link: naming another account on the PC ends the code it
 * paired with (RelayService.setRelayAccount), so it pairs again with the code shown after that.
 */
const SET_UP_FOR_ANOTHER_ACCOUNT_WAITING = "This PC was set up for another Ovis account than the one this device is signed in to. To add it to this device's account instead, run `ovis add` on the PC again and sign in there with that account; then scan its new QR code.";

/** What a device that waited to link reads when the code it paired with was made for another account. */
const CODE_FOR_ANOTHER_ACCOUNT = "This PC's pairing code was made for another Ovis account than the one this device is signed in to. Sign in to that account on this device, then pair again.";

/** What a device that waited to link reads when no account was named for this PC: the way on is on the PC too. */
const ADD_AT_PC = "This PC left its Ovis account. Add it again on the PC itself: sign in there and add it to your account, or run `ovis add` there.";
const SET_UP_FOR_NO_ACCOUNT = "This PC is not set up for an Ovis account yet. Sign in on the PC and add it to your account, or run `ovis add` there; then scan its QR code again.";

/** What a device reads when it links itself on a PC that takes its account's devices from the account's signed list. */
const LIST_FOLLOWED = "This PC lets devices of its Ovis account in by the account's signed list. This device stays paired with this PC; to add it to the account, allow it from a device or PC that is in the account.";
/**
 * What is read when something would bring a PC back into an account whose list removed it. The code `list_removed` is
 * what a screen goes by: the add at the PC itself is to offer the way back as one confirmed step ("This PC was removed
 * from this account. Add it again as a new PC?"), which resets the relay identity and adds the PC it then is. Until that
 * screen is built these words name the two steps.
 */
export const LIST_REMOVED_FROM = "This PC was removed from this Ovis account. It can come back only as a new PC: on the PC, reset its relay identity, then add it again.";

/** What a device reads when its account's service has no word from that account about this device. */
const UNVERIFIED_DEVICE = "Your Ovis account did not confirm this device for this PC. Open Ovis on this device signed in to that account, then scan the PC's QR code again.";

/** What a device reads when the account service could not be asked: it may send the same link again later. */
const SERVICE_UNAVAILABLE = "The Ovis account service did not answer, so this PC could not confirm this device. Try again in a moment.";

/** What a device that already drives this PC reads when the code it was linking under ended, or another came, meanwhile. */
const PAIRING_ENDED = "This PC's pairing code ended or changed while this device was linking. Send the link again.";
/** Said to a row that waits to link and named its account's signed list for this PC, when it then sends a link. */
export const LIST_NAMED_LINK = "This device named its account's signed list for this PC, so the PC joins that account by its list alone, once the list holds it. To link this device instead, scan the PC's QR code again.";
/** Said to a row that waits to link and names a second list for this PC. */
export const LIST_NAMED_OTHER = "This device named another list for this PC already. Scan the PC's QR code again.";

/** What applyLink's look found: the row still waits to link, the account it must name, and whether the account service is asked. */
interface Look { waits: boolean; expected: string | null; vouching: boolean }

/**
 * Every check of a link that answers without a wait, read now: run once before the account service is asked, and
 * once more after, in the turn that writes. A row that waits to link is turned away for another account.
 */
function look(store: DeviceStore, link: LinkRecord, deviceId: string, arrival: LinkArrival, rules: LinkRules): Look | LinkRefused {
  if (store.accountError !== null) return { refused: "account_unavailable" };
  // What the row is now, after the wait above. One that waited to link when its link arrived and has gone since
  // (its time ran out, its code ended) is gone: its link is never judged as a device's
  const waits = arrival.provisional && store.provisionalStands(deviceId);
  // also when another link of the same row made it a member meanwhile: this one was judged as a waiting row's, so it
  // never changes that member
  if (arrival.provisional && !waits) return { refused: "link_required" };
  const account = store.account();
  if (account !== null && account !== link.account) return { refused: "account_mismatch" };
  // A PC pinned to its account's signed list has its members from that list alone: a link makes none, whoever vouches
  // for it. The row keeps the pairing it has
  if (store.listFollowed()) return { refused: "list_followed", message: LIST_FOLLOWED };
  // A PC that the account's list removed joins that account again on no path, until its relay identity is reset
  if (account === null && store.listRemovedFrom(link.account)) {
    if (waits) store.turnAway(deviceId, "account_mismatch", link.account);
    return { refused: "list_removed", message: LIST_REMOVED_FROM };
  }
  // A PC its account stopped listing joins one again only by an add made at the PC: its own press, a code it issued
  // itself, or digits its own screen approved since. A device it kept paired, or a code such a device asked for,
  // brings it into none
  if (account === null && store.addAtPcRequired() && !(arrival.pinned !== null && store.issuedAtPc(arrival.pinned)) && !store.approvedAtPcSinceClear(deviceId)) {
    if (waits) store.turnAway(deviceId, "account_mismatch", link.account);
    return { refused: "account_mismatch", message: ADD_AT_PC };
  }
  // A device that already drives this PC is held to the code made for a PC in no account that lived when its link
  // came, and to none that came since: if that is no longer the code alive (it ended, another replaced it, the PC
  // joined an account meanwhile), nothing changes for it
  if (!arrival.provisional && arrival.pinned !== store.pinnedCode()) return { refused: "pairing_ended", message: PAIRING_ENDED };
  // A PC in no account that its signed-in owner set up for one (POST /api/account/relay-account, as `ovis add` sends
  // it before it shows its code) takes its first member from that account. A link that names another is refused: a
  // row that waits to link goes at once, and a device keeps what it had. The refusal ends no code by itself, but a
  // code with no pairing left, or past its ten minutes, ends as the last row that waits under it goes. While a code
  // made for an account lives, every link is held to that account alone. A row that waits to link is held to the code
  // it paired with, by the account id its own signed link names, until it links or goes, also once that code's ten
  // minutes are over
  const codeFor = waits ? store.waitingFor(deviceId) : account === null && arrival.pinned !== null ? store.pinnedFor(arrival.pinned) : null;
  // A row that waits under the relay tab's code is held to the account named when that code was made, and only while
  // that account is the one named now: no change of naming, seen by the setter or not, carries it elsewhere, and a
  // name that cannot be read is none
  const issuedUnder = waits && account === null ? store.issuedUnder(deviceId) : null;
  const named = rules.setUpFor?.() ?? null;
  const expected = account === null ? codeFor ?? issuedUnder ?? named : null;
  if ((expected !== null && expected !== link.account) || (issuedUnder !== null && named !== null && named !== issuedUnder)) {
    if (waits) store.turnAway(deviceId, "account_mismatch", link.account);
    return { refused: "account_mismatch", message: codeFor !== null ? CODE_FOR_ANOTHER_ACCOUNT : waits ? SET_UP_FOR_ANOTHER_ACCOUNT_WAITING : SET_UP_FOR_ANOTHER_ACCOUNT };
  }
  // A row that waits to link is taken into the account this PC was set up for and into no other: with none named it
  // is refused the same way, and goes at once
  if (waits && (expected === null || (issuedUnder !== null && named === null))) {
    store.turnAway(deviceId, "account_mismatch", link.account);
    return { refused: "account_mismatch", message: SET_UP_FOR_NO_ACCOUNT };
  }
  // while such a code lives, the account it is for must vouch for the key of every link, and always for the link of a
  // row that paired with one (docs/account.md, "The account's word")
  return { waits, expected, vouching: (waits || arrival.pinned !== null) && expected !== null };
}

/**
 * A list a row that waits to link named (listNamedBy). `settled` while the account service is still asked about the
 * row's key: what the naming comes to, which an ask of the same naming meanwhile waits for.
 */
interface ListNaming { readonly account: string; readonly list: string; readonly key: string; settled: Promise<{ ok: true } | LinkRefused> | null }

/** The lists rows that wait to link have named, by device store: a row names one list, and is asked about once. */
const namedLists = new WeakMap<DeviceStore, Map<string, ListNaming>>();

/** The list the row `deviceId` named, or is naming, for this PC (listNamedBy); undefined for none. Its asks from then on are of where that naming stands. */
export function listNamingOf(store: DeviceStore, deviceId: string): { readonly account: string; readonly list: string; readonly key: string } | undefined {
  return namedLists.get(store)?.get(deviceId);
}

/**
 * A device that paired with this PC by a code made for a PC in no account names its account's signed list, in place of
 * a link (docs/account.md, "A device that scans the PC's QR code names the list"): the pairing by that code is a
 * channel the account service is no part of, so what the device says in it is the device's own word. Every rule of a
 * link holds for it, and the account service's word on the device's key, so it brings the PC nowhere a link would
 * not. A row names one list. Nothing is written: the PC then joins by that list, or not at all (ListFollow.joinList).
 */
export async function listNamedBy(store: DeviceStore, named: { readonly account: string; readonly list: string }, session: { deviceId: string; sessionKey: string }, arrival: LinkArrival, rules: LinkRules = {}): Promise<{ ok: true } | LinkRefused> {
  const { deviceId, sessionKey } = session;
  const link = { account: named.account } as LinkRecord;
  const looked = look(store, link, deviceId, arrival, rules);
  if ("refused" in looked) return looked;
  // only a PC in no account, and only a device that waits to link under a code made for that account
  if (store.account() !== null || !looked.waits || looked.expected === null) return { refused: "link_required" };
  if (store.isTombstoned(sessionKey)) return { refused: "tombstoned" };
  const rows = namedLists.get(store) ?? new Map<string, ListNaming>();
  namedLists.set(store, rows);
  const before = rows.get(deviceId);
  if (before !== undefined) {
    if (before.account !== named.account || before.list !== named.list || before.key !== sessionKey) return { refused: "pairing_ended", message: LIST_NAMED_OTHER };
    // the same naming, asked again while the account service is asked about it: what that comes to
    return await (before.settled ?? { ok: true as const });
  }
  // The row's naming is taken now, before anything is awaited: a naming of another list meanwhile is refused, and an ask
  // of this one waits for this one's answer. One the account service does not confirm is no naming
  let settle!: (outcome: { ok: true } | LinkRefused) => void;
  const naming: ListNaming = { account: named.account, list: named.list, key: sessionKey, settled: new Promise((resolve) => { settle = resolve; }) };
  rows.set(deviceId, naming);
  let outcome: { ok: true } | LinkRefused = { refused: "account_unavailable", message: SERVICE_UNAVAILABLE };
  try { outcome = await confirmNaming(store, link, { deviceId, sessionKey, expected: looked.expected }, arrival, rules); }
  finally {
    if (!("ok" in outcome) && rows.get(deviceId) === naming) rows.delete(deviceId);
    naming.settled = null;
    settle(outcome);
  }
  return outcome;
}

/** The account service's word on the key of a row that names its list, and every check of a link read again after it. */
async function confirmNaming(store: DeviceStore, link: LinkRecord, row: { readonly deviceId: string; readonly sessionKey: string; readonly expected: string }, arrival: LinkArrival, rules: LinkRules): Promise<{ ok: true } | LinkRefused> {
  const { deviceId, sessionKey, expected } = row;
  store.noteLink(deviceId, "asked");
  const word = rules.vouch ? await rules.vouch(expected, sessionKey, true) : { vouched: false };
  // whatever happened meanwhile (the row's time, the code's end) is read again now
  const looked = look(store, link, deviceId, arrival, rules);
  if ("refused" in looked) return looked;
  if (store.account() !== null || !looked.waits) return { refused: "link_required" };
  if ("unavailable" in word) {
    store.noteLink(deviceId, "service_unreachable");
    return { refused: "account_unavailable", message: SERVICE_UNAVAILABLE, retryAfter: word.retryAfter };
  }
  if (!word.vouched) {
    store.turnAway(deviceId, "unverified");
    return { refused: "unverified_device", message: UNVERIFIED_DEVICE };
  }
  return { ok: true };
}

/**
 * A `link` from the device `deviceId` over its own session to the PC `serverId`. It needs no
 * member: the session is its authority, which is how a PC gets its first one.
 *
 * Only the record's parsing and its signature check wait, and, while a code made for a PC in no account lives, the
 * account service's word on the link's key (rules.vouch). After the last wait every check runs again, and the checks
 * and the write run in one turn, so two links that both passed their waits never both write. `arrival`: what stood
 * when the link arrived, before those waits (DeviceStore.linkArrived).
 */
export async function applyLink(store: DeviceStore, value: unknown, session: { deviceId: string; serverId: string; sessionKey: string; sessionId?: string }, arrival: LinkArrival, rules: LinkRules = {}): Promise<{ device: PairedDevice } | LinkRefused> {
  const { deviceId, serverId, sessionKey, sessionId } = session;
  const record = await read(value);
  if ("refused" in record) return { refused: record.refused };
  if (record.kind !== "link") return { refused: "record_invalid" };
  const link: LinkRecord = record;
  // a session signed in with an older key of the row cannot move it on: only the key it proved may be replaced
  if (link.server_id !== serverId || link.device_id !== deviceId || link.old_key !== sessionKey) return { refused: "link_not_owner" };
  let looked = look(store, link, deviceId, arrival, rules);
  if ("refused" in looked) return looked;
  // A row that named its account's signed list is added by that list or not at all: the old link path is closed for it
  // (ending that naming is ending the pairing)
  if (listNamingOf(store, deviceId) !== undefined) return { refused: "list_named", message: LIST_NAMED_LINK };
  let vouched = false;
  if (looked.vouching) {
    // the key the row holds once linked is the one asked about; a quiet admission counts for the PC's first link only,
    // by a device that paired with this code
    if (looked.waits) store.noteLink(deviceId, "asked");
    const word = rules.vouch ? await rules.vouch(looked.expected!, link.key, looked.waits) : { vouched: false };
    // whatever happened meanwhile (the row's time, the code's end, another link that passed, a naming of the list) is read again now
    looked = look(store, link, deviceId, arrival, rules);
    if ("refused" in looked) return looked;
    if (listNamingOf(store, deviceId) !== undefined) return { refused: "list_named", message: LIST_NAMED_LINK };
    if ("unavailable" in word) {
      // the row and the code stay: the device sends the same link again once the service may be asked
      if (looked.waits) store.noteLink(deviceId, "service_unreachable");
      return { refused: "account_unavailable", message: SERVICE_UNAVAILABLE, retryAfter: word.retryAfter };
    }
    if (!word.vouched) {
      // a row that waits to link goes; a device keeps what it had; the code stays for the account's own device
      if (looked.waits) store.turnAway(deviceId, "unverified");
      return { refused: "unverified_device", message: UNVERIFIED_DEVICE };
    }
    vouched = true;
  }
  const { waits } = looked;
  // A removed key stays out. One comes back: a key this PC removed itself (Revoke, Revoke all), with a row that
  // waits to link and keeps the key it paired with. The link's write clears that tombstone, which stood when the row
  // paired: a removal made since took the row with it (DeviceStore.dropWaiting). A key an account removed stays out
  // of such a row too, and its removal stands
  if (store.isTombstoned(link.key) && !(waits && link.key === link.old_key && !store.removedByAccount(link.key))) return { refused: "tombstoned" };
  // a row moving to a key this PC holds back would let that key in without anyone approving it here
  if (link.key !== link.old_key && rules.gates?.held(link.key)) return { refused: "removal_pending" };
  // a row that waits with the key of a pairing this PC already has is that device, pairing again: its link renews it
  const renews = waits && link.key === link.old_key && store.pairingsRenewedBy(link.key) !== null;
  if (store.keyHeldByOther(link.key, deviceId) && !renews) return { refused: "key_in_use" };
  const takeBack = waits ? rules.barrier?.() : undefined;
  let device: PairedDevice | null = null;
  try { device = store.linkAccountKey(deviceId, link.old_key, link.key, link.account, sessionId, vouched); }
  catch (error) {
    if (error instanceof ReplacementNeedsAppError) return { refused: "replacement_needs_app" };
    throw error;
  } finally {
    // the row was not written: what went to disk for it goes too. Whatever kept the row from being written is the
    // failure to report, so a barrier that could not be taken back either is said beside it
    if (device === null) {
      try { takeBack?.(); }
      catch (left) { console.error(`[account] the enrollment barrier of a link that was not written could not be taken back: ${left instanceof Error ? left.message : String(left)}`); }
    }
  }
  return device ? { device } : { refused: "link_not_owner" };
}
