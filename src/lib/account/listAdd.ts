/**
 * A device that is in its account's signed list adds a PC to it (docs/account-list.md, "Adding a PC"): the PC posted
 * its keys and its card for the list, the device and the PC work out one number from that card, a person confirms it
 * at the PC and then presses Add here, and the device signs a `pc` entry with exactly the card the number came from.
 *
 * The account service only carries the messages of the comparison, and may be an end of it itself: a number that is
 * shown proves nothing, and only the person's two confirmations do, each for its own end. So this device shows a
 * number only for a card that holds for its own list and that PC's relay key, commits to its nonce before it has
 * seen the PC's, and signs only what the number was worked out from.
 */
import { cardBinding, cardHolds, type ListCard, type ListKind, type ListNames } from "../../../shared/account-list.ts";
import { hexToBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
import type { ListPost } from "./listAnswers.ts";
import { signedNamed, signedOn, writeNamed, type WriteOptions, type WriteRefusal } from "./listWrite.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/** A PC that asks to be added, whose card this device checked: it is that key's own, for this device's list and that relay key. */
export interface PostedPc {
  readonly list: string;
  readonly endpoint: string;
  /** The id that relay key gives. */
  readonly server_id: string;
  readonly key: string;
  readonly enc: string;
  readonly card: string;
}

const cardOf = (post: Pick<PostedPc, "key" | "enc" | "list" | "endpoint">): ListCard => ({ key: post.key, enc: post.enc, list: post.list, endpoint: post.endpoint, invite: null });

/**
 * The PCs that posted for the list this device follows and may write to, each with a card that holds. A post whose
 * card is not that key's, names another list, or whose id is not the one its relay key gives, is left out: nothing
 * is shown or started for it. None for a device that may not write.
 */
export async function postedPcs(list: AccountList, signal?: AbortSignal): Promise<PostedPc[]> {
  const writer = list.writer();
  if (writer === null) return [];
  const posts: PostedPc[] = [];
  for (const post of await writer.service.listPosts(writer.list, signal)) {
    const held: PostedPc = { list: writer.list, endpoint: post.endpoint, server_id: deriveServerId(hexToBytes(post.endpoint)), key: post.key, enc: post.enc, card: post.card };
    if (held.server_id === post.server_id && await cardHolds(cardOf(held), post.card)) posts.push(held);
  }
  return posts;
}

/**
 * Why no number came.
 *
 * - `no_list`: this device may not write to a list.
 * - `gone`: the PC posts no more, or posted other keys since: read the posts again.
 * - `spent`: too many numbers were asked for that PC for now.
 * - `silent`: the PC did not answer in time.
 * - `unreached`: the account service did not answer.
 */
export type NumberRefusal = "no_list" | "gone" | "spent" | "silent" | "unreached";

/** The number both screens show for one attempt, and what a later Add signs: the very post it was worked out from. */
export interface AddNumber {
  readonly post: PostedPc;
  readonly digits: string;
  /**
   * Until when this device takes a press of Add for this number, in ms by its clock: two minutes from the earliest the
   * PC can have answered (the last read that did not show its answer yet), never from when its answer came here.
   */
  readonly until: number;
  /** The member key the comparison was made with: the PC takes an entry signed by it alone, so Add signs with it or not at all. */
  readonly member: string;
}

export type NumberOutcome = { readonly shown: true; readonly number: AddNumber } | { readonly shown: false; readonly why: NumberRefusal };

/**
 * How many numbers one card asks for a PC, on this device: a try that ran out, was not the same or got no answer counts.
 * The account service keeps its own, larger count; this one is the phone's, so a card left open asks the PC no more.
 */
export const NUMBER_TRIES = 3;
/** A number lives this long from the PC's answer. */
export const NUMBER_MS = 120_000;
/** Leave time for the PC's per-minute list budget to reset, then for both ends to poll and reveal. */
export const NUMBER_WAIT_MS = 70_000;
/** How often it looks for that answer. */
const NUMBER_POLL_MS = 1_500;
/** How often the reveal goes again while the service still holds the attempt without the PC's answer. */
const REVEAL_SENDS = 3;

/** The pause between two looks for the PC's answer: inside a loop bounded by NUMBER_WAIT_MS. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason as Error); }, { once: true });
});

/**
 * `work` with `ms` to answer, by its own timer: a request that does not end with its signal is given up all the same,
 * and the call rejects as one that got no answer in time.
 */
function within<T>(ms: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  const over = new DOMException("The account service did not answer in time", "TimeoutError");
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(over); stop.abort(over); }, Math.max(0, ms));
    work(signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal])).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);
const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && error.name === "TimeoutError");

/**
 * Works out the number for `post` with the PC, through the account service: this device commits to a nonce of its
 * own, the PC answers with its nonce, the device reveals its own, and the number is what both give with the card's
 * binding. The commitment goes before the PC's nonce is known, and the reveal only after, so neither end, and nobody
 * between them, can steer the number. The number is shown from the PC's answer on; the PC shows it once the reveal
 * checked out. Only a sign-in that ended, or a cancel, throws.
 */
export async function numberWith(list: AccountList, post: PostedPc, options: { readonly signal?: AbortSignal; readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>; readonly now?: () => number; /** how long to wait for the PC's answer, NUMBER_WAIT_MS unless a caller says */ readonly waitMs?: number } = {}): Promise<NumberOutcome> {
  const wait = options.wait ?? pause;
  const now = options.now ?? Date.now;
  const writer = list.writer();
  if (writer === null || writer.list !== post.list) return { shown: false, why: "no_list" };
  const adder = writer.keys.key;
  const binding = cardBinding(cardOf(post));
  const mine = randomPairNonce();
  const message = { key: post.key, adder, commitment: toBase64Url(pairCommitment(binding, adder, mine)) };
  // One deadline for the whole wait: every request of it ends by then, answered or not, and an answer that comes after
  // it counts for nothing
  const deadline = now() + (options.waitMs ?? NUMBER_WAIT_MS);
  const refused = (error: unknown): NumberOutcome => {
    if (error instanceof SignedOutError || options.signal?.aborted === true) throw error;
    const said = refusalOf(error);
    if (said === null) {
      if (error instanceof DOMException && error.name === "TimeoutError" && now() >= deadline) return { shown: false, why: "silent" };
      if (unanswered(error)) return { shown: false, why: "unreached" };
      throw error;
    }
    return { shown: false, why: said.status === 409 && said.code === "post_changed" ? "gone" : said.status === 429 ? "spent" : "unreached" };
  };
  /** One request of the wait, ended at the deadline: `late` where it ended past it, whatever it answered. */
  const timed = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | "late"> => {
    if (now() >= deadline) return "late";
    const answer = await within(deadline - now(), options.signal, work);
    return now() > deadline ? "late" : answer;
  };
  // the earliest the PC can have answered this commitment: it cannot before it was sent, nor before a read that did not show its answer
  let earliest = now();
  try { if (await timed((signal) => writer.service.listAttempt(writer.list, post.endpoint, message, signal)) === "late") return { shown: false, why: "silent" }; } catch (error) { return refused(error); }
  // the PC's nonce, for this very commitment, read from the posts until it is there
  let theirs: Uint8Array | null = null;
  while (theirs === null) {
    const sent = now();
    let posts: readonly ListPost[] | "late";
    try { posts = await timed((signal) => writer.service.listPosts(writer.list, signal)); } catch (error) { return refused(error); }
    if (posts === "late") return { shown: false, why: "silent" };
    const seen = posts.find((each) => each.endpoint === post.endpoint);
    if (seen === undefined || seen.key !== post.key || seen.enc !== post.enc || seen.card !== post.card) return { shown: false, why: "gone" };
    // another attempt took this one's place (another device of the account asked for a number too): this one is over
    if (seen.attempt === null || seen.attempt.adder !== adder || seen.attempt.commitment !== message.commitment) return { shown: false, why: "gone" };
    if (seen.attempt.nonce !== null) { theirs = fromBase64Url(seen.attempt.nonce); break; }
    earliest = sent;
    if (now() >= deadline) return { shown: false, why: "silent" };
    await wait(Math.min(NUMBER_POLL_MS, deadline - now()), options.signal);
  }
  const until = earliest + NUMBER_MS;
  const reveal = toBase64Url(mine);
  // the reveal, too, is a request of the wait: it ends by the wait's deadline, and by the number's own end
  const revealBy = Math.min(deadline, until);
  for (let sends = 1; ; sends += 1) {
    if (now() >= revealBy) return { shown: false, why: "silent" };
    try { await within(revealBy - now(), options.signal, (signal) => writer.service.listAttempt(writer.list, post.endpoint, { ...message, reveal }, signal)); break; } catch (error) {
      const said = refusalOf(error);
      // the service has not stored the PC's answer where this request landed yet: once more, a moment later
      if (said !== null && said.status === 409 && said.code === "attempt_changed" && sends < REVEAL_SENDS) { await wait(NUMBER_POLL_MS, options.signal); continue; }
      if (said === null && error instanceof DOMException && error.name === "TimeoutError" && options.signal?.aborted !== true) return { shown: false, why: "silent" };
      return said !== null && said.status === 409 ? { shown: false, why: "gone" } : refused(error);
    }
  }
  // an answer to the reveal that came after the deadline counts for nothing
  if (now() >= revealBy) return { shown: false, why: "silent" };
  return { shown: true, number: { post, digits: pairDigits(binding, adder, mine, theirs), until, member: adder } };
}

/** Why a PC was not added: what stops any write (listWrite.ts), or the account service did not admit the PC (`admit`, with its code). */
/**
 * Why a PC was not added: what stops any write (listWrite.ts), the account service did not admit the PC (`admit`, with
 * its code), or the invite the PC joined with no longer lets it in by one press, on the state a signature was to be
 * made on (`invite_ended`: over by this device's clock, used, revoked, or its placer gone).
 */
export type AddPcOutcome = { readonly added: true } | { readonly added: false; readonly why: WriteRefusal | "admit" | "invite_ended"; readonly code?: string; readonly retryAfterMs: number | null };

/**
 * The person pressed Add beside the number: the account admits the PC (the account service places a `pc` entry only
 * for a PC an own sign-in admitted), and this device signs the `pc` entry with exactly the card the number was worked
 * out from, the PC's name sealed and the epoch key wrapped to the PC's encryption key. The PC is added once this
 * device's own copy shows the entry. `admit`: the one-press admission, the caller's own (it may ask for a sign-in).
 * `member`: the member key the comparison (or the scan) began with; a device that holds another key now signs nothing
 * (`changed`), and neither does one whose account or list is not `expect`'s, before the admission too. `signal`: the
 * person's Cancel, checked before the admission, before signing and before sending.
 */
export async function addPostedPc(list: AccountList, post: PostedPc, names: ListNames | null, options: Pick<WriteOptions, "wait" | "expect" | "signal"> & {
  readonly admit: () => Promise<void>;
  readonly member?: string;
  /**
   * The invite the PC joined with, which the same request ends (listInvited.ts): the Add is done only once this
   * device's own copy holds the PC by this card AND the invite's key is ended. `open` says, on the state each signature
   * is to be made on, whether the invite still lets this PC in by one press; where it does not, nothing more of the PC
   * is signed (`invite_ended`). `optional`: the PC is added on other evidence (a compared number), and the invite it
   * joined with is ended beside it only while it is still open: an invite that is over refuses nothing then.
   */
  readonly invite?: { readonly key: string; readonly open: (writer: ListWriter) => boolean; readonly optional?: true };
}): Promise<AddPcOutcome> {
  const { member, admit, invite, ...rest } = options;
  // the member key goes into the write's own scope too, so every read and retry holds it (X3)
  const writeOptions = rest.expect === undefined || member === undefined ? rest : { ...rest, expect: { ...rest.expect, key: member } };
  const changed = (writer: ListWriter | null): boolean => writer === null || writer.list !== post.list
    || (options.expect !== undefined && writer.account !== options.expect.account) || (member !== undefined && writer.keys.key !== member);
  // the list holds the PC by this very card: its key and its encryption key (a row's keys never change once set)
  const pcHeld = (writer: ListWriter): boolean => {
    const row = writer.state.pcs[post.endpoint];
    return row !== undefined && row.removed === null && row.key === post.key && row.enc === post.enc;
  };
  // the invite is ended, or (where ending it is only beside a number) no longer open, so nothing is left to end
  const inviteEnded = (writer: ListWriter): boolean => invite === undefined || (writer.state.signers[invite.key]?.ended ?? null) !== null
    || (invite.optional === true && !invite.open(writer));
  options.signal?.throwIfAborted();
  // what the person pressed for, before anything goes: the account, the list and the member key it was shown for
  const before = list.writer();
  if (before === null || changed(before)) return { added: false, why: "changed", retryAfterMs: null };
  if (invite !== undefined && invite.optional !== true && !pcHeld(before) && !invite.open(before)) return { added: false, why: "invite_ended", retryAfterMs: null };
  const held = list.holdsPc(post.endpoint);
  if (!held) {
    try { await admit(); } catch (error) {
      if (error instanceof SignedOutError) throw error;
      const said = refusalOf(error);
      if (said === null && !unanswered(error)) throw error;
      return said === null ? { added: false, why: "unreached", retryAfterMs: null } : { added: false, why: "admit", code: said.code, retryAfterMs: said.retryAfterMs };
    }
  }
  const ends: readonly ListKind[] = invite === undefined ? [] : [{ kind: "remove", ends: invite.key }];
  // Two rounds at most: where the request that placed the PC's entry could not carry the invite's removal beside it,
  // the next signs that removal alone. The Add is done only when both are in this device's own copy.
  for (let rounds = 0; rounds < 2; rounds += 1) {
    const outcome = await writeNamed<"pc" | "ends", "invite_ended">(list, async (writer) => {
      // every try signs on a writer of the very account, list and member key the press was for (X3)
      if (changed(writer)) return { refused: "changed" };
      // the list holds that relay key by this card already (this press, sent before): what is left is the invite's end
      if (pcHeld(writer)) return inviteEnded(writer) ? { done: { seq: writer.state.footing.seq, hash: writer.state.footing.hash } } : { go: "ends" };
      // the invite is judged again on the very state this signature is made on
      if (invite !== undefined && invite.optional !== true && !invite.open(writer)) return { refused: "invite_ended" };
      return { go: "pc" };
    }, (writer, go) => go === "ends" ? signedOn(writer, ends)
      : signedNamed(writer, names, post.enc, (sealed): ListKind => ({ kind: "pc", key: post.key, endpoint: post.endpoint, enc: post.enc, card: post.card, sealed }), inviteEnded(writer) ? [] : ends),
    { ...writeOptions, operation: `add-pc:${post.endpoint}`, reserve: ends.length });
    if (!outcome.written) return { added: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
    if (invite === undefined) return { added: true };
    const now = list.writer();
    if (now !== null && pcHeld(now) && inviteEnded(now)) return { added: true };
  }
  return { added: false, why: "unknown", retryAfterMs: null };
}
