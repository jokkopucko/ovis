/**
 * A device that is in its account's signed list makes an invite for a PC (docs/account-list.md, "Invites"): one key
 * pair made here, whose private half lives only in the line the person is shown. The account service is given the
 * public key (`POST /v1/pc-invites`), and the list gets an `invite` entry for that key, for one use, that ends within
 * fifteen minutes. The line is returned only once this device's own copy of the list shows the entry.
 *
 * An invite a machine joins with by itself (`auto`) also gets the current epoch's key wrapped to its key, so the PC
 * that joins reads the list's names. Revoking an invite is a `remove` of its key, and for such an invite the next
 * epoch after it.
 */
import { ListWriteError, listView, readKind, sealEpoch, signListEntries, type ListKind, type ListState, type Sealed } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { newInvite } from "../../../shared/account-list-join.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
import { placeOf, signedNamed, signedOn, signedWithEpoch, writeNamed, writeToList, type WriteOptions, type WriteRefusal, type Written } from "./listWrite.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/**
 * How long an invite lasts, in seconds, from this device's own clock as it reads now (nothing else: neither the list's
 * time nor the floor it saved): a little under the fifteen minutes the account service keeps its own invite, so the
 * entry never outlives it.
 */
export const INVITE_S = 14 * 60;

/** An invite as its maker holds it for the moment it is shown: the line is the only copy of the private key. */
export interface MadeInvite {
  /** The invite's public key, as the list spells a key. */
  readonly key: string;
  readonly line: string;
  /** When it ends, in seconds since 1970, as the entry says. */
  readonly exp: number;
  readonly auto: boolean;
}

/** An invite whose entry went out and whose placement is not known yet: its line is kept in memory until it is. */
export interface PendingInvite {
  readonly key: string;
  readonly line: string;
  readonly auto: boolean;
}

/**
 * Why no invite was made: what stops any write (listWrite.ts), or the account service made none (`service`, with its
 * code: `session_not_fresh`, `invites_full`, `pc_add_cap`, `rate_limited`, …). `unknown` comes with `pending`: the
 * entry may be in the list, so its line is neither shown nor dropped, and the service's invite is not ended. The caller
 * keeps it while its page is open and hands it to the next makeInvite, which settles it first.
 */
export type InviteOutcome =
  | { readonly made: true; readonly invite: MadeInvite }
  | { readonly made: false; readonly why: WriteRefusal | "service" | "clock_behind"; readonly code?: string; readonly retryAfterMs: number | null; readonly pending?: PendingInvite };

const operationOf = (auto: boolean): string => `invite:${auto ? "auto" : "plain"}`;

/**
 * Settles an invite whose placement was not known: the request kept for it goes again while the head it was signed on
 * stands, and the device's own copy, read from the log, says whether it holds the entry. `not_placed` only where the
 * log was read and neither holds it nor keeps a request for it: another entry took its place.
 */
async function settle(list: AccountList, pending: PendingInvite, options: Pick<WriteOptions, "wait" | "expect">): Promise<InviteOutcome | "not_placed"> {
  const shown = (): InviteOutcome | null => {
    const row = list.writer()?.state.invites[pending.key];
    return row === undefined ? null : { made: true, invite: { ...pending, exp: row.exp } };
  };
  const outcome = await writeToList<"nothing">(list, async (writer) => writer.state.invites[pending.key] !== undefined ? { done: placeOf(writer.state) } : { refused: "nothing" }, { ...options, operation: operationOf(pending.auto) });
  const held = shown();
  if (held !== null) return held;
  if (!outcome.written && outcome.why === "nothing") {
    const view = await list.sync({ read: true }).catch(() => list.view());
    if (view.reached && shown() === null) return "not_placed";
  }
  return { made: false, why: "unknown", retryAfterMs: null, pending };
}

/**
 * What this device keeps of the invites it made, per account, beside its pages (no line, no private key): the account
 * service's id of each by the invite's public key, so whichever page ends the invite in the list (a Revoke, the Add of
 * the PC that joined with it) ends the service's invite too, after a reload as well; and the invites it revoked, so the
 * screen says Revoked for them. An hour after an invite's end it is forgotten. The page's own memory holds the same,
 * and stands in where the browser gives no storage or its storage refuses a read or a write.
 */
interface InviteRecord { readonly id?: string; readonly revoked?: true; readonly until: number }
const KEEP_MS = 75 * 60_000;
const memoryRecords = new Map<string, Record<string, InviteRecord>>();
const storageHere = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const recordsKey = (account: string): string => `ovis:invite-ids:${account}`;
/** What the browser's storage holds for `account`, or nothing where it has none or refuses the read. */
function storedRecords(account: string): Record<string, InviteRecord> {
  const storage = storageHere();
  if (storage === null) return {};
  try {
    const kept: unknown = JSON.parse(storage.getItem(recordsKey(account)) ?? "{}");
    if (typeof kept !== "object" || kept === null || Array.isArray(kept)) return {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(kept as Record<string, unknown>).filter((entry): entry is [string, InviteRecord] => {
      const row = entry[1] as Partial<InviteRecord> | null;
      return typeof row === "object" && row !== null && typeof row.until === "number" && row.until > now && (row.id === undefined || /^[0-9a-f]{32}$/.test(row.id));
    }));
  } catch { return {}; }
}
/** The records of `account`: the stored ones, and this page's own memory over them. */
function readRecords(account: string): Record<string, InviteRecord> {
  const now = Date.now();
  const memory = Object.fromEntries(Object.entries(memoryRecords.get(account) ?? {}).filter(([, row]) => row.until > now));
  return { ...storedRecords(account), ...memory };
}
function keepRecord(account: string, key: string, change: (row: InviteRecord | undefined) => InviteRecord | null): void {
  const rows = readRecords(account);
  const next = change(rows[key]);
  if (next === null) delete rows[key]; else rows[key] = next;
  // the page's memory always, the browser's storage where it takes the write
  memoryRecords.set(account, rows);
  const storage = storageHere();
  if (storage === null) return;
  try { storage.setItem(recordsKey(account), JSON.stringify(rows)); } catch { /* the page's memory holds it */ }
}

/**
 * The account service's id of the invite with key `key`: the one this device kept when it made it, or where another
 * device made it, the one the service's own list of the account's invites names with that key (asked before the
 * invite is ended in the list, which the service may take for its end). Null where neither says.
 */
export async function serviceInviteId(list: AccountList, key: string): Promise<string | null> {
  const writer = list.writer();
  if (writer === null) return null;
  const kept = readRecords(writer.account)[key]?.id;
  if (kept !== undefined) return kept;
  return (await writer.service.listInvites().catch(() => [])).find((each) => each.invite_key === key)?.id ?? null;
}

/** Invites whose entry went out and whose placement is not known yet, by account and list: their lines, kept in this page's memory for its life (never stored). */
const pendingLines = new Map<string, PendingInvite>();
const pendingKey = (account: string, list: string): string => `${account}:${list}`;

/** The invite an earlier Make an invite on this page left not known, for `list`'s account and list: the next one settles it first. */
export function pendingInvite(list: AccountList): PendingInvite | null {
  const writer = list.writer();
  return writer === null ? null : pendingLines.get(pendingKey(writer.account, writer.list)) ?? null;
}

const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);
const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/**
 * Ends the account service's invite for the invite key `key`, whoever ends it in the list: by the id this device kept
 * when it made it, or where another device made it, by the service's own list of the account's invites when that names
 * the key. What the service answers changes nothing here: the list's entry decides.
 */
export async function endInviteAtService(list: AccountList, key: string, known?: string | null): Promise<void> {
  const writer = list.writer();
  if (writer === null) return;
  const id = known ?? await serviceInviteId(list, key);
  if (id === null) return;
  // the id is kept until the account service says the invite is over (ended now, gone, or used by a PC): a failure
  // leaves it for the next look (endPendingServiceInvites), which ends it without signing anything
  const over = (): void => keepRecord(writer.account, key, (row) => ({ until: row?.until ?? Date.now() + KEEP_MS, ...(row?.revoked ? { revoked: true as const } : {}) }));
  keepRecord(writer.account, key, (row) => ({ until: row?.until ?? Date.now() + KEEP_MS, ...(row?.revoked ? { revoked: true as const } : {}), id }));
  await writer.service.endInvite(id).then(over, (error: unknown) => {
    if (error instanceof SignedOutError) return;
    if (error instanceof AccountServiceError && (error.status === 404 || (error.status === 409 && error.code === "invite_used"))) { over(); return; }
    console.info("Ovis: the account service's invite was not ended", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
  });
}

/**
 * Ends at the account service every invite this device kept an id for that the list has ended, where an earlier try
 * did not reach the service: nothing is signed, only the service's invite is ended. Called as the invites are drawn.
 */
export async function endPendingServiceInvites(list: AccountList): Promise<void> {
  const writer = list.writer();
  if (writer === null) return;
  for (const [key, row] of Object.entries(readRecords(writer.account))) {
    if (row.id !== undefined && (writer.state.signers[key]?.ended ?? null) !== null) await endInviteAtService(list, key, row.id);
  }
}

/**
 * Makes an invite for one PC. `auto`: the PC joins with it by itself (an agent sets it up); otherwise a device of the
 * account presses Add for the PC that joined. The account service's invite is made first, since it is what a PC
 * redeems, then the entry. Where either is refused nothing is shown: the service's invite is ended again, and the
 * key pair is gone with this call. Only a sign-in that ended throws.
 */
export async function makeInvite(list: AccountList, options: { readonly auto: boolean; /** an invite an earlier call left not known: settled before anything else (this page's own, pendingInvite, by default) */ readonly pending?: PendingInvite } & Pick<WriteOptions, "wait" | "expect">): Promise<InviteOutcome> {
  const at = list.writer();
  const slot = at === null ? null : pendingKey(at.account, at.list);
  const earlier = options.pending ?? (slot === null ? undefined : pendingLines.get(slot));
  if (earlier !== undefined) {
    const settled = await settle(list, earlier, options);
    if (settled !== "not_placed") {
      if (slot !== null) { if (!settled.made && settled.pending !== undefined) pendingLines.set(slot, settled.pending); else pendingLines.delete(slot); }
      return settled;
    }
    if (slot !== null) pendingLines.delete(slot);
    // another entry took its place: its line opens nothing, and the account service's invite goes too
    await endInviteAtService(list, earlier.key);
  }
  // one key pair for the whole of it: a request signed again on a new head names the same invite
  const held: {
    invite: { readonly key: string; readonly line: string } | null;
    /** the key the account service made its invite for, whatever became of it since */
    kept: string | null;
    said: { readonly code: string; readonly retryAfterMs: number | null } | null;
  } = { invite: null, kept: null, said: null };
  type Invite = { readonly key: string; readonly line: string };
  const prepare = async (writer: ListWriter): Promise<{ readonly refused: WriteRefusal | "service" | "clock_behind" } | { readonly done: ListPlace } | { readonly go: Invite }> => {
    // An invite this device dates by its own clock would be over before it began where that clock reads behind the
    // list's own time by more than an invite lasts: nothing is made or placed, and the person is told
    if (held.invite === null && writer.issued_at + INVITE_S <= writer.state.full_at) return { refused: "clock_behind" };
    if (held.invite === null) {
      const session = await writer.service.session();
      if (session === undefined || session.account !== writer.account) return { refused: "changed" };
      const fresh = await newInvite(session.service, writer.account, writer.list);
      try {
        const kept = await writer.service.makeInvite(fresh.key, options.auto);
        keepRecord(writer.account, fresh.key, () => ({ id: kept.id, until: Date.now() + KEEP_MS }));
        held.kept = fresh.key;
        // an invite for another account than this device's is no invite of this list: no line is shown for it
        if (kept.account !== writer.account) { held.said = { code: "invalid_answer", retryAfterMs: null }; return { refused: "service" }; }
      } catch (error) {
        if (error instanceof SignedOutError) throw error;
        const refused = refusalOf(error);
        if (refused === null) { if (unanswered(error)) return { refused: "unreached" }; throw error; }
        held.said = { code: refused.code, retryAfterMs: refused.retryAfterMs };
        return { refused: "service" };
      }
      held.invite = fresh;
    }
    // the list holds it already: placed by a request whose answer was lost
    return writer.state.invites[held.invite.key] !== undefined ? { done: placeOf(writer.state) } : { go: held.invite };
  };
  const sign = async (writer: ListWriter, invite: Invite): Promise<Written> => {
    // ends by this device's own clock as it reads now: the list's time or a floor saved once never lengthens it
    const kind = (sealed: Sealed | null): ListKind => ({ kind: "invite", key: invite.key, exp: writer.issued_at + INVITE_S, uses: 1, auto: options.auto, sealed });
    // an invite a machine joins with by itself is wrapped the epoch's key, as a member that comes in is
    const request = options.auto ? await signedNamed(writer, null, invite.key, kind) : await signedOn(writer, [kind(null)]);
    return { ...request, invite: { key: invite.key, auto: options.auto } };
  };
  const { pending: _settled, ...writing } = options;
  const named = { ...writing, operation: operationOf(options.auto) };
  let outcome: Awaited<ReturnType<typeof writeToList<"service" | "clock_behind">>>;
  try {
    outcome = options.auto
      ? await writeNamed<Invite, "service" | "clock_behind">(list, prepare, sign, named)
      : await writeToList<"service" | "clock_behind">(list, async (writer) => { const ready = await prepare(writer); return "go" in ready ? { request: await sign(writer, ready.go) } : ready; }, named);
  } catch (error) {
    // The write failed after the service's invite was made (a store that failed at the read after a placement, most
    // of all): the entry may be in the list, and the line is the only copy of its key. It is kept, as for `unknown`.
    // Only a sign-in that ended throws
    if (error instanceof SignedOutError || held.invite === null) throw error;
    console.warn("Ovis: the invite's entry may have gone out; its line is kept until it is settled", error instanceof Error ? error.name : error);
    const pending: PendingInvite = { ...held.invite, auto: options.auto };
    if (slot !== null) pendingLines.set(slot, pending);
    return { made: false, why: "unknown", retryAfterMs: null, pending };
  }
  if (outcome.written && held.invite !== null) {
    const row = list.writer()?.state.invites[held.invite.key];
    if (row !== undefined) return { made: true, invite: { ...held.invite, exp: row.exp, auto: options.auto } };
  }
  // The entry went out and its placement is not known (no answer and no read of the log since, a request the service
  // kept asking for again, or a copy that does not show it yet): the line is the only copy of the invite's key, so it
  // is kept, not shown, and the service's invite stands until the next call settles it
  if (held.invite !== null && (outcome.written || outcome.why === "unknown" || outcome.why === "busy")) {
    const pending: PendingInvite = { ...held.invite, auto: options.auto };
    if (slot !== null) pendingLines.set(slot, pending);
    return { made: false, why: "unknown", retryAfterMs: null, pending };
  }
  if (outcome.written) return { made: false, why: "unknown", retryAfterMs: null };
  // nothing to show: the account service's invite, if one was made, redeems nothing more
  if (held.kept !== null) await endInviteAtService(list, held.kept);
  if (outcome.why === "service" && held.said !== null) return { made: false, why: "service", code: held.said.code, retryAfterMs: held.said.retryAfterMs };
  return { made: false, why: outcome.why, ...(outcome.code === undefined ? {} : { code: outcome.code }), retryAfterMs: outcome.retryAfterMs };
}

/**
 * How an invite stands, as a device shows it: `used` where a PC joined with it, or its removal was placed with a `pc`
 * entry (a person's Add of the PC that joined with it); `revoked` only for a removal on its own, before its time was
 * over (a Revoke); `ended` for any other end (its placer left, or it went with a PC's removal).
 */
export type InviteState = "open" | "expired" | "used" | "revoked" | "ended";

export interface ShownInvite {
  readonly key: string;
  readonly auto: boolean;
  /** When it ends, in seconds since 1970. */
  readonly exp: number;
  /** The place of its entry: a later invite stands at a later place. */
  readonly seq: number;
  readonly state: InviteState;
  /** This device placed it. */
  readonly mine: boolean;
}

/**
 * The invites the list holds, the latest first, each as it stands at `nowMs` by this device's own clock held against
 * the floor it saved and the list's own time: one past its `exp` is expired, never open, also after the clock was set
 * back. None for a device that may not write the list.
 */
export function invitesOf(list: AccountList, nowMs: number): ShownInvite[] {
  const writer = list.writer();
  if (writer === null) return [];
  const clock = Math.max(writer.shown, Math.floor(nowMs / 1000));
  return listView(writer.state).invites.map((row): ShownInvite => ({
    key: row.key, auto: row.auto, exp: row.exp, seq: row.seq, mine: row.by === writer.keys.key,
    state: row.refusal === "invite_spent" ? "used" : row.refusal === "invite_revoked" ? (readRecords(writer.account)[row.key]?.revoked ? "revoked" : endOf(list, writer.state, writer.state.signers[row.key]?.ended ?? null, row.exp))
      : row.refusal === "invite_expired" || (row.refusal === null && clock > row.exp) ? "expired" : row.refusal === null ? "open" : "ended",
  })).sort((a, b) => b.seq - a.seq);
}

/**
 * What the removal at place `ended` did to an invite, by the entries of this device's own copy around it: placed right
 * after a `pc` entry, it is the Add of the PC that joined with it (`used`); dated past the invite's time, the clean-up
 * of an invite that was over (`expired`); beside the removal of a PC, that PC's end (`ended`); on its own, a Revoke.
 */
function endOf(list: AccountList, state: ListState, ended: number | null, exp: number): InviteState {
  if (ended === null) return "ended";
  const kindAt = (text: string | undefined): { readonly kind: ListKind | null; readonly at: number; readonly signer: string } | null => {
    if (text === undefined) return null;
    try {
      const body = readBody(entryFromText(text).body);
      return { kind: readKind(body), at: body.issued_at, signer: body.signer };
    } catch { return null; }
  };
  const around = list.pageAfter(ended >= 2 ? ended - 2 : null, ended >= 1 ? 3 : 2)?.entries ?? [];
  const at = ended >= 1 ? 1 : 0;
  const [before, removal, after] = [at === 1 ? kindAt(around[0]) : null, kindAt(around[at]), kindAt(around[at + 1])];
  if (removal === null) return "ended";
  // one request: the PC's entry right before, signed by the same member at the same second (a Revoke this device
  // placed after an Add of another PC is known by this device's own record, above)
  if (before?.kind?.kind === "pc" && before.signer === removal.signer && before.at === removal.at) return "used";
  if (removal.at > exp) return "expired";
  // a PC is removed by its relay key, or by its own key where it has one (pcRemoval)
  const pcEnds = (entry: typeof before): boolean => entry?.kind?.kind === "remove"
    && ("endpoint" in entry.kind || ("ends" in entry.kind && state.pc_keys[entry.kind.ends] !== undefined));
  return pcEnds(before) || pcEnds(after) ? "ended" : "revoked";
}

export type RevokeOutcome = { readonly revoked: true } | { readonly revoked: false; readonly why: WriteRefusal; readonly retryAfterMs: number | null };

/**
 * Revokes an invite: a `remove` of its key, so no PC joins with it any more, whoever holds the line. Where the kinds
 * say that the removal took a holder of the epoch's key out (an invite a machine joins with by itself), the next
 * epoch is opened in the same request and its key wrapped to everybody who stays. An invite that is out already is
 * revoked: nothing is signed. Only a sign-in that ended throws.
 */
export async function revokeInvite(list: AccountList, key: string, options: Pick<WriteOptions, "wait" | "expect"> = {}): Promise<RevokeOutcome> {
  let account: string | null = null;
  // the service's id is found before the removal is placed: a service may stop listing an invite the list ended
  const id = await serviceInviteId(list, key);
  const outcome = await writeToList(list, async (writer) => {
    const { state, clock } = writer;
    if (state.invites[key] === undefined || state.signers[key]?.ended !== null) return { done: placeOf(state) };
    // this device revokes it: its screen says Revoked for it, whatever the list's entries around the removal
    account = writer.account;
    const remove: ListKind = { kind: "remove", ends: key };
    const current = writer.epochs.get(state.epoch) ?? null;
    if (current === null) return { request: await signedOn(writer, [remove]) };
    // what the kinds say of the list after the removal: names may still be sealed, or the next epoch is called for
    const after = await signListEntries(state, [remove], { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    if (sealEpoch(after.state, clock) !== null) return { request: await signedOn(writer, [remove]) };
    // the epoch this request opens, with the clean-up the write loop adds beside it (signedWithEpoch)
    try { return { request: await signedWithEpoch(writer, current, [remove]) }; } catch (error) {
      // A device whose clock reads far under the time it saved signs no clean-up, and with keys over their time still
      // in no epoch may be opened: the removal goes alone, and a later writer opens the epoch
      if (writer.adrift && error instanceof ListWriteError) return { request: await signedOn(writer, [remove]) };
      throw error;
    }
  }, { ...options, operation: `revoke:${key}` });
  if (!outcome.written) return { revoked: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
  if (account !== null) keepRecord(account, key, (row) => ({ ...row, revoked: true, until: Math.max(row?.until ?? 0, Date.now() + KEEP_MS) }));
  await endInviteAtService(list, key, id);
  return { revoked: true };
}
