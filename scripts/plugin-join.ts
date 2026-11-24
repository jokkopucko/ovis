/**
 * `ovis join`: a new PC joins an Ovis account with a single-use invite that a device signed in to that account made
 * (docs/relay.md, "A PC with no screen"; docs/account.md, "PC invites"), with no sign-in on the PC. The person at the PC
 * sees which account the invite is for and types yes (or names it with `--account`) before anything is sent: an
 * invite someone else handed over must not attach this PC, and so a terminal on it, to their account unseen. Then the
 * PC lists itself in that account on its own key's proof (POST /v1/pc-invites/redeem), and from there it is `ovis add`
 * (plugin-link.ts addByPress): a plain invite waits for Add on a device of the account, an auto invite is admitted at
 * once, and this PC takes that admission and binds itself through the same route.
 *
 * The invite is the signed list's join line (shared/account-list-join.ts): it carries the invite's private key, a key to
 * the account's list for 15 minutes. It is never printed, logged, written anywhere or sent: the PC proves it holds it by
 * a signature over this account, this PC and this one challenge (shared/account-list-invite.ts), and the account
 * service, which has only the invite's public key, checks that. A line acts only on this PC's own account service. A
 * line on the command line shows in the process list, so the help and the docs name the file and standard input forms
 * first.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

import { accountOsOfPlatform } from "../shared/account-asker.ts";
import { entryToText, ListEntryError, readBody } from "../shared/account-list-entry.ts";
import { InviteRedeemError, type LineProof } from "../shared/account-list-invite.ts";
import { JoinLineError, JoinLineSignError, readJoinLine, type JoinLine } from "../shared/account-list-join.ts";
import { openWrap, sealFields, wrapEpochKey, wrapFromText, wrapToText } from "../shared/account-list-seal.ts";
import { isListLabel, namesFields } from "../shared/account-list.ts";
import { fromBase64Url, toBase64Url } from "../shared/relay-pair-sas.ts";
import { isLoopbackHost } from "../server/access.ts";
import { shortAccount } from "./plugin-cli.ts";
import {
  addByPress, askLine, AwayError, cli, inAnotherAccount, LocalError, localApi, openedListing, pins, plainLabel, relayOn, takesPress,
  type Api, type LinkOptions, type PressEnd, type PressWords, type Unlisted,
} from "./plugin-link.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Each way `ovis join` ends, by the name `--json` gives it, and its exit code (docs/relay.md, "ovis join"). */
export const JOIN_EXIT = {
  ok: 0,
  not_added: 1,
  stopped: 1,
  usage: 2,
  invite_invalid: 3,
  not_confirmed: 4,
  account_mismatch: 5,
  other_account: 6,
  rate_limited: 7,
  pc_add_cap: 8,
  directory_full: 9,
  service_unreachable: 10,
  not_available: 11,
  relay_unavailable: 12,
  not_running: 13,
  no_add: 14,
  internal: 15,
} as const;

export type JoinError = Exclude<keyof typeof JOIN_EXIT, "ok">;

export interface JoinOptions extends LinkOptions {
  /** standard error: everything but the JSON object with `--json` */
  readonly err: (text: string) => void;
  /** the Ovis on this PC answered its health check */
  readonly running: boolean;
  /** OVIS_INVITE, read only when no other form names the invite */
  readonly inviteEnv?: string;
  readonly readFile: (path: string) => string;
  readonly readStdin: () => Promise<string>;
  readonly platform?: string;
}

/** An invite read from a file or standard input is a line: anything longer is not one. */
export const INVITE_READ_MAX = 4096;

/**
 * The invite file `--invite-file` names, read at most to INVITE_READ_MAX and one byte more. Opened without waiting and
 * refused unless it is a regular file, so a FIFO or a device never holds the run where Ctrl+C cannot end it.
 */
export function readInviteFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(INVITE_READ_MAX + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read) read = readSync(fd, buffer, length, buffer.length - length, null);
    return buffer.toString("utf8", 0, length);
  } finally { closeSync(fd); }
}

/** The words after `ovis join` with a relative `--invite-file` made absolute from `cwd`: a release it is handed on to runs elsewhere. */
export function absoluteInviteFile(args: readonly string[], cwd: string): string[] {
  return args.map((arg, index) => {
    if (arg.startsWith("--invite-file=")) return `--invite-file=${resolve(cwd, arg.slice("--invite-file=".length))}`;
    return args[index - 1] === "--invite-file" && arg !== "" && !arg.startsWith("-") ? resolve(cwd, arg) : arg;
  });
}

const ACCOUNT_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

type Source = { readonly kind: "arg"; readonly text: string } | { readonly kind: "file"; readonly path: string } | { readonly kind: "stdin" } | { readonly kind: "env" };

/**
 * The words after `ovis join`. A refusal never repeats a word that is not a flag: any of them may be the invite.
 */
export function parseJoinArgs(args: readonly string[], command = "ovis join"): { readonly source: Source | null; readonly account?: string; readonly json: boolean } | { readonly error: string } {
  const sources: Source[] = [];
  let account: string | undefined;
  let json = false;
  const valued = (index: number, name: string): string | null => {
    const arg = args[index]!;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    const next = args[index + 1];
    return next === undefined || next === "" || next.startsWith("-") && next !== "-" ? null : next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "-") { sources.push({ kind: "stdin" }); continue; }
    for (const name of ["--account", "--invite-file"] as const) {
      if (arg !== name && !arg.startsWith(`${name}=`)) continue;
      const value = valued(index, name);
      if (value === null || value === "") return { error: `${command}: ${name} needs a value` };
      if (arg === name) index++;
      if (name === "--account") {
        if (!ACCOUNT_SHAPE.test(value)) return { error: `${command}: --account takes the id of the Ovis account the invite is for (letters, digits, _ and -)` };
        account = value;
      } else sources.push({ kind: "file", path: value });
    }
    if (arg === "--account" || arg.startsWith("--account=") || arg === "--invite-file" || arg.startsWith("--invite-file=")) continue;
    // a flag's name is no invite (an invite never starts with -), so it may be named back
    if (arg.startsWith("-")) return { error: `${command}: unknown flag ${/^-[-A-Za-z0-9]{0,40}$/.test(arg) ? arg : "(not shown)"}` };
    sources.push({ kind: "arg", text: arg });
  }
  if (sources.length > 1) return { error: `${command}: give the invite one way only: --invite-file <path>, - (standard input), or the invite itself` };
  return { source: sources[0] ?? null, ...account === undefined ? {} : { account }, json };
}

const USAGE_HINT = (command: string): string => `Run ${command} --invite-file <path> (or ${command} - to read it from standard input). ${command} --help says more.`;

const NOT_AN_INVITE = "That is not an Ovis invite: an invite is one line that starts with ovis-join:1:, made on a device signed in to your account. Nothing was sent.";

const INVITE_DEAD = "This invite does not work: it is mistyped, used or expired (an invite works once, for 15 minutes). Ask for a new one.";

/** Seconds from a retry-after header, as a person reads them. */
function inTime(seconds: number | null): string {
  if (seconds === null) return "a while";
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds < 2 * 3600) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

interface Outcome {
  readonly code: number;
  readonly json: Record<string, unknown>;
  readonly message?: string;
}

const failed = (error: JoinError, message: string, extra: Record<string, unknown> = {}): Outcome & { readonly message: string } =>
  ({ code: JOIN_EXIT[error], message, json: { ok: false, error, message, ...extra } });

/** The account service's word on a redeem: listed (with when its card or its admission ends), or why not. */
type Redeemed = { readonly account: string; readonly auto: boolean; readonly until: number | null } | (Outcome & { readonly message: string });

/**
 * What a run changed on this PC on its way to the account, so one that ends unbound puts it back: the account it named
 * for the relay pass (and the one named before; undefined where this PC does not say), the relay it turned on, the
 * approve-here window that listing opens, and the account whose list may hold this PC by this run's redeem.
 */
interface Undo {
  listed: string | null;
  named: boolean;
  namedBefore: string | null | undefined;
  relayWasOff: boolean;
  windowOpen: boolean;
  /** takes off what this run listed and puts back what it changed here: null when nothing was listed; never throws */
  cleanup: (() => Promise<Unlisted | null>) | null;
}

const cleanUp = async (undo: Undo): Promise<Unlisted | null> => {
  try { return await undo.cleanup?.() ?? null; } catch { return null; }
};

/** What a run that ended unbound says of the listing it took off, or could not. */
const leftWords = (off: Unlisted | null): { readonly said: string; readonly listed?: boolean | null } => off === null ? { said: "" }
  : off === "removed" ? { said: " This PC was taken off that account's list again; the invite may be spent.", listed: false }
  : { said: " This PC may still be on that account's list: remove it on a device of that account.", listed: null };

/** `outcome` with what became of a listing this run made added to its words and its object. */
function withLeft(outcome: Outcome, off: Unlisted | null): Outcome {
  const { said, listed } = leftWords(off);
  if (said === "") return outcome;
  return { ...outcome, ...outcome.message === undefined ? {} : { message: `${outcome.message}${said}` },
    json: { ...outcome.json, ...typeof outcome.json["message"] === "string" ? { message: `${outcome.json["message"]}${said}` } : {}, listed } };
}

/** This PC's fresh proof that it is `serverId`, for the `account` role (POST /api/account/pc-proof): single use, a minute long. */
async function pcProof(api: Api, serverId: string, signal?: AbortSignal): Promise<{ challenge_id: string; proof: string }> {
  const proof = await api<{ server_id?: unknown; challenge_id?: unknown; proof?: unknown }>("POST", "/api/account/pc-proof", signal === undefined ? {} : { signal });
  if (proof.server_id !== serverId || typeof proof.challenge_id !== "string" || typeof proof.proof !== "string") throw new LocalError("The Ovis on this PC gave no proof that it is this PC.");
  return { challenge_id: proof.challenge_id, proof: proof.proof };
}

/** Resolves when `signal` aborts: what was read meanwhile no longer counts. */
const aborted = (signal: AbortSignal): Promise<"aborted"> => new Promise((resolve) => {
  if (signal.aborted) resolve("aborted");
  else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
});

export async function join(args: readonly string[], options: JoinOptions): Promise<number> {
  const parsed = parseJoinArgs(args, `${cli(options)} join`);
  const json = "error" in parsed ? args.includes("--json") : parsed.json;
  // with --json, stdout carries the one object, and everything a person would read goes to stderr
  const say = json ? options.err : options.out;
  let printed = false;
  const end = (outcome: Outcome): number => {
    if (printed) return outcome.code;
    printed = true;
    if (outcome.message !== undefined) { try { say(`${outcome.message}\n`); } catch {} }
    if (json) options.out(`${JSON.stringify(outcome.json)}\n`);
    return outcome.code;
  };
  const undo: Undo = { listed: null, named: false, namedBefore: undefined, relayWasOff: false, windowOpen: false, cleanup: null };
  try {
    return end(await joinRun(args, parsed, options, say, undo));
  } catch (error) {
    // whatever went wrong, the one object is printed, and what this run left on this PC and the account's list goes
    const off = await cleanUp(undo);
    const name = error instanceof Error ? error.name : "Error";
    const reason = error instanceof Error ? error.message : String(error);
    if (options.signal.aborted) return end(withLeft(failed("stopped", off === null ? "Stopped. Nothing of the invite was used here." : "Stopped."), off));
    return end(withLeft(failed("internal", `ovis join stopped on an error of its own (${name}: ${reason.slice(0, 200)}).`), off));
  }
}

async function joinRun(args: readonly string[], parsed: ReturnType<typeof parseJoinArgs>, options: JoinOptions, say: (text: string) => void, undo: Undo): Promise<Outcome> {
  const command = `${cli(options)} join`;
  if ("error" in parsed) return failed("usage", `${parsed.error}\n${USAGE_HINT(command)}`);
  const json = parsed.json;
  const source = parsed.source ?? ((options.inviteEnv ?? "") === "" ? null : { kind: "env" } as const);
  if (source === null) return failed("usage", `${command} needs the invite a device of your account made. ${USAGE_HINT(command)}`);
  let line: string;
  try {
    if (source.kind === "stdin") {
      const read = await Promise.race([options.readStdin(), aborted(options.signal)]);
      if (read === "aborted" && options.signal.aborted) return failed("stopped", "Stopped. Nothing was sent.");
      line = read;
    } else line = source.kind === "arg" ? source.text : source.kind === "env" ? options.inviteEnv ?? "" : options.readFile(source.path);
  } catch {
    // never the path: it could be the invite itself, put where a path goes
    return failed("usage", source.kind === "file" ? "Could not read the file --invite-file names (it must be a file you can read). Nothing was sent." : "Could not read the invite from standard input. Nothing was sent.");
  }
  if (options.accountService === null) return failed("relay_unavailable", "The account service is off on this PC (OVIS_ACCOUNT_SERVICE_URL=off), so it joins no account. Nothing was sent.");
  let invite: JoinLine;
  try {
    if (line.length > INVITE_READ_MAX) throw new JoinLineError("length", "too long");
    // the reader takes only a line for this PC's own account service, so a pasted line never points this PC's account
    // traffic, its proof or its listing elsewhere. A line that names the account's signed list is joined by that list
    invite = await readJoinLine(line.trim(), { service: options.accountService, followsLists: true });
  } catch (error) {
    // a refusal names no part of the line; anything else is a fault of this runtime, not the line's
    if (!(error instanceof JoinLineError)) throw error;
    if (error.reason === "other_service") {
      return failed("invite_invalid", `This invite is for another account service than the one this PC uses (${options.accountService}). Nothing was sent. Ask for an invite on a device signed in to that service, or check OVIS_ACCOUNT_SERVICE_URL here.`);
    }
    return failed("invite_invalid", NOT_AN_INVITE);
  }
  const account = invite.account;
  // the account is named by its start as Settings and `ovis status` show it, as `ovis add --account` takes it. A refusal
  // does not name the invite's account: whoever made the invite chose it
  if (parsed.account !== undefined && !pins(parsed.account, account)) {
    return failed("account_mismatch", `The invite is for another Ovis account than the one --account names. Nothing was sent, and the invite was not used. ${cli(options)} status --json on a PC already in your account shows its full id.`);
  }
  let host: string;
  try { host = new URL(options.origin).host; } catch { host = ""; }
  if (!isLoopbackHost(host)) return failed("not_available", `The server at ${options.origin} is not on a loopback address. Run ${command} only on the PC itself, with Ovis listening on 127.0.0.1 (HOST unset).`);
  if (!options.running) return failed("not_running", `Ovis is not running on this PC. Start it (${cli(options)} start, or open the app), then run this again.`);
  // the invite came on standard input, which is then no terminal anybody types at
  const terminal = source.kind !== "stdin" && options.terminal === true;
  const flow: LinkOptions = { ...options, out: say, terminal };
  const api = localApi(flow);
  try {
    return await joining(flow, api, undo, { key: invite.key, signRedeem: invite.signRedeem, account, pinned: parsed.account !== undefined, json, platform: options.platform ?? process.platform,
      list: invite.list === null ? null : { id: invite.list, signJoin: invite.signJoin, signLineProof: invite.signLineProof, encryptionKey: invite.encryptionKey } });
  } catch (error) {
    if (!(error instanceof LocalError || error instanceof AwayError) || options.signal.aborted) throw error;
    const off = await cleanUp(undo);
    return withLeft(failed(error instanceof AwayError ? "not_running" : "not_added", `Could not add this PC: ${(error instanceof LocalError ? error.reason : error.message).replace(/[.\s]*$/, ".")}`), off);
  }
}

async function joining(options: LinkOptions, api: Api, undo: Undo,
  invite: { readonly key: string; readonly signRedeem: JoinLine["signRedeem"]; readonly account: string; readonly pinned: boolean; readonly json: boolean; readonly platform: string;
    /** the account's signed list, when the line names one, with what of the line joins it: the PC then joins by that list alone */
    readonly list: { readonly id: string; readonly signJoin: JoinLine["signJoin"]; readonly signLineProof: JoinLine["signLineProof"]; readonly encryptionKey: CryptoKey } | null }): Promise<Outcome> {
  const { out, signal } = options;
  const { account } = invite;
  const now = options.now ?? Date.now;
  const service = options.accountService!;
  const serviceFetch: Fetch = options.serviceFetch ?? fetch;
  const wait = options.wait ?? ((ms: number, abort: AbortSignal) => new Promise<void>((resolve, reject) => {
    // fixed wait: a pause before asking the account service again, as it asked
    const stop = () => { clearTimeout(timer); reject(abort.reason); };
    const timer = setTimeout(() => { abort.removeEventListener("abort", stop); resolve(); }, ms);
    abort.addEventListener("abort", stop, { once: true });
  }));
  const command = `${cli(options)} join`;
  let status: { account: string | null };
  try { status = await api<{ account: string | null }>("GET", "/api/account/status"); } catch (error) {
    if (error instanceof LocalError && error.status === 404) return failed("not_available", `The Ovis running on this PC is older than ${command} needs. Update it in Settings → Updates, then run this again.`);
    throw error;
  }
  // in that account already: the invite is left for another PC
  if (status.account === account) {
    return { code: JOIN_EXIT.ok, message: `This PC is already in Ovis account ${account}. The invite was not used.`, json: { ok: true, account, added: false, online: null } };
  }
  if (status.account !== null) {
    return failed("other_account", `${inAnotherAccount(options, status.account, command)} The invite was not used.`);
  }
  const takes = await takesPress(api);
  if (takes !== "press") {
    return failed("not_available", takes === "not-own"
      ? `The Ovis on this PC does not count this terminal as the PC itself (a forwarded port?), so it cannot be added from here. Run ${command} on the PC itself.`
      : `The Ovis on this PC cannot take an invite (its Step 2 is off, or it is older). Update it in Settings → Updates, then run this again.`);
  }
  // a line that names the account's signed list is joined by that list alone: an Ovis that follows none is told so
  // before anything is sent, with the invite unused
  if (invite.list !== null) {
    try { await api("GET", "/api/account/list"); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      return failed("not_available", "This invite is for an account with a signed member list, which needs a newer Ovis on this PC. Update it in Settings → Updates, then run this again. Nothing was sent.");
    }
  }
  // nothing has gone to the account service so far, and nothing goes before the person here said this is the account.
  // Under the fleet preview that is asked at a terminal only, --account or not, as `ovis add` does
  const interactive = options.terminal === true && options.isTty === true;
  const preview = options.preview === true;
  if (preview && (!interactive || invite.json)) {
    return failed("not_confirmed", `Adding this PC needs a terminal: there it asks whether the invite's account is yours. Run ${command} in a terminal (over ssh, run ssh -t). Nothing was sent.`);
  }
  if (!invite.pinned && invite.json) {
    return failed("not_confirmed", `With --json nothing is asked: name the account with ${command} --account <the account's id> (${cli(options)} status --json on a PC already in it shows it). Nothing was sent.`);
  }
  if (!invite.pinned && !interactive) {
    return failed("not_confirmed", `Not run in a terminal, so nobody here can confirm the account the invite is for. Run ${command} --account <the account's id> (Manage account in Settings shows it, and ${cli(options)} status on a PC already in it), or run ${command} in a terminal. Nothing was sent.`);
  }
  if (!invite.pinned || preview) {
    const asked = [
      `This invite adds this PC to Ovis account ${account}.`,
      "Compare this ID with Settings → Manage account → Account ID in your",
      `Ovis app, or with ${cli(options)} status on a PC you already use.`,
      "Is this your account? Type yes to add this PC to it: ",
    ].join("\n");
    const answer = await askLine(options, asked);
    if (answer === null || answer.normalize("NFKC").trim().toLowerCase() !== "yes") {
      return failed("not_confirmed", "This PC was not added, and the invite was not used.");
    }
  } else out(`Ovis account ${account} is the one --account names.\n`);
  // what this PC had before this run touches it: the relay off or on, and the account named for it (own window only)
  const before = await api<{ phase?: unknown; relay_account?: unknown }>("GET", "/api/relay");
  undo.namedBefore = typeof before.relay_account === "string" || before.relay_account === null ? before.relay_account : undefined;
  try { await relayOn(options, api); } catch (error) {
    if (!(error instanceof LocalError)) throw error;
    return failed("relay_unavailable", `${error.reason.replace(/[.\s]*$/, ".")} Nothing was sent.`);
  }
  undo.relayWasOff = before.phase === "off";
  let serverId: string | null = null;
  const quick = (ms = 1_000) => ({ signal: AbortSignal.timeout(ms) });
  /** Puts back what this run changed on this PC, for a run that ends with this PC in no account; never throws. */
  const putBack = async (): Promise<void> => {
    if (undo.windowOpen) await api("POST", "/api/relay/link/close", quick()).catch(() => undefined);
    if (undo.named && undo.namedBefore !== undefined && undo.namedBefore !== account) await api("POST", "/api/account/relay-account", { body: { account: undo.namedBefore }, ...quick() }).catch(() => undefined);
    if (undo.relayWasOff) await api("POST", "/api/relay/stop", quick()).catch(() => undefined);
    undo.windowOpen = false;
    undo.named = false;
    undo.relayWasOff = false;
  };
  /** Takes this PC off `from`'s list by its own proof (POST /v1/pcs/{server_id}/leave), on signals of its own and within five seconds. */
  const leave = async (from: string): Promise<Unlisted> => {
    if (serverId === null) return "failed";
    try {
      const proof = await pcProof(api, serverId, AbortSignal.timeout(2_500));
      const left = await serviceFetch(`${service}/v1/pcs/${serverId}/leave`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(2_500),
        body: JSON.stringify({ server_id: serverId, account: from, ...proof }),
      });
      if (left.status !== 204) return "failed";
      if (undo.listed === from) undo.listed = null;
      return "removed";
    } catch { return "failed"; }
  };
  undo.cleanup = async () => {
    const off = undo.listed === null ? null : await leave(undo.listed);
    await putBack();
    return off;
  };
  /** Ends a run that left this PC in no account: what it listed goes, and what it changed here goes back. */
  const unbound = async (outcome: Outcome): Promise<Outcome> => withLeft(outcome, await cleanUp(undo));
  undo.windowOpen = true;
  const listing = await openedListing(api);
  serverId = listing.serverId;
  const label = plainLabel(listing.entry.label).slice(0, 48) || listing.serverId.slice(0, 8);
  const redeemed = await redeem();
  if (!("account" in redeemed)) return await unbound(redeemed);
  if (redeemed.account !== account) {
    // the service listed this PC in another account than the invite's: that listing goes, under the account it named
    undo.listed = redeemed.account;
    return await unbound(failed("not_added", "The account service answered for another account than the invite's. This PC was not added."));
  }
  // the account this PC's relay pass is asked under, and the only one its one press takes
  undo.named = true;
  const named = () => api("POST", "/api/account/relay-account", { body: { account } }).then(() => undefined, () => undefined);
  await named();
  if (!redeemed.auto && redeemed.until !== null && redeemed.until <= now()) {
    return await unbound(failed("no_add", "The card that offers Add for this PC ran out 10 minutes after the invite was first used. Ask for a new invite."));
  }
  let ended: PressEnd | null = null;
  const code = await addByPress({ ...options, ...invite.json ? { terminal: false } : {} }, api, {
    signedIn: account, name: label, listedAt: null, confirmed: redeemed.auto,
    // an auto invite's admission may take a moment to be there; a plain one's card ends when the service says
    ...redeemed.auto ? { noneTries: invite.list === null ? 3 : 5 } : redeemed.until === null ? {} : { until: redeemed.until },
    ...invite.list === null ? { admissionOnly: true as const } : { take: byList(invite.list, redeemed.auto) },
    askBeforeUnlist: true, stopFast: true,
    unlist: () => leave(account), named, signOut: async () => undefined,
    words: joinWords(options, account, redeemed.auto), report: (end) => { ended = end; },
  });
  const outcome = (ended as PressEnd | null) ?? (code === 0 ? { kind: "added", online: false } as const : { kind: "not_added", why: "failed", listed: null } as const);
  if (outcome.kind === "added") {
    undo.listed = null;
    return { code, json: { ok: true, account, added: true, online: outcome.online } };
  }
  if (outcome.kind === "elsewhere") {
    return { code: JOIN_EXIT.other_account, json: { ok: false, error: "other_account", message: `This PC joined another Ovis account (${shortAccount(outcome.account)}), not the one the invite is for.` } };
  }
  const error: JoinError = outcome.why === "timeout" ? "no_add" : outcome.why === "stopped" ? "stopped" : "not_added";
  const message = outcome.why === "timeout" ? "Not added while its card offered Add: nobody pressed it, or a device declined it."
    : outcome.why === "stopped" ? "Stopped before this PC was added."
    : outcome.why === "none_waiting" ? "The invite's add was not there to take (it lasts 10 minutes from the invite's first use)."
    : "This PC was not added.";
  // the auto invite's listing addByPress keeps (it is the account's own): this run made it, and it goes
  if (outcome.why === "none_waiting") return await unbound({ code: JOIN_EXIT[error], message: "This PC was not added.", json: { ok: false, error, message } });
  // addByPress took the listing off, or said why not
  undo.listed = null;
  await putBack();
  return { code: JOIN_EXIT[error], json: { ok: false, error, message, listed: outcome.listed } };

  /**
   * One ask of a join by the account's signed list, which the line names (docs/account.md, "A PC joins the list with an
   * invite"). An invite a person adds a PC with: this PC posts its card and joins once a device of the account chose
   * Add (POST /api/account/list/join). One a PC joins with by itself: the PC builds its `join` from its own keys, this
   * command signs it with the line's key, which never leaves it, and the PC places it and joins. The names' key, which
   * the account wrapped for the invite and only the line opens, is wrapped again for the PC, and its name sealed.
   */
  function byList(list: { readonly id: string; readonly signJoin: JoinLine["signJoin"]; readonly signLineProof: JoinLine["signLineProof"]; readonly encryptionKey: CryptoKey }, auto: boolean) {
    type State = { readonly state: "added" | "waiting" | "again" } | { readonly state: "body"; readonly body: string } | { readonly state: "prove"; readonly card: LineProof["card"] }
      | { readonly state: "prepared"; readonly seq: number; readonly enc: string; readonly seal: { readonly epoch: number; readonly opens: string } | null; readonly wraps: readonly { readonly epoch: number; readonly wrap: string }[] };
    const scope = { account, list: list.id };
    let wrongKeySaid = false;
    const itself = async (): Promise<State> => {
      const prepared = await api<State>("POST", "/api/account/list/join/prepare", { body: { ...scope, invite: invite.key } });
      // this PC is in the list, or in the account, already: it writes no join, and the line proves its join instead
      if (prepared.state === "prove") return await plain();
      if (prepared.state !== "prepared") return prepared;
      const { seq, enc, seal } = prepared;
      let sealed: { epoch: number; bytes: string } | undefined;
      let wraps: { epoch: number; member: string; wrap: string }[] = [];
      const held = seal === null ? undefined : prepared.wraps.find((wrap) => wrap.epoch === seal.epoch);
      if (seal !== null && held !== undefined) {
        try {
          const opened = await openWrap({ list: list.id, epoch: seal.epoch, commitment: seal.opens, wrap: wrapFromText(held.wrap), member: { key: invite.key, privateKey: list.encryptionKey } });
          // the list commits to that key: one that does not give its commitment is the account service's doing
          if (!opened.open && opened.why === "other_key" && !wrongKeySaid) {
            wrongKeySaid = true;
            out("The account service gave this PC a key to the list's names that the list does not commit to, so this PC joins without names. Tell the account's owner: the account service did this.\n");
          }
          if (opened.open) {
            const own = await wrapEpochKey({ list: list.id, epoch: opened.value, member: enc });
            if (own !== null) wraps = [{ epoch: seal.epoch, member: enc, wrap: wrapToText(own) }];
            if (isListLabel(label)) sealed = { epoch: seal.epoch, bytes: toBase64Url(await sealFields({ place: { list: list.id, seq }, epoch: opened.value, commitment: seal.opens, fields: namesFields({ label, os: null }) })) };
          }
        } catch { /* a wrap that does not open gives no names: the PC joins without them */ }
      }
      const built = await api<State>("POST", "/api/account/list/join/body", { body: { ...scope, invite: invite.key, seq, ...sealed === undefined ? {} : { sealed } } });
      if (built.state !== "body") return built;
      const entry = entryToText(await list.signJoin(readBody(fromBase64Url(built.body))));
      return await api<State>("POST", "/api/account/list/join/place", { body: { ...scope, invite: invite.key, entry, ...wraps.length === 0 ? {} : { wraps } } });
    };
    // An invite a person adds a PC with: the line names the list, so this command shows the PC that it holds the line.
    // The PC hands over its own card for that list; the line signs its proof for that card, this account and this PC
    let proof: string | null = null;
    const plain = async (): Promise<State> => {
      const named = { ...scope, invite: invite.key };
      if (proof === null) {
        const asked = await api<State>("POST", "/api/account/list/join", { body: named });
        if (asked.state !== "prove") return asked;
        proof = await list.signLineProof({ server_id: listing.serverId, card: asked.card });
      }
      return await api<State>("POST", "/api/account/list/join", { body: { ...named, proof } });
    };
    return async (): Promise<"added" | "none" | "slow" | "away" | "joined"> => {
      try {
        const state = auto ? await itself() : await plain();
        return state.state === "added" ? "added" : "none";
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof AwayError) return "away";
        if (error instanceof JoinLineSignError || error instanceof ListEntryError || error instanceof InviteRedeemError) throw new LocalError("The Ovis on this PC handed this command something that is no join of this invite, so nothing was signed.");
        if (!(error instanceof LocalError)) throw error;
        if (error.status === 404 || error.status === 405) throw new LocalError(`This invite is for an account with a signed member list, which the Ovis running on this PC does not follow. Update it in Settings → Updates, then run ${command} again with a new invite.`);
        if (error.code === "in_account") return "joined";
        if (error.status === 503) return "slow";
        throw error;
      }
    };
  }

  /**
   * POST /v1/pc-invites/redeem with this PC's listing, a fresh proof of its key and the invite's signature over both. A
   * proof that lapsed on the way, or the service's try_again, is asked again twice. An answer that did not come, or
   * came unreadable, may hide a listing the service made: the same PC and key get the same answer, so it is asked
   * again, and when it still says nothing the listing is taken off. A refusal is told by its name only.
   */
  async function redeem(): Promise<Redeemed> {
    let unclear = 0;
    for (let attempt = 0; ; attempt++) {
      let proof: { challenge_id: string; proof: string };
      try { proof = await pcProof(api, listing.serverId); } catch (error) {
        if (signal.aborted || !(error instanceof LocalError)) throw error;
        if (error.code === "account_unavailable") return failed("service_unreachable", "The account service did not answer this PC. Try again in a moment: the invite works for 15 minutes.");
        return failed("not_available", `The Ovis on this PC gave no proof that it is this PC (${error.reason.replace(/[.\s]*$/, "")}). Update it in Settings → Updates, then run this again.`);
      }
      const os = accountOsOfPlatform(invite.platform);
      // signed again for every try: each answers a challenge of its own
      let signature: string;
      try { signature = await invite.signRedeem({ server_id: listing.serverId, public_key: listing.entry.public_key, challenge_id: proof.challenge_id }); } catch (error) {
        if (!(error instanceof InviteRedeemError)) throw error;
        return failed("not_added", "The account service's challenge is not one this command signs for. This PC was not added.");
      }
      // from here the service may list this PC, whatever comes back
      undo.listed = account;
      let response: Response;
      let body: unknown = null;
      let readable = true;
      try {
        // never redirected: the invite's key, its signature and the proof go to this PC's account service alone
        response = await serviceFetch(`${service}/v1/pc-invites/redeem`, {
          method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          body: JSON.stringify({ invite_key: invite.key, invite_signature: signature, server_id: listing.serverId, public_key: listing.entry.public_key, relay: listing.entry.relay, label, ...os === null ? {} : { os }, ...proof }),
        });
        try { body = await response.json(); } catch { readable = false; }
      } catch {
        if (signal.aborted) return failed("stopped", "Stopped while the account service was asked to list this PC.");
        response = new Response(null, { status: 599 });
        readable = false;
      }
      if (signal.aborted) return failed("stopped", "Stopped while the account service was asked to list this PC.");
      if (response.status === 200 && readable) {
        const answer = body as { account?: unknown; auto?: unknown; card_until?: unknown; admission_until?: unknown } | null;
        if (typeof answer?.account === "string" && typeof answer.auto === "boolean") {
          // the service's own clock: its deadline counted from its Date, not this PC's
          const deadline = Date.parse(typeof answer.card_until === "string" ? answer.card_until : "");
          const told = Date.parse(response.headers.get("date") ?? "");
          return { account: answer.account, auto: answer.auto, until: Number.isFinite(deadline) ? now() + deadline - (Number.isFinite(told) ? told : now()) : null };
        }
      }
      if (response.status === 200 || response.status >= 500 || !readable) {
        if (++unclear < 3) {
          await wait(1_000, signal);
          continue;
        }
        return failed("service_unreachable", "The account service did not say whether it took this PC. Try again in a moment.");
      }
      const said = (body as { error?: { code?: unknown } } | null)?.error?.code;
      const code = typeof said === "string" && /^[a-z0-9_]{1,40}$/.test(said) ? said : null;
      if (attempt < 2 && ((response.status === 401 && code === "proof_invalid") || (response.status === 409 && code === "try_again"))) {
        await wait(1_000, signal);
        continue;
      }
      // a definite refusal lists nothing; after a try whose answer was lost it may have, so that one is still taken off
      if (unclear === 0) undo.listed = null;
      const header = response.headers.get("retry-after")?.trim() ?? "";
      const retryAfter = /^[0-9]{1,9}$/.test(header) ? Number(header) : null;
      if (response.status === 400 && code === "invite_invalid") return failed("invite_invalid", INVITE_DEAD);
      if (response.status === 429 && code === "pc_add_cap") return failed("pc_add_cap", `Your Ovis account has added as many PCs as it may for now: try again in ${inTime(retryAfter)}. The invite was not used.`, { retry_after: retryAfter });
      if (response.status === 429) return failed("rate_limited", `The account service asks this PC to wait: try again in ${inTime(retryAfter)}.`, { retry_after: retryAfter });
      if (response.status === 409 && code === "directory_full") return failed("directory_full", `Your account holds as many PCs as it can. Remove one in the Ovis app, then run ${command} again (with a new invite once this one ran out).`);
      if (response.status === 404) return failed("not_available", `The account service takes no PC invites for this account. Add this PC with ${cli(options)} add instead.`);
      return failed("not_added", `The account service did not take this PC (${code ?? `HTTP ${response.status}`}). This PC was not added.`);
    }
  }
}

/** `ovis join`'s words for the press: an invite chose the account, and nothing was signed in to. */
function joinWords(options: LinkOptions, account: string, auto: boolean): PressWords {
  const command = `${cli(options)} join`;
  return {
    command, anew: "Ask for a new invite to try again.", chosen: "the invite is for",
    closing: `Check: ${cli(options)} status      Undo: ${cli(options)} logout\n`,
    waiting: (name, lasts) => auto
      ? `This PC is listed in Ovis account ${account} as ${name}, and the invite adds it with no Add to press.\n`
      : `This PC is listed in Ovis account ${account} as ${name}. Open Ovis on your phone or another device signed in to that account and press Add for ${name} (its card shows for 10 minutes).\nWaiting… (up to ${lasts}, Ctrl+C to stop)\n`,
    noneWaiting: `The invite's add is no longer there to take: it lasts 10 minutes from the invite's first use. Ask for a new invite, then run ${command} again.\n`,
  };
}
