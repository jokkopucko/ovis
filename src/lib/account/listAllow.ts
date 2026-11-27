/**
 * A device that is in its account's signed list lets another device in (docs/account-list.md, "Letting a device
 * in"): it signs a `device` entry for the key whose digits a person just compared, with the card that key's own
 * sign-in claimed, seals the newcomer's name, wraps the epoch key to it, and places all of it in one request.
 *
 * Every entry is signed through the kinds' writer, on this device's own state, and only when it would count there.
 * The account service's answer to the placement is trusted for nothing: the newcomer is in once this device's own
 * copy shows the entry at its place, and that place is what the newcomer is handed.
 */
import type { AccountOs } from "../../../shared/account-asker.ts";
import type { ListKind } from "../../../shared/account-list.ts";
import type { AccountList, ListOffer } from "./accountList.ts";
import type { ListClaim } from "./listAnswers.ts";
import { listNames } from "./listGenesis.ts";
import { WRITE_RESENDS, WRITE_TRIES, placeOf, signedNamed, writeNamed, type WriteRefusal } from "./listWrite.ts";

/**
 * What an approval is bound to from the first press on, kept by whoever offers Try again and handed to every try: the
 * account it began under, and the list and the member key of its first read, which that read fills in.
 */
export interface AllowScope { account: string; list?: string; key?: string }

/** The device a person is letting in: the key it showed the PC it asked, and the name and system it gave the account service. */
export interface Newcomer {
  readonly key: string;
  readonly label: string;
  readonly os: AccountOs | null;
}

/** Why a device was not let into the list: what stops any write (listWrite.ts), or `removed`: the list put that key out before, and a key that is out never comes back. */
export type AllowRefusal = WriteRefusal | "removed";

export type AllowOutcome =
  | { readonly allowed: true; readonly offer: ListOffer }
  | { readonly allowed: false; readonly why: AllowRefusal; readonly retryAfterMs: number | null };

/** How often one Allow reads the list and signs anew, and how often one signed request is sent again (listWrite.ts). */
export const ALLOW_TRIES = WRITE_TRIES;
export const ALLOW_RESENDS = WRITE_RESENDS;

/** How long the read of the newcomer's claim waits for its answer. */
const CLAIMS_MS = 30_000;

/**
 * Lets `newcomer` into the list this device follows. It reads the list first, signs on what it then holds, and
 * places the request. When the head moved under it, or the account service judged the request by a clock a moment
 * apart from this device's, it reads and signs again, ALLOW_TRIES times at most; while the service says it is
 * rebuilding the list, the same request goes again, ALLOW_RESENDS times at most. Only a sign-in that ended throws.
 */
export async function allowDevice(list: AccountList, newcomer: Newcomer, options: {
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * The account the approval was begun under. The write is bound to it, and to the list of its first read, across
   * every retry and every request of removals: a sign-in another tab changed meanwhile ends it with nothing signed
   * (`changed`), and never leads to the way of an account with no list.
   */
  readonly account?: string;
  /**
   * The same, with the list and the member key of the first read, which this call fills in: handed again to every
   * Try again, so that a retry under another list or another member key signs nothing (`changed`).
   */
  readonly scope?: AllowScope;
  /** how long the read of the claims, and one placement, wait; a test's own */
  readonly claimsMs?: number;
  readonly placeMs?: number;
} = {}): Promise<AllowOutcome> {
  const names = listNames(newcomer.label, newcomer.os);
  // The account the Allow began under: the one it was asked for, or the one this page's list was drawn for when it
  // was called. Read at every try of every round, with the list and the member key of the first writer.
  const began = options.scope?.account ?? options.account ?? list.view().account ?? undefined;
  const held: AllowScope = options.scope ?? { account: began ?? "" };
  const outcome = await writeNamed<ListClaim, "removed">(list, async (writer) => {
    held.list ??= writer.list;
    held.key ??= writer.keys.key;
    const row = writer.state.signers[newcomer.key];
    // the list holds the key already: let in before (the place handed on is where this device stands now), or put out for good
    // (the place handed on is that of the entry that let it in, where this device's copy shows it)
    if (row !== undefined) return row.ended !== null || row.as !== "device" ? { refused: "removed" } : { done: list.placeAt(row.seq) ?? placeOf(writer.state) };
    const claim = (await writer.service.listClaims(writer.list, AbortSignal.timeout(options.claimsMs ?? CLAIMS_MS))).find((each) => each.key === newcomer.key);
    return claim === undefined ? { refused: "not_claimed" } : { go: claim };
  }, (writer, claim) => signedNamed(writer, names, claim.enc, (sealed): ListKind => ({ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed, rotates: false })),
  { operation: `allow:${newcomer.key}`, ...(options.wait === undefined ? {} : { wait: options.wait }), ...(options.placeMs === undefined ? {} : { placeMs: options.placeMs }), ...(began === undefined ? {} : { expect: held }) });
  // a device that is in no list of the account it was asked for is not "an account with no list"
  if (!outcome.written && outcome.why === "no_list" && began !== undefined && list.view().account !== began) return { allowed: false, why: "changed", retryAfterMs: null };
  if (!outcome.written) return { allowed: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
  // The entry is in this device's copy. So is whatever came after it: where another member put the newcomer out
  // meanwhile, the copy just read says so, and nothing more is signed for a key the list holds no more.
  if (!list.view().devices.some((device) => device.key === newcomer.key)) return { allowed: false, why: "removed", retryAfterMs: null };
  return { allowed: true, offer: { list: outcome.list, seq: outcome.place.seq, hash: outcome.place.hash } };
}
