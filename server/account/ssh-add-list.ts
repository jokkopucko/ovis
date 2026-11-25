/**
 * Adding another PC over SSH to an account that keeps a signed list, from this PC's own window (docs/account.md,
 * "Adding a PC over SSH to an account that keeps a list"). This PC follows the list as a PC a person added, so its own
 * list key signs for it, on the act of the person at its own window. Over the SSH channel that add opened, this PC
 * names the list and its own key to that PC (the take), takes back that PC's card for the list, signs the `pc` entry
 * with it at the relay key the inspect read, places it, and sends the same take again: that PC joins its account by
 * the list once it finds that entry, signed by this very key. The account service carries the entry and that PC's
 * post of its keys (the second lock), and names nothing to either PC: the card is checked here against the relay key
 * the inspect read over the same SSH session before anything is signed, and "added" is said only once that PC
 * answered that it joined AND this PC's own copy, read again, holds it. Each step can be run again: the entry this PC
 * signed is kept and sent again as it is (the Allow's keeper, one signature per place), and a PC the list holds by it
 * joins at the next take.
 */
import { cardHolds } from "../../shared/account-list.ts";
import type { AccountAddNamed } from "../account-add-channel.ts";
import { AccountAddError, type AccountAddCard } from "../machines.ts";
import type { AccountAddRelay } from "../../shared/machines.ts";
import type { AllowOutcome, AllowRefusal, ListFollow } from "./list-follow.ts";

export interface SshListRefusal { readonly code: string; readonly message: string; readonly status: number }

/**
 * That PC in the account, as a take answers it: the same answer as an add with no list, and `listJoined` where it joined
 * the account's list by this add (its first answer was its card), not where the list held it already.
 */
export type SshListTaken = { readonly account: string; readonly relay: AccountAddRelay | null; readonly unanswered?: true; readonly listJoined?: true };

export interface SshListDeps {
  /** That PC's relay key, 64 hex, as this PC's inspect read it over the add's SSH session: its card is held to it. */
  readonly endpoint: string;
  readonly list: Pick<ListFollow, "allowRefusal" | "status" | "own" | "addPc" | "holdsPcRead">;
  /** The take over the add's SSH channel, naming the list and the adder (MachineManager.accountTake); its refusals throw. */
  take(named: AccountAddNamed): Promise<SshListTaken | { readonly waiting: AccountAddCard }>;
  /** Closes the add's forward: this add ends before a take was answered for good. */
  end(): Promise<void>;
  /** How often the take goes again after the entry is placed while that PC has not read it yet. */
  readonly tries?: number;
  wait?(ms: number): Promise<void>;
}

/** How often the take goes again once the entry is placed, and how long between two. */
const AFTER_PLACED_TRIES = 5;
const AFTER_PLACED_WAIT_MS = 1_000;

/** Why this PC signs nobody into its list now, in words for the person at its window. */
const CANNOT_ADD: Readonly<Record<AllowRefusal, string>> = {
  not_pinned: "This PC does not follow your account's signed list, so it cannot add another PC to it. Run ovis add on that PC and add it with the number it shows.",
  not_signer: "This PC joined your account with an invite, so it cannot add other PCs to your account's signed list. Run ovis add on that PC and add it with the number it shows.",
  alarm: "This PC was shown two different lists of your account, so it adds nobody until that is resolved.",
  stopped: "Your account's list holds what this Ovis is too old to read. Update Ovis on this PC first.",
  behind: "Your account's list holds what this Ovis is too old to read. Update Ovis on this PC first.",
  unavailable: "This PC's copy of your account's list, or its keys, cannot be read right now.",
  held_here: "This PC keeps that key out.",
  not_written: "That PC's card does not fit your account's list, so nothing was signed.",
  refused: "The account service did not take the entry that adds that PC.",
  not_claimed: "The account service did not take the entry that adds that PC.",
  list_stopped: "The account service changes your account's list for nobody right now. Try again later.",
  service_away: "The account service did not answer, so the entry that adds that PC may or may not be in your account's list. Connect again to check.",
  head_lost: "Your account's list kept changing while the entry was placed. Try again.",
  not_in_list: "The entry that adds that PC is not in your account's list.",
};
/** What stops this PC from signing anyone, as against what stopped this one entry. */
const CANNOT_SIGN: ReadonlySet<AllowRefusal> = new Set(["not_pinned", "not_signer", "alarm", "stopped", "behind", "unavailable"]);

/** The pause between two takes after the entry is placed: inside a loop bounded by its tries. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why this PC signs nobody in, and what the person does instead: the number on that PC, which needs no other PC to sign. */
function cannotAdd(reason: AllowRefusal): string {
  const words = CANNOT_ADD[reason];
  return words.includes("ovis add") ? words : `${words} Or run ovis add on that PC and add it with the number it shows.`;
}

const refuse = (code: string, message: string, status: number): { readonly refused: SshListRefusal } => ({ refused: { code, message, status } });

function notAdded(outcome: Extract<AllowOutcome, { refused: AllowRefusal }>): { readonly refused: SshListRefusal } {
  const words = CANNOT_ADD[outcome.refused] + (outcome.detail === null ? "" : ` (${outcome.detail})`);
  if (CANNOT_SIGN.has(outcome.refused)) return refuse("list_cannot_add", cannotAdd(outcome.refused), 409);
  // no answer from the service: the entry may be in the list all the same, which only the log says
  if (outcome.refused === "service_away") return refuse("take_unanswered", words, 409);
  // the account service takes no more additions to the list for now: the same add goes later
  if (outcome.refused === "refused" && outcome.detail === "429 entry_budget") return refuse("list_budget", "Your account's list takes no more additions for now. Add that PC again later.", 409);
  return refuse("list_not_added", words, 409);
}

/** Where an add stopped with the entry in the list and that PC not following it: running the add again finishes it. */
const UNBOUND = "That PC is in your account's list, and has not taken it yet. Add it again to finish: nothing more is signed.";
/** The entry is in the list, and that PC's answer to the take after it was lost or refused: whether it took the entry is not known. */
const UNCONFIRMED = "That PC's entry is in your account's list, and whether that PC took it could not be confirmed. Add it again to finish: nothing more is signed.";
/** That PC said it joined, and this PC's own copy does not show it yet. */
const UNSEEN = "That PC says it joined your account's list, and this PC's copy of the list does not show it yet. Connect to it again to check.";

/** That PC said it joined: said added only once this PC's own copy of the list this add named, read again, holds it too. */
async function seen(deps: SshListDeps, list: string, taken: SshListTaken): Promise<SshListTaken | { readonly refused: SshListRefusal }> {
  return await deps.list.holdsPcRead(deps.endpoint, list) ? taken : refuse("take_unanswered", UNSEEN, 409);
}

export async function addOverSshByList(deps: SshListDeps): Promise<SshListTaken | { readonly refused: SshListRefusal }> {
  const { list } = deps;
  // asked before anything goes to that PC: one that cannot sign names no list to it
  const cannot = list.allowRefusal();
  if (cannot !== null) return refuse("list_cannot_add", cannotAdd(cannot), 409);
  const pinned = list.status().pinned_list;
  const own = await list.own();
  if (pinned === null || own === null) return refuse("list_cannot_add", cannotAdd("unavailable"), 409);
  const named: AccountAddNamed = { list: pinned, adder: own.keys.key };
  let taken: Awaited<ReturnType<SshListDeps["take"]>>;
  try { taken = await deps.take(named); } catch (error) {
    // its answer lost: nothing is signed yet, and whether it follows the list is not known
    if (error instanceof AccountAddError && error.code === "take_lost") return refuse("take_unanswered", error.message, 409);
    throw error;
  }
  // that PC says it follows the list: added once this PC's own copy holds it too
  if (!("waiting" in taken)) return await seen(deps, pinned, taken);
  try {
    return await signedIn(deps, named, pinned, taken.waiting);
  } catch (error) {
    // whatever stopped it, the forward to that PC's owner socket goes with this add
    await deps.end();
    throw error;
  }
}

/** That PC answered with its card for the list: this PC checks it, signs that PC's entry, and has it take the entry. */
async function signedIn(deps: SshListDeps, named: AccountAddNamed, pinned: string, card: AccountAddCard): Promise<SshListTaken | { readonly refused: SshListRefusal }> {
  const { list } = deps;
  // a PC that cannot read the list, or that the list put out, would never take an entry: none is signed for it
  if (card.standing !== "waiting") {
    await deps.end();
    return card.standing === "out"
      ? refuse("list_removed", "That PC was removed from your account's list. It comes back only as a new PC: run ovis add on it.", 409)
      : refuse("that_pc_behind", "That PC's Ovis cannot read your account's list. Update Ovis there, then add it again.", 409);
  }
  // That PC's card, as it handed it over this SSH session, must be its key's own for this list and the relay key the
  // inspect read over the same session, before anything is signed. Nothing the account service holds stands in for it
  if (card.endpoint !== deps.endpoint || !await cardHolds({ key: card.key, enc: card.enc, list: pinned, endpoint: deps.endpoint, invite: null }, card.card)) {
    await deps.end();
    return refuse("list_not_added", "That PC's card is not its own for your account's list and the relay key read over SSH, so nothing was signed.", 409);
  }
  const added = await list.addPc({ ...card, endpoint: deps.endpoint });
  if ("refused" in added) {
    await deps.end();
    return notAdded(added);
  }
  const wait = deps.wait ?? pause;
  const tries = deps.tries ?? AFTER_PLACED_TRIES;
  // the entry is in this PC's own copy: that PC reads it at its next take
  for (let tried = 1; tried <= tries; tried++) {
    if (tried > 1) await wait(AFTER_PLACED_WAIT_MS);
    let taken: Awaited<ReturnType<SshListDeps["take"]>>;
    try { taken = await deps.take(named); } catch (error) {
      // The entry is in the list, and that PC did not say it took it (its answer was lost, or it refused): this add
      // stopped there, never "not added", and adding it again finishes it with nothing more signed
      if (!(error instanceof AccountAddError)) throw error;
      console.warn(`[account] the PC an add over SSH reached did not take its entry: ${error.code}`);
      await deps.end();
      return refuse("list_unbound", UNCONFIRMED, 409);
    }
    // `listJoined` as that PC said it: one that followed the list before this take (another way in) joined nothing by it
    if (!("waiting" in taken)) return await seen(deps, pinned, taken);
  }
  await deps.end();
  return refuse("list_unbound", UNBOUND, 409);
}
