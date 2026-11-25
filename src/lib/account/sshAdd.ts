/**
 * Adding another PC to this PC's account over SSH (docs/account.md, "Adding a PC over SSH"), as this PC's own window does
 * it once the setup job reached that PC's own Ovis: the window lists that PC and admits it with its own sign-in, then
 * asks this PC to hand that PC only the account (POST /api/account/ssh-add); that PC takes the admission itself and turns
 * its relay on. "added" only once that PC is bound and says its relay is online: a listing or an admission alone adds
 * nobody, and a PC nobody can open through its relay is not what was asked for. On an account that keeps a signed list,
 * this PC signs that PC into the list itself, over the same connection ("Adding a PC over SSH to an account that keeps a
 * list"); the window's steps are the same, and only its words for what stops that are its own.
 */
import { accountAddRelay, type AccountAddRelay, type AccountAddTarget } from "../../../shared/machines.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { apiFetch } from "../api-request-id.ts";
import { ownWindowHere } from "./addThisPc.ts";
import type { PcAccountStatus } from "./join.ts";
import { AccountServiceError, sameSignIn, type AccountService } from "./service.ts";
import { noteAct } from "./seenPcs.ts";
import type { AccountSession } from "./store.ts";

/**
 * - `added`: that PC took the admission, is in the account, and its relay is online.
 * - `already`: that PC is in this account already, and its relay is online; nothing was listed or admitted.
 * - `added-unchecked`, `already-unchecked`: in the account, but its Ovis did not say how its relay stands (an Ovis from
 *   before that); `added-unanswered`, `already-unanswered`: in the account, as a second look found once the take's own
 *   answer was lost, its relay not known.
 * - `not-online`: that PC is in this account, but its relay was not online when it answered.
 * - `relay-off`: that PC is in this account already, and its owner turned its relay off there, which an add leaves so.
 * - `maybe`: the take went out (or may have) and no answer came, not even to a second look: it may have been added.
 * - `other-account`: that PC is in another account; nothing was listed.
 * - `number`: the service refused the admission for want of two-step sign-in: that PC adds itself with its number.
 * - `sign-in-again`: the service refused this sign-in (not fresh, or not this device's own).
 * - `list-cannot-add`: the account keeps a signed list, and this PC cannot sign another PC into it (it joined by an
 *   invite, or follows no list): that PC is added with the number `ovis add` shows there.
 * - `update-that-pc`: the account keeps a signed list, and that PC's Ovis is too old to be named it, or to read it.
 * - `pc-error`: that PC's Ovis could not answer the take (an error of its own): asking again may do.
 * - `list-not-added`: that PC posted its keys, and its entry did not go into the list: adding it again goes on from there.
 * - `list-placed`: its entry is in the list, and that PC has not taken it yet: adding it again finishes, signing nothing more.
 * - `list-later`: the account's list takes no more additions for now (its budget): adding it again later goes on.
 * - `list-removed`: the account's list removed that PC: it comes back only as a new PC, from `ovis add` there.
 * - `account-changed`: this PC's own account changed while that PC was being added: that PC may be in the account it was
 *   added to, which is where to look.
 * - `disconnected`: the SSH connection the take needs ended before it was sent (or the job is gone): connecting again goes on.
 * - `refused`: anything else, the attempt given up or the sign-in changed included.
 */
export type SshAddOutcome = "added" | "already" | "added-unchecked" | "already-unchecked" | "added-unanswered" | "already-unanswered"
  | "not-online" | "relay-off" | "maybe" | "other-account" | "number" | "sign-in-again" | "list-cannot-add" | "update-that-pc" | "list-not-added" | "list-placed"
  | "list-later" | "list-removed" | "account-changed" | "pc-error" | "disconnected" | "refused";

/**
 * What this PC said of the take: that PC's relay as it answered (null: not said; `unanswered`: the take's answer was lost and
 * a second look found that PC in the account), whether that PC joined the account's signed list by this very take
 * (`listJoined`), or the refusal's code.
 */
export type SshTake = { readonly relay: AccountAddRelay | null; readonly unanswered?: true; readonly listJoined?: true } | { readonly refused: string };

/** Whether this window may offer it: this PC's own window, signed in to the very account this PC is bound to. */
export function sshAddOffered(here: { ownWindow: boolean; signedInAccount: string | null; pcAccount: string | null }): boolean {
  return here.ownWindow && here.pcAccount !== null && here.signedInAccount === here.pcAccount;
}

/**
 * Whether this window adds a PC to the account over SSH (Add PC's Add it to my account, and the relay tab's list of PCs
 * to add): sshAddOffered in this PC's own window (ownWindowHere: `local`, or the access token on a loopback address),
 * on a PC whose account rules are on and readable (`pc_add_from_account: true`).
 */
export function sshAddListed(here: {
  pcAddFromAccount: PcAccountStatus["pcAddFromAccount"]; auth: { readonly via?: string } | null | undefined; hostname?: string;
  signedInAccount: string | null; pcAccount: string | null;
}): boolean {
  const ownWindow = here.hostname === undefined ? ownWindowHere(here.auth) : ownWindowHere(here.auth, here.hostname);
  return here.pcAddFromAccount === true && sshAddOffered({ ownWindow, signedInAccount: here.signedInAccount, pcAccount: here.pcAccount });
}

const hex = (key: string): string => Array.from(importPublicKey(key), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * POST /api/account/ssh-add. A reply that took is held to the add it answers: the account it was asked for and the PC the
 * job reached. One for another account or PC, or one that does not read, says nothing of this add (`take_unknown`).
 */
async function takeHere(jobId: string, serverId: string, account: string): Promise<SshTake> {
  const answer = await apiFetch("/api/account/ssh-add", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ job_id: jobId, server_id: serverId }) });
  const body = await answer.json().catch(() => null) as { account?: unknown; server_id?: unknown; relay?: unknown; unanswered?: unknown; list_joined?: unknown; error?: { code?: unknown } } | null;
  // this PC failed on its own side: the take may have gone out already
  if (answer.status >= 500) return { refused: "take_unanswered" };
  if (!answer.ok) return { refused: typeof body?.error?.code === "string" ? body.error.code : "refused" };
  if (body === null || typeof body !== "object" || body.account !== account || body.server_id !== serverId) return { refused: "take_unknown" };
  return { relay: accountAddRelay(body.relay), ...(body.unanswered === true ? { unanswered: true as const } : {}), ...(body.list_joined === true ? { listJoined: true as const } : {}) };
}

/** A take's refusal, by its code, as the dialog says it. */
const REFUSED: Readonly<Record<string, SshAddOutcome>> = {
  disconnected: "disconnected", job_not_found: "disconnected",
  // `list_add`: this PC follows no list, and that PC's account keeps one, so it takes no add on the account service's word
  list_cannot_add: "list-cannot-add", list_add: "list-cannot-add",
  // too old to be named a list, or to read the one it was named
  that_pc_old: "update-that-pc", that_pc_behind: "update-that-pc",
  // a current Ovis there that could not answer (its own error): asking again may do
  that_pc_error: "pc-error",
  list_not_added: "list-not-added", list_unbound: "list-placed", list_budget: "list-later",
  list_removed: "list-removed", account_changed: "account-changed",
  // the take may have gone out, or its reply said nothing of this add: never "not added"
  take_unanswered: "maybe", take_unknown: "maybe",
};

/**
 * The take, and what it came to. `already`: inspect found that PC in this account before it. `now`: the take confirmed,
 * for that PC and this account, that it is in the account by this add: it was not there, or the take put it in the
 * account's signed list.
 */
async function taken(take: (jobId: string, serverId: string) => Promise<SshTake>, jobId: string, serverId: string, before: boolean): Promise<{ readonly outcome: SshAddOutcome; readonly now: boolean }> {
  let said: SshTake;
  try { said = await take(jobId, serverId); }
  catch (error) {
    // no answer from this PC: it may have sent the take, so this is never "not added"
    console.warn("Ovis: this PC gave no answer to handing that PC the account", error instanceof Error ? error.name : error);
    return { outcome: "maybe", now: false };
  }
  if ("refused" in said) return { outcome: REFUSED[said.refused] ?? "refused", now: false };
  // in the account before, and put in its list by this take: this add put it there
  const already = before && said.listJoined !== true;
  const outcome = ((): SshAddOutcome => {
    if (said.unanswered === true) return already ? "already-unanswered" : "added-unanswered";
    if (said.relay === null) return already ? "already-unchecked" : "added-unchecked";
    if (said.relay.phase === "online") return already ? "already" : "added";
    // its owner turned its relay off there: an add that found it in the account already leaves the switch as it is
    if (already && said.relay.phase === "off" && said.relay.blocked === null) return "relay-off";
    return "not-online";
  })();
  return { outcome, now: !already };
}

export async function addOverSsh(service: AccountService, job: { readonly id: string; readonly account_add: AccountAddTarget }, options: {
  readonly account: string;
  /** false once the dialog closed or the attempt was replaced: nothing more is written */
  readonly running: () => boolean;
  readonly take?: (jobId: string, serverId: string) => Promise<SshTake>;
  /** a sign-in just made again here: written with only while it is still the one stored */
  readonly signIn?: AccountSession;
}): Promise<SshAddOutcome> {
  try { return await adding(service, job, options); }
  catch (error) {
    // what this page stores could not be read (its sign-in): nothing was taken, and the add may be started again
    console.warn("Ovis: the add over SSH stopped before the take", error instanceof Error ? error.name : error);
    return "refused";
  }
}

async function adding(service: AccountService, job: { readonly id: string; readonly account_add: AccountAddTarget }, options: Parameters<typeof addOverSsh>[2]): Promise<SshAddOutcome> {
  const target = job.account_add;
  const take = options.take ?? ((jobId: string, serverId: string) => takeHere(jobId, serverId, options.account));
  if (target.account !== null && target.account !== options.account) return "other-account";
  // pinned to the sign-in read now: one stored meanwhile (another tab signed out and in) is never written with, and no
  // take goes for it, which on an account that keeps a list may have this PC sign that PC into it
  const stored = await service.session();
  if (stored?.account !== options.account || (options.signIn !== undefined && !sameSignIn(stored, options.signIn)) || !options.running()) return "refused";
  const session = options.signIn ?? stored;
  // This device added that PC over SSH: kept in its own record of its PCs, by the relay key the PC gave over that channel,
  // only once the take confirmed the add of that PC to this account, never before it and never for a refusal
  const kept = async (result: { readonly outcome: SshAddOutcome; readonly now: boolean }): Promise<SshAddOutcome> => {
    // an attempt that ended while its take was out (the dialog closed, another attempt took its place) writes nothing more
    if (result.now && options.running()) {
      try { await noteAct(session.account, hex(target.public_key), "ssh").catch(() => undefined); } catch { /* it only records: a key that does not read keeps nothing */ }
    }
    return result.outcome;
  };
  // in this account already: nothing is listed or admitted, but it is taken all the same, which turns its relay on (and,
  // for an account that keeps a list, may put it in that list)
  if (target.account === options.account) return await kept(await taken(take, job.id, target.server_id, true));
  const directory = service.forSignIn(session);
  // a sign-in the account service would refuse as too old asks for a fresh one at once: the calls before that refusal
  // (the account's PCs, the listing, its proof) may each take long on a slow service, with the dialog saying it adds
  if (options.signIn === undefined && await directory.addAsksSignIn()) return "sign-in-again";
  try {
    const listed = (await directory.listPcs()).some((pc) => pc.server_id === target.server_id);
    if (!options.running()) return "refused";
    if (!listed) await directory.putPc(target.server_id, { label: target.label, public_key: hex(target.public_key), relay: target.relay }, undefined, undefined, { prove: true });
    if (!options.running()) return "refused";
    await directory.admitPc(target.server_id);
  } catch (error) {
    if (error instanceof AccountServiceError && error.code === "two_step_required") return "number";
    if (error instanceof AccountServiceError && (error.code === "session_not_fresh" || error.code === "own_sign_in_required")) return "sign-in-again";
    console.warn("Ovis: the account service did not admit that PC", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
    return "refused";
  }
  const still = await service.session();
  if (still === undefined || !sameSignIn(still, session) || !options.running()) return "refused";
  return await kept(await taken(take, job.id, target.server_id, false));
}
