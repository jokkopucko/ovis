/**
 * What scripts/account-list-gossip-browser-qa.ts runs inside a real browser: a device of an account's signed list, with
 * the stores and the keys the app uses there (IndexedDB, WebCrypto), that signs in to a real PC through the relay with
 * the key its list holds for it and compares the list with that PC over the session (src/lib/account/listGossip.ts).
 */
import { signedOn, writeToList } from "../src/lib/account/listWrite.ts";
import { accountDevice, withAccountDevice } from "../src/lib/account/accountDevice.ts";
import { accountList, type AccountListView, type ListOffer } from "../src/lib/account/accountList.ts";
import { allowDevice, type AllowOutcome, type Newcomer } from "../src/lib/account/listAllow.ts";
import { keepListGossip } from "../src/lib/account/listGossip.ts";
import { deviceListKeys } from "../src/lib/account/listKeys.ts";
import { AccountService } from "../src/lib/account/service.ts";
import { indexedAccountStore, newKey, type AccountSession } from "../src/lib/account/store.ts";
import type { RelayDevice, ShellDeviceStore } from "../src/lib/relay/device.ts";
import { openRelayTransport, type RelayTransport } from "../src/lib/relay/transport.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";

const service = new AccountService({ store: indexedAccountStore });
// the first device of this account starts its list although the account lists PCs already (they came in before it)
const list = accountList({ service, accountStore: indexedAccountStore, names: () => ({ label: "QA browser", os: "linux" }), genesis: () => "always", durable: async () => true });

/** Stores a sign-in as the app does after one, with the key that sign-in registers with the account service; answers that key. */
export async function signIn(session: AccountSession): Promise<string> {
  const key = await newKey();
  await indexedAccountStore.set("session", session);
  await indexedAccountStore.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id ?? "", key, no: null });
  return key.public_spki;
}

/** The account service took the sign-in's key at this place in the account's order. */
export async function registered(no: number): Promise<void> {
  await indexedAccountStore.update("signin_key", (kept) => kept === undefined ? kept : { ...kept, no });
}

export function sync(): Promise<AccountListView> {
  return list.sync();
}

/** This device's member key: the one a member lets in, and the one it signs in to a pinned PC with. */
export async function memberKey(): Promise<string> {
  return (await deviceListKeys(indexedAccountStore)).key;
}

/** This device lets another in: the `device` entry is signed with the member key IndexedDB holds. */
export function allow(newcomer: Newcomer): Promise<AllowOutcome> {
  return allowDevice(list, newcomer);
}

/** This device takes the place the member that let it in handed it. */
export function adopt(offer: ListOffer): Promise<AccountListView> {
  return list.adopt(offer);
}

/** This device adds a PC that posted its keys and its card (no name sealed). True once its own copy holds the entry. */
export async function addPostedPc(pc: { readonly endpoint: string; readonly key: string; readonly enc: string; readonly card: string }): Promise<boolean> {
  const outcome = await writeToList(list, async (writer) => ({ request: await signedOn(writer, [{ kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card: pc.card, sealed: null }]) }), { wait: async () => {} });
  return outcome.written;
}

/** This device puts the device with `key` out of the list. True once its own copy holds the removal. */
export async function remove(key: string): Promise<boolean> {
  const outcome = await writeToList(list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), { wait: async () => {} });
  return outcome.written;
}

/** A store of this one PC's row only: the account's row of this device, under the key its list holds for it. */
function rowStore(device: RelayDevice): ShellDeviceStore {
  const none: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async (_id, change) => change(undefined) };
  return { ...none, ...withAccountDevice(none, device) };
}

/** A session with the PC of `offer`, signed in by the key the account's list holds for this device. */
async function session(offer: RelayOffer): Promise<RelayTransport> {
  const key = await indexedAccountStore.key();
  return openRelayTransport(offer, { store: rowStore(accountDevice(offer, { private_key: key.private_key, public_spki: key.public_spki })), accountListKey: true });
}

/** Whether that PC lets this device in now: its role, or the refusal's code. */
export async function opens(offer: RelayOffer): Promise<string> {
  try {
    const opened = await session(offer);
    const role = opened.followsList ? "in" : "in, by no list";
    opened.close();
    return role;
  } catch (error) {
    return typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : error instanceof Error ? error.name : "failed";
  }
}

let open: { readonly transport: RelayTransport; readonly stop: () => void } | null = null;

/**
 * Opens a session with that PC and keeps the list compared over it, as the shell does for the session it owns (it
 * starts at once, and again whenever this device's copy moves). Answers whether the PC selected the list.
 */
export async function meet(offer: RelayOffer): Promise<boolean> {
  leave();
  const transport = await session(offer);
  open = { transport, stop: keepListGossip(transport, { list: () => list, pc: offer.server_id }) };
  return transport.followsList;
}

/** Ends the session `meet` opened. */
export function leave(): void {
  open?.stop();
  open?.transport.close();
  open = null;
}
