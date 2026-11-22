/**
 * One whole read of the account's snapshot (Step 2, rows G1, G13, T15, T52, T58, T60). Every page must carry the
 * first page's snapshot id, version and methods version, for this PC's account and relay identity, in order, and the
 * last page says it is the last. The snapshot's blocks only narrow, so each applies as it is read and stands whatever
 * happens to the read. Everything that widens (lifts, the list itself) is staged and committed only when the whole read
 * validated, in one turn with no wait inside, and only while `gen` moved by nothing but this read's own denials.
 */
import { OrderConflict } from "./account-order.ts";
import type { BlockRecord, DeviceLiftRecord } from "../../shared/account-records.ts";
import { AccountSnapshotError, assembleSnapshot, parseSnapshotPage, SNAPSHOT_GONE, type AccountSnapshot, type AccountSnapshotPage } from "../../shared/account-snapshot.ts";

/** One page of the snapshot as the service sent it. */
export type PageAnswer = { readonly page: unknown } | { readonly snapshot_gone: true };

/** What a read is judged under: noted when it starts and asked again in the commit turn. */
export interface ReadScope {
  readonly account: string;
  readonly serverId: string;
  readonly gen: number;
  readonly lock: string | null;
}

export interface StagedRead {
  readonly snapshot: AccountSnapshot;
  readonly lifts: readonly DeviceLiftRecord[];
}

export interface SnapshotPorts {
  /** The binding, relay identity, `gen` and lock now; null for a PC in no account. */
  scope(): ReadScope | null;
  /** The version of the last snapshot this PC applied, null for none. */
  lastVersion(): number | null;
  /** The ids of the blocks this PC's safety log holds: a freeze line may name one the snapshot no longer carries. */
  knownBlocks(): ReadonlySet<string>;
  /** Applies a block of the snapshot now, through this PC's verified path; true when it raised `gen`. */
  deny(block: BlockRecord): Promise<boolean>;
  /**
   * This PC's own authority for a lift the service took (DeviceStore.liftAuthority): its signature holds and its signer
   * is older here than the blocked key and not removed. Asked before the commit turn; a change it relied on raises gen.
   */
  liftAuthority(lift: DeviceLiftRecord, snapshot: AccountSnapshot): Promise<boolean>;
  /** Synchronous: journal, files and memory in one turn. Returns the number of lifts still authorized. */
  commit(stage: StagedRead): number;
  /** List admissions follow the safety writes and staged signed adds in the same synchronous turn. */
  commitList?(snapshot: AccountSnapshot): void;
  /** An explicit service opt-out for this read's binding, not a whole read. */
  step2Off?(): void;
  methodsVersion(): number | null;
  journalMethod(version: number): void;
  requestRead(): void;
}

export class SnapshotWriteRefused extends Error {}

export type ReadRefusal = "unbound" | typeof SNAPSHOT_GONE | "mixed_snapshot" | "scope_mismatch" | "stale" | "malformed" | "incomplete" | "page_failed" | "scope_changed" | "generation_changed" | "commit_failed";

export type ReadOutcome =
  | { readonly committed: true; readonly snapshot: string; readonly denials: number; readonly liftsRefused: number }
  | { readonly committed: false; readonly reason: ReadRefusal; readonly denials: number };

export const SNAPSHOT_MAX_PAGES = 20;

export async function readSnapshot(
  fetchPage: (cursor: { snapshot: string | null; page: number }) => Promise<PageAnswer>,
  ports: SnapshotPorts,
  maxPages = SNAPSHOT_MAX_PAGES,
): Promise<ReadOutcome> {
  const noted = ports.scope();
  let denials = 0;
  let raised = 0;
  const refused = (reason: ReadRefusal): ReadOutcome => ({ committed: false, reason, denials });
  if (noted === null) return refused("unbound");

  const pages: AccountSnapshotPage[] = [];
  for (let index = 0; ; index++) {
    if (index === maxPages) return refused("incomplete");
    let answer: PageAnswer;
    try { answer = await fetchPage({ snapshot: pages[0]?.snapshot ?? null, page: index }); } catch { return refused("page_failed"); }
    if ("snapshot_gone" in answer) return refused(SNAPSHOT_GONE);
    let page: AccountSnapshotPage;
    try { page = parseSnapshotPage(answer.page); } catch (error) {
      if (error instanceof AccountSnapshotError) return refused("malformed");
      throw error;
    }
    if (page.account !== noted.account || page.server_id !== noted.serverId) return refused("scope_mismatch");
    const first = pages[0];
    if (first === undefined) {
      const last = ports.lastVersion();
      if (last !== null && page.version < last) return refused("stale");
    } else if (page.snapshot !== first.snapshot || page.version !== first.version || page.methods_version !== first.methods_version) {
      return refused("mixed_snapshot");
    }
    if (page.page !== index) return refused("malformed");
    pages.push(page);
    for (const block of page.blocks) {
      denials++;
      if (await ports.deny(block)) raised++;
    }
    if (page.last) break;
  }

  let snapshot: AccountSnapshot;
  try { snapshot = assembleSnapshot(pages, { account: noted.account, server_id: noted.serverId, lastApplied: ports.lastVersion(), knownBlocks: ports.knownBlocks() }); } catch (error) {
    if (error instanceof AccountSnapshotError) return refused("malformed");
    throw error;
  }

  const authorized: DeviceLiftRecord[] = [];
  const removed = new Set(snapshot.removed.map((row) => row.key));
  for (const lift of snapshot.lifts) if (!removed.has(lift.signer) && await ports.liftAuthority(lift, snapshot)) authorized.push(lift);

  // the commit turn: nothing below awaits, so no denial can land between these checks and the write
  const now = ports.scope();
  if (now === null || now.account !== noted.account || now.serverId !== noted.serverId || now.lock !== noted.lock) return refused("scope_changed");
  if (now.gen !== noted.gen + raised) return refused("generation_changed");
  const last = ports.lastVersion();
  if (last !== null && snapshot.version < last) return refused("stale");
  let committedLifts: number;
  try { committedLifts = ports.commit({ snapshot, lifts: authorized }); } catch (error) {
    if (error instanceof OrderConflict) return refused("malformed");
    if (error instanceof SnapshotWriteRefused) return refused("commit_failed");
    throw error;
  }
  if (ports.methodsVersion() !== snapshot.methods_version) ports.journalMethod(snapshot.methods_version);
  // Publishing list access also renews freshness; no durable operation may follow it.
  ports.commitList?.(snapshot);
  return { committed: true, snapshot: snapshot.snapshot, denials, liftsRefused: snapshot.lifts.length - committedLifts };
}
