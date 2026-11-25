/**
 * A PC that joined with an invite a device of the account made, and waits for Add (docs/account-list.md,
 * "Invites"). The account service says which PC used an invite, and that is only its word: a service that lies could
 * name a PC of its own. So a device offers Add for a posted PC only on evidence the service cannot make: the invite's
 * own key signed for that very PC and that very card, and the device's own copy of the list holds that invite as
 * open, placed by a member, waiting for Add.
 *
 * The line never leaves the PC it was typed at. What it signs there is the line's proof (shared/account-list-invite.ts,
 * lineProofBytes): a message of its own for the account, the PC's id, the list and the PC's very card. A redeem
 * signature of the line is no such proof: its challenge is the account service's to choose.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { cardHolds, inviteRefusal, listView, type ListNames } from "../../../shared/account-list.ts";
import { verifyLineProof } from "../../../shared/account-list-invite.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
import { addPostedPc, type AddPcOutcome, type PostedPc } from "./listAdd.ts";
import type { ListPost } from "./listAnswers.ts";
import type { WriteOptions } from "./listWrite.ts";

/** A posted PC that the line of an open invite of this device's list signed for. */
export interface InvitedPc extends PostedPc {
  /** The invite's public key. */
  readonly invite: string;
  /** The key of the member that placed the invite, as the list holds it. */
  readonly by: string | null;
  /** When the invite ends, in seconds since 1970, as its entry says. */
  readonly exp: number;
}

/**
 * Whether the invite with key `invite` lets a PC in by one press, on `writer`'s state at `nowS` (seconds, this device's
 * own clock held against the floor it saved and the list's time): an invite of the list, open as far as a member can
 * tell (not ended, its placer still in, a use left), one that waits for a person (not one a PC joins with by itself),
 * and not past its `exp`.
 */
export function inviteLetsIn(writer: ListWriter, invite: string, nowS: number): boolean {
  const row = writer.state.invites[invite];
  return row !== undefined && !row.auto && row.joins < row.uses && Math.max(writer.shown, nowS) <= row.exp && inviteRefusal(writer.state, invite) === null;
}

/**
 * Of `posts`, the PCs this device may offer Add for with no number: each with a card that holds for this device's
 * list and its own relay key, an invite that the device's own copy holds as open at `nowMs`, placed by a member and
 * not one a PC joins with by itself, and that invite's signature over this account, this PC and this card. None for a
 * device that may not write the list.
 */
export async function invitedPcs(list: AccountList, posts: readonly ListPost[], nowMs: number): Promise<InvitedPc[]> {
  const writer = list.writer();
  if (writer === null) return [];
  const open = new Map(listView(writer.state).invites
    .filter((row) => inviteLetsIn(writer, row.key, Math.floor(nowMs / 1000)))
    .map((row) => [row.key, row]));
  const found: InvitedPc[] = [];
  for (const post of posts) {
    if (post.invite === undefined || post.invite_proof === undefined || !open.has(post.invite)) continue;
    if (deriveServerId(hexToBytes(post.endpoint)) !== post.server_id) continue;
    if (!await cardHolds({ key: post.key, enc: post.enc, list: writer.list, endpoint: post.endpoint, invite: null }, post.card)) continue;
    const signed = await verifyLineProof({ account: writer.account, server_id: post.server_id, list: writer.list, card: { key: post.key, enc: post.enc, endpoint: post.endpoint } }, post.invite_proof, post.invite);
    const row = open.get(post.invite);
    if (signed && row !== undefined) found.push({ list: writer.list, endpoint: post.endpoint, server_id: post.server_id, key: post.key, enc: post.enc, card: post.card, invite: post.invite, by: row.by, exp: row.exp });
  }
  return found;
}

/**
 * The person pressed Add for a PC that joined with their invite: the account admits the PC, and this device signs its
 * `pc` entry with the card the line signed for, and ends the invite's key in the same request, so nobody else joins
 * with that line. No number is compared: the line's own signature is what says that this PC is the one. The invite is
 * judged again on the state of every signature (inviteLetsIn), and the Add is done only once this device's
 * copy holds the PC and the invite's end. `member`: the member key at the press. Answers as addPostedPc does; only a
 * sign-in that ended throws.
 */
export async function addInvitedPc(list: AccountList, pc: InvitedPc, names: ListNames | null, options: Pick<WriteOptions, "wait" | "expect" | "signal"> & { readonly admit: () => Promise<void>; readonly member?: string }): Promise<AddPcOutcome> {
  // judged by the writer's own reading of this device's clock, held against its floor and the list's time
  return addPostedPc(list, pc, names, { ...options, invite: { key: pc.invite, open: (writer) => inviteLetsIn(writer, pc.invite, writer.issued_at) } });
}
