/**
 * The account's order as this PC's whole reads saw it (Step 2, S2-24, P21): each key's number in the account, and whether
 * it was late, that is first seen in a whole read with a number not above the highest number seen before. A late key
 * was inserted into the account's order behind keys this PC already knew, so it is not trusted as older than them: it
 * lifts no block (T52) and ends no hold (T53). Written in the commit turn of a whole read. A file that cannot be read
 * leaves every key late and is never overwritten here, so a damaged table grants nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { accountDeviceId } from "../../shared/account-records.ts";

export const ACCOUNT_ORDER_FILE = "account-order.json";

interface OrderEntry {
  readonly no: number | null;
  readonly late: boolean;
  /** Unknown for a local-only key or a pin from before membership was recorded. */
  readonly removed: boolean | null;
  readonly joined: number | null;
  /** The binding whose latest whole read listed the key; a pin carried from another binding places nothing there. */
  readonly listed_in?: string;
}
interface OrderDoc {
  readonly v: 1;
  readonly account: string | null;
  readonly bind_id?: string;
  readonly server_id?: string;
  readonly last_version?: number;
  readonly methods_version?: number;
  readonly max_no: number;
  readonly keys: Readonly<Record<string, OrderEntry>>;
}

/** What a whole read lists, as the order needs it. */
export interface OrderedRead {
  readonly server_id: string;
  readonly version: number;
  readonly account: string;
  readonly devices: readonly { readonly key: string; readonly no: number }[];
  readonly removed: readonly { readonly key: string; readonly no: number }[];
}

const EMPTY: OrderDoc = { v: 1, account: null, max_no: 0, keys: {} };

export class OrderConflict extends Error {
  constructor(readonly key: string) { super("Snapshot changes a pinned account number"); }
}

export type LiftOrder = Pick<AccountOrder, "late" | "registered" | "no" | "listedOn">;

function parse(value: unknown): OrderDoc | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Partial<OrderDoc>;
  if (doc.v !== 1 || !(doc.account === null || typeof doc.account === "string") || doc.max_no === undefined || !Number.isSafeInteger(doc.max_no) || doc.max_no < 0 || typeof doc.keys !== "object" || doc.keys === null) return null;
  if (doc.last_version !== undefined || doc.bind_id !== undefined || doc.server_id !== undefined) {
    if (typeof doc.bind_id !== "string" || typeof doc.server_id !== "string" || typeof doc.last_version !== "number" || !Number.isSafeInteger(doc.last_version) || doc.last_version < 1) return null;
  }
  if (doc.methods_version !== undefined && (!Number.isSafeInteger(doc.methods_version) || doc.methods_version < 0)) return null;
  const keys: Record<string, OrderEntry> = {};
  for (const [key, entry] of Object.entries(doc.keys)) {
    if (!entry || (entry.no !== null && (!Number.isSafeInteger(entry.no) || entry.no > doc.max_no)) || typeof entry.late !== "boolean") return null;
    if (entry.removed != null && typeof entry.removed !== "boolean") return null;
    if (entry.joined != null && (!Number.isSafeInteger(entry.joined) || entry.joined < 0)) return null;
    if (entry.listed_in !== undefined && typeof entry.listed_in !== "string") return null;
    keys[key] = { ...entry, removed: entry.removed ?? null, joined: entry.joined ?? null };
  }
  return { ...doc as OrderDoc, keys };
}

export class AccountOrder {
  private constructor(private readonly path: string, private doc: OrderDoc, readonly problem: string | null) {}

  static open(stateDir: string): AccountOrder {
    const path = join(stateDir, ACCOUNT_ORDER_FILE);
    if (!existsSync(path)) return new AccountOrder(path, EMPTY, null);
    let doc: OrderDoc | null = null;
    try { doc = parse(JSON.parse(readFileSync(path, "utf8"))); } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error)) throw error;
    }
    return doc === null ? new AccountOrder(path, EMPTY, `${path} cannot be read: every key counts as late until it is restored`) : new AccountOrder(path, doc, null);
  }

  /** Whether \`key\` was first seen late in the account's order; every key while the table is damaged. */
  late(key: string): boolean {
    return this.problem !== null || (this.doc.keys[key]?.late ?? false);
  }

  /** The key's number in the account's order as this PC saw it, null for a key no whole read listed. */
  no(key: string): number | null {
    return this.doc.keys[key]?.no ?? null;
  }

  /** Whether a whole read for binding `bindId` itself listed `key`, as a device or a removal. */
  listedOn(key: string, bindId: string): boolean {
    return this.problem === null && this.doc.keys[key]?.listed_in === bindId;
  }

  registered(key: string, account: string): boolean {
    return this.doc.account === account && this.doc.keys[key]?.removed === false;
  }

  /** A local admission can precede the key's first listing, or even the PC's first binding. */
  recordJoins(rows: readonly { relay_public_key?: string; origin?: { admit_no: number } }[]): void {
    if (this.problem !== null) return;
    const additions: Record<string, OrderEntry> = {};
    for (const { relay_public_key: key, origin } of rows) {
      if (key === undefined || origin === undefined || this.doc.keys[key]?.joined != null) continue;
      const joined = Math.min(origin.admit_no, additions[key]?.joined ?? origin.admit_no);
      additions[key] = { ...(this.doc.keys[key] ?? { no: null, late: false, removed: null }), joined };
    }
    if (Object.keys(additions).length === 0) return;
    const next = { ...this.doc, keys: { ...this.doc.keys, ...additions } };
    writePrivateState(this.path, next);
    this.doc = next;
  }

  /** A rowless AUTH names the deterministic account device id, not a public key supplied by its caller. */
  relayKey(serverId: string, deviceId: string): string | undefined {
    return Object.keys(this.doc.keys).find((key) => accountDeviceId(serverId, key) === deviceId);
  }

  lastVersion(bindId: string | undefined, serverId: string | null): number | null {
    return this.doc.bind_id === bindId && this.doc.server_id === serverId ? this.doc.last_version ?? null : null;
  }

  methodsVersion(): number | null { return this.doc.methods_version ?? null; }

  /** Remember only a version whose notice the journal successfully appended. */
  recordMethod(version: number): void {
    const next = { ...this.doc, methods_version: version };
    writePrivateState(this.path, next);
    this.doc = next;
  }

  /** The commit turn of a whole read: new keys enter, marked late when their number is not above the highest seen. */
  record(read: OrderedRead, bindId: string): void {
    this.prepare(read, bindId)();
  }

  /** A read-only view for authority checks, using exactly the pins the commit will publish. */
  preview(read: OrderedRead, bindId: string | undefined): LiftOrder {
    return new AccountOrder(this.path, this.project(read, bindId), null);
  }

  private project(read: OrderedRead, bindId: string | undefined): OrderDoc {
    if (this.problem !== null) throw new Error(this.problem);
    const base = this.doc.account === read.account ? this.doc : { ...EMPTY, account: read.account };
    const keys: Record<string, OrderEntry> = { ...base.keys };
    // Admission numbers belong to this directory. Account numbers never cross a binding to another account.
    if (base !== this.doc) for (const [key, { joined }] of Object.entries(this.doc.keys)) {
      if (joined !== null) keys[key] = { no: null, late: false, removed: null, joined };
    }
    let max = base.max_no;
    for (const [list, removed] of [[read.devices, false], [read.removed, true]] as const) for (const { key, no } of list) {
      const pinned = keys[key];
      if (pinned?.no != null && pinned.no !== no) throw new OrderConflict(key);
      keys[key] = { no, late: pinned?.no == null ? no <= base.max_no : pinned.late,
        removed: removed || pinned?.removed === true, joined: pinned?.joined ?? null, ...(bindId === undefined ? {} : { listed_in: bindId }) };
      max = Math.max(max, no);
    }
    return { ...base, max_no: max, keys };
  }

  /** Validate before any widening. Publishing the watermark returns its undo for a refused lift batch. */
  prepare(read: OrderedRead, bindId: string): () => () => void {
    const next: OrderDoc = { ...this.project(read, bindId), bind_id: bindId, server_id: read.server_id, last_version: read.version };
    return () => {
      const previous = this.doc;
      writePrivateState(this.path, next);
      this.doc = next;
      return () => {
        writePrivateState(this.path, previous);
        this.doc = previous;
      };
    };
  }
}
