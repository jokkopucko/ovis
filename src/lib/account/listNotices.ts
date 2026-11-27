/**
 * Which devices this device tells the person about (docs/account-list.md, "Putting a member out"): the devices
 * another member let into the account's signed list since this device last looked. A member's word is the entry it
 * signed, so the notice comes from this device's own copy, whatever PC let the device in.
 *
 * What this device has seen is kept per account in the page's storage: the place in the list it had looked up to,
 * and the devices whose notice the person closed since. On the first look nothing is told: whoever was in before this
 * device looked is no news.
 */
import { listView, type ListState } from "../../../shared/account-list.ts";

export interface NoticesSeen {
  readonly list: string;
  /** The member key that looked: a device that signs in again with a new key looks for the first time. */
  readonly member: string;
  /** The place in the list this device had looked up to: a device let in at or before it is no news. */
  readonly floor: number;
  /** The devices let in after `floor` whose notice the person closed. */
  readonly closed: readonly string[];
}

/** A device another member let in: its key, the place of its entry and the key that signed it. */
export interface ListNewcomer {
  readonly key: string;
  readonly seq: number;
  readonly by: string | null;
}

/**
 * The devices that are in and that another member let in since `seen`, in the order they came in. None on the first
 * look (`seen` null). A device that handed its place to a new key of its own (the entry that let the key in ended the
 * key that signed it) is the same device, and no news.
 */
export function listNewcomers(state: ListState, self: string, seen: NoticesSeen | null): ListNewcomer[] {
  if (seen === null || seen.list !== state.list || seen.member !== self) return [];
  const handedOver = (seq: number, by: string | null): boolean => by !== null && state.signers[by]?.ended === seq;
  return listView(state).devices
    .filter((row) => row.ended === null && !row.carried && row.key !== self && row.by !== self && row.seq > seen.floor && !seen.closed.includes(row.key) && !handedOver(row.seq, row.by))
    .map((row) => ({ key: row.key, seq: row.seq, by: row.by }));
}

/**
 * What is seen once the person closed `key`'s notice: with every notice shown closed, the floor moves up to the last
 * of them. A notice closed earlier and no longer shown stays closed: it may stand above that floor.
 */
export function closeNotice(seen: NoticesSeen, shown: readonly ListNewcomer[], key: string): NoticesSeen {
  const closed = [...new Set([...seen.closed, key])];
  if (!shown.every((newcomer) => closed.includes(newcomer.key))) return { ...seen, closed };
  const drawn = new Set(shown.map((newcomer) => newcomer.key));
  return { list: seen.list, member: seen.member, floor: Math.max(seen.floor, ...shown.map((newcomer) => newcomer.seq)), closed: closed.filter((each) => !drawn.has(each)) };
}

const STORAGE = "ovis-list-device-notices";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE) ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch { return {}; }
}

/** What this page's storage holds as seen for `account`'s list `list` by the member key `member`; null for nothing, or a record of another list or member. */
export function readNoticesSeen(account: string, list: string, member: string): NoticesSeen | null {
  const value = readAll()[account];
  if (!isRecord(value) || value.list !== list || value.member !== member || typeof value.floor !== "number" || !Number.isSafeInteger(value.floor) || value.floor < 0
    || !Array.isArray(value.closed) || !value.closed.every((key): key is string => typeof key === "string")) return null;
  return { list, member, floor: value.floor, closed: value.closed };
}

export function writeNoticesSeen(account: string, seen: NoticesSeen): void {
  try { globalThis.localStorage?.setItem(STORAGE, JSON.stringify({ ...readAll(), [account]: seen })); }
  catch (error) { console.warn("Ovis: what the device notices showed was not kept", error instanceof Error ? error.name : error); }
}

/**
 * Closes `key`'s notice against what the storage holds now, not what a page read when it drew: another tab's close
 * made meanwhile stays. With no record of that list and member, nothing is written.
 */
export function closeStoredNotice(account: string, list: string, member: string, shown: readonly ListNewcomer[], key: string): void {
  const now = readNoticesSeen(account, list, member);
  if (now !== null) writeNoticesSeen(account, closeNotice(now, shown, key));
}
