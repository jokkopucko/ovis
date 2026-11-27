/**
 * The keys of a PC a move carried in as an endpoint with no key (docs/account-list.md, "An account that was in use";
 * Part F, F8): such a PC follows the list and lets its devices in, and it allows nobody until a `pc` entry gives it its
 * keys. A member that did something itself for that PC (addedItself, by its own record: it paired with it at the PC,
 * pressed Add for it, added it over SSH, joined it by its own invite, or is its own window) signs that entry with no
 * question, with the card the PC hands it over their end-to-end session (`POST /api/account/list/card`). Never on the
 * directory's word, and never because the PC says which list it follows: any other member leaves it to the number at
 * the PC.
 */
import { addedItself } from "../../../shared/account-list-migrate.ts";
import { cardHolds, isListKey, type ListNames } from "../../../shared/account-list.ts";
import { isListHash } from "../../../shared/account-list-entry.ts";
import { hexToBytes } from "@noble/hashes/utils.js";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList } from "./accountList.ts";
import { addPostedPc } from "./listAdd.ts";
import { pcHowOf, type PcFetch } from "./listMigrate.ts";
import type { WriteRefusal } from "./listWrite.ts";
import type { SeenPcs } from "./seenPcs.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const CARD_CHARS = 86;

/**
 * What came of it: `added` (this device's own copy holds the PC by its card); `not_needed` (the list holds no keyless
 * carried PC at that relay key); `no_evidence` (this device did nothing itself for it); `no_card` (the PC handed no card
 * that holds, for this list and this very relay key); or why the write did not go (listWrite.ts, listAdd.ts).
 */
export type CarriedKeys = "added" | "not_needed" | "no_evidence" | "no_card" | WriteRefusal | "admit" | "invite_ended";

export async function keysForCarriedPc(given: {
  readonly list: AccountList; readonly fetch: PcFetch; readonly account: string; readonly endpoint: string; readonly record: SeenPcs; readonly names: ListNames | null;
}): Promise<CarriedKeys> {
  const { list, endpoint } = given;
  const writer = list.writer();
  if (writer === null || writer.account !== given.account) return "blocked";
  const row = writer.state.pcs[endpoint];
  if (row === undefined || row.how !== "carried" || row.removed !== null || row.key !== null) return "not_needed";
  if (!addedItself({ how: pcHowOf(given.record.pcs[endpoint]) })) return "no_evidence";
  let card: unknown;
  try {
    // the PC posts this very card for the list in the same call, so the account service takes the entry right after
    const answer = await given.fetch("/api/account/list/card", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: "{}" });
    card = answer.ok ? await answer.json() : null;
  } catch {
    return "no_card";
  }
  if (!isRecord(card) || card.endpoint !== endpoint || card.list !== writer.list || typeof card.list !== "string" || !isListHash(card.list)) return "no_card";
  const { key, enc } = card;
  if (typeof key !== "string" || !isListKey(key) || typeof enc !== "string" || !isListKey(enc) || typeof card.card !== "string" || card.card.length !== CARD_CHARS) return "no_card";
  // the PC's own signature over its keys, this list and the relay key this very session is bound to
  if (!await cardHolds({ key, enc, list: writer.list, endpoint, invite: null }, card.card)) return "no_card";
  const outcome = await addPostedPc(list, { list: writer.list, endpoint, server_id: deriveServerId(hexToBytes(endpoint)), key, enc, card: card.card }, given.names, {
    // the account lets a carried PC in already: nothing is admitted for it
    admit: async () => {},
    member: writer.keys.key,
    expect: { account: writer.account, list: writer.list, key: writer.keys.key },
  });
  return outcome.added ? "added" : outcome.why;
}
