/**
 * A device that is in its account's signed list puts a PC out of the account (docs/account-list.md, "PCs of a list
 * account"): it signs what the kinds say removes that PC (`pcRemoval`: the `remove` that fits how the PC came in,
 * and that of the invite it joined by while that invite still lets a PC in), then the `epoch` entry that the removal
 * calls for, and wraps the new epoch's key to everybody who stays. One request, signed through the kinds' writer.
 *
 * The key of a PC that is out never comes back: the PC joins the account again only as a new PC.
 */
import { pcRemoval } from "../../../shared/account-list.ts";
import type { AccountList } from "./accountList.ts";
import { placeOf, signedOn, signedWithEpoch, writeToList, type WriteOptions, type WriteRefusal } from "./listWrite.ts";

export type PcRemovalOutcome =
  | { readonly removed: true }
  | { readonly removed: false; readonly why: WriteRefusal; readonly retryAfterMs: number | null };

/**
 * Puts the PC at the relay key `endpoint` out of the list this device follows. A PC the list does not hold, or holds
 * no more, is out already: nothing is sent. A device that holds no key of the current epoch signs the removal alone,
 * and the next writer that has names to seal opens the epoch. Only a sign-in that ended throws.
 */
export async function removeListPc(list: AccountList, endpoint: string, options: Pick<WriteOptions, "wait" | "expect" | "signal" | "writer"> = {}): Promise<PcRemovalOutcome> {
  const outcome = await writeToList(list, async (writer) => {
    const { state } = writer;
    const removal = pcRemoval(state, endpoint);
    if (removal.length === 0) return { done: placeOf(state) };
    const current = writer.epochs.get(state.epoch) ?? null;
    if (current === null) return { request: await signedOn(writer, removal) };
    // with the epoch that this request opens anyway, the keys whose time is over go too, as far as the request has
    // room and this device's clock can be gone by (the writer's own rule): names are sealed again after it
    return { request: await signedWithEpoch(writer, current, removal) };
  }, { ...options, operation: `remove-pc:${endpoint}` });
  return outcome.written ? { removed: true } : { removed: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
}
