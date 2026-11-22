/**
 * From an entry's `adds`, `power` and `ends` alone this file keeps who may sign; with the member's
 * level it tells what a member does with one entry; and it holds loose entries, the footing and
 * going back as a function over what the member holds and what it is shown.
 *
 * Every function here takes what a caller hands it once, when it is called: one reader for each
 * type (plainPlace, plainRow, plainRows, plainState, plainTexts, plainMember, plainAnswer,
 * plainHeld, and readSignersState for the saved state that a replay is told) reads each field
 * once, by the name its type gives it, into plain frozen data of this file's own, and a list of
 * bytes into a copy of it. From then on the function reads those copies alone. So nothing decides
 * twice: not what a caller's object says at a second reading, and not what it says once a
 * signature is being awaited. Nothing is taken by a spread, which takes an object's own
 * enumerable fields alone: a field may as well be inherited, or the object's own and not
 * enumerable.
 */
import {
  ListEntryError, entryFromText, entryHash, entryHolds, firstState, isListHash, isListKeyEncoding, readBody,
  type Entry, type EntryBody, type HeldEntry, type ListField, type ListRefusalCode, type SignerPower,
} from "./account-list-entry.ts";

/** Why an entry that holds is passed over: its signer is no signer then, or a field it carries is not lawful then. */
export type PassedOverCode = "signer_unknown" | "signer_not_allowed" | "key_reused" | "already_out";

export interface ListPlace {
  readonly seq: number;
  readonly hash: string;
}

/** A row is never deleted: a key that was ended stays, with the power it had. */
export interface SignerRow {
  readonly power: SignerPower;
  readonly seq: number;
  /**
   * That entry's signer: its own key for entry 0. Null where a later kind's proof made it a signer
   * (above level 1 only): the keys that entry 0 or an `adds` made signers are the rows whose `by` is
   * not null, and the signers' rule for `adds` turns on that.
   */
  readonly by: string | null;
  readonly ended: number | null;
}

/** From the member's store it comes only through readSignersState(value, level), never JSON.parse. */
export interface SignersState {
  readonly level: number;
  readonly list: string;
  readonly footing: ListPlace;
  /** What the list needs: the highest `v` among its entries that are not passed over and that a `full` signer signed. A kind lets a key in on a proof only at a level that the list already needs (KeyProof). */
  readonly needs: number;
  /**
   * The place of the entry from which the member is behind, or null: it is behind exactly when its
   * level is below `needs`. Behind, a member goes on only while it holds what a member that reads
   * everything holds, the same rows and the same footing. One entry alone can part the two: an
   * entry for which a kind may let a key in on a proof (KeyProof), which a member that is behind
   * cannot hear. There it stops, also when the proof lets nobody in, which it cannot tell, and it
   * takes no entry until it replays after an update. The stop is kept in the state (`needs_replay`).
   */
  readonly behind: number | null;
  /**
   * One row for each key that was made a signer, named by that key. A key is a signer while its
   * row's `ended` is null; the first signer is the row whose `seq` is 0. While the member is
   * stopped (`needs_replay`) the rows answer for nobody: signerPower says null for every key then.
   */
  readonly signers: { readonly [key: string]: SignerRow };
  /**
   * Only on a member that stopped for a replay (`behind`): the entry at which it stopped, by its
   * place and its hash; or, on a state that a higher level wrote and a lower build read, its footing
   * (readSignersState). While it is set the member takes no entry, judges none and places none to
   * sign, and its readers answer for nobody (signerPower is null, isBehind is true): an answer ends
   * for it with `needs_replay` again, whatever it shows. The stop is saved and read again with the
   * state, and every replay is told the saved state (replayEntries): a stopped member stays stopped
   * until it can read the entry it stopped at. A replay clears the stop only by taking that very
   * entry, which only a level that can judge it does. Another entry in that place is another
   * history: the member is stuck there, and the stop stays. A state has no such member otherwise.
   */
  readonly needs_replay?: ListPlace;
}

export interface ListMember {
  readonly entries: readonly string[];
  readonly state: SignersState;
}

/**
 * For a member of a higher level: what the kind of an entry it reads lets in on a proof of its own,
 * as the key and the power that kind names, or null. Level 1 defines no such kind, so a member of
 * level 1 passes none. A proof lets in the signer of its own entry only, and only a key that was
 * never made a signer in any way. So a proof may be asked for an entry of a level above 1 that the
 * list already needs (its `v` is above 1 and at most `needs`: a signer of power `full` has signed
 * an entry of that level before it), that carries no `adds` and no `ends`, and whose signer has no
 * row. A member that is not behind reads such an entry and is asked. It gets copies of its own to
 * read, of that entry, bytes and all, and of the state the entry is judged on: whatever it does to
 * them, then or later, changes nothing that the member holds. When it names that signer, the key
 * is a signer from the next entry on, and the entry is read and is part of the list for that
 * member; otherwise the entry is one whose signer is no signer: passed over, and loose. A member
 * that is behind cannot hear the proof, so it cannot tell which of the two the entry is: it stops
 * there (`needs_replay`). So no member goes on past an entry at which another may have let a key
 * in. A proof is that of the member's level, of the kinds its build reads: so a build acts for a
 * member only with a state of a level it reads. readSignersState reads a saved state of a higher
 * level stopped at its footing, so that no build acts on it with its own proofs; a replay by the
 * build's level, told that state, gives a state of that level, or no member.
 */
export type KeyProof = (entry: HeldEntry, state: SignersState) => { readonly key: string; readonly power: SignerPower } | null;

/** `behind` says that the member is behind there: its kind lets nobody new in, and a removal still applies. */
export type TakenOutcome =
  /** Nothing in it applies. It is loose when its signer is no signer for the member. */
  | { readonly outcome: "passed_over"; readonly code: PassedOverCode; readonly loose: boolean }
  /** Its `v` is above the member's level: `adds` and `ends` have applied, and its kind does nothing. */
  | { readonly outcome: "cannot_read"; readonly power: SignerPower; readonly behind: boolean }
  /** Its `v` is at most the member's level: `adds` and `ends` have applied, and its kind's rule reads it. `power` is null when it is read on a proof of its own. */
  | { readonly outcome: "reads"; readonly power: SignerPower | null; readonly behind: boolean };

export type StopsOutcome = { readonly outcome: "stops"; readonly code: "needs_replay" };

export interface TakenEntry {
  readonly held: HeldEntry;
  readonly outcome: TakenOutcome;
}

export interface ListStop {
  readonly seq: number;
  readonly code: ListRefusalCode | "needs_replay";
}

export interface ShownAnswer {
  /**
   * The place the entries follow: the place the caller asked after. It is the caller's own number,
   * never read from the answer: taken from the answer's first entry, it would let a service reach
   * the RangeError of shownEntries.
   */
  readonly after: number;
  readonly entries: readonly string[];
  readonly head: ListPlace;
}

export interface ShownResult {
  readonly member: ListMember;
  readonly dropped_from: number | null;
  readonly took: readonly TakenEntry[];
  readonly stopped: ListStop | null;
  readonly stuck: boolean;
  readonly asks_after: number | null;
}

export interface ReplayResult {
  /**
   * Null when there is no entry 0 or it does not hold. Null as well where the replay would give a
   * shorter history than the saved member's (replayEntries): it makes no member then, and the
   * caller keeps the one it has saved.
   */
  readonly member: ListMember | null;
  readonly took: readonly TakenEntry[];
  readonly stopped: ListStop | null;
  readonly stuck: boolean;
}

/** The row of a key that was ever made a signer, or null. Only a row of its own counts: what every object answers to is no row. */
function rowOf(signers: SignersState["signers"], key: string): SignerRow | null {
  return Object.hasOwn(signers, key) ? (signers[key] ?? null) : null;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isLevel = (value: unknown): value is number => isCount(value) && value >= 1;
function mustBeLevel(level: number): void {
  if (!isLevel(level)) throw new RangeError(`A level is a whole number from 1, not ${level}`);
}

const plainPlace = ({ seq, hash }: ListPlace): ListPlace => Object.freeze({ seq, hash });

const plainRow = ({ power, seq, by, ended }: SignerRow): SignerRow => Object.freeze({ power, seq, by, ended });

function plainRows(signers: SignersState["signers"]): SignersState["signers"] {
  const rows: (readonly [string, SignerRow])[] = [];
  for (const key of Object.getOwnPropertyNames(signers)) {
    const row = signers[key] ?? null;
    if (row !== null) rows.push([key, plainRow(row)]);
  }
  return Object.freeze(Object.fromEntries(rows));
}

function plainState(state: SignersState): SignersState {
  const { level, list, footing, needs, behind, signers, needs_replay } = state;
  mustBeLevel(level);
  const plain = { level, list, footing: plainPlace(footing), needs, behind, signers: plainRows(signers) };
  return needs_replay === undefined ? Object.freeze(plain) : stoppedAt(plain, needs_replay);
}

function stoppedAt({ level, list, footing, needs, behind, signers }: SignersState, { seq, hash }: ListPlace): SignersState {
  return Object.freeze({ level, list, footing, needs, behind, signers, needs_replay: Object.freeze({ seq, hash }) });
}

function plainTexts(texts: readonly string[]): readonly string[] {
  const { length } = texts;
  return Object.freeze(Array.from({ length }, (_, at) => texts[at] ?? ""));
}

function plainMember(member: ListMember): ListMember {
  const { entries, state } = member;
  return Object.freeze({ entries: plainTexts(entries), state: plainState(state) });
}

function plainAnswer(answer: ShownAnswer): ShownAnswer {
  const { after, entries, head } = answer;
  return Object.freeze({ after, entries: plainTexts(entries), head: plainPlace(head) });
}

function plainHeld(held: HeldEntry): HeldEntry {
  const { entry, body, hash, list } = held;
  const { body: bytes, signature } = entry;
  const { issued_at, kind, list: of, prev, seq, signer, v, adds, ends, own } = body;
  const { length } = own;
  const fields: ListField[] = [];
  for (let at = 0; at < length; at++) {
    const field = own[at];
    if (field === undefined) continue;
    const { name, value } = field;
    fields.push(Object.freeze({ name, value: new Uint8Array(value) }));
  }
  const plain: { -readonly [Name in keyof EntryBody]: EntryBody[Name] } = { issued_at, kind, list: of, prev, seq, signer, v, own: Object.freeze(fields) };
  if (adds !== undefined) {
    const { key, power } = adds;
    plain.adds = Object.freeze({ key, power });
  }
  if (ends !== undefined) plain.ends = ends;
  return Object.freeze({ entry: Object.freeze({ body: new Uint8Array(bytes), signature: new Uint8Array(signature) }), body: Object.freeze(plain), hash, list });
}

/**
 * The power of a key that is a signer in this state, or null. Null for every key while the member
 * is stopped (`needs_replay`): it was shown an entry that it could not judge, so it answers for
 * nobody until a replay has taken that entry.
 */
export function signerPower(state: SignersState, key: string): SignerPower | null {
  const { signers, needs_replay } = plainState(state);
  if (needs_replay !== undefined) return null;
  const row = rowOf(signers, key);
  return row !== null && row.ended === null ? row.power : null;
}

export function isBehind(state: SignersState): boolean {
  const { behind, needs_replay } = plainState(state);
  return behind !== null || needs_replay !== undefined;
}

function stateOfFirst({ body, hash }: HeldEntry, level: number): SignersState {
  const { signer, v } = body;
  return Object.freeze({ level, list: hash, footing: Object.freeze({ seq: 0, hash }), needs: v, behind: v > level ? 0 : null, signers: Object.freeze({ [signer]: Object.freeze({ power: "full", seq: 0, by: signer, ended: null }) }) });
}

/** The signers' rules: entry 0 makes its own signer the first signer, with power `full`; it is the footing at the least, and its `v` is the first that the list needs. A member that has a saved state is rebuilt by replayEntries, which is told that state, and not from this state. */
export function firstSignersState(first: HeldEntry, level: number): SignersState {
  const held = plainHeld(first);
  mustBeLevel(level);
  return stateOfFirst(held, level);
}

/** The signers' rules for `adds` and for `ends`, both judged on the state before the entry: the code of the first clause that is not lawful (for `adds`, then for `ends`; in each the signer's power, then the key), or null. */
function unlawful(power: SignerPower, signer: string, adds: EntryBody["adds"], added: SignerRow | null, ends: string | undefined, going: SignerRow | null): PassedOverCode | null {
  if (adds !== undefined) {
    if (power !== "full") return "signer_not_allowed";
    // A key that entry 0 or an `adds` made a signer is never added again, and neither is a key that was ended, also one that a proof let in: out is out.
    if (added !== null && (added.by !== null || added.ended !== null)) return "key_reused";
  }
  if (ends !== undefined) {
    if (power !== "full" && ends !== signer) return "signer_not_allowed";
    if (going === null || going.ended !== null) return "already_out";
  }
  return null;
}

interface Judged {
  readonly outcome: TakenOutcome | StopsOutcome;
  readonly loose: boolean;
  readonly needs: number;
  readonly behind: number | null;
  readonly rows: readonly (readonly [string, SignerRow])[];
}

const STOPS: StopsOutcome = Object.freeze({ outcome: "stops", code: "needs_replay" });

/**
 * What a member does with one entry that holds on this state's list, by the signers' rules. The
 * state and the entry are this file's own copies. It turns on no row but those the entry names
 * (its signer's, that of the key it adds, that of the key it ends), which it looks up before a
 * proof is asked, and it writes none. A proof may be asked for an entry of a level above 1 that
 * the list already needs, that carries no `adds` and no `ends`, and whose signer has no row: a
 * member that is not behind is asked, and one that is behind stops there. The proof is handed
 * copies of its own (plainHeld, plainState), and what it answers is read once.
 */
function judge(state: SignersState, held: HeldEntry, proof: KeyProof | undefined): Judged {
  const { adds, ends, seq, signer, v } = held.body;
  const { level, needs, behind, signers } = state;
  const own = rowOf(signers, signer);
  const added = adds === undefined ? null : rowOf(signers, adds.key);
  const going = ends === undefined ? null : rowOf(signers, ends);
  const power = own !== null && own.ended === null ? own.power : null;
  const reads = v <= level;
  if (power === null) {
    const passedOver: Judged = { outcome: { outcome: "passed_over", code: "signer_unknown", loose: true }, loose: true, needs, behind, rows: [] };
    // Nobody the member knows has vouched for it. A kind may yet let this entry's own signer in on a proof: a kind of a level above 1 that the list already needs, a key that has no row, an entry that carries no `adds` and no `ends`.
    if (own !== null || v <= 1 || v > needs || adds !== undefined || ends !== undefined) return passedOver;
    // Behind, the member cannot hear that proof, so it cannot tell whether the key came in here: it stops. No member goes on past such an entry without knowing.
    if (behind !== null) return { outcome: STOPS, loose: false, needs, behind, rows: [] };
    const asked = reads && proof !== undefined ? proof(plainHeld(held), plainState(state)) : null;
    if (asked === null) return passedOver;
    const { key, power: lets } = asked;
    if (key !== signer) return passedOver;
    return { outcome: { outcome: "reads", power: null, behind: false }, loose: false, needs, behind, rows: [[signer, Object.freeze({ power: lets, seq, by: null, ended: null })]] };
  }
  const code = unlawful(power, signer, adds, added, ends, going);
  if (code !== null) return { outcome: { outcome: "passed_over", code, loose: false }, loose: false, needs, behind, rows: [] };

  // `adds` and `ends` always apply, read or not: first the key that comes in, then the key that goes. One key in both goes with the row that the `adds` gave it.
  const rows: (readonly [string, SignerRow])[] = [];
  let comes: SignerRow | null = null;
  if (adds !== undefined) {
    comes = Object.freeze({ power: adds.power, seq, by: signer, ended: null });
    rows.push([adds.key, comes]);
  }
  if (ends !== undefined) {
    const goes = adds?.key === ends ? comes : going;
    if (goes !== null) rows.push([ends, Object.freeze({ power: goes.power, seq: goes.seq, by: goes.by, ended: seq })]);
  }
  const counts = power === "full";
  const behindAfter = behind ?? (counts && !reads ? seq : null);
  return {
    outcome: reads ? { outcome: "reads", power, behind: behind !== null } : { outcome: "cannot_read", power, behind: behindAfter !== null },
    loose: false,
    needs: counts && v > needs ? v : needs,
    behind: behindAfter,
    rows,
  };
}

function stateAfter(state: SignersState, held: HeldEntry, judged: Judged, signers: SignersState["signers"]): SignersState {
  const footing = judged.loose ? state.footing : Object.freeze({ seq: held.body.seq, hash: held.hash });
  return Object.freeze({ level: state.level, list: state.list, footing, needs: judged.needs, behind: judged.behind, signers });
}

/**
 * What a member does with one entry that holds on this state's list: whether it is passed over, and
 * if not, the signers after it and whether the member can read it. An entry that one of the signers
 * signed moves the footing, also when it is passed over for a field that is not lawful. It turns on
 * no row but those the entry names: its signer's, and those of the keys in `adds` and `ends`. A
 * member that is behind stops at an entry for which a proof may be asked (SignersState.behind):
 * the outcome is `stops`, and the state is as it was but for `needs_replay`, which holds the
 * entry's place and hash. On a state that holds one already, every entry is a `stops`. The state
 * and the entry are taken once (plainState, plainHeld), and the state it gives is made of those
 * copies. It changes nothing it was given. The entry is one that holds on this state's list, past
 * its footing: the caller says so, and an entry of another list, or one at or under the footing,
 * is its mistake, a RangeError.
 */
export function judgeEntry(state: SignersState, held: HeldEntry, proof?: KeyProof): { readonly outcome: TakenOutcome | StopsOutcome; readonly state: SignersState } {
  const given = plainState(state);
  const entry = plainHeld(held);
  if (entry.list !== given.list) throw new RangeError("The entry is of another list than the state");
  if (entry.body.seq <= given.footing.seq) throw new RangeError("The entry lies at or under the state's footing");
  if (given.needs_replay !== undefined) return { outcome: STOPS, state: given };
  const judged = judge(given, entry, proof);
  if (judged.outcome.outcome === "stops") return { outcome: judged.outcome, state: stoppedAt(given, { seq: entry.body.seq, hash: entry.hash }) };
  const signers = judged.rows.length === 0 ? given.signers : Object.freeze(Object.fromEntries([...Object.entries(given.signers), ...judged.rows]));
  return { outcome: judged.outcome, state: stateAfter(given, entry, judged, signers) };
}

/** No proof is handed it: a proof gets a copy of the state. */
type Rows = { [key: string]: SignerRow };

function takeEntry(state: SignersState, rows: Rows | null, held: HeldEntry, proof: KeyProof | undefined): { readonly state: SignersState; readonly rows: Rows | null; readonly outcome: TakenOutcome } | null {
  const judged = judge(state, held, proof);
  const { outcome } = judged;
  if (outcome.outcome === "stops") return null;
  let written = rows;
  if (judged.rows.length > 0) {
    written ??= Object.fromEntries(Object.entries(state.signers));
    // Each key is one of an entry that holds, so it is a key in form and never a name that an object has of itself.
    for (const [key, row] of judged.rows) written[key] = row;
  }
  return { state: stateAfter(state, held, judged, written ?? state.signers), rows: written, outcome };
}

function ownEntry(entries: readonly string[], seq: number, list: string): HeldEntry {
  const text = entries[seq];
  if (text === undefined) throw new RangeError(`The member holds no entry ${seq}`);
  const entry = entryFromText(text);
  return { entry, body: readBody(entry.body), hash: entryHash(entry.body), list };
}

export function listHead(member: ListMember): ListPlace {
  const { entries, state } = plainMember(member);
  const seq = entries.length - 1;
  return { seq, hash: ownEntry(entries, seq, state.list).hash };
}

function refusalOf(error: unknown): ListRefusalCode {
  if (error instanceof ListEntryError) return error.code;
  throw error;
}

type Fit =
  | { readonly fit: "holds"; readonly held: HeldEntry }
  | { readonly fit: "elsewhere" }
  | { readonly fit: "no"; readonly code: ListRefusalCode };

/** An entry that holds is made frozen data like every held entry here, with bytes of its own: it comes back to the caller and is read again for the entry after it, and a proof is handed another copy. */
async function fits(entry: Entry, before: HeldEntry): Promise<Fit> {
  let code: ListRefusalCode;
  try {
    return { fit: "holds", held: plainHeld(await entryHolds(entry, before)) };
  } catch (error) {
    code = refusalOf(error);
  }
  if (code !== "chain_broken") return { fit: "no", code };
  const { prev } = readBody(entry.body);
  if (prev === "" || prev === before.hash) return { fit: "no", code };
  try {
    await entryHolds(entry, { entry: before.entry, body: before.body, hash: prev, list: before.list });
    return { fit: "elsewhere" };
  } catch (error) {
    if (!(error instanceof ListEntryError)) throw error;
    return { fit: "no", code };
  }
}

/**
 * What a member does with one answer of the log, entry by entry. The caller asked for the
 * entries after a place the member holds: its head; its footing when it goes back; or, when the
 * log gives it the entries after a place in parts, the place where the part before ended.
 *
 * - An entry that is the same entry as its own at that place changes nothing.
 * - An entry past its head is taken as judgeEntry judges it, or stops it when it does not hold.
 * - It learns of another continuation when an entry does not continue the entry before it and that
 *   entry is loose (its head, or a loose entry before it), or when the answer's `head` lies past
 *   its footing and at or before its own head with another hash than its own entry there:
 *   `asks_after` then names its footing.
 * - Among the entries after its footing, at the first place where it is shown another entry that
 *   holds there, it drops its own entries from that place on and takes what it is shown.
 * - Another history under its footing stops it for good (`stuck`): an entry does not continue the
 *   entry before it, which stands at or under the footing, or `head` lies at or before the footing
 *   with another hash.
 *
 * The footing moves with each entry that the member takes, also inside one answer: an entry that
 * does not continue the footing is the first entry after it wherever it stands in an answer. The
 * answer's `head` is held against the member's head and footing when the answer arrives, and as
 * they stand after each entry that the member takes, and not after an entry that is the same as
 * its own: its own entries past that one may be those that the answer goes on to replace, as they
 * may be when an answer arrives that follows a place before its head. Once the head says one of
 * the two things above, the member takes no further entry of that answer. So what a member does
 * with an honest answer never depends on where it was cut, when it is shown the parts in order,
 * each after the place where the part before ended. The caller knows that place and no result
 * names it: a part that shows only entries the member holds changes nothing and asks nothing,
 * also when the log goes on past it with other entries than the member's own. A caller that asks
 * only after the member's head or its footing is then shown that part again each time, and never
 * comes to those entries.
 *
 * `asks_after` is the member's next request at its own pace: at most one such request follows an
 * answer at once and anything more waits for its next poll, which the caller must keep to since no
 * function here can count requests (without it a lying service makes a member send requests as
 * fast as it answers them).
 *
 * After an entry that does not hold, or an answer that breaks off, the member's head stands at the
 * last entry it took, and what it dropped stays dropped. A member's own entry comes into its copy
 * only here, when the log shows it at its place, never from the answer to its post.
 *
 * A member that is behind stops at an entry it cannot place (SignersState.behind): the answer
 * ends there for it with `needs_replay`, stuck. It takes neither that entry nor any after it. Its
 * own loose entries from that place on are dropped, as for any entry that holds there, so its
 * copy ends before the entry it stopped at. Its state keeps the stop, that entry's place and hash:
 * every later answer ends the same way, whatever it shows, until a replay takes that very entry.
 *
 * A place the member does not hold for the answer to follow, a state whose footing is not the
 * member's own entry at that place, or one whose level is no level, is the caller's mistake: a
 * RangeError, and nothing is judged.
 *
 * The member and the answer are taken once, when the answer arrives (plainMember, plainAnswer),
 * and nothing of either is read again. What comes back is built from those copies, so it is of
 * the member and of the answer as they were handed over, whatever the caller does to either
 * meanwhile or later, and whatever either says at a second reading.
 */
export async function shownEntries(member: ListMember, answer: ShownAnswer, proof?: KeyProof): Promise<ShownResult> {
  const given = plainMember(member);
  const { after, entries: shown, head } = plainAnswer(answer);
  const entries = Array.from(given.entries);
  let state = given.state;
  let rows: Rows | null = null;
  const { list } = state;
  const top = entries.length - 1;
  if (!Number.isInteger(after) || after < 0 || after > top) throw new RangeError(`The member holds no entry ${after} for the answer to follow`);
  if (ownEntry(entries, state.footing.seq, list).hash !== state.footing.hash) throw new RangeError(`The member's entry ${state.footing.seq} is not its footing: this state is not that of these entries`);
  const took: TakenEntry[] = [];
  let dropped: number | null = null;
  const done = (rest: Partial<Pick<ShownResult, "stopped" | "stuck" | "asks_after">> = {}): ShownResult => {
    if (rows !== null) Object.freeze(rows);
    return { member: { entries, state }, dropped_from: dropped, took, stopped: null, stuck: false, asks_after: null, ...rest };
  };
  const stops = (seq: number, code: ListRefusalCode) => done({ stopped: { seq, code } });
  const stuck = (seq: number) => done({ stopped: { seq, code: "chain_broken" }, stuck: true });
  if (state.needs_replay !== undefined) return done({ stopped: { seq: state.needs_replay.seq, code: "needs_replay" }, stuck: true });

  const headSeq = Number.isInteger(head.seq) && head.seq >= 0 ? head.seq : -1;
  let atHead = headSeq >= 0 && headSeq <= top ? ownEntry(entries, headSeq, list).hash : null;
  const byHead = (follows: number): ShownResult | null => {
    if (atHead === null || atHead === head.hash) return null;
    if (headSeq <= state.footing.seq) return stuck(headSeq);
    return follows === entries.length - 1 ? done({ asks_after: state.footing.seq }) : null;
  };

  let before = ownEntry(entries, after, list);
  let caught = byHead(after);
  for (const [index, text] of shown.entries()) {
    if (caught !== null) return caught;
    const seq = after + 1 + index;
    let entry: Entry;
    try {
      entry = entryFromText(text);
    } catch (error) {
      return stops(seq, refusalOf(error));
    }
    const own = seq < entries.length ? ownEntry(entries, seq, list) : null;
    if (own !== null && entryHash(entry.body) === own.hash) {
      before = own;
      continue;
    }
    const fit = await fits(entry, before);
    if (fit.fit === "no") return stops(seq, fit.code);
    if (fit.fit === "elsewhere") return seq - 1 <= state.footing.seq ? stuck(seq) : done({ asks_after: state.footing.seq });
    if (seq <= state.footing.seq) return stuck(seq);
    const taken = takeEntry(state, rows, fit.held, proof);
    if (own !== null) {
      entries.length = seq;
      dropped = seq;
    }
    if (taken === null) {
      state = stoppedAt(state, { seq, hash: fit.held.hash });
      return done({ stopped: { seq, code: "needs_replay" }, stuck: true });
    }
    state = taken.state;
    rows = taken.rows;
    entries.push(text);
    took.push({ held: fit.held, outcome: taken.outcome });
    before = fit.held;
    if (seq <= headSeq) atHead = seq === headSeq ? fit.held.hash : null;
    caught = byHead(seq);
  }
  return caught ?? done();
}

/**
 * A member's entries from entry 0, each taken by its level: how it starts, and how it replays every
 * entry it kept after an update. Given a list id, only the entry with that hash is entry 0.
 *
 * A replay is given every entry it has and has nobody to ask, so it never goes back: each entry
 * holds on the one before it (docs/account-list.md, "When an entry holds"), or the replay stops
 * there, with that entry's refusal. Its result either
 * took every entry it was given, or names where it stopped: at an entry that does not hold, or,
 * for a member that is behind, at an entry it cannot place (`needs_replay`).
 *
 * Every replay is told the member's saved state, as `saved`: the state its store holds, read by
 * readSignersState at the replay's level, or null for a first replay of a member that has none. A
 * saved state that a higher level wrote is so stopped at its footing, and a replay by this level
 * takes the member on only where it reaches that footing. It is not optional, so
 * that no caller forgets it. The replay never gives a shorter history than the saved member's, at
 * any level, stopped or not: it reaches the saved footing, taking the very entry there, and for a
 * stopped member the place before its stop. Where it would end before that, at an entry that
 * this level cannot place, as a level below the one that made the saved state may be unable to,
 * or at one that does not hold, it makes no member: `member` is null, `stopped` names the saved
 * member's stop, or else the entry it could not take, and the caller keeps the member it has
 * saved. Another entry at the saved footing is another history: no member either
 * (`chain_broken`).
 *
 * The saved stop stays in the state the replay gives unless the replay takes that very entry: the
 * entry in that place, with that hash, by a level that does not stop there again. So a replay of
 * the member's own entries leaves the member stopped, by any level, and the result says so:
 * `stopped` names that stop, and `stuck` is true. To go on, the member replays its own entries
 * together with the entry it stopped at, by a level that can judge it, and then asks the log as it
 * always does. Its caller keeps that entry's text for this: the log may have replaced the entry
 * since, if it was loose. Another entry in that place is another history than the one the member
 * was shown: the replay stops there (`chain_broken`), and the stop stays.
 *
 * Null as the saved state is the caller's word that the member has none. Told null, or an older
 * state than its last, for a member that has one, a replay may forget a stop the member holds,
 * and a level below the one that made it may give the member of a shorter history: the module
 * cannot tell. So a member whose saved state is lost, or does not read, is not replayed as a first
 * one.
 *
 * The entries, the list id, the proof and the saved state are taken once, when it is called. A
 * level that is no level, a saved state that is neither null nor one that readSignersState reads,
 * or entries that end before the saved member's history, are the caller's mistake: a RangeError.
 */
export async function replayEntries(entries: readonly string[], level: number, options: { readonly saved: SignersState | null; readonly given?: string; readonly proof?: KeyProof }): Promise<ReplayResult> {
  const texts = plainTexts(entries);
  const [text, ...rest] = texts;
  const { given, proof, saved: told } = options;
  mustBeLevel(level);
  const saved = toldSaved(told, level);
  const stop = saved?.needs_replay ?? null;
  const reach = saved === null ? -1 : Math.max(saved.footing.seq, stop === null ? 0 : stop.seq - 1);
  if (texts.length <= reach) throw new RangeError("The entries end before the saved member's history: they are not its own");
  if (text === undefined) return { member: null, took: [], stopped: null, stuck: false };
  const none = (stopped: ListStop): ReplayResult => ({ member: null, took: [], stopped, stuck: true });
  let before: HeldEntry;
  try {
    before = plainHeld((await firstState(entryFromText(text), given)).first);
  } catch (error) {
    const refused: ListStop = { seq: 0, code: refusalOf(error) };
    return saved === null ? { member: null, took: [], stopped: refused, stuck: false } : none(refused);
  }
  if (saved !== null && before.hash !== saved.list) return none({ seq: 0, code: "list_mismatch" });
  let state = stateOfFirst(before, level);
  let rows: Rows | null = null;
  const kept = [text];
  const took: TakenEntry[] = [{ held: before, outcome: before.body.v > level ? { outcome: "cannot_read", power: "full", behind: true } : { outcome: "reads", power: "full", behind: false } }];
  const replayed = (refused: ListStop | null): ReplayResult => {
    if (rows !== null) Object.freeze(rows);
    if (stop !== null && kept.length <= stop.seq) state = stoppedAt(state, stop);
    const at = state.needs_replay;
    return { member: { entries: kept, state }, took, stopped: refused ?? (at === undefined ? null : { seq: at.seq, code: "needs_replay" }), stuck: at !== undefined };
  };
  for (const [index, next] of rest.entries()) {
    const seq = index + 1;
    let held: HeldEntry;
    try {
      held = plainHeld(await entryHolds(entryFromText(next), before));
    } catch (error) {
      const refused: ListStop = { seq, code: refusalOf(error) };
      return seq <= reach ? none(refused) : replayed(refused);
    }
    if (saved !== null && seq === saved.footing.seq && held.hash !== saved.footing.hash) return none({ seq, code: "chain_broken" });
    if (stop !== null && seq === stop.seq && held.hash !== stop.hash) return replayed({ seq, code: "chain_broken" });
    const taken = takeEntry(state, rows, held, proof);
    if (taken === null) {
      if (seq <= reach) return none({ seq: stop === null ? seq : stop.seq, code: "needs_replay" });
      state = stoppedAt(state, { seq, hash: held.hash });
      return replayed(null);
    }
    state = taken.state;
    rows = taken.rows;
    kept.push(next);
    took.push({ held, outcome: taken.outcome });
    before = held;
  }
  return replayed(null);
}

/**
 * A member signs an entry only on its footing. The place its next entry takes, or null when the
 * head it is shown lies past its footing: it then places nothing, says so, and asks again. Null
 * as well when the head lies at or under its footing and is not the member's own entry at that
 * place, or names no place: that is another history under its footing, which an answer stops as
 * `stuck` (shownEntries), and the member signs nothing on top of it.
 */
export function signingPlace(member: ListMember, shown: ListPlace): { readonly list: string; readonly prev: string; readonly seq: number } | null {
  const { entries, state } = plainMember(member);
  const { seq, hash } = plainPlace(shown);
  const { footing, list } = state;
  if (state.needs_replay !== undefined) return null;
  if (!Number.isInteger(seq) || seq < 0 || seq > footing.seq || ownEntry(entries, seq, list).hash !== hash) return null;
  return { list, prev: footing.hash, seq: footing.seq + 1 };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readStop(value: unknown): ListPlace | null {
  if (!isRecord(value)) return null;
  const { seq, hash } = value;
  return isCount(seq) && typeof hash === "string" && isListHash(hash) ? Object.freeze({ seq, hash }) : null;
}

function toldSaved(told: SignersState | null, level: number): SignersState | null {
  if (told === null) return null;
  const saved = readSignersState(told, level);
  if (saved === null) throw new RangeError("A replay is told the member's saved state, or null for a first replay of a member that has none");
  return saved;
}

function readSignerRow(key: string, value: unknown, footing: number): SignerRow | null {
  if (!isListKeyEncoding(key) || !isRecord(value)) return null;
  const { power, seq, by, ended } = value;
  if (power !== "full" && power !== "bound") return null;
  if (!isCount(seq) || seq > footing) return null;
  if (by !== null && typeof by !== "string") return null;
  if (ended !== null && !(isCount(ended) && ended >= seq && ended <= footing)) return null;
  // Entry 0 made its own signer the first signer, with power `full`, and nothing else came in there.
  if (seq === 0 && (by !== key || power !== "full")) return null;
  return Object.freeze({ power, seq, by, ended });
}

/**
 * Whether a saved row's `by` can be what SignerRow says it is: the signer of the entry that made the
 * row's key a signer. Entry 0's is its own key, which readSignerRow holds it to. Null is a proof's,
 * so above level 1 only. Any other names a key that was a signer of power `full` at the row's
 * place: its row came in before that place with power `full`, and was not ended before it. Above
 * level 1 that key's row may also be a later one, or the row itself: a key that a proof made a
 * signer can be added, by another key or by itself, after it added this row's key, and its row is
 * then the one that `adds` gave it.
 */
function madeByItsSigner(rows: SignersState["signers"], row: SignerRow, level: number): boolean {
  if (row.seq === 0) return true;
  if (row.by === null) return level > 1;
  const signer = rowOf(rows, row.by);
  if (signer === null) return false;
  if (signer.seq < row.seq) return signer.power === "full" && (signer.ended === null || signer.ended >= row.seq);
  return level > 1 && signer.by !== null;
}

/**
 * A saved state, read again by a build of this level: the state when the value has its form and
 * agrees with itself, null for anything else. The value must come from the member's own store and
 * is as trusted as its private key: a caller that loads it from anywhere else must replay the
 * entries instead. It is the reader of a value of no known type: each field is read once, and the
 * state it gives is frozen. It takes every state that a function of this file gives from entries,
 * or from a state that it takes and an entry that holds on that state's list; and a level that it
 * takes, those functions take.
 *
 * A state that a higher level wrote is read back stopped: this build cannot judge by that level's
 * rules, nor run its proofs. Its stop is at its footing (`needs_replay` is the footing's place and
 * hash), unless it is stopped already, and then it keeps its stop. So this build takes nothing,
 * judges nothing, places nothing to sign and answers for no key through it, until a replay told
 * this state takes the entry at that place: by this build's level where it can reach it, which
 * gives a state of this level, or by the level that wrote it. A level that is no level is the
 * caller's mistake: a RangeError.
 */
export function readSignersState(value: unknown, level: number): SignersState | null {
  mustBeLevel(level);
  if (!isRecord(value)) return null;
  const { level: made, list, footing, needs, behind, signers, needs_replay } = value;
  if (!isLevel(made) || !isCount(needs) || needs < 1) return null;
  if (typeof list !== "string" || !isListHash(list)) return null;
  if (!isRecord(footing)) return null;
  const { seq, hash } = footing;
  if (!isCount(seq) || typeof hash !== "string" || !isListHash(hash)) return null;
  if (seq === 0 && hash !== list) return null;
  if (behind !== null && !(isCount(behind) && behind <= seq)) return null;
  if ((behind !== null) !== (needs > made)) return null;
  if (!isRecord(signers)) return null;
  const rows: { [key: string]: SignerRow } = {};
  for (const key of Object.getOwnPropertyNames(signers)) {
    const row = readSignerRow(key, signers[key], seq);
    if (row === null) return null;
    rows[key] = row;
  }
  const all = Object.values(rows);
  if (all.filter((row) => row.seq === 0).length !== 1) return null;
  // Each row's `by` is what SignerRow says it is (madeByItsSigner). So it is null or the key of a row: a key in form, and no name that every object answers to.
  if (!all.every((row) => madeByItsSigner(rows, row, made))) return null;
  const read = { level: made, list, footing: Object.freeze({ seq, hash }), needs, behind, signers: Object.freeze(rows) };
  let state: SignersState = Object.freeze(read);
  if (needs_replay !== undefined) {
    const stop = readStop(needs_replay);
    if (stop === null || stop.seq < seq || (stop.seq === seq && stop.hash !== hash)) return null;
    state = stoppedAt(read, stop);
  }
  return made > level && state.needs_replay === undefined ? stoppedAt(state, state.footing) : state;
}
