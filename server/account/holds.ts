/**
 * What holds account `add`s back on this PC (docs/account.md, "Enrolling a PC"): the barrier a PC
 * keeps from its first link until the member that linked it hands over the account's devices, and
 * the keys that member could not let in (removed somewhere it checked). Both are on disk, so a stop
 * lifts neither, and a file that will not parse holds every add back until it is restored.
 */
import { readFileSync, rmSync } from "node:fs";
import { isAccountKeyEncoding } from "../../shared/account-records.ts";
import { writePrivateState } from "../private-state.ts";

/** Keys held at most; past them every add is held back, as a full list could be missing the one that matters. */
export const ACCOUNT_HELD_MAX = 4096;

function readJson(path: string | undefined): { value: unknown } | null | "missing" {
  if (!path) return "missing";
  try { return { value: JSON.parse(readFileSync(path, "utf8")) as unknown }; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
}

export class AccountHolds {
  /** Why the holds could not be read: every add waits until it is fixed. */
  readonly error: string | null = null;
  private enrollingBy: string | null = null;
  /** the barrier names a device whose link succeeded: no later link takes it over */
  private confirmed = false;
  private keys = new Set<string>();
  private overflowed = false;

  constructor(private readonly options: { enrollingPath?: string; heldPath?: string } = {}) {
    const enrolling = readJson(options.enrollingPath);
    const held = readJson(options.heldPath);
    // each file is read whatever the other holds, so fixing one never writes over the other
    const problems: string[] = [];
    if (held === null) problems.push(`${options.heldPath} cannot be read`);
    else if (held !== "missing") {
      const value = held.value as { keys?: unknown; full?: unknown } | null;
      if (!Array.isArray(value?.keys) || !value.keys.every(isAccountKeyEncoding) || typeof value.full !== "boolean") problems.push(`${options.heldPath} is not a list of held keys`);
      else { this.keys = new Set(value.keys); this.overflowed = value.full; }
    }
    if (enrolling === null) problems.push(`${options.enrollingPath} cannot be read`);
    else if (enrolling !== "missing") {
      const by = (enrolling.value as { by?: unknown } | null)?.by;
      if (typeof by !== "string") problems.push(`${options.enrollingPath} is not an enrollment barrier`);
      else { this.enrollingBy = by; this.confirmed = (enrolling.value as { confirmed?: unknown }).confirmed === true; }
    }
    if (problems.length > 0) this.error = `${problems.join("; ")}: account adds wait until it is restored or removed.`;
  }

  /**
   * A link while the PC has no account. `stale`: the PC has no account (its first member left before
   * enrolling it), so a barrier an earlier link confirmed is taken over.
   */
  startEnrolling(by: string, options: { stale?: boolean } = {}): void {
    this.assertReadable();
    if (options.stale) this.confirmed = false;
    if (this.confirmed) return;
    if (this.options.enrollingPath) writePrivateState(this.options.enrollingPath, { by });
    this.enrollingBy = by;
  }

  /**
   * The barrier of a link whose device waited to link (docs/account.md, "Who may admit a device"). Nothing of such a
   * device is written before its link has passed, so its barrier goes to disk in the turn that writes its row, right
   * before it. A barrier that stands and no link confirmed (another link's, on its way or refused) already holds
   * the adds back, and is left as it is. Returns what takes this call's write back, should the row not be written.
   */
  startEnrollingBeforeRow(by: string): () => void {
    if (this.enrollingBy !== null && !this.confirmed) return () => {};
    this.startEnrolling(by, { stale: true });
    return () => this.endEnrolling();
  }

  /** The link of `by` succeeded: it ends the wait, unless an earlier successful link already holds it. */
  confirmEnrolling(by: string): void {
    this.assertReadable();
    if (this.confirmed) return;
    if (this.options.enrollingPath) writePrivateState(this.options.enrollingPath, { by, confirmed: true });
    this.enrollingBy = by;
    this.confirmed = true;
  }

  /** A file that cannot be read is never written over: what it held would be lost. */
  private assertReadable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  endEnrolling(): void {
    this.assertReadable();
    if (this.options.enrollingPath) rmSync(this.options.enrollingPath, { force: true });
    this.enrollingBy = null;
    this.confirmed = false;
  }

  enrolling(): boolean { return this.enrollingBy !== null; }

  /** The member whose enrollment ends the wait: the one whose link brought the PC into the account. */
  enrollingMember(): string | null { return this.enrollingBy; }

  /** Keys an enrolling member found removed (or suspected) elsewhere: an add for one never applies here. */
  hold(keys: readonly string[]): void {
    this.assertReadable();
    const next = new Set(this.keys);
    for (const key of keys) next.add(key);
    const full = this.overflowed || next.size > ACCOUNT_HELD_MAX;
    const kept = full ? [...next].slice(0, ACCOUNT_HELD_MAX) : [...next];
    if (this.options.heldPath) writePrivateState(this.options.heldPath, { keys: kept, full });
    this.keys = new Set(kept);
    this.overflowed = full;
  }

  /** Waiting removes had to be dropped: every add is held back from now on, until the file is removed. */
  overflow(): void {
    this.assertReadable();
    if (this.options.heldPath) writePrivateState(this.options.heldPath, { keys: [...this.keys], full: true });
    this.overflowed = true;
  }

  /** Unreadable holds and named keys bar both paths; overflow alone bars signed adds, not list admissions (T17). */
  holds(key: string, source: "add" | "list" = "add"): boolean {
    return this.error !== null || this.keys.has(key) || (source === "add" && this.overflowed);
  }

  list(): string[] { return [...this.keys]; }

  /** Every add is held back: the list overflowed, or the holds cannot be read. */
  full(): boolean { return this.error !== null || this.overflowed; }
}
