/**
 * A device that scanned a PC's QR code for its account names its account's signed list to that PC, in place of the
 * link (docs/account-list.md, "Adding a PC"): the pairing the scan made is an end-to-end session to the PC in front
 * of the person, so the PC's card is taken from that session and no number is compared. The device checks the card,
 * has the account admit the PC, signs the `pc` entry with that card, and asks the PC again until it read the entry.
 *
 * A PC that follows no list, or is from before lists, has no such call: the link goes as before.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { cardHolds, type ListNames } from "../../../shared/account-list.ts";
import { isListKeyEncoding } from "../../../shared/account-list-entry.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList } from "./accountList.ts";
import { AccountPcError, post, type PcFetch } from "./join.ts";
import { SignedOutError } from "./service.ts";
import { addPostedPc, type AddPcOutcome, type PostedPc } from "./listAdd.ts";

/**
 * What became of naming the list to the PC.
 *
 * - `none`: the PC has no such call (it follows no list, or is from before lists): send the link as before.
 * - `added`: the PC said it read its entry, and this device's own copy of the list, read again after that, holds the
 *   PC: it is in the list, and the pairing that named it is spent.
 * - `placed`: this device's own copy holds the entry it signed for the PC, and the PC has not said yet that it read
 *   it: it will, at its next read. The pairing is not spent until it did.
 * - `unknown`: the entry went out and whether it was placed is not known yet (no answer, and no read of the log
 *   since; or the account service kept asking for the request again, which stays kept and may still be placed). The
 *   pairing is not spent, as for `placed`, and the next read of this device's own copy says.
 * - `refused`: nothing was signed, the list did not take the entry, or the PC refused at a later ask; `why` is the
 *   PC's code, or the list's (`not_in_list`: the PC said it read an entry this device's copy does not hold).
 */
export type NamedOutcome =
  | { readonly outcome: "none" | "added" | "placed" | "unknown" }
  | { readonly outcome: "refused"; readonly why: string; readonly add?: Extract<AddPcOutcome, { readonly added: false }> };

/** How often the PC is asked whether it read the entry: it counts the calls of one pairing. */
export const NAMED_ASKS = 4;
const NAMED_POLL_MS = 1_500;

/** The pause between two asks: inside a loop bounded by NAMED_ASKS. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason as Error); }, { once: true });
});

export async function nameListToPc(options: {
  readonly fetch: PcFetch; readonly list: AccountList; readonly account: string;
  /** The relay key of the PC this session is bound to, 64 hex: the card must be for it. */
  readonly endpoint: string;
  readonly names: ListNames | null;
  readonly admit: () => Promise<void>;
  /** The person's Cancel: checked before the admission, before signing and before sending (listWrite.ts WriteOptions.signal). */
  readonly signal?: AbortSignal; readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<NamedOutcome> {
  const wait = options.wait ?? pause;
  const writer = options.list.writer();
  if (writer === null || writer.account !== options.account) return { outcome: "none" };
  // the member key the naming began with: an entry is signed by it or by none (X3)
  const member = writer.keys.key;
  const ask = async (first: boolean): Promise<Record<string, unknown> | "none" | { readonly refused: string }> => {
    options.signal?.throwIfAborted();
    try {
      return await (await post(options.fetch, "/api/account/list/named", { account: options.account, list: writer.list })).json() as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof AccountPcError)) throw error;
      // No such call, or a PC that follows no list a person named. A PC from before this call has no route for it, and
      // its pairing's session lets only the status and the link through: it answers `403 link_required` before any
      // route is looked up. At the first ask that is "no such call", and the link goes as before (a PC that has the
      // call and refuses the row's link the same way refuses that link too). Later, every answer is the PC's own word.
      return first && (error.status === 404 || (error.status === 403 && error.code === "link_required")) ? "none" : { refused: error.code };
    }
  };
  const refusedBy = (answer: Record<string, unknown> | "none" | { readonly refused: string }): string | null =>
    answer === "none" ? "not_found" : "refused" in answer && typeof answer.refused === "string" ? answer.refused : null;
  // The PC says it read its entry: this device's own copy, read from the log again, must hold the PC at that very relay
  // key, for the account the naming began with. The PC's word alone spends no pairing.
  // A read that did not reach the log tells nothing of an entry the copy does not hold yet: not known yet, never "not in".
  const taken = async (): Promise<NamedOutcome> => {
    const view = await options.list.sync({ read: true }).catch(() => null);
    const now = view ?? options.list.view();
    if (now.account === options.account && options.list.holdsPc(options.endpoint)) return { outcome: "added" };
    return view !== null && view.reached && view.account === options.account ? { outcome: "refused", why: "not_in_list" } : { outcome: "unknown" };
  };
  const first = await ask(true);
  if (first === "none") return { outcome: "none" };
  const said = refusedBy(first);
  if (said !== null) return { outcome: "refused", why: said };
  const answer = first as Record<string, unknown>;
  if (answer.state === "added") return taken();
  const { key, enc, card } = answer;
  if (answer.state !== "waiting" || typeof key !== "string" || !isListKeyEncoding(key) || typeof enc !== "string" || !isListKeyEncoding(enc) || typeof card !== "string") return { outcome: "refused", why: "invalid_answer" };
  const posted: PostedPc = { list: writer.list, endpoint: options.endpoint, server_id: deriveServerId(hexToBytes(options.endpoint)), key, enc, card };
  // the card is that key's own, for this device's list and the relay key this very session is bound to: nothing else is signed
  if (!await cardHolds({ key, enc, list: writer.list, endpoint: options.endpoint, invite: null }, card)) return { outcome: "refused", why: "card_invalid" };
  const added = await addPostedPc(options.list, posted, options.names, {
    admit: options.admit, expect: { account: options.account, list: writer.list }, member, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!added.added) {
    if (added.why !== "unknown" && added.why !== "busy") return { outcome: "refused", why: added.why === "admit" ? added.code ?? "admit" : added.why, add: added };
    // Not known whether the entry was placed: this device's own copy, read from the log, says. Where it holds the PC by
    // this card's key the PC is asked as after a placement; otherwise it is not known yet, never refused
    await options.list.sync({ read: true }).catch(() => undefined);
    const now = options.list.writer();
    const row = now?.account === options.account ? now.state.pcs[options.endpoint] : undefined;
    if (row === undefined || row.removed !== null || row.key !== key) return { outcome: "unknown" };
  }
  for (let asks = 1; asks < NAMED_ASKS; asks += 1) {
    // The entry is in the list: a session that drops now leaves it placed (the pairing kept, nothing opened over it),
    // never a failure of the enrollment. A Cancel stays a Cancel
    let again: Awaited<ReturnType<typeof ask>>;
    try { again = await ask(false); } catch (error) {
      if (options.signal?.aborted === true || error instanceof SignedOutError) throw error;
      return { outcome: "placed" };
    }
    const refused = refusedBy(again);
    // the entry is in the list, and the PC turned it away: said as the PC's refusal, never as placed
    if (refused !== null) return { outcome: "refused", why: refused };
    if ((again as Record<string, unknown>).state === "added") return taken();
    if (asks + 1 < NAMED_ASKS) await wait(NAMED_POLL_MS, options.signal);
  }
  return { outcome: "placed" };
}
