/**
 * Leaving the account from this device (docs/account.md, rule 5; design "sign out"): a `remove`
 * for its own account key, signed by that key, goes to the mailbox of every PC of the account, so
 * each PC revokes this device the next time it collects its mail; then the sign-in ends and this
 * device forgets its account key and the pairings that used it. Signing out only ends the sign-in
 * and keeps every pairing, as one made by QR code is kept.
 */
import { newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { RemoveRecord } from "../../../shared/account-records.ts";
import type { RelayDeviceStore } from "../relay/device.ts";
import { sameSignIn, SignedOutError, type AccountService } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";
import { post, rememberDevice, type PcFetch } from "./join.ts";

export interface LeaveResult {
  readonly remove: RemoveRecord;
  /** PCs this device signs in to with the account key that the account does not list: no remove reached them, so their pairing is kept */
  readonly unconfirmed: readonly string[];
  /** PCs the remove only went to by mailbox: each applies it when it next reads its mail, or refuses it there if this device was revoked meanwhile, so none is confirmed here */
  readonly queued?: readonly string[];
}

/**
 * `session` is the sign-in the person left from, read when they asked: every call is made for it
 * alone, so a sign-in made meanwhile is never sent removals, signed out or forgotten.
 */
export async function leaveAccount(options: { service: AccountService; accountStore: AccountStore; relayStore: RelayDeviceStore; session: AccountSession; now?: () => number }): Promise<LeaveResult> {
  const { session } = options;
  const service = options.service.forSignIn(session);
  const key = await options.accountStore.key();
  const remove: RemoveRecord = await signAccountRecord({
    v: 1, kind: "remove", account: session.account, key: key.public_spki,
    issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: key.public_spki,
  }, key.private_key);
  // marked in the transaction that reads the links on their way (relay/accountController.ts takes one in the
  // same names before it sends a link): a link recorded before is named below, and none goes out after
  const leave = newRecordId();
  let linking: readonly string[] | undefined;
  await options.accountStore.updateMany(["session", "leaving", "linking"], (current) => {
    if (current.session === undefined || !sameSignIn(current.session, session)) return current;
    linking = Object.values(current.linking ?? {});
    return { ...current, leaving: { ...current.leaving, [leave]: key.public_spki } };
  });
  if (linking === undefined) throw new SignedOutError();
  const unconfirmed: string[] = [];
  try {
    const pcs = (await service.listPcs()).map((pc) => pc.server_id);
    for (let start = 0; start < pcs.length; start += 32) await service.postRecord(pcs.slice(start, start + 32), remove);
    // only pairings on PCs the remove went to are forgotten: one on a PC the account does not list (or of another account) still works there
    const listed = new Set(pcs);
    const forgotten = new Set<string>();
    for (const device of await options.relayStore.list()) {
      const accountKeyed = device.public_spki === key.public_spki || device.pending_key?.public_spki === key.public_spki;
      if (!accountKeyed) continue;
      // reached only where the PC confirmed this pairing is a member of this account, and the remove went to it
      if (listed.has(device.server_id) && device.account === session.account) { await options.relayStore.remove(device.server_id); forgotten.add(device.server_id); }
      else unconfirmed.push(device.server_id);
    }
    // a link already on its way may still land on its PC, whatever the pairing says now
    for (const serverId of new Set(linking)) if (!forgotten.has(serverId) && !unconfirmed.includes(serverId)) unconfirmed.push(serverId);
  } catch (error) {
    // nothing was left: links with this key go out again
    await options.accountStore.update("leaving", (current) => {
      const { [leave]: _failed, ...rest } = current ?? {};
      return Object.keys(rest).length > 0 ? rest : undefined;
    });
    throw error;
  }
  // the removes are queued: the sign-in ends here whatever the service answers to the sign-out
  try { await service.signOut(); }
  catch (error) { console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error); }
  // the account's PCs tombstone this key: never sign in with it again (a kept pairing holds its own copy of the key)
  // unsent blocks stay: only the service's answer takes one away (S32-1)
  await options.accountStore.clear((current) => !sameSignIn(current, session), { unsent: () => true });
  return { remove, unconfirmed };
}

/**
 * Disconnects another device of the account from every PC of it (a lost phone): a `remove` for
 * its account key, signed by this device's. A PC applies it only when this device is one of its
 * members, so it goes to the PCs this device is linked on, first through the account service and
 * then at once on the PC this window is in (`here`); the account's other PCs are named back as not
 * reached, for another member to disconnect it there.
 */
export async function removeFromAccount(options: {
  service: AccountService; accountStore: AccountStore; relayStore: RelayDeviceStore; key: string; account: string; here?: PcFetch; hereId?: string; now?: () => number;
}): Promise<LeaveResult> {
  const session = await options.service.session();
  if (session === undefined) throw new Error("Sign in first, so every PC of the account hears of it");
  // the row shown belongs to the account signed in here, or nothing is signed for it
  if (session.account !== options.account) throw new Error("That device belongs to another account");
  const own = await options.accountStore.key();
  if (options.key === own.public_spki) throw new TypeError("This device leaves the account with leaveAccount");
  const remove: RemoveRecord = await signAccountRecord({
    v: 1, kind: "remove", account: session.account, key: options.key,
    issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: own.public_spki,
  }, own.private_key);
  // kept before it is sent: a PC this device brings into the account later tombstones the key, and never gets an add for it
  await rememberDevice(options.accountStore, remove);
  // a PC applies the remove only where this device is a member: pairings that PC confirmed for this account
  const linked = new Set((await options.relayStore.list()).filter((device) => device.public_spki === own.public_spki && device.account === session.account).map((device) => device.server_id));
  if (options.here) {
    // the PC answers every record's outcome with 200: a refusal there is a failure here
    const answer = await (await post(options.here, "/api/account/records", { records: [remove] })).json() as { results?: { outcome?: string; code?: string }[] };
    const outcome = answer.results?.[0];
    if (outcome?.outcome === "refused") throw new Error(`This PC refused the removal (${outcome.code ?? "refused"})`);
  }
  const done = (id: string) => options.here !== undefined && id === options.hereId;
  const listed = (await options.service.listPcs()).map((pc) => pc.server_id);
  const reached = listed.filter((id) => linked.has(id) && !done(id));
  const failed: string[] = [];
  for (let start = 0; start < reached.length; start += 32) {
    const batch = reached.slice(start, start + 32);
    try { await options.service.postRecord(batch, remove); } catch { failed.push(...batch); }
  }
  // not reached: listed PCs this device is not a member of, linked PCs the account does not list, and failed posts
  const unconfirmed = [...listed.filter((id) => !linked.has(id)), ...[...linked].filter((id) => !listed.includes(id)), ...failed].filter((id) => !done(id));
  return { remove, unconfirmed, queued: reached.filter((id) => !failed.includes(id)) };
}
