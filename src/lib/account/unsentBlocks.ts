/**
 * Not me's signed blocks on their way to the account service (ledger S32-1, device table T51, T60): kept in this
 * device's account store before any PC or the service is sent one, and until the service has answered for each, so a
 * closed tab or a reload loses no block. A later attempt sends the same signed records again (the service takes a
 * record id once). A record leaves only on the service's confirmation of it (taken, its id already taken, or its
 * target already removed), or after its owner pressed OK on its final refusal (FINAL; refusalShown): until then it
 * stays, marked refused. Any other answer keeps it as it is: no answer, a timeout, a 5xx, a 401, 408 or 429, a
 * route the service hides (404 while step 2 is off for the account), try_again, a sign-in too old, an answer this
 * build does not know, and any failure before it went out (a refused token refresh, a sign-out).
 */
import type { BlockRecord } from "../../../shared/account-records.ts";
import { AccountRefreshError, AccountServiceError } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

export interface UnsentBlocks {
  readonly account: string;
  /** the sign-in that signed them, for the record: entries are matched by `account`, so any sign-in to it sends them */
  readonly sign_in_id: string | undefined;
  readonly records: readonly BlockRecord[];
  /** the service refused them for good; they stay until the account's owner pressed OK on that refusal */
  readonly refused?: true;
}

/** How the service answered for a whole set: took it, found its target already removed, or refused it for good. */
export type Delivered = "sent" | "done" | "refused";

/**
 * The service's refusals of a block record itself (ovis-account src/safety.ts), by code and the status it comes with,
 * which no later send changes. The same code with any other status is no such answer.
 */
const FINAL = new Map([
  ["record_invalid", 400], ["signature_invalid", 400], ["account_mismatch", 403], ["frozen", 403],
  ["signer_not_member", 403], ["unknown_target", 403], ["signer_not_older", 403],
]);
/** The block's target is already removed (409): what the block was for holds, so this confirms it. */
const MOOT = "target_removed";
const MOOT_STATUS = 409;

/**
 * Stores `records` for `session`, one entry per record id, and their targets among the account's own blocks, in one step
 * with reading that it is still the stored sign-in; false (nothing kept) when it is not. Call it before handing them to any
 * PC or the service.
 */
export async function keepUnsent(store: AccountStore, session: AccountSession, records: readonly BlockRecord[]): Promise<boolean> {
  let kept = false;
  await store.updateMany(["session", "unsent_blocks", "own_blocks"], (current) => {
    const stored = current.session;
    if (stored === undefined || stored.account !== session.account || stored.sign_in_id !== session.sign_in_id) return current;
    kept = true;
    const added = Object.fromEntries(records.map((record) => [record.id, { account: session.account, sign_in_id: session.sign_in_id, records: [record] }]));
    const blocked = [...new Set([...current.own_blocks?.[session.account] ?? [], ...records.map((record) => record.target)])];
    return { ...current, unsent_blocks: { ...current.unsent_blocks, ...added }, own_blocks: { ...current.own_blocks, [session.account]: blocked } };
  });
  return kept;
}

/**
 * Posts the kept `records` with `post`. A record the service confirmed leaves the store, by its id; one it refused for
 * good is marked refused, to leave once its owner pressed OK; any other stays as it is. None is written back once something
 * else removed it. The first answer a retry may change is thrown once every record was tried.
 */
export async function postKept(store: AccountStore, session: AccountSession, records: readonly BlockRecord[], post: (record: BlockRecord) => Promise<void>): Promise<Delivered> {
  const answers = await Promise.allSettled(records.map(post));
  const answer = (id: string): "confirmed" | "refused" | "open" => {
    const settled = answers[records.findIndex((record) => record.id === id)];
    if (settled === undefined) return "open";
    if (settled.status === "fulfilled" || answeredBy(settled.reason) === MOOT) return "confirmed";
    return answeredBy(settled.reason) === undefined ? "open" : "refused";
  };
  await store.update("unsent_blocks", (current) => {
    if (current === undefined) return undefined;
    const next: Record<string, UnsentBlocks> = {};
    for (const [id, entry] of Object.entries(current)) {
      const said = entry.account === session.account ? answer(id) : "open";
      if (said === "open") next[id] = entry;
      else if (said === "refused") next[id] = { ...entry, refused: true };
    }
    return Object.keys(next).length === 0 ? undefined : next;
  });
  const retry = answers.find((settled): settled is PromiseRejectedResult => settled.status === "rejected" && answeredBy(settled.reason) === undefined);
  if (retry !== undefined) throw retry.reason;
  const codes = answers.flatMap((settled) => settled.status === "rejected" ? [answeredBy(settled.reason)] : []);
  if (codes.some((code) => code !== MOOT)) {
    console.warn("Ovis: the account service refused the block for good", codes.filter((code) => code !== MOOT).join(", "));
    return "refused";
  }
  return codes.length > 0 ? "done" : "sent";
}

/**
 * The service's own answer for the record, when `error` is one: its final refusal's code, or its target removed. Never
 * a token refresh's answer, an error this build does not know, or one a later send may change.
 */
function answeredBy(error: unknown): string | undefined {
  if (!(error instanceof AccountServiceError) || error instanceof AccountRefreshError) return undefined;
  const answered = FINAL.get(error.code) === error.status || (error.code === MOOT && error.status === MOOT_STATUS);
  return answered ? error.code : undefined;
}

/**
 * `ids` of `account` whose final refusal its owner has now pressed OK on: they leave the store, while `account` is still
 * the stored sign-in's (read in the same step). A record still waiting stays.
 */
export async function refusalShown(store: AccountStore, account: string, ids: readonly string[]): Promise<void> {
  const shown = new Set(ids);
  await store.updateMany(["session", "unsent_blocks"], (current) => {
    if (current.session?.account !== account || current.unsent_blocks === undefined) return current;
    const next = Object.fromEntries(Object.entries(current.unsent_blocks).filter(([id, entry]) => !(shown.has(id) && entry.account === account && entry.refused === true)));
    return { ...current, unsent_blocks: Object.keys(next).length === 0 ? undefined : next };
  });
}

/**
 * The blocks signed under \`session\`'s account that the account service has not answered for, one record each: any
 * sign-in to that account sends them; another account never sees them.
 */
export async function unsentBlocks(store: AccountStore, session: AccountSession): Promise<UnsentBlocks[]> {
  const kept = await store.get("unsent_blocks");
  return Object.values(kept ?? {}).filter((entry) => entry.account === session.account);
}
