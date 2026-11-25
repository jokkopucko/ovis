/**
 * The account service's answers about a signed list, as a device reads them (docs/account-list.md, "On a device"):
 * parsed here, at the edge, and for their form only. Nothing in them says who is in the account: an entry is checked
 * by the list's own rules, a wrap against the list's commitment, and a list id or a head only says what to read.
 */
import { isListHash, isListKeyEncoding } from "../../../shared/account-list-entry.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import { LIST_WRAP_TEXT_LENGTH } from "../../../shared/account-list-seal.ts";

/** The list the account service names for an account, and the head it says that list has. */
export interface ListHint {
  readonly list: string;
  readonly head: ListPlace;
}

/** One answer of the log: the entries after `after` (null: from entry 0), each as its text, never read here. */
export interface ListPage {
  readonly list: string;
  readonly after: number | null;
  readonly entries: readonly string[];
  readonly head: ListPlace;
  readonly more: boolean;
}

/** An epoch key wrapped to one member, as its text. */
export interface ListWrap {
  readonly epoch: number;
  readonly wrap: string;
}

/** The most entries one page holds, and the most this device asks for. */
export const LIST_PAGE_MAX = 256;
/** The most wraps one answer may hold: one for each epoch of a list at its largest. */
const LIST_WRAPS_MAX = 20480;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function placeOf(value: unknown): ListPlace | null {
  return isRecord(value) && isCount(value.seq) && typeof value.hash === "string" && isListHash(value.hash) ? { seq: value.seq, hash: value.hash } : null;
}

/**
 * The account service's clock as an answer carries it (`now`, seconds), or null. It is a hint like the rest: a device
 * uses it only to date an entry no later than the service will take, never to judge anything.
 */
export function nowOf(body: unknown): number | null {
  return isRecord(body) && isCount(body.now) ? body.now : null;
}

/** `{ list, head }`, or `{ list: null }` as null; undefined for anything else. */
export function hintOf(body: unknown): ListHint | null | undefined {
  if (!isRecord(body)) return undefined;
  if (body.list === null) return null;
  const head = placeOf(body.head);
  return typeof body.list === "string" && isListHash(body.list) && head !== null ? { list: body.list, head } : undefined;
}

/**
 * A page of a log; null for an answer out of form or with more entries than a page holds. Which list it says it is
 * of, and which place it says it follows, are the answer's own word: the reader holds them against what it asked.
 */
export function pageOf(body: unknown): ListPage | null {
  if (!isRecord(body) || typeof body.list !== "string" || !isListHash(body.list) || typeof body.more !== "boolean") return null;
  const head = placeOf(body.head);
  const { after, entries } = body;
  if (head === null || !(after === null || isCount(after)) || !Array.isArray(entries) || entries.length > LIST_PAGE_MAX) return null;
  if (!entries.every((entry): entry is string => typeof entry === "string")) return null;
  return { list: body.list, after, entries, head, more: body.more };
}

/** The wraps an answer holds, each epoch once; null for an answer out of form. What a wrap holds is openWrap's to say. */
export function wrapsOf(body: unknown): ListWrap[] | null {
  if (!isRecord(body) || !Array.isArray(body.wraps) || body.wraps.length > LIST_WRAPS_MAX) return null;
  const wraps = new Map<number, ListWrap>();
  for (const wrap of body.wraps as readonly unknown[]) {
    if (!isRecord(wrap) || !isCount(wrap.epoch) || typeof wrap.wrap !== "string" || wrap.wrap.length !== LIST_WRAP_TEXT_LENGTH || wraps.has(wrap.epoch)) return null;
    wraps.set(wrap.epoch, { epoch: wrap.epoch, wrap: wrap.wrap });
  }
  return [...wraps.values()];
}

/** The body of the genesis: entry 0 and the first epoch key's wrap for the device that signed it. */
export function genesisBody(entry: string, wrap: { readonly member: string; readonly wrap: string }): { entry: string; wraps: { epoch: number; member: string; wrap: string }[] } {
  if (!isListKeyEncoding(wrap.member) || wrap.wrap.length !== LIST_WRAP_TEXT_LENGTH) throw new RangeError("A genesis carries the wrap of epoch 0 for its own encryption key");
  return { entry, wraps: [{ epoch: 0, member: wrap.member, wrap: wrap.wrap }] };
}

/** A device's claim of its own key at the account service, as another device reads it: the key, its encryption key and its card. */
export interface ListClaim {
  readonly key: string;
  readonly enc: string;
  readonly card: string;
}

/** The most claims one answer may hold: the account service keeps one for each sign-in that waits. */
const LIST_CLAIMS_MAX = 256;
/** A card's signature as text. */
const CARD_CHARS = 86;

/**
 * The claims an answer holds, each key once; null for an answer out of form. A claim is only where a card is found:
 * the card proves itself, and which key is the person's new device is what the comparing of digits says.
 */
export function claimsOf(body: unknown): ListClaim[] | null {
  if (!isRecord(body) || !Array.isArray(body.claims) || body.claims.length > LIST_CLAIMS_MAX) return null;
  const claims = new Map<string, ListClaim>();
  for (const claim of body.claims as readonly unknown[]) {
    if (!isRecord(claim) || typeof claim.key !== "string" || !isListKeyEncoding(claim.key) || typeof claim.enc !== "string" || !isListKeyEncoding(claim.enc)
      || typeof claim.card !== "string" || claim.card.length !== CARD_CHARS || claims.has(claim.key)) return null;
    claims.set(claim.key, { key: claim.key, enc: claim.enc, card: claim.card });
  }
  return [...claims.values()];
}

/** The comparison of numbers under way for a PC's post: who opened it and with what commitment, the PC's nonce once it answered, the adder's once revealed. */
export interface ListAttempt {
  readonly adder: string;
  readonly commitment: string;
  readonly nonce: string | null;
  readonly reveal: string | null;
}

/**
 * A PC that asks to be added to the list: the keys and the card it posted with a proof of its own relay key, as the
 * account service shows them. `server_id` is only what the service says: the id that counts is the one `endpoint` gives.
 */
export interface ListPost {
  readonly endpoint: string;
  readonly server_id: string;
  readonly key: string;
  readonly enc: string;
  readonly card: string;
  readonly attempt: ListAttempt | null;
  /**
   * A PC that joined with an invite's line: the invite's public key, and the line's own signature over this very post
   * (shared/account-list-invite.ts lineProofBytes). Both or neither; the account service only carries them.
   */
  readonly invite?: string;
  readonly invite_proof?: string;
}

/** The most posts one answer is read for. */
const LIST_POSTS_MAX = 64;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** The attempt an answer carries, null for none; undefined for one out of form. */
export function attemptOf(value: unknown): ListAttempt | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.adder !== "string" || !isListKeyEncoding(value.adder) || typeof value.commitment !== "string" || !NONCE.test(value.commitment)) return undefined;
  const part = (text: unknown): string | null | undefined => text === null || text === undefined ? null : typeof text === "string" && NONCE.test(text) ? text : undefined;
  const [nonce, reveal] = [part(value.nonce), part(value.reveal)];
  return nonce === undefined || reveal === undefined ? undefined : { adder: value.adder, commitment: value.commitment, nonce, reveal };
}

/** The posts an answer holds, each relay key once; null for an answer out of form. */
export function postsOf(body: unknown): ListPost[] | null {
  if (!isRecord(body) || !Array.isArray(body.posts) || body.posts.length > LIST_POSTS_MAX) return null;
  const posts = new Map<string, ListPost>();
  for (const post of body.posts as readonly unknown[]) {
    if (!isRecord(post) || typeof post.endpoint !== "string" || !isListHash(post.endpoint) || typeof post.server_id !== "string" || !/^[0-9a-f]{32}$/.test(post.server_id)
      || typeof post.key !== "string" || !isListKeyEncoding(post.key) || typeof post.enc !== "string" || !isListKeyEncoding(post.enc)
      || typeof post.card !== "string" || post.card.length !== CARD_CHARS || posts.has(post.endpoint)) return null;
    const attempt = attemptOf(post.attempt);
    if (attempt === undefined) return null;
    // an invite and its proof, both in their form, or neither is taken: the post is then one of a PC that only asks
    const invited = typeof post.invite === "string" && isListKeyEncoding(post.invite) && typeof post.invite_proof === "string" && /^[A-Za-z0-9_-]{86}$/.test(post.invite_proof)
      ? { invite: post.invite, invite_proof: post.invite_proof } : {};
    posts.set(post.endpoint, { endpoint: post.endpoint, server_id: post.server_id, key: post.key, enc: post.enc, card: post.card, attempt, ...invited });
  }
  return [...posts.values()];
}

/** An epoch key wrapped to one member, as a placement carries it. */
export interface PlacedWrap {
  readonly epoch: number;
  readonly member: string;
  readonly wrap: string;
}
