/**
 * Merging this PC's account state with a sibling state folder at start (T48), before anything is served, with
 * OVIS_ACCOUNT_OPENS_ALL on. Each file by its own rule, and none by time:
 * - `account-pc.json` is read with its sibling by `PcAccountState.takeSibling` (P12), not merged here.
 * - `account-removed.json` (P13): markers by (key, account) with the union of their removals by id (one id in both is
 *   one record, whose `over` is the union of its copies); Revokes and their unrevokes as a union by id.
 * - the enrollment barrier stands when either folder has one, and the held keys are a union (S13, T48).
 * - the signed records waiting to apply (`account-pending.json`) are a union by record id (T41).
 * A file that cannot be read in either folder is reported, and the PC fails closed (S19).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { isAccountKeyEncoding } from "../../shared/account-records.ts";
import { parseEvidence, REMOVAL_FILE, RemovalEvidence, type Marker, type Removal } from "./removal-evidence.ts";

const ENROLLING_FILE = "account-enrolling.json";
const HELD_FILE = "account-held.json";
const PENDING_FILE = "account-pending.json";

type Read = { value: Record<string, unknown> } | "missing";

function read(dir: string, file: string): Read {
  const path = join(dir, file);
  if (!existsSync(path)) return "missing";
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`);
  return { value: value as Record<string, unknown> };
}

const byId = <T extends { id: string }>(lists: readonly (readonly T[])[]): T[] => [...new Map(lists.flat().map((item) => [item.id, item])).values()];

export function mergedRemovalEvidence(docs: readonly NonNullable<ReturnType<typeof parseEvidence>>[]): NonNullable<ReturnType<typeof parseEvidence>> {
  const markers = new Map<string, Marker>();
  for (const marker of docs.flatMap((doc) => doc.markers)) {
    const at = JSON.stringify([marker.key, marker.account]);
    const kept = markers.get(at);
    if (kept === undefined) { markers.set(at, marker); continue; }
    const removals = new Map<string, Removal>(kept.removals.map((removal) => [removal.id, removal]));
    for (const removal of marker.removals) {
      const same = removals.get(removal.id);
      removals.set(removal.id, same === undefined ? removal : { ...same, over: [...new Set([...same.over, ...removal.over])] });
    }
    markers.set(at, { ...kept, removals: [...removals.values()] });
  }
  return { v: 1, markers: [...markers.values()], revokes: byId(docs.map((doc) => doc.revokes)), unrevokes: byId(docs.map((doc) => doc.unrevokes)) };
}

function mergeEvidence(active: string, sibling: string): void {
  // each folder's evidence by the evidence reader's own verdict: what it refuses (writable by others, missing beside a
  // journal, unreadable) is refused here too, and the PC fails closed (T28, S19)
  for (const dir of [active, sibling]) {
    const refused = RemovalEvidence.open(dir, null).strict;
    if (refused !== null) throw new Error(refused);
  }
  const docs = [read(active, REMOVAL_FILE), read(sibling, REMOVAL_FILE)].flatMap(doc => {
    if (doc === "missing") return [];
    const parsed = parseEvidence(doc.value);
    if (parsed === null) throw new Error(`${REMOVAL_FILE} is not this PC's removal evidence`);
    return [parsed];
  });
  if (docs.length < 2) {
    if (docs.length === 1) for (const dir of [active, sibling]) if (!existsSync(join(dir, REMOVAL_FILE))) {
      const { row_drops: _local, ...shared } = docs[0] ?? {};
      writePrivateState(join(dir, REMOVAL_FILE), shared);
    }
    return;
  }
  const merged = mergedRemovalEvidence(docs);
  // Each folder numbers its own admissions and journal: a sibling's receipt cannot acknowledge this folder's drop.
  for (const [index, dir] of [active, sibling].entries()) writePrivateState(join(dir, REMOVAL_FILE), { ...merged, row_drops: docs[index]?.row_drops });
}

function mergeHolds(active: string, sibling: string): void {
  const [ownBarrier, otherBarrier] = [read(active, ENROLLING_FILE), read(sibling, ENROLLING_FILE)];
  if (ownBarrier === "missing" && otherBarrier !== "missing") writePrivateState(join(active, ENROLLING_FILE), otherBarrier.value);
  if (otherBarrier === "missing" && ownBarrier !== "missing") writePrivateState(join(sibling, ENROLLING_FILE), ownBarrier.value);
  const held = [read(active, HELD_FILE), read(sibling, HELD_FILE)].flatMap((doc) => doc === "missing" ? [] : [doc.value]);
  // a held list that is not one holds every key until repaired: refused here, never merged into holding nobody (S19)
  if (held.some((doc) => !Array.isArray(doc.keys) || !doc.keys.every(isAccountKeyEncoding) || typeof doc.full !== "boolean")) throw new Error(`${HELD_FILE} is not a list of held keys`);
  if (held.length === 0) return;
  const merged = { keys: [...new Set(held.flatMap((doc) => doc.keys as string[]))], full: held.some((doc) => doc.full === true) };
  for (const dir of [active, sibling]) writePrivateState(join(dir, HELD_FILE), merged);
}

/** The union of waiting records by id (T41, T48), checked before either folder is written. */
function mergePending(active: string, sibling: string): unknown[] | null {
  const lists = [active, sibling].flatMap((dir) => {
    const path = join(dir, PENDING_FILE);
    if (!existsSync(path)) return [];
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error(`${path} is not a list of waiting records`);
    return [value as unknown[]];
  });
  if (lists.length === 0) return null;
  const merged = new Map<string, unknown>();
  for (const record of lists.flat()) {
    const id = typeof record === "object" && record !== null && "id" in record && typeof record.id === "string" ? record.id : null;
    const key = id === null ? `json:${JSON.stringify(record)}` : `id:${id}`;
    if (id !== null && merged.has(key) && !Bun.deepEquals(merged.get(key), record, true)) {
      throw new TypeError(`${PENDING_FILE} contains conflicting records with the same id`);
    }
    merged.set(key, record);
  }
  return [...merged.values()];
}

/** Merges the account state of `sibling` into `active` and back; why it could not, or null. */
export function mergeAccountState(active: string, sibling: string): string | null {
  try {
    const pending = mergePending(active, sibling);
    mergeEvidence(active, sibling);
    mergeHolds(active, sibling);
    if (pending !== null) for (const dir of [active, sibling]) writePrivateState(join(dir, PENDING_FILE), pending);
    return null;
  } catch (error) {
    return `Cannot merge the account state of ${sibling} into ${active} (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is restored.`;
  }
}
