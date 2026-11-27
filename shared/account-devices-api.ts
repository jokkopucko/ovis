/**
 * What an app and a PC say to each other about the account's devices: notices, block receipts, holds
 * and the recovery acts. Shapes and validators only, and nothing here is sent while the release flag is off.
 */
import { isListHash, isListKeyEncoding } from "./account-list-entry.ts";
import { AccountRecordError, isAccountKeyEncoding, parseSafetyRecord, type BlockRecord, type SafetyRecord } from "./account-records.ts";
import { PAIR_FINGERPRINT_PATTERN } from "./pair-fingerprint.ts";

/**
 * The release flag of step 2: unset or anything but `1` keeps every existing path. Read only through
 * accountOpensAll, by the PC's server and the account service; an app follows what a PC advertises
 * (ACCOUNT_OPENS_ALL_CAPABILITY) and has no switch of its own.
 */
/** How long this PC's screen keeps an asked act open (server/account/local-confirm.ts); the app shows its deadline. */
export const CONFIRM_MS = 2 * 60_000;

export { accountOpensAll, OVIS_ACCOUNT_OPENS_ALL } from "./account-opens-all.ts";
/** The capability a PC advertises while Step 2 is on; an app shows nothing of Step 2 for a PC without it. */
export const ACCOUNT_OPENS_ALL_CAPABILITY = "account-opens-all/1";

export class AccountDevicesApiError extends Error {
  readonly code = "request_invalid";
}

function fail(message: string): never {
  throw new AccountDevicesApiError(message);
}

/** Device table P15: the journal kinds a notice can carry; `release` and `admit` are the recovery's own (R11), `tailnet` a block or Allow of a tailnet node (server/tailnet-nodes.ts). */
export type NoticeKind = "admit" | "drop" | "remove" | "block" | "lift" | "promote" | "confirm" | "lock" | "unlock" | "account" | "method" | "merge" | "release" | "tailnet";

/** Device table P18, T34, T58: the registering sign-in provider for a list admission, if the snapshot still names it. */
export type NoticeSignInMethod = "github" | "google" | "apple" | null;
/** A way of signing in to an account, as the account service names it. */
export type SignInMethod = Exclude<NoticeSignInMethod, null>;
export function isSignInMethod(value: unknown): value is SignInMethod {
  return value === "github" || value === "google" || value === "apple";
}
/**
 * Device table T34, T58, section 5b: two-step sign-in as the account record states it, never inferred by the app.
 * List admissions report `set` (not proof this sign-in used two-step) or `unknown`, even without a provider.
 * Non-list admissions report null. `verified` remains a wire value but is not emitted for list admissions.
 */
export type NoticeTwoStep = "verified" | "set" | "unknown" | null;

/**
 * Device table P15, T57: one journal entry as a row receives it, before anything else on its stream.
 * `seq` orders the journal and nothing else; `open` is set while an `admit` nobody decided waits (never cut).
 * `how` is the admission path; `method` and `two_step` are filled by the server from the account record.
 */
export interface DeviceNotice {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly kind: NoticeKind;
  readonly how: string;
  readonly key: string | null;
  readonly no: number | null;
  readonly row: string | null;
  readonly label: string;
  readonly by: string | null;
  readonly account: string | null;
  readonly open: boolean;
  readonly method: NoticeSignInMethod;
  readonly two_step: NoticeTwoStep;
}

/** Device table P15, T57: the unseen notices on connect; `cut` counts the ones trimmed before this row saw them. */
export interface NoticeReplay { readonly notices: readonly DeviceNotice[]; readonly cut: number }

/** Device table T57: an acknowledgement moves this row's `seen` and decides nothing. */
export interface NoticeSeen { readonly type: "notice-seen"; readonly seq: number }
/**
 * Device table T51, T53, T57: deciding an `admit` notice. "It's me" counts only from a row that passes
 * T53's tests; "Not me" carries the block signed with the app's own device key, and works after the row is gone.
 * Device table P16 allows a second block when the app also holds a key a PC paired: at most two, one per key, for
 * one target. Each PC judges each signer by its own admission order; the account's `no` only decides whether
 * the app offers the button.
 */
export type NoticeAnswer =
  | { readonly type: "notice-answer"; readonly id: string; readonly answer: "its_me" }
  | { readonly type: "notice-answer"; readonly id: string; readonly answer: "not_me"; readonly blocks: readonly BlockRecord[] };

/**
 * Device table P21, T51, P16: why a PC refused a block. `signer_not_older`: by THIS PC's admission order the signer is
 * not older than the target (the account's `no` is never the authority); `signer_not_member`: the signer is removed
 * on this PC; `frozen`: the signer is itself frozen here; `unknown_target`: the PC cannot place the target.
 */
export type BlockRefusal = "signer_not_older" | "signer_not_member" | "frozen" | "unknown_target" | "record_invalid";
const REFUSALS: readonly string[] = ["signer_not_older", "signer_not_member", "frozen", "unknown_target", "record_invalid"];

/**
 * Device table T51, T60, P24: a PC's own answer to a block. `applied` with the log number is given again for
 * as long as the entry is whole; `already_applied` (no number) once the record was folded at that PC;
 * `refused` with its reason, which is never shown as done.
 */
export type BlockReceipt =
  | { readonly outcome: "applied"; readonly id: string; readonly n: number }
  | { readonly outcome: "already_applied"; readonly id: string }
  | { readonly outcome: "refused"; readonly id: string; readonly reason: BlockRefusal };

/**
 * Device table T60, T64, T65: what the app shows for one PC after a block. `applied`, `already_applied` and
 * `refused` come from the PC's receipt; only the first two are done, and the rest are never shown as done.
 */
export type PcBlockOutcome =
  | { readonly [S in BlockReceipt["outcome"]]: { readonly server_id: string; readonly state: S; readonly receipt: Extract<BlockReceipt, { outcome: S }> } }[BlockReceipt["outcome"]]
  | { readonly server_id: string; readonly state: "waiting" | "unreachable" | "unsupported" };

/** Device table T60: the outcome for one PC that answered, taken from its receipt and from nothing else. */
export function blockOutcome(serverId: string, receipt: BlockReceipt): PcBlockOutcome {
  return { server_id: serverId, state: receipt.outcome, receipt } as PcBlockOutcome;
}

/**
 * Device table S22, S25, T53, T56: why a row may not sign in yet. `join_hold` ends at `until`, which is null
 * while its notice is not yet durably published and the 10 seconds have not started (P17);
 * `catching_up` waits for a whole read (P7); `frozen` names the block whose freeze holds it (P16).
 */
export type HoldState =
  | { readonly reason: "join_hold"; readonly until: string | null }
  | { readonly reason: "catching_up" }
  | { readonly reason: "frozen"; readonly block: string };

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Device table S22, S25, T53, T56: a hold state as an app reads it from a `held` refusal; throws AccountDevicesApiError. */
export function parseHoldState(value: unknown): HoldState {
  const hold = shape(value, ["reason", "until", "block"]);
  if (hold.reason === "join_hold" && "until" in hold && !("block" in hold)
    && (hold.until === null || (typeof hold.until === "string" && ISO_MS.test(hold.until) && new Date(hold.until).toISOString() === hold.until))) return hold as unknown as HoldState;
  if (hold.reason === "catching_up" && Object.keys(hold).length === 1) return hold as unknown as HoldState;
  if (hold.reason === "frozen" && !("until" in hold) && typeof hold.block === "string" && HEX64.test(hold.block)) return hold as unknown as HoldState;
  fail("Invalid hold state");
}

/**
 * Device table R11: the acts of `ovis recover`, over the recovery socket only (and, one confirm each, on
 * the desktop app's own screen). `undo` with no rows ends every release; `admit` names one pending redemption and the
 * fingerprint of its key the terminal showed, which must match it.
 */
export type RecoveryAction =
  | { readonly act: "list" }
  | { readonly act: "release"; readonly rows: readonly string[] }
  | { readonly act: "undo"; readonly rows: readonly string[] | null }
  | { readonly act: "remove"; readonly targets: readonly string[] }
  | { readonly act: "revoke_all" }
  | { readonly act: "account_status" }
  | { readonly act: "restamp"; readonly confirm?: string }
  | { readonly act: "lift"; readonly blocks: readonly string[] }
  | { readonly act: "admit"; readonly pending: string; readonly fingerprint: string }
  // adding this PC to its owner's account from another PC over SSH (docs/account.md, "Adding a PC over SSH")
  | { readonly act: "account_add_inspect" }
  // `list` and `adder`, both or neither: the account keeps a signed list, and this take names it and the key whose entry
  // adds this PC to it (docs/account.md, "Adding a PC over SSH to an account that keeps a list")
  | { readonly act: "account_add_take"; readonly account: string; readonly server_id: string; readonly list?: string; readonly adder?: string };

/** A safety record still in force, named by the ID the recovery socket accepts for a lift. */
export type RecoveryStanding = {
  readonly kind: "block" | "freeze";
  readonly id: string;
  readonly target: string;
  readonly account: string;
  readonly signer: string;
};

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const LIFT_ID = /^(?:f:)?[0-9a-f]{64}$/;
/** A row id of either device file: 16 lowercase hex (server/devices.ts, accountDeviceId). */
const ROW_ID = /^[0-9a-f]{16}$/;
const ids = (value: unknown, pattern: RegExp): value is string[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= 64 && value.every((entry) => typeof entry === "string" && pattern.test(entry));

function shape(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("A request is a JSON object");
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) if (!fields.includes(name)) fail(`Unexpected field ${name}`);
  return object;
}

/** Device table T51, T57: an app's answer to a notice; throws AccountDevicesApiError. A "Not me" block must parse as one. */
export function parseNoticeAnswer(value: unknown): NoticeAnswer {
  const answer = shape(value, ["type", "id", "answer", "blocks"]);
  if (answer.type !== "notice-answer" || typeof answer.id !== "string" || !HEX32.test(answer.id)) fail("Invalid notice answer");
  if (answer.answer === "its_me" && !("blocks" in answer)) return answer as unknown as NoticeAnswer;
  if (answer.answer !== "not_me" || !Array.isArray(answer.blocks) || answer.blocks.length < 1 || answer.blocks.length > 2) fail("Invalid notice answer");
  const blocks = answer.blocks.map((entry): SafetyRecord => {
    try {
      return parseSafetyRecord(entry);
    } catch (error) {
      if (error instanceof AccountRecordError) fail(`Invalid block: ${error.message}`);
      throw error;
    }
  });
  const first = blocks[0]!;
  if (first.kind !== "block") fail("Not me carries blocks only");
  for (const block of blocks) {
    if (block.kind !== "block" || block.target !== first.target || block.account !== first.account) fail("Not me carries blocks of one target");
  }
  if (blocks.length === 2 && blocks[0]!.signer === blocks[1]!.signer) fail("A second block is signed by the app's other key");
  return answer as unknown as NoticeAnswer;
}

/** Device table T51, T60: a PC's receipt as the app reads it; throws AccountDevicesApiError. */
export function parseBlockReceipt(value: unknown): BlockReceipt {
  const receipt = shape(value, ["outcome", "id", "n", "reason"]);
  if ("reason" in receipt !== (receipt.outcome === "refused")) fail("Only a refusal has a reason");
  if (typeof receipt.id !== "string" || !HEX64.test(receipt.id)) fail("Invalid block id");
  if (receipt.outcome === "applied" && Number.isSafeInteger(receipt.n) && (receipt.n as number) >= 1) return receipt as unknown as BlockReceipt;
  if ((receipt.outcome === "already_applied" || receipt.outcome === "refused") && !("n" in receipt)
    && (receipt.outcome === "already_applied" || REFUSALS.includes(receipt.reason as string))) return receipt as unknown as BlockReceipt;
  fail("Invalid receipt");
}

/** Device table R11: one recovery act; throws AccountDevicesApiError. Every list names 1-64 entries. */
export function parseRecoveryAction(value: unknown): RecoveryAction {
  const action = shape(value, ["act", "rows", "targets", "blocks", "pending", "fingerprint", "account", "server_id", "list", "adder", "confirm"]);
  const only = (...fields: string[]) => Object.keys(action).every((name) => name === "act" || fields.includes(name));
  const ok = (() => {
    switch (action.act) {
      case "list": case "revoke_all": case "account_status": case "account_add_inspect": return only();
      case "account_add_take": return (only("account", "server_id") || (only("account", "server_id", "list", "adder") && typeof action.list === "string" && isListHash(action.list)
        && typeof action.adder === "string" && isListKeyEncoding(action.adder))) && typeof action.account === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(action.account)
        && typeof action.server_id === "string" && HEX32.test(action.server_id);
      case "restamp": return only("confirm") && (!("confirm" in action) || (typeof action.confirm === "string" && HEX32.test(action.confirm)));
      case "release": return only("rows") && ids(action.rows, ROW_ID);
      case "undo": return only("rows") && (action.rows === null || ids(action.rows, ROW_ID));
      // a row id or an account key, nothing in between
      case "remove": return only("targets") && Array.isArray(action.targets) && action.targets.length >= 1 && action.targets.length <= 64
        && action.targets.every((target) => typeof target === "string" && (ROW_ID.test(target) || isAccountKeyEncoding(target)));
      case "lift": return only("blocks") && ids(action.blocks, LIFT_ID);
      case "admit": return only("pending", "fingerprint") && typeof action.pending === "string" && HEX32.test(action.pending)
        && typeof action.fingerprint === "string" && PAIR_FINGERPRINT_PATTERN.test(action.fingerprint);
      default: return false;
    }
  })();
  if (!ok) fail("Invalid recovery action");
  return action as unknown as RecoveryAction;
}
