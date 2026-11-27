/**
 * A device that is in its account's signed list puts members out of it (docs/account-list.md, "Putting a member
 * out"): it signs a `remove` that ends a key, then the `epoch` the kinds call for, with the new epoch's key wrapped
 * to everybody who stays, and places all of it in one request. The same request tidies up what may no longer hold
 * the current epoch's key: an invite past its `exp`, a borrowed browser past its `until`.
 *
 * Every entry is signed through the kinds' writer, on this device's own state, and only when it would count there.
 * A key that is ended never comes back: nothing here signs it in again. The account service's answer to the
 * placement is trusted for nothing: a member is out once this device's own copy shows its removal at its place.
 */
import { listView, pcRemoval, readKind, sealEpoch, signListEntry, type ListKind, type ListState } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { standsFor } from "../../../shared/account-list-migrate.ts";
import type { AccountList, AccountListView, ListWriter } from "./accountList.ts";
import { placeOf, signedOn, signedWithEpoch, TIDY_OPERATION, writeToList, type WriteOptions, type WriteRefusal, type Written } from "./listWrite.ts";
import { SignedOutError } from "./service.ts";

/**
 * A member that came in through another key: a device it let in, a key with no name it added, or a PC it added or
 * whose invite it placed. `via` is the key it came in through.
 */
export type Arrival =
  | { readonly kind: "device"; readonly key: string; readonly seq: number; readonly via: string }
  | { readonly kind: "signer"; readonly key: string; readonly seq: number; readonly via: string }
  | { readonly kind: "pc"; readonly endpoint: string; readonly seq: number; readonly via: string };

/**
 * What came in through `key` and is still in, in the order it came in: whatever that key let in, and whatever came
 * in through those in turn, also through a member that is out already (whoever it let in may still be in). The device
 * is followed through every key it held: what it let in under a key it later handed on to `key` counts. This
 * device (`self`) is never among them, and neither is what came in through it: the person removing a key trusts the
 * device they remove it from. Devices and PCs that were in the account before the list (`carried`) came in through
 * nobody, and so did a PC carried in (`carriedEndpoints`, carriedPcs) that a later `pc` entry only gave its keys.
 */
export function cameInThrough(state: ListState, key: string, self: string | null, carriedEndpoints: ReadonlySet<string> = new Set()): Arrival[] {
  const view = listView(state);
  const placer = (signer: string | null): string | null => (signer === null ? null : state.signers[signer]?.by ?? null);
  // keys with no name, in or out: listView names only those in
  const nameless = Object.entries(state.signers).filter(([, row]) => row.as === null).map(([signer, row]) => ({ key: signer, seq: row.seq, by: row.by, out: row.ended !== null }));
  const found: Arrival[] = [];
  // the keys a device held before it handed its place on, to `of` at the end of the chain (standsFor)
  const heldBefore = (of: string): string[] => Object.keys(state.signers).filter((other) => other !== of && state.signers[other]?.ended !== null && standsFor(state, other) === of);
  const before = heldBefore(key);
  // this device, by every key it held: what came in through it is never offered
  const mine = new Set(self === null ? [] : [self, ...heldBefore(self)]);
  const seen = new Set<string>([key, ...before]);
  const from = [key, ...before];
  for (let via = from.shift(); via !== undefined; via = from.shift()) {
    // `live`: offered to the person; whether in or out, what it let in is followed
    const take = (arrival: Arrival, signs: string | null, live: boolean): void => {
      const id = arrival.kind === "pc" ? `pc:${arrival.endpoint}` : arrival.key;
      if (seen.has(id) || (arrival.kind !== "pc" && mine.has(arrival.key))) return;
      seen.add(id);
      if (live) found.push(arrival);
      if (signs !== null && !mine.has(signs)) from.push(signs);
    };
    for (const row of view.devices) if (!row.carried && row.by === via) take({ kind: "device", key: row.key, seq: row.seq, via }, row.key, row.ended === null);
    for (const row of nameless) if (row.by === via) take({ kind: "signer", key: row.key, seq: row.seq, via }, row.key, !row.out);
    for (const row of view.pcs) {
      // a PC's first admission says whom it came in through: one carried in came in through nobody
      if (row.how === "carried" || carriedEndpoints.has(row.endpoint)) continue;
      // a PC a person added came in through the key that signed its `pc`; one that joined, through whoever placed its invite
      const by = row.how === "added" ? placer(row.key) : placer(row.invite);
      if (by === via) take({ kind: "pc", endpoint: row.endpoint, seq: row.seq, via }, row.how === "added" ? row.key : null, row.removed === null);
    }
  }
  return found.sort((a, b) => a.seq - b.seq);
}

/** How many entries carriedPcs reads at a time. */
const CARRIED_PAGE = 256;

/**
 * The relay keys of the PCs carried into the list: the `carried` entries that follow entry 0 while nothing else has
 * been signed (the kinds count a `carried` only then), from this device's own copy. The list's state forgets that a
 * PC was carried once a `pc` entry gives it its keys; its first admission is read here.
 */
export function carriedPcs(list: AccountList): ReadonlySet<string> {
  const found = new Set<string>();
  for (let after: number | null = null; ;) {
    const page = list.pageAfter(after, CARRIED_PAGE);
    if (page === null || page.entries.length === 0) return found;
    for (const text of page.entries) {
      const body = readBody(entryFromText(text).body);
      if (body.seq === 0) continue;
      const kind = readKind(body);
      if (kind?.kind !== "carried") return found;
      if ("endpoint" in kind) found.add(kind.endpoint);
    }
    after = (after ?? -1) + page.entries.length;
  }
}

/** Who a removal puts out: keys (a device, a key with no name) and PCs by their relay key. */
export interface Removal {
  readonly keys: readonly string[];
  readonly pcs: readonly string[];
}

/**
 * The account, the list and the member key a write began with (the lead's X3): a write compares them again after
 * every read of the list, and ends with nothing signed where another sign-in or another list took their place.
 */
export interface WriteScope {
  readonly account: string;
  readonly list: string;
  readonly member: string;
}

/** The scope of what the page shows now: the account and list it follows and this device's key in it; null where it is in none. */
export function scopeOf(view: AccountListView): WriteScope | null {
  const self = view.devices.find((device) => device.self);
  return view.account === null || view.status.at !== "following" || view.status.standing !== "in" || self === undefined ? null
    : { account: view.account, list: view.status.list, member: self.key };
}

/**
 * Why nothing, or not everything, was put out: the write loop's reasons (listWrite.ts, WriteRefusal), or `changed`:
 * another sign-in, another list or another key stood in the write's place by its next read; `unread`: this device's
 * own store did not answer whether it keeps a copy of the account's list, which is no word that it keeps none (the
 * lead's X6); `handed`: a device asked for handed its place to a new key since (`heirs`, by the key asked for), so
 * the person is asked again for that key. `placed`: how many of the members asked for went in parts that were placed
 * before the refusal.
 */
export type RemoveOutcome =
  | { readonly removed: true }
  | {
    readonly removed: false; readonly why: WriteRefusal | "changed" | "unconfirmed" | "unread" | "handed"; readonly retryAfterMs: number | null; readonly placed: number;
    readonly unconfirmed?: readonly string[]; readonly heirs?: Readonly<Record<string, string>>;
  };

/** The most entries one request carries (the account service's bound). */
export const BATCH_ENTRIES_MAX = 16;
/** The most requests one removal places, each the next part of it. */
const PARTS_MAX = 64;

/** A request signed on a writer's state; `whole`: it holds all that was asked; `asked`: how many asked-for members it puts out. */
export interface Signed extends Written {
  readonly whole: boolean;
  readonly asked: number;
}

/**
 * The request that puts out what `removal` names and is still in, then opens the next epoch where the kinds call for
 * one and this device holds the current epoch's key (`epoch`: false for a device that puts itself out, which leaves
 * the next epoch to one that stays). A request that opens an epoch carries, in the room that is left, the removals of
 * whoever is over its time: the writer adds them itself (listWrite.ts, signedWithEpoch: by the clock it signs by, none
 * from a device adrift from its floor), so the removal asked for and its epoch always fit (the lead's X4) and the rest
 * is tidied later. Null when nothing is left to put out. A removal too long for one request is placed in parts, the
 * epoch with the last.
 */
export async function removalRequest(writer: ListWriter, removal: Removal, options: { readonly epoch: boolean }): Promise<Signed | null> {
  const current = writer.epochs.get(writer.state.epoch) ?? null;
  const opens = options.epoch && current !== null;
  // room for the epoch at the end, where this device can open it
  const room = BATCH_ENTRIES_MAX - (opens ? 1 : 0);
  const signer = { key: writer.keys.key, privateKey: writer.keys.signs };
  // each member's removal is made on the state the ones before it leave: a PC that went out with its key needs none
  let after = writer.state;
  const kinds: ListKind[] = [];
  const steps: ((state: ListState) => ListKind[])[] = [
    ...removal.keys.map((key) => (state: ListState): ListKind[] => (state.signers[key] !== undefined && state.signers[key].ended === null ? [{ kind: "remove", ends: key }] : [])),
    ...removal.pcs.map((endpoint) => (state: ListState): ListKind[] => pcRemoval(state, endpoint)),
  ];
  let whole = true;
  let asked = 0;
  for (const step of steps) {
    const next = step(after);
    if (kinds.length + next.length > room) { whole = false; break; }
    for (const kind of next) after = (await signListEntry(after, kind, signer, writer.issued_at)).state;
    kinds.push(...next);
    if (next.length > 0) asked += 1;
  }
  if (kinds.length === 0) return null;
  // the epoch goes with the last part, and only where nobody who stays could seal under the current one
  const written = whole && opens && current !== null && sealEpoch(after, writer.clock) === null ? await signedWithEpoch(writer, current, kinds) : await signedOn(writer, kinds);
  return { ...written, whole, asked };
}

/**
 * Places what `build` signs on the list as this device holds it, through the one write loop (listWrite.ts), part
 * after part until `build` has nothing left to sign. Every read must still show `scope`, or nothing more is signed.
 * Only a sign-in that ended throws.
 */
async function placeParts(list: AccountList, scope: WriteScope | null, build: (writer: ListWriter) => Promise<Signed | null>, options: WriteOptions, guard?: (writer: ListWriter) => "unconfirmed" | "handed" | null): Promise<RemoveOutcome> {
  let placed = 0;
  for (let parts = 0; parts < PARTS_MAX; parts += 1) {
    let whole = true;
    let asked = 0;
    const outcome = await writeToList<"changed" | "unconfirmed" | "handed">(list, async (writer) => {
      if (scope !== null && (writer.account !== scope.account || writer.list !== scope.list || writer.keys.key !== scope.member)) return { refused: "changed" };
      const refused = guard?.(writer) ?? null;
      if (refused !== null) return { refused };
      const request = await build(writer);
      if (request === null) return { done: placeOf(writer.state) };
      ({ whole, asked } = request);
      return { request };
    // the writer holds every read, and the request kept for this change too, against what was shown (C2) before it sends
    }, scope === null ? options : { ...options, expect: { account: scope.account, list: scope.list, key: scope.member } });
    if (!outcome.written) return { removed: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs, placed };
    placed += asked;
    if (whole) return { removed: true };
  }
  return { removed: false, why: "busy", retryAfterMs: null, placed };
}

/** What a removal puts out, as 16 hex: the sorted keys it ends and the relay keys of the PCs it puts out. */
async function removalDigest(removal: Removal): Promise<string> {
  const named = [...removal.keys, ...removal.pcs.map((endpoint) => `pc:${endpoint}`)].sort().join("\n");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(named)));
  return Array.from(hash.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Puts out the keys and PCs that `removal` names, in one request with the epoch after it, and what is over its time
 * with them where there is room. A key that is out already is passed by; with nothing left the outcome is `removed`.
 * `scope`: what the write was begun for (scopeOf the view the person acted on); null takes the first read's.
 */
export async function removeFromList(list: AccountList, removal: Removal, options: Pick<WriteOptions, "wait" | "operation" | "writer"> & { readonly scope?: WriteScope | null } = {}): Promise<RemoveOutcome> {
  // A device asked for that handed its place to a new key since is not out: its heir is. Nothing is signed, and the
  // person is asked again for the heir (the key was asked for, not the device that holds it now).
  let heirs: Record<string, string> = {};
  // a person's change of its own, named by what it puts out: a request kept for another change (another choice of
  // ticks included) is never sent, nor reported, as this one's
  const operation = `${options.operation ?? `remove:${removal.keys[0] ?? removal.pcs[0] ?? ""}`}:${await removalDigest(removal)}`;
  const outcome = await placeParts(list, options.scope ?? scopeOf(list.view()), (writer) => removalRequest(writer, removal, { epoch: true }), { ...options, operation }, (writer) => {
    heirs = {};
    for (const key of removal.keys) {
      const heir = standsFor(writer.state, key);
      if (heir !== null && heir !== key) heirs[key] = heir;
    }
    return Object.keys(heirs).length > 0 ? "handed" : null;
  });
  return !outcome.removed && outcome.why === "handed" ? { ...outcome, heirs } : outcome;
}

/**
 * Sign out every device's removal: every other device the list holds, in one request with the epoch. `confirmed`: the
 * devices the person's question named. Each read is held against it: a device the question did not name ends the
 * write with nothing more signed (`unconfirmed`, with its keys), so the person is asked again.
 */
export async function removeOtherDevices(list: AccountList, scope: WriteScope, confirmed: readonly string[], options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome> {
  const others = (writer: ListWriter): string[] => listView(writer.state).devices.filter((row) => row.ended === null && row.key !== writer.keys.key).map((row) => row.key);
  let unconfirmed: string[] = [];
  // named by the devices its question confirmed: a request kept for another confirmation is never sent for this one
  const operation = `sign-out-all:${await removalDigest({ keys: confirmed, pcs: [] })}`;
  const outcome = await placeParts(list, scope, (writer) => removalRequest(writer, { keys: others(writer), pcs: [] }, { epoch: true }), { ...options, operation }, (writer) => {
    unconfirmed = others(writer).filter((key) => !confirmed.includes(key));
    return unconfirmed.length > 0 ? "unconfirmed" : null;
  });
  return !outcome.removed && outcome.why === "unconfirmed" ? { ...outcome, unconfirmed } : outcome;
}

/**
 * This device puts itself out (signing out, leaving the account): one `remove` of its own key, which a device of
 * any power may sign. It opens no epoch: a device that is on its way out leaves that to one that stays, since the
 * next epoch's key would be its own to know.
 *
 * The account service may end this device's sign-in with the removal (a linked device), so the write is over once
 * the service took the request; it counts only once this device's own read of the log then shows this device out.
 * A read that is not possible (that sign-in ended, the log did not answer) leaves it `unknown`; a read that shows
 * this device still in is a refusal, whatever the service answered.
 */
export async function removeSelf(list: AccountList, scope: WriteScope, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome> {
  const outcome = await placeParts(list, scope, (signs) => removalRequest(signs, { keys: [signs.keys.key], pcs: [] }, { epoch: false }),
    { ...options, operation: "leave", writer: () => list.writer({ self: true }), trustPlaced: true });
  if (!outcome.removed) return outcome;
  const unsure: RemoveOutcome = { removed: false, why: "unknown", retryAfterMs: null, placed: 0 };
  let read: AccountListView;
  try { read = await list.sync({ read: true }); } catch (error) {
    if (error instanceof SignedOutError) return unsure;
    throw error;
  }
  if (read.account === scope.account && read.status.at === "following" && read.status.list === scope.list && read.status.standing === "out") return outcome;
  return read.reached ? { removed: false, why: "refused", retryAfterMs: null, placed: 0 } : unsure;
}

/**
 * The tidying a device of power `full` does by itself while it is in front (docs/account-list.md, "What a device
 * writes after entry 0"): where nobody could seal under the current epoch (a key whose time is over is in, or another
 * member put itself out), it opens the next one, and the writer puts out with it each invite past its `exp` and each
 * device past its `until`, by the clock it signs by (listWrite.ts, signedWithEpoch), judged again on the state it
 * signs on. A device adrift from its saved floor does none of it. Each place of the list is tried once by this page
 * (`tried`), whatever becomes of it, so a service that refuses is not asked again and again.
 */
export async function tidyList(list: AccountList, tried: Set<string>, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome | null> {
  const writer = list.writer();
  if (writer === null || writer.adrift) return null;
  const at = `tidy@${writer.list}:${writer.state.footing.seq}`;
  if (tried.has(at) || !writer.epochs.has(writer.state.epoch) || sealEpoch(writer.state, writer.clock) !== null) return null;
  tried.add(at);
  const scope = { account: writer.account, list: writer.list, member: writer.keys.key };
  return placeParts(list, scope, async (signs) => {
    const current = signs.epochs.get(signs.state.epoch) ?? null;
    // only what still calls for the epoch on the state it is signed on
    if (signs.adrift || current === null || sealEpoch(signs.state, signs.clock) !== null) return null;
    return { ...(await signedWithEpoch(signs, current, [])), whole: true, asked: 0 };
  }, { ...options, operation: TIDY_OPERATION });
}
