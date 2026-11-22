/**
 * The PC's own account state (P12, OD1): `account-pc.json` `{v, next_admit, binding, clears, first, others_ever}`.
 * The PC's account is this file's binding, not "some row names an account": the first link binds it in the turn that
 * writes its row (T13, T59), the last member leaving changes nothing (T30), and only Revoke all, a relay identity
 * reset or a person at the PC clears it. A clear is kept in `clears`, which is never cut, and the file is never deleted.
 * `next_admit` numbers the admissions on this PC (P22, server/account/admission-order.ts).
 *
 * Fails closed (S19): a file that cannot be read, that is missing beside a device journal, or rows of two accounts at
 * the one-time migration (T50). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { ADMISSION_FILE, type OriginFrom, type OriginHow, type RowOrigin } from "./admission-order.ts";
import { DEVICE_JOURNAL_FILE } from "./safety-log.ts";

/** `unlisted`: a PC bound on the account service's word that the account stopped listing (one press, docs/account.md) */
export type ClearReason = "revoke_all" | "identity_reset" | "unlisted";
// A receipt written by an older version still invalidates its bind_id; new clears cannot emit that reason.
export interface AccountClear { readonly bind_id: string; readonly reason: ClearReason | "left_on_pc"; readonly by: string }
export interface AccountBinding {
  readonly account: string;
  readonly bind_id: string;
  /** a first link's binding, on disk before its row: it stands only once the row is (T13) */
  readonly pending?: true;
  /** bound in one press, on the account service's word for the account this PC's owner named; no row made it */
  readonly service?: true;
}

interface ServiceStep2 {
  readonly bind_id: string;
  readonly revision: number;
  readonly off: boolean;
}

interface PcDoc {
  v: 1;
  next_admit: number;
  binding: AccountBinding | null;
  clears: AccountClear[];
  /** the first-device fact (T67): the key of the row whose link bound the PC; `list_key` only when a link proved it */
  first: { key: string; list_key: string | null } | null;
  /** set by the first admission of another account row and never unset (H2) */
  others_ever: boolean;
  /** P14: raised by every denial and policy change; a decision that widens commits only at the gen it noted */
  gen: number;
  /** the removal evidence was on disk once: its file missing since is damage, never a fresh start (S19) */
  evidence_written?: true;
  /** A listed PC's explicit service opt-out cannot be undone by a named recovery release. */
  service_step2?: ServiceStep2;
}

const REASONS: ReadonlySet<string> = new Set(["revoke_all", "identity_reset", "left_on_pc", "unlisted"]);
const ID = /^[0-9a-f]{32}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

function parseDoc(value: unknown): (PcDoc & { counterOnly?: true }) | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not this PC's account state";
  const doc = value as Partial<PcDoc>;
  if (doc.v !== 1) return "unknown version";
  if (!Number.isSafeInteger(doc.next_admit) || doc.next_admit! < 1) return "invalid next_admit";
  // S2-03 wrote the counter alone: the binding is not migrated yet, and the upgrade takes it from the rows (T50)
  if (doc.binding === undefined && doc.clears === undefined && doc.first === undefined && doc.others_ever === undefined) {
    return { v: 1, next_admit: doc.next_admit!, binding: null, clears: [], first: null, others_ever: false, gen: 0, counterOnly: true };
  }
  const binding = doc.binding;
  if (binding !== null && !(typeof binding === "object" && binding !== undefined && typeof binding.account === "string" && ACCOUNT.test(binding.account) && typeof binding.bind_id === "string" && ID.test(binding.bind_id) && (binding.pending === undefined || binding.pending === true) && (binding.service === undefined || (binding.service === true && binding.pending === undefined)))) return "invalid binding";
  if (!Array.isArray(doc.clears) || !doc.clears.every((clear) => typeof clear === "object" && clear !== null && typeof clear.bind_id === "string" && ID.test(clear.bind_id) && REASONS.has(clear.reason) && typeof clear.by === "string")) return "invalid clears";
  if (binding !== null && doc.clears.some((clear) => clear.bind_id === binding.bind_id)) return "a cleared binding stands";
  const first = doc.first;
  if (first !== null && !(typeof first === "object" && first !== undefined && typeof first.key === "string" && (first.list_key === null || typeof first.list_key === "string"))) return "invalid first";
  if (typeof doc.others_ever !== "boolean") return "invalid others_ever";
  if (doc.evidence_written !== undefined && doc.evidence_written !== true) return "invalid evidence_written";
  const step2 = doc.service_step2;
  if (step2 !== undefined && (step2 === null || typeof step2 !== "object" || typeof step2.bind_id !== "string"
    || !ID.test(step2.bind_id) || !Number.isSafeInteger(step2.revision) || step2.revision < 0 || typeof step2.off !== "boolean")) return "invalid service_step2";
  if (doc.gen === undefined) return { ...doc, gen: 0 } as PcDoc;
  if (!Number.isSafeInteger(doc.gen) || doc.gen < 0) return "invalid gen";
  return doc as PcDoc;
}

function serviceStep2(doc: PcDoc, binding: AccountBinding | null): ServiceStep2 | undefined {
  return binding !== null && doc.service_step2?.bind_id === binding.bind_id ? doc.service_step2 : undefined;
}

/** A folder by what it is on disk, so a link to it and its real path are one folder (P21). */
function realFolder(stateDir: string): string {
  try { return realpathSync(stateDir); } catch { return resolve(stateDir); }
}

/** The one handle of each folder's account state in this process (P21). */
const HANDLES = new Map<string, PcAccountState>();

export class PcAccountState {
  private readonly bindingListeners = new Set<() => void>();

  onBindingChange(listener: () => void): () => void {
    this.bindingListeners.add(listener);
    return () => { this.bindingListeners.delete(listener); };
  }
  private doc: PcDoc = { v: 1, next_admit: 1, binding: null, clears: [], first: null, others_ever: false, gen: 0 };
  private problem: string | null = null;
  /** no file and no journal: this folder's rows predate the release, and are migrated once (T50) */
  private fresh = false;

  private constructor(private readonly path: string) {}

  /**
   * The one handle of `stateDir`'s account state in this process, read again from disk: no two handles of one folder
   * give numbers (P21), whatever path names it.
   */
  static open(stateDir: string): PcAccountState {
    const path = join(realFolder(stateDir), ADMISSION_FILE);
    const state = HANDLES.get(path) ?? new PcAccountState(path);
    HANDLES.set(path, state);
    state.doc = { v: 1, next_admit: 1, binding: null, clears: [], first: null, others_ever: false, gen: 0 };
    state.problem = null;
    state.fresh = false;
    state.upgradingFrom = false;
    state.siblingBinding = null;
    let text: string;
    try { text = readFileSync(state.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") state.problem = `Cannot read ${state.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(stateDir, DEVICE_JOURNAL_FILE))) state.problem = `${state.path} is missing beside the device journal`;
      else state.fresh = true;
      return state;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { state.problem = `${state.path} is not JSON`; return state; }
    const parsed = parseDoc(value);
    if (typeof parsed === "string") state.problem = `${state.path} cannot be trusted: ${parsed}`;
    else {
      const { counterOnly, ...doc } = parsed;
      state.upgradingFrom = counterOnly === true;
      state.doc = doc;
    }
    return state;
  }

  /**
   * This folder's own rows as they are on disk before a sibling merge can remove any (P21, S29): a missing file beside
   * a row it numbered, or one at or behind such a number, is damage. Run before the merge.
   */
  checkRows(rows: readonly { readonly origin?: RowOrigin | undefined }[]): void {
    const numbers = rows.flatMap((row) => row.origin === undefined || row.origin.from === "legacy" ? [] : [row.origin.admit_no]);
    if (numbers.length === 0) return;
    if (this.fresh) this.missingBeside();
    else this.checkAbove(numbers);
  }

  /**
   * A first link's binding left pending by a stop (T13): it stands when its row reached the disk, and bound nothing
   * when it did not.
   */
  settlePending(rowOnDisk: (binding: AccountBinding, firstKey: string | null) => boolean): void {
    const binding = this.doc.binding;
    if (binding?.pending !== true || this.problem !== null) return;
    const { pending: _left, ...standing } = binding;
    this.write(rowOnDisk(standing, this.doc.first?.key ?? null) ? { ...this.doc, binding: standing } : { ...this.doc, binding: null, first: null });
  }

  /** Member rows of an account this PC is not in: the binding and the rows disagree, which is damage (P12, S19). */
  checkMembers(accounts: readonly string[]): void {
    const bound = this.doc.binding?.account ?? null;
    const other = accounts.find((account) => account !== bound);
    if (this.problem === null && other !== undefined) this.problem = `this PC's devices name ${other}, and ${this.path} binds it to ${bound ?? "no account"}`;
  }

  /** A row numbered at or past the next number: the file is behind its rows, which is damage (P21). */
  checkAbove(numbers: readonly number[]): void {
    const highest = Math.max(0, ...numbers);
    if (this.problem === null && highest >= this.doc.next_admit) this.problem = `${this.path} is behind the number ${highest} a row here carries`;
  }

  /** The one-time migration could not be written: this PC's account state is unknown, so it fails closed (S19). */
  /** `what` could not be written to this file: the PC's account state is unknown until it is (S19). */
  unwritten(error: unknown, what = "The rows from before the upgrade could not be migrated"): void {
    if (this.problem !== null) return;
    this.fresh = false;
    this.problem = `${what} in ${this.path} (${error instanceof Error ? error.message : String(error)})`;
  }

  /** A folder whose rows already carry numbers lost this file: damage, not a migration (P21, S19). */
  missingBeside(): void {
    this.fresh = false;
    this.problem = `${this.path} is missing beside rows this PC numbered`;
  }

  /** Why this PC fails closed, or null: no device gets in while its account state cannot be known. */
  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the account state is restored.`;
  }

  get migrating(): boolean { return (this.fresh || this.upgrading) && this.problem === null; }

  /** S2-03's counter file, read: the rows are numbered already, and only the binding is migrated (T50). */
  get upgrading(): boolean { return this.upgradingFrom && this.problem === null; }
  private upgradingFrom = false;

  /** A standing binding of the sibling folder, taken by this folder's migration (P12). */
  private siblingBinding: AccountBinding | null = null;

  /**
   * The sibling folder's account file, read before this folder's binding is trusted (P12, T59): a bind_id either folder
   * lists among its clears never stands, and two standing bindings to different accounts fail closed. The clears of
   * both are kept here; the count stays this folder's own. A file that cannot be read fails closed (S19).
   */
  takeSibling(siblingDir: string): void {
    if (this.problem !== null) return;
    const path = join(realFolder(siblingDir), ADMISSION_FILE);
    let parsed: ReturnType<typeof parseDoc>;
    try { parsed = parseDoc(JSON.parse(readFileSync(path, "utf8"))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.problem = `${path} cannot be read (${error instanceof Error ? error.message : String(error)})`;
      return;
    }
    if (typeof parsed === "string") { this.problem = `${path} cannot be trusted: ${parsed}`; return; }
    const clears = [...new Map([...this.doc.clears, ...parsed.clears].map((clear) => [clear.bind_id, clear])).values()];
    const standing = (binding: AccountBinding | null) => binding !== null && binding.pending !== true && !clears.some((clear) => clear.bind_id === binding.bind_id) ? binding : null;
    const own = standing(this.doc.binding);
    const theirs = standing(parsed.binding);
    if (own !== null && theirs !== null && own.account !== theirs.account) { this.problem = `${this.path} and ${path} bind this PC to two accounts`; return; }
    this.siblingBinding = theirs;
    const doc = { ...this.doc, binding: own, clears, others_ever: this.doc.others_ever || parsed.others_ever };
    const sharedStep2 = (binding: AccountBinding | null) => {
      const mine = serviceStep2(this.doc, binding);
      const other = serviceStep2(parsed, binding);
      // A reconciliation supersedes the off decision it observed. An independent concurrent off wins a tie.
      if (mine === undefined || (other !== undefined && (other.revision > mine.revision
        || (other.revision === mine.revision && other.off)))) return other;
      return mine;
    };
    const activeBinding = own ?? theirs;
    const activeStep2 = sharedStep2(activeBinding);
    if (activeStep2) doc.service_step2 = activeStep2;
    // Both folders keep the clears and the service opt-out for the binding they hold.
    const siblingStep2 = sharedStep2(theirs);
    if (parsed.clears.length !== clears.length || (siblingStep2 && JSON.stringify(siblingStep2) !== JSON.stringify(parsed.service_step2))) {
      const siblingDoc: PcDoc = { ...parsed, clears, binding: standing(parsed.binding) ?? (parsed.binding?.pending === true && !clears.some((clear) => clear.bind_id === parsed.binding!.bind_id) ? parsed.binding : null) };
      if (siblingStep2) siblingDoc.service_step2 = siblingStep2;
      try { writePrivateState(path, siblingDoc); } catch (error) {
        this.problem = `${path} cannot learn this PC's account denials (${error instanceof Error ? error.message : String(error)})`;
        return;
      }
    }
    if (this.fresh) { this.doc = doc; return; }
    // a folder in no account beside one that is: the PC is in that account (P12)
    if (own === null && theirs !== null) { doc.binding = theirs; doc.first = this.doc.first ?? parsed.first; }
    if (JSON.stringify(doc) !== JSON.stringify(this.doc)) this.write(doc);
  }

  /**
   * The migration's check, before any row is touched: the rows' accounts. Rows of two accounts name no binding to
   * take, so the PC fails closed and nothing is written (T50).
   */
  migrationAccount(rows: readonly { account?: string | undefined }[]): string | null {
    const accounts = new Set(rows.flatMap((row) => row.account === undefined ? [] : [row.account]));
    if (accounts.size > 1) this.problem = `${this.path} is missing and this PC's devices name ${accounts.size} accounts`;
    return accounts.size === 1 ? [...accounts][0]! : null;
  }

  /** Ends the migration, once: a PC with rows has had other devices, so it never takes the first-device path (T67). */
  migrate(account: string | null, hadRows: boolean): void {
    if (!this.migrating) return;
    const sibling = this.siblingBinding;
    if (sibling !== null && account !== null && sibling.account !== account) { this.problem = `${this.path}: this PC's devices name ${account}, its other folder ${sibling.account}`; return; }
    const binding = sibling ?? (account === null ? null : { account, bind_id: randomBytes(16).toString("hex") });
    this.write({ ...this.doc, binding, others_ever: this.doc.others_ever || hadRows });
    this.fresh = false;
    this.upgradingFrom = false;
  }

  account(): string | null { return this.doc.binding?.account ?? null; }

  binding(): AccountBinding | null { return this.doc.binding; }

  clears(): readonly AccountClear[] { return this.doc.clears; }

  gen(): number { return this.doc.gen; }

  /** All admissions already numbered here are strictly below this boundary, even with the PC clock set back. */
  nextAdmission(): number { return this.doc.next_admit; }

  /** A denial or a policy change reached the disk (P14): a decision that noted the old gen does not commit. */
  /** Whether this PC's removal evidence was on disk once (S19). */
  evidenceWritten(): boolean { return this.doc.evidence_written === true; }

  /** The removal evidence is on disk: from now on its file missing is damage (S19). Written once. */
  noteEvidenceWritten(): void {
    if (this.doc.evidence_written === true || this.problem !== null || this.fresh) return;
    this.write({ ...this.doc, evidence_written: true });
  }

  raiseGen(): void { this.write({ ...this.doc, gen: this.doc.gen + 1 }); }

  /** The first-device fact (T67): the key that bound the PC, and its proved sign-in key or null. */
  first(): { readonly key: string; readonly list_key: string | null } | null { return this.doc.first; }

  othersEver(): boolean { return this.doc.others_ever; }

  /** The first admission of another account row sets it; nothing unsets it (H2). */
  setOthersEver(): void {
    if (!this.doc.others_ever) this.write({ ...this.doc, others_ever: true });
  }

  /** The first link binds the PC; returns what takes this write back, should the row it belongs to not be written. */
  bind(account: string, key: string): { commit: () => void; takeBack: () => void } {
    if (this.doc.binding !== null) throw new Error("This PC is already in an account");
    const { first, others_ever } = this.doc;
    const binding = { account, bind_id: randomBytes(16).toString("hex") };
    this.write({ ...this.doc, binding: { ...binding, pending: true }, first: { key, list_key: null }, others_ever: others_ever || this.doc.clears.length > 0 });
    return {
      // the row is on disk: the binding stands from here, whatever fails after (T13)
      commit: () => this.write({ ...this.doc, binding }),
      // only the binding goes back; the count this turn took stays taken (P21)
      takeBack: () => this.write({ ...this.doc, binding: null, first, others_ever }),
    };
  }


  /**
   * One press binds a PC in no account on the account service's word for `account`, the one its owner named here: no row
   * is written with it, so it stands at once, and no device is its first (T67).
   */
  bindByService(account: string): void {
    if (this.doc.binding !== null) throw new Error("This PC is already in an account");
    this.write({ ...this.doc, binding: { account, bind_id: randomBytes(16).toString("hex"), service: true }, first: null, others_ever: this.doc.others_ever || this.doc.clears.length > 0 });
  }

  /** The PC leaves its account: only for one of the named reasons. The clear is kept, and the file stays. */
  clear(reason: ClearReason, by: string): boolean {
    const binding = this.doc.binding;
    // a PC already strict writes nothing: what it was told to clear waits for its repair, and it serves nobody meanwhile
    if (binding === null || this.problem !== null) return false;
    this.write({ ...this.doc, binding: null, clears: [...this.doc.clears, { bind_id: binding.bind_id, reason, by }], gen: this.doc.gen + 1 });
    return true;
  }

  /** The origin of a row being admitted now; its number is on disk before the row is, so none is ever used twice. */
  admit(from: OriginFrom, how: OriginHow, by: string | null, now: number): RowOrigin {
    // nothing is numbered before the one-time migration has run (T50): it decides where the count starts
    if (this.fresh) throw new Error(`${this.path}: the rows from before the upgrade are not migrated yet`);
    const admitNo = this.doc.next_admit;
    this.write({ ...this.doc, next_admit: admitNo + 1 });
    return { from, how, by, admit_no: admitNo, at: new Date(now).toISOString() };
  }

  serviceStep2Off(): boolean {
    return serviceStep2(this.doc, this.binding())?.off === true;
  }

  setServiceStep2Off(off: boolean): boolean {
    const binding = this.binding();
    if (binding === null) return false;
    const prior = serviceStep2(this.doc, binding);
    if ((prior?.off ?? false) === off) return false;
    const revision = (prior?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("The service's Step 2 revision is exhausted");
    try { this.write({ ...this.doc, service_step2: { bind_id: binding.bind_id, revision, off } }); }
    catch (error) {
      this.unwritten(error, "The service's Step 2 status could not be saved");
      throw error;
    }
    return true;
  }

  private write(doc: PcDoc): void {
    if (this.problem !== null) throw new Error(this.strict!);
    // The provisional first-link write and its rollback both represent no committed binding.
    const committedId = (binding: AccountBinding | null) => binding?.pending ? undefined : binding?.bind_id;
    const before = committedId(this.doc.binding);
    writePrivateState(this.path, doc);
    this.doc = doc;
    if (before !== committedId(doc.binding)) for (const listener of this.bindingListeners) listener();
  }
}
