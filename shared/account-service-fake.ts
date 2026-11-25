/**
 * Test support only: nothing in production imports it (server/conventions.test.ts).
 * It checks what the real service must check (record shape and signature, the caller's directory,
 * server proof with the `account` role), so tests fail where a PC or app relies on something the
 * service would refuse.
 */
import {
  ACCOUNT_RECORDS_MAX, AccountRecordError, isAccountKeyEncoding, isDeviceSafetyRecord, parseSafetyRecord, pcAddSigningBytes, readAccountRecord, verifySafetyRecord,
  type AccountRecord, type BlockRecord, type DeviceLiftRecord, type PcAddPurpose, type SafetyRecord,
} from "./account-records.ts";
import { ACCOUNT_SNAPSHOT_V, SNAPSHOT_GONE, type AccountSnapshotPage, type SnapshotFreezeLine } from "./account-snapshot.ts";
import { ListEntryError, canonicalBase64Url, entryFromText, entryHash, entryHolds, entryToText, firstState, isListHash, readBody, signEntry, verifySignature, type Entry, type EntryBody, type HeldEntry } from "./account-list-entry.ts";
import {
  CARD_SIGNATURE_CHARS, EPOCH_LINK_BYTES, ListKindError, admitsDevice, cardHolds, firstListState, holdsPc, inviteRefusal, isListKey, kindBody, listClock, readKind, sealEpoch, signCard, takeEntry, wrapKeys,
  type ListKind, type ListState,
} from "./account-list.ts";
import { signerPower, type ListPlace } from "./account-list-signers.ts";
import { accountOsOf, type AccountOs, type AccountPlace } from "./account-asker.ts";
import { isWssOrigin } from "./relay-offer.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "./relay-server-proof.ts";
import { isListKeyEncoding, isListPoint } from "./account-list-entry.ts";
import { verifyInviteRedeem, verifyLineProof } from "./account-list-invite.ts";
import { MIGRATION_CARRIED_MAX, linkBytes } from "./account-list-migrate.ts";

export const CHALLENGE_TTL_MS = 60_000;
/** How long a PC's own leave (POST /v1/pcs/{server_id}/leave) keeps a PUT without its proof from listing it again. */
export const PC_LEFT_MS = 30 * 24 * 60 * 60 * 1000;

/** a listing's own ID (account#57), as the service makes it */
const LISTING_ID = /^[0-9a-f]{32}$/;

/** account#57's completion scope, and the context its challenge is stored and proved under */
function completionScope(value: unknown): { account: string; listing_id: string } | null {
  if (value === null || typeof value !== "object") return null;
  const { account, listing_id } = value as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof account === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(account) && typeof listing_id === "string" && LISTING_ID.test(listing_id)
    ? { account, listing_id } : null;
}
const completionKey = (scope: { account: string; listing_id: string }, nonce: string): string => `pc-complete/1:${scope.account}:${scope.listing_id}:${nonce}`;
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PAGE = 100;
export const MAILBOX_MAX = 1000;
export const ACCESS_TOKEN_TTL_S = 3600;
export const DIRECTORY_MAX = 100;
export const LIMIT_WINDOW_MS = 10 * 60_000;
export const ADMISSIONS_PER_WINDOW = 10;
/** Quiet admissions one account may post in a window: a count of their own, apart from the ordinary ones. */
export const QUIET_ADMISSIONS_PER_WINDOW = 60;
export const ACCOUNT_REQUESTS_PER_WINDOW = 600;
export const DEVICE_CODE_TTL_S = 900;
export const DEVICE_POLL_S = 5;
export const ACCOUNT_RING = { pane_id: null, title: "Ovis", body: "Your Ovis account has news", tag: "ovis-account" } as const;

export interface FakeRing { account: string; endpoint: string; payload: typeof ACCOUNT_RING }
export const SIGNIN_CODE_TTL_MS = 60_000;

export type SignInProvider = "github" | "google" | "apple";
const SIGN_IN_PROVIDERS: readonly string[] = ["github", "google", "apple"];
const DEVICE_PAGES: Readonly<Record<string, string>> = { github: "https://github.com/login/device", google: "https://www.google.com/device" };
export const LINK_TOKEN_TTL_S = 600;
/** How recent a sign-in must be to add or remove a sign-in method. */
export const REAUTH_MS = 10 * 60_000;

/** The web app's redirect: the code comes back in the fragment there, so it never reaches the host's logs. */
export const WEB_REDIRECT = "https://app.ovis.sh/";

/** The only redirects sign-in returns to (docs/account.md, "Signing in"), compared exactly. */
export function isAllowedRedirect(uri: string): boolean {
  if (uri === WEB_REDIRECT || uri === "ovis://account/callback") return true;
  const loopback = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/callback$/.exec(uri);
  return loopback !== null && Number(loopback[1]) >= 1 && Number(loopback[1]) <= 65535;
}

async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

interface Session { account: string; provider: SignInProvider | "test"; family: string; expires: number }

/** `public_key`: the PC's relay key (X25519, 64 hex), from which `server_id` derives; `relay`: the wss origin it is reached through. */
export interface FakePc { server_id: string; label: string; public_key: string; relay: string; added_at: string; last_seen_at: string | null; new_until?: string | null; admitted_at?: string | null; exempt?: boolean;
  /** PCL-1: listed by a sign-in that was no app's own (a device code) and not confirmed since, as the service's `listed_by_device` */
  listed_by_device?: boolean;
  /** listed by a device code while Step 2 was on: until confirmed or admitted it leaves the account never used (account#62) */
  pending_under_step2?: boolean;
  /** the sign-in (family) that wrote the listing, as the service's `listed_by_session` (account#63): upkeep never rewrites it */
  listed_by_session?: string;
  /** with `completions` (account#57): this listing's own ID */
  listing_id?: string;
  /** the PC completed its add (the service's `completed_at`; with `completions`, POST /v1/pc/complete), and a device was admitted to it by its digits (`digit_admitted`) */
  completed_at?: string | null;
  digit_admitted?: boolean;
  /** this PC pulled its mailbox since the listing was made (the service's `pulled_since_listed`): the completion's evidence of its own */
  pulled_since_listed?: boolean;
  /**
   * With `pcAddProofs`, on a listing a device code made under Step 2: when that sign-in was made, which starts the listing's
   * LISTING_ASKS_MS, and who asked (the system its PUT named and the place the service saw it come from)
   */
  asking_since?: number;
  asking?: { os: AccountOs | null; country: string | null; city: string | null } }
/** How long a listing that asks to join may be let in, from the device-code sign-in that made it; past it 409 `listing_expired`. */
export const LISTING_ASKS_MS = 10 * 60_000;
/** How long a key proof's challenge (POST /v1/pcs/challenge) is good for. */
export const PC_ADD_CHALLENGE_TTL_MS = 2 * 60_000;
/** How long a PC added in one press stays new to the account's other devices. */
export const PC_NEW_MS = 24 * 60 * 60_000;
/** One-press PC adds one account may make per rolling day; past it 429 `pc_add_cap`. */
export const PC_ADMITS_PER_DAY = 3;
/** `key`: the waiting device's account key, which the PC matches against the comparison it is asked for. */
export interface FakeAdmission { id: string; server_id: string; account: string; label: string; key: string; at: string; os: AccountOs | null; country: string | null; city: string | null }
/** How long an admission reaches its PC's mailbox: the PC lets a waiting account device compare digits only within it. */
export const ADMISSION_TTL_MS = 10 * 60_000;
/** How long a PC invite works, once. */
export const PC_INVITE_TTL_MS = 15 * 60_000;
/** Open PC invites (POST /v1/pc-invites) one account may hold at once. */
export const INVITES_OPEN_MAX = 5;
/** How long GET /v1/pc-invites still lists an invite after a PC used it. */
export const INVITE_USED_SHOWN_MS = 24 * 60 * 60_000;
/** Invites one account may make, and redeems one PC may try, in a window; past it 429 `rate_limited` (retry-after 60). */
export const INVITES_PER_WINDOW = 20;
export const REDEEMS_PER_WINDOW = 10;
interface FakeInvite {
  /** `key`: the invite's public key (`invite_key`), all the service is given of it: the join line's private key never comes here */
  id: string; account: string; key: string; auto: boolean; family: string; madeAt: number; revoked: boolean;
  /** When it ends, in ms: PC_INVITE_TTL_MS after it was made, or a list's invite's `exp` when that is sooner (inviteEnd) */
  expiresAt?: number;
  used: { at: number; server_id: string; public_key: string; listing_id: string; label: string; os: AccountOs | null; country: string | null; city: string | null } | null;
}

interface Mail { seq: number; record: AccountRecord; at: number }

/** Devices one snapshot page lists. */
export const SNAPSHOT_PAGE = 100;

/** Device table P6, P21: an account's registered keys, each with a `no` that is never reused, and its durable records. */
interface Registry {
  next: number;
  version: number;
  /** Device table T58: raised when the account gains or loses a sign-in method */
  methods_version: number;
  devices: Map<string, { no: number; label: string; eligible: boolean; removed: boolean }>;
  blocks: BlockRecord[];
  lifts: DeviceLiftRecord[];
  freezes: SnapshotFreezeLine[];
}

type SnapshotState = Omit<AccountSnapshotPage, "page" | "last" | "v">;

/**
 * The limits of the signed list's routes (/v2, docs/development.md "The account service's list routes"), as the
 * service has them. Each instance copies them into `listLimits`, where a test may lower one.
 */
export const LIST_LIMITS = {
  /** From this `seq` on, only `remove` and `epoch` are placed (409 `list_full`). */
  removalsOnlyFrom: 16384,
  /** From this `seq` on, nothing is placed. */
  closedFrom: 20480,
  /** Past this many characters of the service's own state of the list as JSON after an entry, only `remove` and `epoch` are placed. */
  stateChars: 1024 * 1024,
  /** Past this many, only `remove`, which adds no row to the state. */
  stateHardChars: 1536 * 1024,
  /** Additions (`device`, `pc`, `invite`, `join`) one list takes in any ten minutes (429 `entry_budget`). */
  additionsPerWindow: 60,
  /** And in any 24 hours: the long-run bound, since a list's state only grows. */
  additionsPerDay: 96,
  /** Removals by one signer of the list in ten minutes (`remove` entries, at most one `epoch` last, at the head, from a caller that may write): they spend this, not the account's requests. */
  removalsPerWindow: 120,
  /** Attempts of the number comparison an adder opens on one PC's post in ten minutes (429 `attempts_spent`); a reveal is not counted. */
  attemptsPerWindow: 6,
  /** Calls of the list routes one proven PC makes in a minute (the service's MACHINE_LIMITER). */
  pcCallsPerMinute: 30,
};
/** How long a device's claim (POST /v2/lists/{list}/claims) and a PC's post of its keys (POST /v2/pc/list/keys) last. */
export const LIST_CLAIM_MS = 10 * 60_000;
/** Entries one log page holds at most, and about how much text. */
export const LIST_PAGE_MAX = 256;
export const LIST_PAGE_CHARS = 1024 * 1024;
/** Entries and wraps one placement carries at most. */
export const LIST_BATCH_MAX = 16;
export const LIST_WRAPS_MAX = 1024;
/** How far an entry's `issued_at` may lie ahead of the service's clock, in seconds, the genesis's too: the list's own time is the latest one a full signer wrote. */
export const LIST_ISSUED_AHEAD_S = 600;
/** Body limits of the list routes, in bytes. */
const LIST_BODY = { genesis: 32 * 1024, birth: 256 * 1024, entries: 512 * 1024, small: 8 * 1024 } as const;
/** A wrap as text: 151 base64url characters, the 113 bytes of Part C's wrap. */
const WRAP_TEXT = 151;
const WRAP_BYTES = 113;

/**
 * Whom a tamper rule lies to: a device by the sign-in of its token (a refresh keeps it), a PC by its server_id.
 * A rule without one lies to every reader.
 */
export type ListReader = { readonly token: string } | { readonly server_id: string };

/** A wrap as the list routes carry it. */
export interface ListWrap { readonly epoch: number; readonly member: string; readonly wrap: string }

/**
 * The lies a test makes the fake's list routes tell, for one list (`tamperList`). Nothing is on by default, and a
 * lie changes only what is served or refused: the log the service holds stays as placed. Each field names what a
 * member must survive.
 */
export interface ListTamper {
  /** Lie to this reader only; to every reader when left out. For `headMoved` and `dropWraps` it is the placer. */
  readonly reader?: ListReader;
  /** These texts are served after the log as if placed, the head moved to the last: an entry of a key that is no member is passed over (loose), never let in. */
  readonly inject?: readonly string[];
  /** These wraps are served in place of the stored ones for their member and epoch: a wrap to a key of the service's own does not match the chain's `epoch_opens` (`other_key`). */
  readonly wraps?: readonly ListWrap[];
  /** The log ends at this seq for the reader, its head with it: a removal after it never arrives, which only head gossip or a direct push can tell. */
  readonly withholdAfter?: number;
  /** Every answer reports this head (the log, which list, the mailbox): one the log does not reach shows the tail withheld; an old one is a hint that changes nothing. */
  readonly head?: ListPlace;
  /** The log is served with these texts in place of its own from the first one's seq on: two readers given two forks each hold a valid member-signed history, which only head gossip parts. */
  readonly fork?: readonly string[];
  /** Pages end after these seqs, `more` true: a reader that asks again `after` its last seq joins the same log whatever the cuts. */
  readonly pages?: readonly number[];
  /** This other list (another account's) is answered for this one, under this one's id: its entry 0 does not hash to the id the member pinned. */
  readonly answerList?: string;
  /** This id is reported as the account's list (GET /v2/lists/mine, POST /v2/pc/list, the mailbox's with_list), the log unchanged: the id is a hint, pinned only from a member. */
  readonly listId?: string;
  /** The links of these member keys are not served to a PC (POST /v2/pc/list/links): a service can withhold a link, never forge one. */
  readonly withholdLinks?: readonly string[];
  /** One byte of the body of the entry at this seq is flipped as served: it no longer holds (`signature_invalid`, or `entry_malformed`). */
  readonly flipEntry?: { readonly seq: number; readonly byte?: number };
  /** One byte of this member's wrap of this epoch is flipped as served: it does not open (`refused`), which is no evidence. */
  readonly flipWrap?: { readonly member: string; readonly epoch: number; readonly byte?: number };
  /** Every placement is refused 409 `head_moved` with the true head, forever: a writer stops after its own bound and says so. */
  readonly headMoved?: boolean;
  /** A placed batch's entries are stored and its wraps dropped: the new member sees no names, and is let in all the same. */
  readonly dropWraps?: boolean;
  /** Placements, and a PC's reads whose only right is its row in the list, answer 503 `list_rebuilding` (retry-after 1): the client sends the same request again. */
  readonly rebuilding?: boolean;
  /** The same calls answer 503 `list_stopped`: the client shows that the service cannot change the list. */
  readonly stopped?: boolean;
}

/**
 * Lies of the fake's about an account rather than one list (`tamperAccount`), for the migration's tests. Nothing is on by
 * default.
 */
export interface AccountTamper {
  /** A genesis, a birth or a placement is stored and its answer never comes: `fetch` rejects as a lost connection does. The client asks again and learns from `list_exists`, or `placed: 0`, what was stored. */
  readonly withholdAnswer?: boolean;
  /** These registered keys are listed eligible in the snapshot again, removed or not: a PC from before the list trusts it, one that follows the list does not. */
  readonly eligibleAgain?: readonly string[];
}

/** What accountList shows: the list's id, every entry as its text, the head, the service's own state, every stored wrap, the claims and posts that still lock, and the links (D11.2). */
export interface FakeListView {
  readonly id: string;
  readonly entries: readonly string[];
  readonly head: ListPlace;
  readonly state: ListState;
  readonly wraps: readonly ListWrap[];
  readonly claims: readonly { readonly key: string; readonly enc: string; readonly card: string; readonly until: number }[];
  readonly posts: readonly ListPostView[];
  /** Each member key's link: the registered sign-in key it names. */
  readonly links: readonly { readonly key: string; readonly device: string }[];
}

/**
 * A device's claim of its member key, by the sign-in (family) that took it at `at`, with the registered sign-in key its
 * link names (written with the member when its entry is placed), or null.
 */
interface ListClaim { readonly family: string; readonly enc: string; readonly card: string; readonly at: number; readonly link: string | null }
/**
 * The comparison of numbers a post carries (the formats' B7), which the service only carries: the adder's key and
 * commitment, then the PC's nonce, then the adder's reveal.
 */
export interface ListAttempt { readonly adder: string; readonly commitment: string; readonly nonce: string | null; readonly reveal: string | null }
/**
 * A PC's post of its keys, taken at `at`, with the attempt open on it, and the plain invite's key and its line's proof when
 * the PC joined by that line (null otherwise).
 */
interface ListPost {
  readonly server_id: string; readonly key: string; readonly enc: string; readonly card: string; readonly at: number; attempt: ListAttempt | null;
  readonly invite: { readonly key: string; readonly proof: string } | null;
}
/** A post as GET /v2/lists/{list}/posts shows it: `invite` and `invite_proof` only on a post that carried them. */
export interface ListPostView {
  readonly endpoint: string; readonly server_id: string; readonly key: string; readonly enc: string; readonly card: string; readonly until: number; readonly attempt: ListAttempt | null;
  readonly invite?: string; readonly invite_proof?: string;
}

/** A list as the service holds it: every entry as the text it was sent, its own state of the list (never served), wraps, claims and posts. */
interface FakeList {
  readonly id: string;
  readonly account: string;
  readonly texts: string[];
  readonly hashes: string[];
  last: HeldEntry;
  state: ListState;
  /** by member, then epoch: one wrap each, written once */
  readonly wraps: Map<string, Map<number, string>>;
  /** by the claimed key: one per key, and one per sign-in */
  readonly claims: Map<string, ListClaim>;
  /** by endpoint */
  readonly posts: Map<string, ListPost>;
  /** when each addition was placed, for the entry budget */
  readonly additions: number[];
  /** by member key: the registered sign-in key its link names (D11.2); one per member key, and one per registered key */
  readonly links: Map<string, string>;
  /** every link taken, oldest first, with its two signatures, kept when it gives way (POST /v2/pc/list/links serves them) */
  linkLog?: { readonly key: string; readonly device: string; readonly link: { readonly member: string; readonly device: string }; readonly linked_at: number }[];
  readonly tamper: { readonly rule: ListTamper; readonly family: string | null; readonly server_id: string | null }[];
}

/** Who reads or places: a device's sign-in, or a PC by its server_id and endpoint (its relay key). */
type ListCaller = { readonly family: string; readonly server_id?: undefined; readonly endpoint?: undefined } | { readonly family?: undefined; readonly server_id: string; readonly endpoint: string };

export class FakeAccountService {
  private readonly tokens = new Map<string, Session>();
  /** `link`: the sign-in (account and refresh family) a linking sign-in adds this identity to, once that sign-in redeems the code */
  private readonly codes = new Map<string, { account: string; provider: SignInProvider; challenge: string; redirect: string; expires: number; link: { account: string; family: string } | null }>();
  private readonly refreshTokens = new Map<string, { account: string; provider: SignInProvider; family: string; used: boolean }>();
  private readonly revokedFamilies = new Set<string>();
  private readonly appleTokens = new Map<string, { account: string; nonce: string }>();
  private readonly signIns = new Map<SignInProvider, string>();
  private readonly deviceSignIns = new Map<string, { provider: SignInProvider; userCode: string; account: string | null; denied: boolean; interval: number; nextPoll: number; expires: number; challenge: string | null; page?: boolean; requester?: { label: string | null; os: AccountOs | null } }>();
  private readonly identityList = new Map<string, Map<SignInProvider, { added_at: string }>>();
  private readonly linkTokens = new Map<string, { account: string; family: string; provider: SignInProvider; expires: number }>();
  /** by refresh family: when that sign-in was made (a refresh keeps it), for what needs a recent one */
  private readonly signedInAt = new Map<string, number>();
  /** by refresh family: the sign-in's two_step_set (null: unknown, as a Google sign-in without amr) */
  private readonly twoStep = new Map<string, boolean | null>();
  /** what a sign-in made through the sign-in routes says of two-step sign-in; tests set it */
  signInTwoStep: boolean | null = null;
  /** one-press admissions by account and PC (`box`), and each account's admit times, for the daily cap */
  private readonly pcAdmissions = new Map<string, { at: number; taken: boolean; family: string; listing?: string }>();
  private readonly admitTimes = new Map<string, number[]>();
  /** accounts that admitted or removed a PC: never empty again for the first-PC exemption */
  private readonly usedAccounts = new Set<string>();
  /** by refresh family: when that sign-in registered its own account device key (registerSessionKey) */
  private readonly keyRegisteredAt = new Map<string, number>();
  /** by key: the refresh family that registered it with registerSessionKey */
  private readonly keyFamily = new Map<string, string>();
  private offered: { providers: SignInProvider[]; device: SignInProvider[]; device_page?: SignInProvider[] } = { providers: ["github", "google", "apple"], device: ["github", "google"] };
  private readonly pushes = new Map<string, { account: string; endpoint: string }>();
  private readonly counters = new Map<string, { start: number; count: number }>();
  private readonly ringList: FakeRing[] = [];
  private readonly directories = new Map<string, Map<string, FakePc>>();
  private readonly mailboxes = new Map<string, Mail[]>();
  private readonly challenges = new Map<string, { server_id: string; expected: string; expires: number }>();
  /** box(server_id, account): when the PC left that account by its own proof */
  private readonly pcLeaves = new Map<string, number>();
  private readonly admissionList: FakeAdmission[] = [];
  /** quiet admissions: only an app's own sign-in posts one, and only a PC the account lists reads them */
  private readonly quietList: FakeAdmission[] = [];
  private readonly accountLimits = new Map<string, Record<string, unknown>>();
  private readonly subscribed = new Set<string>();
  private readonly deletedAccounts = new Set<string>();
  /** sign-ins made with a device code or on the link page, refreshes included: they cannot delete the account */
  private readonly deviceFamilies = new Set<string>();
  /** Where the service sees every request come from (Cloudflare's `request.cf`); unknown unless a test says. */
  requestPlace: AccountPlace = { country: null, city: null };
  linkPageAcceptsLabelAndOs = true;
  private readonly registries = new Map<string, Registry>();
  private readonly snapshots = new Map<string, SnapshotState>();
  /** OVIS_ACCOUNT_OPENS_ALL at the service: off, the snapshot and safety-record routes do not exist. */
  opensAll = false;
  /** Newer services distinguish a listed PC's snapshot opt-out from a hidden 404. */
  reportsStep2Off = false;
  /**
   * account#57: each listing has its own ID; a PC's admission may name it (`with_listing_id`), and the PC, once bound,
   * records its add complete with a proof scoped to that account and listing (POST /v1/pc/complete). Off: an older service,
   * which a PC no longer binds to in one press.
   */
  completions = true;
  /**
   * The mailbox says beside `listing_id` whether that listing stands on a one-press admission this PC took
   * (`listing_admitted`). Off: a service from before the field, which omits it.
   */
  saysListingAdmitted = true;
  /**
   * The one-press admit asks a used account's sign-in for two-step (`two_step_required`), as the service did until
   * 2026-11-23. Off, the service since: such an admit is logged as exempt instead.
   */
  admitAsksTwoStep = false;
  /**
   * The service since it takes key proofs: an own sign-in older than REAUTH_MS adds a PC (the admit, a confirm, and where
   * Step 2 is on a PUT that lists a PC the account does not list yet) only with a proof by the key registered for that very
   * sign-in, over a challenge of POST /v1/pcs/challenge; any own sign-in declines a listing that asks to join; such a listing
   * says who is asking and is let in only within LISTING_ASKS_MS (409 `listing_expired`). Off, the service before: no
   * challenge route (404), an admit's body that is not `{}` is 400 `invalid_request`, a PUT ignores `key_proof`, and the
   * admit, a confirm and a Decline all ask for a sign-in from the last ten minutes.
   */
  pcAddProofs = true;
  /**
   * With `pcAddProofs`, the service's switch for its list rule: on, an old own sign-in's PUT of a PC the account does not list yet is
   * refused `session_not_fresh` without a key proof. Off (as the service ships at first), such a PUT lists the PC as before;
   * a proof that is sent is judged all the same.
   */
  listProofRequired = true;
  /** POST /v1/pcs/challenge's challenges, by id: for one sign-in (family), spent by their first use */
  private readonly pcAddChallenges = new Map<string, { family: string; challenge: string; expires: number }>();
  /** PC invites (POST /v1/pc-invites and the routes beside it). Off: the feature is off for every account (404 `not_found`). */
  pcInvites = true;
  private readonly invites = new Map<string, FakeInvite>();
  /** box(server_id, account): the listing a plain invite made, whose card offers Add until `until` (409 `listing_expired` after) */
  private readonly inviteCards = new Map<string, { until: number; listing: string }>();
  private seq = 0;
  readonly requests: string[] = [];
  /**
   * OVIS_LIST_ACCOUNTS at the service: account ids separated by commas, or the one entry `*` for every account. For an
   * account it does not name, every /v2 route answers as an unknown one and the mailbox's `with_list` says `list: null`;
   * its list is kept. Empty, as the service ships: no account.
   */
  listAccounts = "";
  /**
   * OVIS_LIST_MIGRATE_ACCOUNTS at the service, read as `listAccounts` is: the accounts that may move onto a list by the
   * one-request birth (Part F, F10b). Empty, as the service ships: no account.
   */
  listMigrateAccounts = "";
  /** LIST_LIMITS, for this instance: a test lowers one to reach it. */
  readonly listLimits = { ...LIST_LIMITS };
  private readonly accountLies = new Map<string, AccountTamper>();
  private readonly lists = new Map<string, FakeList>();
  /** by account: its one list's id */
  private readonly accountLists = new Map<string, string>();
  /** by block id: when the service kept it, for frozenSignIn */
  private readonly blocksKeptAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `device`: the token is a device code's sign-in (a PC's), never an app's own */
  issueToken(account: string, { twoStep = null, device = false }: { twoStep?: boolean | null; device?: boolean } = {}): string {
    const token = randomHex(32);
    const family = randomHex(16);
    this.tokens.set(token, { account, provider: "test", family, expires: Number.POSITIVE_INFINITY });
    this.signedInAt.set(family, this.now());
    this.twoStep.set(family, twoStep);
    if (device) this.deviceFamilies.add(family);
    return token;
  }

  setLimits(account: string, limits: Record<string, unknown> | null): void {
    if (limits === null) this.accountLimits.delete(account);
    else this.accountLimits.set(account, limits);
  }

  signInAs(provider: SignInProvider, account: string): void { this.signIns.set(provider, account); }

  subscribe(account: string, renews = true): void { if (renews) this.subscribed.add(account); else this.subscribed.delete(account); }

  deleted(account: string): boolean { return this.deletedAccounts.has(account); }

  offerSignIns(providers: SignInProvider[], device: SignInProvider[]): void { this.offered = { providers, device }; }

  offerLinkPage(providers: SignInProvider[]): void { this.offered = { ...this.offered, device_page: providers }; }

  linkRequester(userCode: string): { label: string | null; os: AccountOs | null } | undefined {
    for (const entry of this.deviceSignIns.values()) if (entry.page && entry.userCode === userCode) return entry.requester;
    return undefined;
  }

  approveOnLinkPage(userCode: string, account: string, provider: SignInProvider): void {
    // one approval, as the service: an approved request's code names nothing any more
    for (const entry of this.deviceSignIns.values()) {
      if (entry.userCode === userCode && entry.page && entry.account === null && this.now() < entry.expires) { entry.account = account; entry.provider = provider; entry.userCode = ""; }
    }
  }


  private addIdentity(account: string, provider: SignInProvider): void {
    const methods = this.identityList.get(account) ?? new Map();
    if (!methods.has(provider)) { methods.set(provider, { added_at: this.iso() }); this.methodsChanged(account); }
    this.identityList.set(account, methods);
  }

  /** An identity token as Sign in with Apple hands an iOS app, for `account`, whose `nonce` claim is the hash the app gave Apple. */
  appleIdToken(account: string, nonceHash: string): string {
    const token = randomHex(32);
    this.appleTokens.set(token, { account, nonce: nonceHash });
    return token;
  }

  approveDevice(userCode: string, account: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.account = account;
  }

  denyDevice(userCode: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.denied = true;
  }

  rings(): readonly FakeRing[] { return this.ringList; }

  private ring(account: string, family: string): void {
    for (const [owner, push] of this.pushes) if (push.account === account && owner !== family) this.ringList.push({ account, endpoint: push.endpoint, payload: ACCOUNT_RING });
  }

  private withinRateLimit(key: string, max: number): boolean {
    const now = this.now();
    const counter = this.counters.get(key);
    if (!counter || now - counter.start >= LIMIT_WINDOW_MS) { this.counters.set(key, { start: now, count: 1 }); return true; }
    counter.count += 1;
    return counter.count <= max;
  }

  revokeToken(token: string): void { this.tokens.delete(token); }

  private grant(account: string, provider: SignInProvider, family?: string, device = false) {
    if (family === undefined) {
      family = randomHex(16);
      this.signedInAt.set(family, this.now());
      this.twoStep.set(family, this.signInTwoStep);
      if (device) this.deviceFamilies.add(family);
    }
    const access = randomHex(32);
    const refresh = randomHex(32);
    this.tokens.set(access, { account, provider, family, expires: this.now() + ACCESS_TOKEN_TTL_S * 1000 });
    this.refreshTokens.set(refresh, { account, provider, family, used: false });
    return json({ access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S, account, provider });
  }

  private signIn(url: URL, provider: string): Response {
    if (!SIGN_IN_PROVIDERS.includes(provider)) return problem(404, "not_found", "Unknown provider");
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!isAllowedRedirect(redirect)) return problem(400, "invalid_redirect_uri", "That redirect is not allowed");
    // the web redirect always takes the fragment; the app's scheme may ask for it; a loopback server never sees one
    const mode = url.searchParams.get("response_mode") ?? (redirect === WEB_REDIRECT ? "fragment" : "query");
    const loopback = redirect.startsWith("http://127.0.0.1:");
    if ((mode !== "fragment" && mode !== "query") || (redirect === WEB_REDIRECT && mode !== "fragment") || (loopback && mode !== "query")) {
      return problem(400, "invalid_request", "That response_mode does not go with that redirect");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length === 0) {
      return problem(400, "invalid_request", "Send state and an S256 code_challenge");
    }
    // a link token is spent here, but nothing is linked until its code is redeemed (token)
    const link = url.searchParams.get("link_token");
    const linking = link === null ? undefined : this.linkTokens.get(link);
    if (link !== null) this.linkTokens.delete(link);
    const valid = link === null || (linking !== undefined && linking.provider === provider && this.now() < linking.expires);
    const code = randomHex(32);
    if (valid) this.codes.set(code, { account: this.signIns.get(provider as SignInProvider) ?? `acct_${provider}`, provider: provider as SignInProvider, challenge, redirect, expires: this.now() + SIGNIN_CODE_TTL_MS, link: linking ? { account: linking.account, family: linking.family } : null });
    const back = new URL(redirect);
    const answer = new URLSearchParams(valid ? { code, state } : { error: "invalid_link", state });
    if (mode === "fragment") back.hash = answer.toString();
    else back.search = answer.toString();
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const invalid = (message: string) => problem(400, "invalid_grant", message);
    switch (body.grant_type) {
      case "authorization_code": {
        const code = typeof body.code === "string" ? this.codes.get(body.code) : undefined;
        if (typeof body.code === "string") this.codes.delete(body.code);
        if (!code || this.now() >= code.expires || body.redirect_uri !== code.redirect) return invalid("The code is wrong, spent or expired");
        if (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== code.challenge) return invalid("The code_verifier does not match");
        if (code.link === null) {
          this.addIdentity(code.account, code.provider);
          return this.grant(code.account, code.provider);
        }
        // a link commits only here, redeemed by the very sign-in that asked for it
        const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const holder = bearer === undefined ? undefined : this.tokens.get(bearer);
        if (holder === undefined || holder.family !== code.link.family || this.now() >= holder.expires || this.revokedFamilies.has(holder.family)) return invalid("Redeem a link with the sign-in that asked for it");
        if (code.account !== code.link.account && this.identityList.get(code.account)?.has(code.provider)) return problem(409, "identity_in_use", "That identity belongs to another account");
        this.signIns.set(code.provider, code.link.account);
        this.addIdentity(code.link.account, code.provider);
        return this.grant(code.link.account, code.provider);
      }
      case "refresh_token": {
        const refresh = typeof body.refresh_token === "string" ? this.refreshTokens.get(body.refresh_token) : undefined;
        if (!refresh || this.revokedFamilies.has(refresh.family)) return invalid("Sign in again");
        // a refresh token is good once: seeing it again means it leaked, so the whole family goes
        if (refresh.used) { this.revokeFamily(refresh.family); return invalid("Sign in again"); }
        refresh.used = true;
        return this.grant(refresh.account, refresh.provider, refresh.family);
      }
      case "apple_id_token": {
        const apple = typeof body.id_token === "string" ? this.appleTokens.get(body.id_token) : undefined;
        if (typeof body.id_token === "string") this.appleTokens.delete(body.id_token);
        // the app sends its plain nonce; Apple was given its SHA-256 in lowercase hex
        if (!apple || typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 128 || await sha256Hex(body.nonce) !== apple.nonce) return invalid("The identity token is not valid for that nonce");
        return this.grant(apple.account, "apple");
      }
      case "urn:ietf:params:oauth:grant-type:device_code": {
        const entry = typeof body.device_code === "string" ? this.deviceSignIns.get(body.device_code) : undefined;
        if (!entry || this.now() >= entry.expires) return problem(400, "expired_token", "Start the sign-in again");
        // a bound sign-in: refused before anything else, so a poll without the verifier moves nothing
        if (entry.challenge !== null && (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== entry.challenge)) {
          return invalid("That verifier is not this sign-in's");
        }
        if (this.now() < entry.nextPoll) {
          entry.interval += DEVICE_POLL_S;
          entry.nextPoll = this.now() + entry.interval * 1000;
          return problem(400, "slow_down", `Poll every ${entry.interval} seconds`);
        }
        entry.nextPoll = this.now() + entry.interval * 1000;
        if (entry.denied) { this.deviceSignIns.delete(body.device_code as string); return problem(400, "access_denied", "The sign-in was refused at the provider"); }
        if (entry.account === null) return problem(400, "authorization_pending", "Waiting for the sign-in at the provider");
        this.deviceSignIns.delete(body.device_code as string);
        this.addIdentity(entry.account, entry.provider);
        return this.grant(entry.account, entry.provider, undefined, true);
      }
      default: return problem(400, "unsupported_grant_type", "Use authorization_code, refresh_token or apple_id_token");
    }
  }

  /** POST /v1/signout/all: every sign-in of the account ends, codes not yet redeemed included; its PCs and device keys stay. */
  private signOutEverywhere(account: string): void {
    for (const held of [...this.tokens.values()]) if (held.account === account) this.revokeFamily(held.family);
    for (const [token, refresh] of this.refreshTokens) if (refresh.account === account) { this.revokedFamilies.add(refresh.family); this.refreshTokens.delete(token); }
    for (const [family, push] of this.pushes) if (push.account === account) this.pushes.delete(family);
    for (const [token, link] of this.linkTokens) if (link.account === account) this.linkTokens.delete(token);
    for (const [code, held] of this.codes) if (held.account === account) this.codes.delete(code);
    for (const [code, waiting] of this.deviceSignIns) if (waiting.account === account) this.deviceSignIns.delete(code);
  }

  private erase(account: string): void {
    this.signOutEverywhere(account);
    for (const [provider, signsInTo] of this.signIns) if (signsInTo === account) this.signIns.delete(provider);
    for (const key of [...this.mailboxes.keys()]) if (key.endsWith(`\0${account}`)) this.mailboxes.delete(key);
    for (const key of [...this.pcLeaves.keys()]) if (key.endsWith(`\0${account}`)) this.pcLeaves.delete(key);
    for (const key of [...this.counters.keys()]) if (key.endsWith(`:${account}`)) this.counters.delete(key);
    for (const list of [this.admissionList, this.quietList]) for (let index = list.length - 1; index >= 0; index--) if (list[index]?.account === account) list.splice(index, 1);
    this.identityList.delete(account);
    // the account's deletion is the only thing that deletes its list
    const list = this.accountLists.get(account);
    if (list !== undefined) this.lists.delete(list);
    this.accountLists.delete(account);
    this.directories.delete(account);
    this.accountLimits.delete(account);
    this.deletedAccounts.add(account);
  }

  private revokeFamily(family: string): void {
    this.revokedFamilies.add(family);
    for (const [token, session] of this.tokens) if (session.family === family) this.tokens.delete(token);
  }

  private registry(account: string): Registry {
    const registry = this.registries.get(account) ?? { next: 1, version: 1, methods_version: 0, devices: new Map(), blocks: [], lifts: [], freezes: [] };
    this.registries.set(account, registry);
    return registry;
  }

  /** Device table P18, P21: registers a key for the account (S2-19 adds the route) and returns its `no`. */
  /** The account device key the sign-in behind `token` registers now, as POST /v1/devices would. */
  registerSessionKey(token: string, key: string, label: string): number {
    const session = this.tokens.get(token);
    if (session === undefined) throw new Error("no such token");
    this.keyRegisteredAt.set(session.family, this.now());
    this.keyFamily.set(key, session.family);
    return this.registerDevice(session.account, key, label);
  }

  /**
   * Whether the account was ever used, as the service's first-PC exemption judges it (account#62, NEVER_USED_ADMIT and
   * NEVER_USED_CONFIRM): another PC listed but a device code's listing made under Step 2 that nobody confirmed or admitted
   * (PCL-1: anyone may type a code), a one-press admit or a member's removal ever; then device keys, revoked ones
   * included, but one this sign-in registered itself. For the admit (`kind` "admit") they count only once the account
   * had a confirmed or admitted PC, since a person may sign in on the phone first; for a confirm, always.
   */
  /**
   * Whether a listing is a member of its account, as the service's memberPc (NO_PC_YET's basis): a PC of the account where
   * Step 2 is on now, or one never pending under Step 2. A device code's listing made while Step 2 was off stays one.
   */
  private member(row: FakePc): boolean {
    return !this.opensAll || row.listed_by_device !== true || row.pending_under_step2 !== true;
  }

  /**
   * With `pcAddProofs`, a listing that asks to join: one a device code made while Step 2 was on, never confirmed, admitted
   * (by one press, a confirm or digits) or completed. Ending one cuts nobody off, so any own sign-in may.
   */
  private askingToJoin(row: FakePc): boolean {
    return this.pcAddProofs && this.opensAll && row.listed_by_device === true && row.pending_under_step2 === true && row.admitted_at == null && row.completed_at == null && row.digit_admitted !== true;
  }

  /** Such a listing past its LISTING_ASKS_MS, counted from the sign-in that made it (else from its own listing). */
  private askingExpired(row: FakePc): boolean {
    return this.askingToJoin(row) && this.now() - (row.asking_since ?? Date.parse(row.added_at)) > LISTING_ASKS_MS;
  }

  /** Who is asking, on an unconfirmed PC, as GET and PUT /v1/pcs give it with `pcAddProofs`. */
  private askingView(row: FakePc): Record<string, unknown> {
    if (!this.pcAddProofs || !this.opensAll || row.listed_by_device !== true) return {};
    return {
      asking_os: row.asking?.os ?? null, asking_country: row.asking?.country ?? null, asking_city: row.asking?.city ?? null,
      asking_until: this.askingToJoin(row) ? new Date((row.asking_since ?? Date.parse(row.added_at)) + LISTING_ASKS_MS).toISOString() : null,
    };
  }

  /**
   * The key `proof` proves for an add by `session`, as the service's: null without a proof, or when its signature is not by
   * the key that very sign-in registered (not removed, not frozen), over this purpose, account, PC, listing and challenge.
   * A Response for a malformed proof (400 `invalid_request`), or a challenge that is unknown, spent, past its two minutes or
   * another sign-in's (400 `challenge_invalid`); the challenge is spent whatever comes of it.
   */
  private async provedKey(session: Session, proof: unknown, purpose: PcAddPurpose, serverId: string, listingId: string): Promise<string | null | Response> {
    if (proof === undefined) return null;
    const shaped = keyProofOf(proof);
    if (shaped === null) return problem(400, "invalid_request", "Send key_proof as { challenge_id, signature }");
    const { challenge_id: id, signature } = shaped;
    const held = this.pcAddChallenges.get(id);
    if (held?.family === session.family) this.pcAddChallenges.delete(id);
    if (held === undefined || held.family !== session.family || this.now() > held.expires) return problem(400, "challenge_invalid", "Ask for a new challenge and sign it");
    const registry = this.registries.get(session.account);
    const key = [...this.keyFamily].find(([each, family]) => {
      const device = registry?.devices.get(each);
      return family === session.family && device !== undefined && !device.removed && !this.frozen(registry!, device.no);
    })?.[0];
    if (key === undefined) return null;
    try {
      const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(key)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const bytes = pcAddSigningBytes(purpose, session.account, serverId, listingId, id, held.challenge);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, new Uint8Array(fromBase64Url(signature)), bytes) ? key : null;
    } catch {
      return null;
    }
  }

  private everUsed(account: string, serverId: string, family: string, kind: "admit" | "confirm"): boolean {
    const rows = [...(this.directories.get(account)?.values() ?? [])];
    const pending = (row: FakePc): boolean => row.pending_under_step2 === true && row.listed_by_device === true && row.admitted_at == null;
    if (rows.some((row) => row.server_id !== serverId && !pending(row)) || this.usedAccounts.has(account)) return true;
    const keys = [...(this.registries.get(account)?.devices.keys() ?? [])].filter((key) => this.keyFamily.get(key) !== family);
    if (keys.length === 0) return false;
    if (kind === "confirm") return true;
    return rows.some((row) => row.admitted_at != null || (row.server_id !== serverId && row.listed_by_device !== true));
  }

  registerDevice(account: string, key: string, label: string, eligible = true): number {
    const registry = this.registry(account);
    const known = registry.devices.get(key);
    if (known) return known.no;
    const no = registry.next++;
    registry.devices.set(key, { no, label, eligible, removed: false });
    registry.version += 1;
    return no;
  }

  /** Device table T36 (service effect): the key leaves the list and keeps its `no` in `removed`. */
  removeDevice(account: string, key: string): void {
    const device = this.registry(account).devices.get(key);
    if (!device || device.removed) return;
    device.removed = true;
    this.registry(account).version += 1;
  }

  private methodsChanged(account: string): void {
    const registry = this.registry(account);
    registry.methods_version += 1;
    registry.version += 1;
  }

  /** Makes every snapshot id handed out so far answer `snapshot_gone`. */
  dropSnapshots(): void { this.snapshots.clear(); }

  pcs(account: string): FakePc[] { return [...this.directories.get(account)?.values() ?? []]; }

  admissions(): readonly FakeAdmission[] { return this.admissionList; }

  quietAdmissions(): readonly FakeAdmission[] { return this.quietList; }

  mailbox(serverId: string, account: string): AccountRecord[] {
    this.expire();
    return (this.mailboxes.get(box(serverId, account)) ?? []).map(({ record }) => record);
  }

  dropQueuedRecords(serverId: string, account: string, predicate: (record: AccountRecord) => boolean): void {
    const key = box(serverId, account);
    this.mailboxes.set(key, (this.mailboxes.get(key) ?? []).filter(({ record }) => !predicate(record)));
  }

  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith("/v2/")) return await this.v2(request, url);
      if (url.pathname.startsWith("/v1/pc/")) return await this.pc(request, url.pathname);
      const leaving = /^\/v1\/pcs\/([0-9a-f]{32})\/leave$/.exec(url.pathname)?.[1];
      if (leaving !== undefined && request.method === "POST") return await this.leave(request, leaving);
      if (url.pathname === "/v1/pc-invites/redeem" && request.method === "POST") return await this.redeem(request);
      const provider = /^\/v1\/signin\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (provider !== undefined && request.method === "GET") return this.signIn(url, provider);
      if (url.pathname === "/v1/token" && request.method === "POST") return await this.token(request);
      if (url.pathname === "/v1/providers" && request.method === "GET") return json(this.offered);
      if (url.pathname === "/v1/signin/ovis/device" && request.method === "POST" && (this.offered.device_page ?? []).length > 0) {
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        const label = body.label;
        if (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)
          || (label !== undefined && (typeof label !== "string" || label.length < 1 || label.length > 48 || /[\p{Cc}\p{Cs}]/u.test(label)))
          || Object.keys(body).some((name) => !["code_challenge", "code_challenge_method", ...(this.linkPageAcceptsLabelAndOs ? ["label", "os"] : [])].includes(name))) {
          return problem(400, "invalid_request", "Start a sign-in on the link page with an S256 code_challenge, and a label of 1-48 characters if any");
        }
        const deviceCode = randomHex(32);
        const letters = "BCDFGHJKLMNPQRSTVWXZ";
        const pick = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => letters[byte % letters.length]).join("");
        const userCode = `${pick()}-${pick()}`;
        this.deviceSignIns.set(deviceCode, { provider: "github", userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + 600_000, challenge: body.code_challenge, page: true, requester: { label: typeof label === "string" ? label : null, os: accountOsOf(body.os) } });
        const page = new URL("/link", url.origin);
        const complete = new URL(page);
        complete.searchParams.set("code", userCode);
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: page.href, verification_uri_complete: complete.href, expires_in: 600, interval: DEVICE_POLL_S, code_challenge_method: "S256" });
      }
      const deviceProvider = /^\/v1\/signin\/([a-z]+)\/device$/.exec(url.pathname)?.[1];
      if (deviceProvider !== undefined && DEVICE_PAGES[deviceProvider] !== undefined && request.method === "POST") {
        const text = await request.text();
        const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
        // a device code can be phished (RFC 8628): it signs in, but never adds a method to an account
        if ("link_token" in body) return problem(400, "invalid_request", "Add a sign-in method through a redirect sign-in");
        const bound = Object.keys(body).length > 0;
        if (bound && (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge) || Object.keys(body).length !== 2)) {
          return problem(400, "invalid_request", "Start a device sign-in with nothing, or an S256 code_challenge");
        }
        const deviceCode = randomHex(32);
        const userCode = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
        this.deviceSignIns.set(deviceCode, { provider: deviceProvider as SignInProvider, userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + DEVICE_CODE_TTL_S * 1000, challenge: bound ? body.code_challenge as string : null });
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: DEVICE_PAGES[deviceProvider], expires_in: DEVICE_CODE_TTL_S, interval: DEVICE_POLL_S, ...(bound ? { code_challenge_method: "S256" } : {}) });
      }
      if (url.pathname === "/v1/push/key" && request.method === "GET") return json({ public_key: "BFakeVapidPublicKeyForTests" });
      return await this.client(request, url.pathname);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      if (error instanceof SyntaxError) return problem(400, "invalid_json", "The body is not JSON");
      throw error;
    }
  };

  private async client(request: Request, path: string): Promise<Response> {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family)) return problem(401, "unauthorized", "Sign in again");
    const account = session.account;
    if (!this.withinRateLimit(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW)) return problem(429, "rate_limited", "Too many requests; try again later");
    if (path === "/v1/signout" && request.method === "POST") {
      this.revokeFamily(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "PUT") {
      const body = await request.json() as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      if (typeof body.endpoint !== "string" || !URL.canParse(body.endpoint) || typeof body.keys?.p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(body.keys.p256dh)
        || typeof body.keys.auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.keys.auth)) return problem(400, "invalid_endpoint", "Send the subscription's endpoint and keys");
      this.pushes.set(session.family, { account, endpoint: body.endpoint });
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "DELETE") {
      this.pushes.delete(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities" && request.method === "GET") {
      return json({ identities: [...this.identityList.get(account) ?? []].map(([provider, { added_at }]) => ({ provider, added_at })) });
    }
    if (path === "/v1/account/limits" && request.method === "GET") {
      const limits = this.accountLimits.get(account);
      return limits ? json(limits) : problem(404, "not_found", "Unknown request");
    }
    const recent = this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) <= REAUTH_MS;
    if ((path === "/v1/identities/link" && request.method === "POST") || (path.startsWith("/v1/identities/") && request.method === "DELETE")) {
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
    }
    if (path === "/v1/signout/all" && request.method === "POST") {
      // as deleting the account: a device code's sign-in never signs the account's owner out, and only a recent one does
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      this.ring(account, session.family);
      this.signOutEverywhere(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/account" && request.method === "DELETE") {
      // a device code can be typed for someone else's PC: its sign-in must not end the account
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      if (this.subscribed.has(account)) return problem(409, "subscription_active", "Cancel the subscription in the billing portal first");
      this.erase(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities/link" && request.method === "POST") {
      const body = await request.json() as { provider?: unknown };
      if (typeof body.provider !== "string" || !this.offered.providers.includes(body.provider as SignInProvider)) return problem(400, "invalid_provider", "Name a provider this service offers");
      if (this.identityList.get(account)?.has(body.provider as SignInProvider)) return problem(409, "identity_exists", "The account already signs in with it");
      const token = randomHex(32);
      this.linkTokens.set(token, { account, family: session.family, provider: body.provider as SignInProvider, expires: this.now() + LINK_TOKEN_TTL_S * 1000 });
      return json({ link_token: token, expires_in: LINK_TOKEN_TTL_S });
    }
    const removed = /^\/v1\/identities\/([a-z]+)$/.exec(path)?.[1] as SignInProvider | undefined;
    if (removed !== undefined && request.method === "DELETE") {
      const methods = this.identityList.get(account);
      if (!methods?.has(removed)) return problem(404, "not_found", "The account does not sign in with it");
      if (methods.size === 1) return problem(409, "last_identity", "Add another way to sign in first");
      methods.delete(removed);
      this.methodsChanged(account);
      if (this.signIns.get(removed) === account) this.signIns.delete(removed);
      // the sign-ins made with it end
      for (const held of [...this.tokens.values()]) if (held.account === account && held.provider === removed) this.revokeFamily(held.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/pc-invites" || path.startsWith("/v1/pc-invites/")) return await this.inviteRoute(request, path, session, recent);
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    if (path === "/v1/session" && request.method === "GET") {
      return json({ account, own_sign_in: !this.deviceFamilies.has(session.family), signed_in_at: new Date(this.signedInAt.get(session.family) ?? this.now()).toISOString() });
    }
    if (path === "/v1/devices" && request.method === "GET" && this.opensAll) {
      // as the service: every key the account registered, with Step 2's word on it and without a block's freeze line
      // (rulings-migrate-3.md, its addendum on GET /v1/devices); the account's lie `eligibleAgain` lists a key again
      const registry = this.registry(account);
      const again = new Set(this.accountLies.get(account)?.eligibleAgain ?? []);
      return json({ methods_version: registry.methods_version, devices: [...registry.devices].sort(([, a], [, b]) => a.no - b.no).map(([key, device]) => ({
        no: device.no, key, registered_at: this.iso(), signed_in: true, removed: device.removed && !again.has(key), provider: "github", two_step_set: true,
        eligible: again.has(key) || (device.eligible && !device.removed),
        // the name the app sent when its sign-in registered the key, only where it sent one
        ...(device.label === "" ? {} : { label: device.label }),
      })) });
    }
    if (path === "/v1/pcs" && request.method === "GET") {
      // PCL-1: while step 2 is on, a PC listed by a device code and not confirmed only for `?include=unconfirmed`
      const unconfirmed = new URL(request.url).searchParams.get("include") === "unconfirmed";
      // null while step 2 is off for the account, and once passed
      const keyAt = this.keyRegisteredAt.get(session.family);
      return json({ pcs: [...directory.values()].filter((entry) => unconfirmed || !this.opensAll || entry.listed_by_device !== true).map((row) => {
        const { exempt, listed_by_device, pending_under_step2: _pending, listed_by_session: _lister, digit_admitted: _digits, pulled_since_listed: _pulled, asking_since: _since, asking: _asking, ...entry } = row;
        return {
          ...entry,
          unconfirmed: this.opensAll && listed_by_device === true,
          ...this.askingView(row),
          new_until: this.opensAll && entry.new_until != null && Date.parse(entry.new_until) > this.now() ? entry.new_until : null,
          admitted_at: this.opensAll ? entry.admitted_at ?? null : null,
          // the one admit no device was told about: shown to a device whose own key came after it
          admitted_before_you: this.opensAll && exempt === true && keyAt !== undefined && entry.admitted_at != null && Date.parse(entry.admitted_at) < keyAt,
        };
      }) });
    }
    if (path === "/v1/pcs/challenge" && request.method === "POST" && this.pcAddProofs && this.opensAll) {
      // a challenge for one key proof (pcAddSigningBytes), for an app's own sign-in only, spent by its first use
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in on this device first");
      const text = await request.text();
      const body: unknown = text.trim() === "" ? {} : JSON.parse(text);
      if (typeof body !== "object" || body === null || Object.keys(body).length > 0) return problem(400, "invalid_request", "Send {}");
      const id = randomHex(16);
      const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      this.pcAddChallenges.set(id, { family: session.family, challenge, expires: this.now() + PC_ADD_CHALLENGE_TTL_MS });
      return json({ challenge_id: id, challenge, expires_in: PC_ADD_CHALLENGE_TTL_MS / 1000 });
    }
    const admitted = /^\/v1\/pcs\/([0-9a-f]{32})\/admit$/.exec(path)?.[1];
    if (admitted !== undefined && request.method === "POST" && this.opensAll) {
      // the body is `{}`, or with `pcAddProofs` `{ key_proof }`: anything else is refused before the sign-in is looked at
      const text = await request.text();
      const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Object.keys(body).some((name) => !(this.pcAddProofs && name === "key_proof"))) return problem(400, "invalid_request", "Send {} or { key_proof }");
      // C1: an app's own sign-in, made within REAUTH_MS, or older with a proof by its own key for this PC's current listing
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in in the app itself");
      const signed = directory.get(admitted)?.listing_id ?? "";
      const proved = await this.provedKey(session, body.key_proof, "admit", admitted, signed);
      if (proved instanceof Response) return proved;
      if (!recent && proved === null) return problem(403, "session_not_fresh", "Sign in again on this device first");
      // as the service binds the signed listing into its write: one replaced while the proof was checked is not admitted
      if (proved !== null && (directory.get(admitted)?.listing_id ?? "") !== signed) return problem(409, "listing_changed", "This add is no longer waiting for that action");
      // the first-PC exemption: an account never used (no other PC, no admit or removal, no device key ever) waives two-step
      const exempt = this.twoStep.get(session.family) !== true;
      const entry = directory.get(admitted);
      const open = this.pcAdmissions.get(box(admitted, account));
      // a retry of this same sign-in's own admission, still open, gets the same answer: no second exemption is granted
      const retry = entry !== undefined && open !== undefined && !open.taken && open.family === session.family && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null;
      if (this.admitAsksTwoStep && exempt && !retry && this.everUsed(account, admitted, session.family, "admit")) return problem(403, "two_step_required", "Set up two-step sign-in first");
      if (entry === undefined) return problem(400, "unknown_pc", "List PCs of this account only");
      if (this.askingExpired(entry)) return problem(409, "listing_expired", "This PC asked to join more than ten minutes ago; start adding it again on the PC");
      if (this.cardExpired(admitted, account, entry)) return problem(409, "listing_expired", "This PC's card ran out; a new invite opens it again");
      if (open !== undefined && !open.taken && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null) {
        return json({ server_id: admitted, account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until });
      }
      // C4: the account's one-press adds of the last day
      const times = (this.admitTimes.get(account) ?? []).filter((at) => this.now() - at < PC_NEW_MS);
      if (times.length >= PC_ADMITS_PER_DAY) {
        const capped = problem(429, "pc_add_cap", "This account added enough PCs today");
        capped.headers.set("retry-after", String(Math.ceil((times[0]! + PC_NEW_MS - this.now()) / 1000)));
        return capped;
      }
      this.admitTimes.set(account, [...times, this.now()]);
      // one instant for the admission, its directory entry and this answer: a retry answers the same
      const at = this.now();
      this.pcAdmissions.set(box(admitted, account), { at, taken: false, family: session.family, ...(entry.listing_id === undefined ? {} : { listing: entry.listing_id }) });
      this.usedAccounts.add(account);
      entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      entry.admitted_at = new Date(at).toISOString();
      entry.exempt = exempt;
      entry.listed_by_device = false;
      this.ring(account, session.family);
      return json({ server_id: admitted, account, admitted_at: new Date(at).toISOString(), new_until: entry.new_until });
    }
    const pc = /^\/v1\/pcs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (pc !== undefined && request.method === "PUT") {
      const body = await request.json() as { label?: unknown; public_key?: unknown; relay?: unknown; confirm?: unknown; listing_id?: unknown; challenge_id?: unknown; proof?: unknown; key_proof?: unknown; os?: unknown };
      // PCL-1: only an app's own sign-in may say "this is my PC"; a device code can be typed for someone else's PC
      const own = !this.deviceFamilies.has(session.family);
      const confirm = body.confirm === true;
      // account#67: a confirm names the listing its card showed, and only a confirm does
      const named = body.listing_id !== undefined;
      if (named && (!confirm || typeof body.listing_id !== "string" || !LISTING_ID.test(body.listing_id))) return problem(400, "invalid_request", "Name a listing only to confirm it");
      if (confirm && !own) return problem(403, "own_sign_in_required", "Sign in on this device to confirm the PC");
      if (typeof body.label !== "string" || body.label.length < 1 || body.label.length > 48) return problem(400, "invalid_label", "Name the PC");
      // the key is stored, but it cannot be forged: it must give this server_id
      const key = proofKey(body.public_key);
      if (!key || deriveServerId(key) !== pc) return problem(400, "server_key_mismatch", "That key does not give that server_id");
      if (typeof body.relay !== "string" || !isWssOrigin(body.relay)) return problem(400, "invalid_relay", "Give the relay's wss origin");
      // the PC's own proof of this server_id, sent beside the entry when the PC itself lists it: it lists it again after its leave
      const proven = body.challenge_id !== undefined || body.proof !== undefined;
      if (proven && !this.takeProof({ server_id: pc, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      // with `pcAddProofs` an own sign-in adds a PC only from the last ten minutes, or older with a proof by its own key: a
      // confirm, and where Step 2 is on a PUT that lists a PC the account does not list yet. Upkeep of a listed PC and a device
      // code's listing ask nothing of the sign-in, and read no proof. The service before ignores `key_proof`
      if (this.pcAddProofs && body.key_proof !== undefined && keyProofOf(body.key_proof) === null) return problem(400, "invalid_request", "Send key_proof as { challenge_id, signature }");
      // an account that has a signed list lists a new PC only by a sign-in that may add one, whatever Step 2 and the list
      // rule's switch say: its listing is what the list's `pc` lock counts
      const hasList = this.listOfAccount(account) !== undefined;
      if (this.pcAddProofs && own && (confirm || ((this.opensAll || hasList) && !directory.has(pc)))) {
        const listing = named ? body.listing_id as string : directory.get(pc)?.listing_id ?? "";
        const proved = await this.provedKey(session, body.key_proof, confirm ? "confirm" : "list", pc, listing);
        if (proved instanceof Response) return proved;
        const enforced = confirm || this.listProofRequired || hasList || body.key_proof !== undefined;
        if (!recent && proved === null && enforced) return problem(403, "session_not_fresh", "Sign in again on this device first");
      }
      // PCL-4: a confirm asks what the one-press admit asks of the sign-in: fresh (or proved, above), and two-step set unless the
      // account was never used; and a listing that asks to join is confirmed only within its ten minutes
      if (confirm) {
        if (!this.pcAddProofs && !recent) return problem(403, "session_not_fresh", "Sign in again on this device first");
        if (this.twoStep.get(session.family) !== true && this.everUsed(account, pc, session.family, "confirm")) return problem(403, "two_step_required", "Two-step sign-in must be on for one press; add this PC with the number");
        const listed = directory.get(pc);
        if (listed !== undefined && this.askingExpired(listed)) return problem(409, "listing_expired", "This PC asked to join more than ten minutes ago; start adding it again on the PC");
      }
      const fresh = !directory.has(pc);
      const leftAt = this.pcLeaves.get(box(pc, account));
      if (fresh && !proven && leftAt !== undefined && this.now() - leftAt < PC_LEFT_MS) {
        return json({ error: { left_at: new Date(leftAt).toISOString(), code: "pc_left", message: "This PC left the account; sign in on the PC to add it again" } }, 409);
      }
      if (fresh && directory.size >= DIRECTORY_MAX) return problem(409, "directory_full", "Remove a PC first");
      // a re-PUT (the nine-minute relist) keeps the PC's admission and its confirmation mark
      const before = directory.get(pc);
      // a named confirm acts only on that listing, still the PC's current one and still unconfirmed, and writes the confirm alone
      if (named && (before === undefined || before.listing_id !== body.listing_id || before.listed_by_device !== true)) {
        return problem(409, "listing_changed", "This add is no longer waiting for that action");
      }
      const confirming = confirm && before?.listed_by_device === true;
      const entry: FakePc = { server_id: pc, ...(named ? { label: before!.label, public_key: before!.public_key, relay: before!.relay } : { label: body.label, public_key: body.public_key as string, relay: body.relay }), added_at: before?.added_at ?? this.iso(), last_seen_at: before?.last_seen_at ?? null,
        ...(before?.new_until == null ? {} : { new_until: before.new_until, admitted_at: before.admitted_at ?? null, exempt: before.exempt ?? false }),
        listed_by_device: before === undefined ? !own : before.listed_by_device === true && !confirming,
        pending_under_step2: before === undefined ? !own && this.opensAll : before.pending_under_step2 === true,
        ...(before === undefined ? { listed_by_session: session.family } : before.listed_by_session === undefined ? {} : { listed_by_session: before.listed_by_session }),
        ...(this.completions ? { listing_id: before?.listing_id ?? randomHex(16), completed_at: before?.completed_at ?? null } : {}),
        // upkeep keeps the listing, and with it the mark of the PC's pull since it was made
        ...(before?.pulled_since_listed === true ? { pulled_since_listed: true } : {}),
        // a listing that asks to join keeps, from its own listing on, when its sign-in was made and who asked; a confirm clears who
        ...(before === undefined
          ? !own && this.opensAll && this.pcAddProofs ? { asking_since: this.signedInAt.get(session.family) ?? this.now(), asking: { os: accountOsOf(body.os), ...this.requestPlace } } : {}
          : { ...(before.asking_since === undefined ? {} : { asking_since: before.asking_since }), ...(before.asking === undefined || confirming ? {} : { asking: before.asking }) }) };
      // a confirm makes the PC one the account's devices open, as the admit does: new to them for PC_NEW_MS (C3). It
      // writes no admission: the row it confirms is what makes the account used from then on
      if (confirming) {
        entry.admitted_at = this.iso();
        entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      }
      directory.set(pc, entry);
      if (proven) this.pcLeaves.delete(box(pc, account));
      if (fresh || confirming) this.ring(account, session.family);
      const { exempt: _exempt, listed_by_device, pending_under_step2: _pending, listed_by_session: _lister, digit_admitted: _digits, pulled_since_listed: _pulled, asking_since: _since, asking: _asking, ...shown } = entry;
      return json({ pc: { ...shown, unconfirmed: this.opensAll && listed_by_device === true, ...this.askingView(entry) } });
    }
    if (pc !== undefined && request.method === "DELETE") {
      // account#67: a Decline names the listing its card showed; after the sign-in checks, it removes only that listing while
      // it still asks to join (not admitted by one press, a confirm or digits, and not completed)
      const named = new URL(request.url).searchParams.get("listing_id");
      if (named !== null && !LISTING_ID.test(named)) return problem(400, "invalid_request", "That is no listing ID");
      const listed = directory.get(pc);
      const changed = named !== null && (listed === undefined || listed.listing_id !== named || listed.admitted_at != null || listed.digit_admitted === true || listed.completed_at != null);
      // PCR-1: removing unbinds the PC and cuts the account's devices off it, so it asks what deleting the account asks. The
      // compat ruling's one exception: a device code's sign-in ends its own listing (written by it, never confirmed, admitted
      // or completed), as an installed CLI renews its card
      if (this.deviceFamilies.has(session.family)) {
        const own = directory.get(pc);
        // as the service: written by this sign-in, never confirmed, admitted (one press or digits) or completed
        if (own === undefined || own.listed_by_session !== session.family || own.listed_by_device !== true || own.admitted_at != null
          || own.completed_at != null || own.digit_admitted === true) {
          return problem(403, "own_sign_in_required", "Sign in on this device to remove a PC");
        }
        if (changed) return problem(409, "listing_changed", "This PC no longer asks to join by that listing");
        directory.delete(pc);
        // ruling (b): a member's end is a member's removal (the account is used); a listing pending under Step 2 was never one
        if (this.member(own)) this.usedAccounts.add(account);
        return new Response(null, { status: 204 });
      }
      // with `pcAddProofs` an own sign-in of any age ends a listing that still asks to join: it cuts nobody off, so saying No
      // is never harder than Add
      if (!recent && !(listed !== undefined && this.askingToJoin(listed))) return problem(403, "reauth_required", "Sign in again first");
      if (changed) return problem(409, "listing_changed", "This PC no longer asks to join by that listing");
      const removed = directory.get(pc);
      directory.delete(pc);
      this.pcAdmissions.delete(box(pc, account));
      // PCL-1: ending a listing that was never the account's (unconfirmed under Step 2) is no member's removal
      if (removed !== undefined && this.member(removed)) this.usedAccounts.add(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/records" && request.method === "POST") {
      const body = await request.json() as { server_ids?: unknown; record?: unknown };
      if (!Array.isArray(body.server_ids) || body.server_ids.length > ACCOUNT_RECORDS_MAX || !body.server_ids.every((id) => typeof id === "string" && directory.has(id))) {
        return problem(400, "unknown_pc", "List PCs of this account only");
      }
      const record = await readAccountRecord(body.record);
      if (!record) return problem(400, "signature_invalid", "The signature does not hold");
      if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
      const targets = [...new Set(body.server_ids as string[])];
      this.expire();
      if (targets.some((id) => (this.mailboxes.get(box(id, account))?.length ?? 0) >= MAILBOX_MAX)) return problem(429, "mailbox_full", "That PC has not collected its records");
      for (const id of targets) {
        const queue = this.mailboxes.get(box(id, account)) ?? [];
        queue.push({ seq: ++this.seq, record, at: this.now() });
        this.mailboxes.set(box(id, account), queue);
      }
      return json({ queued: new Set(body.server_ids).size });
    }
    if (path === "/v1/safety-records" && request.method === "POST" && this.opensAll) return await this.safetyRecord(account, await request.json());
    if (path === "/v1/admissions" && request.method === "GET") {
      // what the approving client checks the key PC X shows it against, before it signs an add
      const admissions = this.admissionList
        .filter((a) => a.account === account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, server_id, at, os, country, city }) => ({ key, label, server_id, at, os, country, city }));
      return json({ admissions });
    }
    if (path === "/v1/admissions" && request.method === "POST") {
      const body = await request.json() as { server_id?: unknown; label?: unknown; key?: unknown; os?: unknown; quiet?: unknown };
      if (body.quiet !== undefined && typeof body.quiet !== "boolean") return problem(400, "invalid_request", "quiet is true or false");
      if (typeof body.server_id !== "string" || !directory.has(body.server_id) || typeof body.label !== "string") return problem(400, "unknown_pc", "List PCs of this account only");
      if (!isAccountKeyEncoding(body.key)) return problem(400, "invalid_key", "Name the waiting device's account key");
      // quiet only for an app's own sign-in: one a typed device code opened gets the ordinary kind
      const quiet = body.quiet === true && !this.deviceFamilies.has(session.family);
      if (!this.withinRateLimit(quiet ? `quiet_admissions:${account}` : `admissions:${account}`, quiet ? QUIET_ADMISSIONS_PER_WINDOW : ADMISSIONS_PER_WINDOW)) return problem(429, "too_many_admissions", "Too many requests; try again later");
      const admission = { id: randomHex(16), server_id: body.server_id, account, label: body.label, key: body.key, at: this.iso(), os: accountOsOf(body.os), ...this.requestPlace };
      (quiet ? this.quietList : this.admissionList).push(admission);
      if (!quiet) this.ring(account, session.family);
      return json({ id: admission.id });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /** Spends the challenge `body` names and says whether `body.proof` answers it for `body.server_id`. */
  private takeProof(body: { server_id: unknown; challenge_id: unknown; proof: unknown }): { server_id: string } | null {
    const challenge = typeof body.challenge_id === "string" ? this.challenges.get(body.challenge_id) : undefined;
    if (typeof body.challenge_id === "string") this.challenges.delete(body.challenge_id);
    if (!challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) return null;
    return { server_id: challenge.server_id };
  }

  /** A plain invite's listing that nobody admitted within its card's ten minutes: Add is no longer offered for it. */
  private cardExpired(serverId: string, account: string, entry: FakePc): boolean {
    const card = this.inviteCards.get(box(serverId, account));
    return card !== undefined && entry.listing_id === card.listing && entry.new_until == null && this.now() > card.until;
  }

  /**
   * POST, GET /v1/pc-invites and DELETE /v1/pc-invites/{id}: an own sign-in's. The fake holds no key-proof challenges
   * (POST /v1/pcs/challenge), so a stale sign-in makes no invite here, `key_proof` or not.
   */
  private async inviteRoute(request: Request, path: string, session: Session, recent: boolean): Promise<Response> {
    const account = session.account;
    if (!this.pcInvites) return problem(404, "not_found", "Unknown request");
    if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in in the app itself");
    const now = this.now();
    const open = (invite: FakeInvite) => this.inviteOpen(invite, now);
    if (path === "/v1/pc-invites" && request.method === "POST") {
      let body: unknown;
      try { body = JSON.parse(await request.text()); } catch { return problem(400, "invalid_request", "Send a JSON object"); }
      const made = body as { invite_key?: unknown; auto?: unknown; key_proof?: unknown };
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((name) => !["invite_key", "auto", "key_proof"].includes(name))
        || (made.auto !== undefined && typeof made.auto !== "boolean")
        || typeof made.invite_key !== "string" || !isListKeyEncoding(made.invite_key) || !isListPoint(made.invite_key)) return problem(400, "invalid_request", "Send the invite's public key, and auto and key_proof only");
      if ((body as { key_proof?: unknown }).key_proof !== undefined) return problem(400, "challenge_invalid", "Ask for a new challenge and answer it");
      if (!recent) return problem(403, "session_not_fresh", "Sign in again on this device first");
      if (!this.withinRateLimit(`invites:${account}`, INVITES_PER_WINDOW)) return limited("rate_limited", 60);
      if ([...this.invites.values()].filter((invite) => invite.account === account && open(invite)).length >= INVITES_OPEN_MAX) return problem(409, "invites_full", "Revoke an open invite first");
      // an auto invite would be refused at its redeem: it is refused here, while the person who makes it is there to read why
      const times = (this.admitTimes.get(account) ?? []).filter((at) => now - at < PC_NEW_MS);
      if (made.auto === true && times.length >= PC_ADMITS_PER_DAY) return limited("pc_add_cap", Math.ceil((times[0]! + PC_NEW_MS - now) / 1000));
      // a key is an invite once, of any account, open or not, and never a device's
      if (this.inviteKeyUsed(made.invite_key)) return problem(409, "invite_key_used", "Make a new key for a new invite");
      const invite: FakeInvite = { id: randomHex(16), account, key: made.invite_key, auto: made.auto === true, family: session.family, madeAt: now, revoked: false, used: null };
      this.invites.set(invite.id, invite);
      return json({ id: invite.id, account, expires_at: new Date(now + PC_INVITE_TTL_MS).toISOString(), auto: invite.auto });
    }
    if (path === "/v1/pc-invites" && request.method === "GET") {
      const maker = (family: string) => {
        const key = [...this.keyFamily].find(([, of]) => of === family)?.[0];
        const device = key === undefined ? undefined : this.registries.get(account)?.devices.get(key);
        return { device_no: device?.no ?? null, device_label: device?.label ?? null };
      };
      return json({ invites: [...this.invites.values()].filter((invite) => invite.account === account && (open(invite) || (invite.used !== null && now - invite.used.at < INVITE_USED_SHOWN_MS)))
        .map((invite) => ({
          id: invite.id, made_at: new Date(invite.madeAt).toISOString(), expires_at: new Date(inviteEnd(invite)).toISOString(), auto: invite.auto,
          ...maker(invite.family), yours: invite.family === session.family, used_at: invite.used === null ? null : new Date(invite.used.at).toISOString(),
          used_by: invite.used === null ? null : { server_id: invite.used.server_id, listing_id: invite.used.listing_id, label: invite.used.label, os: invite.used.os, country: invite.used.country, city: invite.used.city },
        })) });
    }
    const id = /^\/v1\/pc-invites\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (id !== undefined && request.method === "DELETE") {
      const invite = this.invites.get(id);
      if (invite === undefined || invite.account !== account) return problem(404, "not_found", "No such invite");
      if (invite.used !== null) return problem(409, "invite_used", "A PC used this invite; remove that PC instead");
      invite.revoked = true;
      return new Response(null, { status: 204 });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /**
   * POST /v1/pc-invites/redeem: a PC, with no sign-in, lists itself in the invite's account on its own key's proof. One
   * body for every dead or malformed invite. A plain invite's listing waits for Add on its card for ten minutes; an auto
   * invite's is admitted at once, within the account's daily one-press cap. The same PC and key asking again while its
   * listing is current get the same answer.
   */
  private async redeem(request: Request): Promise<Response> {
    if (!this.pcInvites) return problem(404, "not_found", "Unknown request");
    let body: Record<string, unknown>;
    try { body = JSON.parse(await request.text()) as Record<string, unknown>; } catch { return problem(400, "invalid_request", "Send a JSON object"); }
    const strings = ["invite_key", "invite_signature", "server_id", "public_key", "relay", "label", "challenge_id", "proof"];
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((name) => name !== "os" && !strings.includes(name))
      || strings.some((name) => typeof body[name] !== "string") || (body.os !== undefined && accountOsOf(body.os) === null) || !/^[0-9a-f]{32}$/.test(body.server_id as string)) {
      return problem(400, "invalid_request", "Send the invite's key and signature, this PC's listing and its proof");
    }
    const serverId = body.server_id as string;
    const publicKey = body.public_key as string;
    const label = body.label as string;
    if (!this.withinRateLimit(`redeems:${serverId}`, REDEEMS_PER_WINDOW)) return limited("rate_limited", 60);
    const key = proofKey(publicKey);
    if (!key || deriveServerId(key) !== serverId) return problem(400, "server_key_mismatch", "That key does not give that server_id");
    if (!isWssOrigin(body.relay as string)) return problem(400, "invalid_relay", "Give the relay's wss origin");
    if (label.length < 1 || label.length > 48 || /\p{Cc}/u.test(label)) return problem(400, "invalid_label", "Name the PC in 1-48 characters");
    if (!this.takeProof({ server_id: serverId, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const dead = problem(400, "invite_invalid", "This invite does not work");
    const invite = [...this.invites.values()].find((held) => held.key === body.invite_key);
    if (invite === undefined || invite.revoked || this.now() >= inviteEnd(invite) || this.deletedAccounts.has(invite.account)) return dead;
    // an invite lives with the sign-in that made it: once that ends, an unused one redeems nothing (a used one still answers its PC)
    const makerGone = this.revokedFamilies.has(invite.family);
    if (invite.used === null && makerGone) return dead;
    // held by whoever holds the line: its private key signed for this account, this PC and this challenge (the account from the row, never the request)
    if (!await verifyInviteRedeem({ account: invite.account, server_id: serverId, public_key: publicKey, challenge_id: body.challenge_id as string }, body.invite_signature, invite.key)) return dead;
    // an account that has a list redeems only an invite its list holds as open (D11.5), told only to a PC that holds the line;
    // a used invite is past this, so the same PC's retry is answered as before whatever the list says of it since
    // an unused invite that ran out while its proof was checked redeems nothing
    if (invite.used === null && this.now() >= inviteEnd(invite)) return dead;
    const asked = invite.used === null ? this.listOfAccount(invite.account) : undefined;
    if (asked !== undefined) {
      const halted = this.halted(asked, { server_id: serverId, endpoint: publicKey });
      if (halted !== null) return halted;
      if (!this.listHoldsInvite(asked, invite.key)) return problem(409, "invite_not_in_list", "This account has a signed list, and the list holds no open invite of this key; a device places the invite's entry first");
    }
    const account = invite.account;
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    const before = directory.get(serverId);
    if (invite.used !== null) {
      const same = invite.used.server_id === serverId && invite.used.public_key === publicKey && before?.listing_id === invite.used.listing_id;
      return same ? json(redeemed(account, invite.used.listing_id, invite.auto, invite.used.at, makerGone)) : dead;
    }
    if (before === undefined && directory.size >= DIRECTORY_MAX) return problem(409, "directory_full", "Remove a PC first");
    const times = (this.admitTimes.get(account) ?? []).filter((at) => this.now() - at < PC_NEW_MS);
    // the invite stays open: the cap is the account's, not the invite's
    if (invite.auto && times.length >= PC_ADMITS_PER_DAY) return limited("pc_add_cap", Math.ceil((times[0]! + PC_NEW_MS - this.now()) / 1000));
    const at = this.now();
    const listing = randomHex(16);
    const entry: FakePc = { server_id: serverId, label, public_key: publicKey, relay: body.relay as string, added_at: new Date(at).toISOString(), last_seen_at: before?.last_seen_at ?? null,
      listed_by_device: !invite.auto, pending_under_step2: this.opensAll && !invite.auto, listed_by_session: invite.family, listing_id: listing, completed_at: null };
    const place = box(serverId, account);
    this.pcAdmissions.delete(place);
    this.inviteCards.delete(place);
    if (invite.auto) {
      this.admitTimes.set(account, [...times, at]);
      // the maker's session's, as a one-press admit's: it ends with that sign-in (the listing stays confirmed)
      this.pcAdmissions.set(place, { at, taken: false, family: invite.family, listing });
      this.usedAccounts.add(account);
      entry.new_until = new Date(at + PC_NEW_MS).toISOString();
      entry.admitted_at = new Date(at).toISOString();
      entry.exempt = false;
    } else this.inviteCards.set(place, { until: at + ADMISSION_TTL_MS, listing });
    directory.set(serverId, entry);
    this.pcLeaves.delete(place);
    invite.used = { at, server_id: serverId, public_key: publicKey, listing_id: listing, label, os: accountOsOf(body.os), ...this.requestPlace };
    this.ring(account, "");
    return json(redeemed(account, listing, invite.auto, at));
  }

  /**
   * The PC leaves an account by its own proof, with no bearer (`ovis logout`, account#65): as a DELETE /v1/pcs does, the
   * listing and its untaken admission end; its mailbox and admissions for the account go; and for PC_LEFT_MS a PUT
   * lists it again only with the PC's own proof. 204 whether or not the account listed it.
   */
  private async leave(request: Request, serverId: string): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    if (body.server_id !== serverId || typeof body.account !== "string" || body.challenge_id === undefined || body.proof === undefined) {
      return problem(400, "invalid_request", "Name this PC and the account it leaves");
    }
    if (!this.takeProof({ server_id: serverId, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const account = body.account;
    const key = box(serverId, account);
    const directory = this.directories.get(account);
    const removed = directory?.get(serverId);
    directory?.delete(serverId);
    this.pcAdmissions.delete(key);
    this.mailboxes.delete(key);
    for (const list of [this.admissionList, this.quietList]) {
      for (let index = list.length - 1; index >= 0; index--) if (list[index]!.server_id === serverId && list[index]!.account === account) list.splice(index, 1);
    }
    if (!this.deletedAccounts.has(account)) this.pcLeaves.set(key, this.now());
    if (removed !== undefined) {
      if (!(this.opensAll && removed.listed_by_device === true)) this.usedAccounts.add(account);
      this.ring(account, "");
    }
    return new Response(null, { status: 204 });
  }

  private async pc(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST") return problem(404, "not_found", "Unknown request");
    const body = await request.json() as Record<string, unknown>;
    if (path === "/v1/pc/challenge") {
      const key = proofKey(body.public_key);
      if (!key || typeof body.server_id !== "string" || deriveServerId(key) !== body.server_id) return problem(401, "server_key_mismatch", "That key does not give that server_id");
      const challengeId = randomHex(16);
      // a completion's proof is scoped to its account and listing: its context is not a wire nonce (account#57)
      const scope = this.completions ? completionScope(body.completion) : null;
      if (body.completion !== undefined && scope === null) return problem(400, "invalid_body", "Name the account and listing");
      const context = scope ? completionKey(scope, challengeId) : challengeId;
      const { expected, frame } = serverChallenge(key, { server_id: body.server_id, role: "account", connection_id: context });
      this.challenges.set(context, { server_id: body.server_id, expected, expires: this.now() + CHALLENGE_TTL_MS });
      return json({ challenge_id: challengeId, frame });
    }
    if (path === "/v1/pc/complete" && this.completions) {
      const scope = completionScope({ account: body.account, listing_id: body.listing_id });
      const context = scope && typeof body.challenge_id === "string" ? completionKey(scope, body.challenge_id) : null;
      const challenge = context === null ? undefined : this.challenges.get(context);
      if (context !== null) this.challenges.delete(context);
      if (!scope || !challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) {
        return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      }
      const entry = this.directories.get(scope.account)?.get(challenge.server_id);
      // the listing still current, and its own evidence: an admission of it taken (or a completion already stamped)
      const taken = this.pcAdmissions.get(box(challenge.server_id, scope.account))?.taken === true;
      // a listing still current and confirmed, with evidence of its own: completed already, a mailbox pull of this PC since it
      // was made (so a list account's PC, which takes no one-press admission, completes on its pull), a digit admission, or a
      // one-press admission it took
      if (entry?.listing_id !== scope.listing_id || !this.confirmed(entry)
        || (entry.completed_at == null && entry.pulled_since_listed !== true && entry.digit_admitted !== true && !taken)) return problem(409, "listing_changed", "This add is no longer waiting for that action");
      entry.completed_at ??= this.iso();
      return json({ completed_at: entry.completed_at });
    }
    if (path === "/v1/pc/mailbox" || (path === "/v1/pc/admission" && this.opensAll)
      || (path === "/v1/pc/snapshot" && (this.opensAll || this.reportsStep2Off))) {
      const challenge = this.takeProof({ server_id: body.server_id, challenge_id: body.challenge_id, proof: body.proof });
      if (!challenge) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      if (typeof body.account !== "string") return problem(400, "invalid_account", "Name the account this PC belongs to");
      if (path === "/v1/pc/admission") {
        // G1: only the named account's own admission, while that account lists the PC; any other account's is invisible
        const open = this.pcAdmissions.get(box(challenge.server_id, body.account));
        const entry = this.directories.get(body.account)?.get(challenge.server_id);
        // retry-safe for 10 minutes, inclusive; it ends with the sign-in that made it
        if (open === undefined || this.now() - open.at > ADMISSION_TTL_MS || this.revokedFamilies.has(open.family) || entry?.new_until == null) {
          return entry !== undefined && this.cardExpired(challenge.server_id, body.account, entry)
            ? problem(409, "listing_expired", "This PC's card ran out; a new invite opens it again")
            : problem(404, "no_admission", "No account added this PC in one press");
        }
        // D11.9: an account that has a list takes a PC by its list alone, so it hands out no one-press admission, a retry included
        if (this.listOfAccount(body.account) !== undefined) return problem(409, "list_add", "This account keeps a signed list and takes a PC by that list alone");
        open.taken = true;
        return json({ account: body.account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until,
          ...(this.completions && body.with_listing_id === true ? { listing_id: entry.listing_id ?? null } : {}) });
      }
      if (path === "/v1/pc/snapshot") {
        // P6: only a PC the account lists reads the account's devices and records
        if (!this.opensAll) return this.directories.get(body.account)?.has(challenge.server_id) === true
          ? problem(404, "step2_off", "Step 2 is off for this account")
          : problem(404, "not_found", "Unknown request");
        if (this.directories.get(body.account)?.has(challenge.server_id) !== true) return problem(403, "not_listed", "This PC is not one of the account's");
        return this.snapshotPage(challenge.server_id, body.account, body.snapshot, body.page);
      }
      this.expire();
      const key = box(challenge.server_id, body.account);
      const queue = this.mailboxes.get(key) ?? [];
      const ack = typeof body.ack === "number" ? body.ack : null;
      const rest = ack === null ? queue : queue.filter(({ seq }) => seq > ack);
      this.mailboxes.set(key, rest);
      // only the account the PC says it belongs to learns that it came by
      const entry = this.directories.get(body.account)?.get(challenge.server_id);
      if (entry) {
        entry.last_seen_at = this.iso();
        entry.pulled_since_listed = true;
      }
      const admissions = this.admissionList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // the quiet ones in a field of their own, and only while the account still lists the PC
      const quiet = entry === undefined ? [] : this.quietList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // as the service: the listing it holds this PC under, when it confirms one (never one a device code listed under Step 2)
      const named = entry !== undefined && !(this.opensAll && entry.listed_by_device === true) ? entry.listing_id ?? null : null;
      const taken = this.pcAdmissions.get(key);
      const listing = this.completions && body.with_listing_id === true
        ? { listing_id: named, ...(this.saysListingAdmitted ? { listing_admitted: named !== null && entry?.admitted_at != null && taken?.taken === true && taken.listing === named } : {}) } : {};
      // the signed list's id and head, read with the pull, for a PC the account lists confirmed; without the member, unchanged
      const list = body.with_list === true ? { list: this.mailboxList(challenge.server_id, body.account, entry) } : {};
      return json({ ...listing, ...list, records: rest.slice(0, MAILBOX_PAGE).map(({ seq, record }) => ({ seq, record })), more: rest.length > MAILBOX_PAGE, admissions, quiet_admissions: quiet });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /**
   * Device table P6, G1: page 0 freezes the account's state under a new snapshot id; every later page is
   * asked by that id and served from the same state, or answered `snapshot_gone`.
   */
  private snapshotPage(serverId: string, account: string, id: unknown, page: unknown): Response {
    let state: SnapshotState | undefined;
    if (id === undefined && (page === undefined || page === 0)) {
      const registry = this.registry(account);
      const entries = [...registry.devices].sort(([, a], [, b]) => a.no - b.no);
      // D11.3: "has a list" is the list itself, whatever the switch says; a list being read again answers 503, a stopped one adds nobody
      const list = this.listOfAccount(account);
      const lie = list === undefined ? {} : this.tamperFor(list, { server_id: serverId, endpoint: this.directories.get(account)?.get(serverId)?.public_key ?? "" });
      if (lie.rebuilding === true) {
        const busy = problem(503, "list_rebuilding", "The service is reading this account's list again; keep what you read last and ask again in a moment");
        busy.headers.set("retry-after", "1");
        return busy;
      }
      const eligible = this.snapshotEligible(registry, list === undefined || lie.stopped === true ? null : list);
      const again = new Set(this.accountLies.get(account)?.eligibleAgain ?? []);
      state = {
        snapshot: randomHex(16), account, server_id: serverId, version: registry.version, methods_version: registry.methods_version,
        devices: entries.filter(([key, d]) => !d.removed || again.has(key)).map(([key, device]) => ({ key, no: device.no, eligible: again.has(key) || eligible(key, device), label: device.label })),
        removed: entries.filter(([key, d]) => d.removed && !again.has(key)).map(([key, { no }]) => ({ key, no })),
        blocks: [...registry.blocks], lifts: [...registry.lifts], freezes: [...registry.freezes],
      };
      this.snapshots.set(state.snapshot, state);
    } else if (typeof id === "string") {
      state = this.snapshots.get(id);
      if (state === undefined || state.account !== account || state.server_id !== serverId) return problem(410, SNAPSHOT_GONE, "Start the read again");
    }
    if (state === undefined || !Number.isSafeInteger(page ?? 0) || (page ?? 0) as number < 0) return problem(400, "invalid_request", "Ask page 0 with no snapshot, then each page by its snapshot id");
    const index = (page ?? 0) as number;
    // every list is paged on its own, so no page holds more than SNAPSHOT_PAGE entries of any list
    const lists = [state.devices, state.removed, state.blocks, state.lifts, state.freezes];
    const pages = Math.max(1, ...lists.map((list) => Math.ceil(list.length / SNAPSHOT_PAGE)));
    if (index >= pages) return problem(400, "invalid_request", "No such page");
    const slice = <T>(list: readonly T[]) => list.slice(index * SNAPSHOT_PAGE, (index + 1) * SNAPSHOT_PAGE);
    const body: AccountSnapshotPage = {
      v: ACCOUNT_SNAPSHOT_V, snapshot: state.snapshot, account, server_id: serverId, version: state.version, methods_version: state.methods_version, page: index, last: index === pages - 1,
      devices: slice(state.devices), removed: slice(state.removed), blocks: slice(state.blocks), lifts: slice(state.lifts), freezes: slice(state.freezes),
    };
    return json(body);
  }

  /**
   * Whether a registered key is eligible in the snapshot: under every freeze line (P16, G12), and by Step 2's rules (the
   * registry's `eligible`); for an account that has a list (D11.3) also when it is linked to a device a member allowed, its
   * sign-in lives and is an app's own, and a member up the chain of who let that device in passes Step 2's rules now.
   */
  private snapshotEligible(registry: Registry, list: FakeList | null): (key: string, device: { readonly no: number; readonly eligible: boolean; readonly removed: boolean }) => boolean {
    const passes = (device: { readonly no: number; readonly eligible: boolean; readonly removed: boolean }) => device.eligible && !device.removed && !this.frozen(registry, device.no);
    if (list === null) return (_key, device) => passes(device);
    const allows = this.listAllows(list);
    return (key, device) => {
      if (passes(device)) return true;
      const family = this.keyFamily.get(key);
      if (device.removed || this.frozen(registry, device.no) || family === undefined || this.revokedFamilies.has(family) || this.deviceFamilies.has(family) || !allows.allowed(key)) return false;
      return allows.allowers(key).some((by) => {
        const held = registry.devices.get(by);
        return held !== undefined && passes(held);
      });
    };
  }

  /**
   * Device table P16, P21, T52 (service effect): a block commits whole (target removed, freeze line, record
   * kept); a lift ends that block's service line. Each signer must be a registered member older than the target.
   */
  private frozen(registry: { freezes: readonly SnapshotFreezeLine[] }, no: number): boolean {
    return registry.freezes.some((line) => no > line.after);
  }

  private async safetyRecord(account: string, body: { record?: unknown }): Promise<Response> {
    let record: SafetyRecord;
    try {
      record = parseSafetyRecord(body.record);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      throw error;
    }
    if (!isDeviceSafetyRecord(record)) return problem(400, "record_invalid", "Send a block or a device's lift");
    if (!await verifySafetyRecord(record)) return problem(400, "signature_invalid", "The signature does not hold");
    if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
    const registry = this.registry(account);
    const signer = registry.devices.get(record.signer);
    if (signer && this.frozen(registry, signer.no)) return problem(403, "frozen", "A key a block freezes signs nothing");
    if (!signer || signer.removed || signer.no !== record.signer_no) return problem(403, "signer_not_member", "The signer is not a device of this account");
    if (record.kind === "block") {
      const target = registry.devices.get(record.target);
      if (!target || target.no !== record.target_no) return problem(403, "unknown_target", "The target is not where the block says");
      if (signer.no >= target.no) return problem(403, "signer_not_older", "Only a device older than the target blocks it");
      if (!registry.blocks.some((held) => held.id === record.id)) {
        if (target.removed) return problem(409, "target_removed", "The target is already removed");
        target.removed = true;
        registry.blocks.push(record);
        this.blocksKeptAt.set(record.id, this.now());
        registry.freezes.push({ block: record.id, target: record.target, after: record.target_no });
        registry.version += 1;
      }
      return json({ id: record.id });
    }
    const block = registry.blocks.find((held) => held.id === record.target);
    if (!block) return problem(404, "not_found", "No such block");
    if (record.signer_no >= block.target_no) return problem(403, "signer_not_older", "Only a device older than the blocked one lifts it");
    // T52: as the service, only a list-eligible device lifts
    if (!signer.eligible) return problem(403, "not_eligible", "This device cannot lift a block yet");
    if (!registry.lifts.some((held) => held.id === record.id)) {
      registry.lifts.push(record);
      registry.freezes = registry.freezes.filter((line) => line.block !== block.id);
      registry.version += 1;
    }
    return json({ id: record.id });
  }

  /** An account's signed list as the service holds it, for a test to look at (no lie applies here); null for an account that has none. */
  accountList(account: string): FakeListView | null {
    const list = this.listOfAccount(account);
    if (list === undefined) return null;
    return {
      id: list.id, entries: [...list.texts], head: headOf(list), state: list.state,
      wraps: [...list.wraps].flatMap(([member, epochs]) => [...epochs].map(([epoch, wrap]) => ({ epoch, member, wrap }))),
      claims: this.liveClaims(list).map(({ key, enc, card, at }) => ({ key, enc, card, until: untilOf(at) })),
      posts: this.livePosts(list).map(([endpoint, post]) => postView(endpoint, post)),
      links: [...list.links].map(([key, device]) => ({ key, device })),
    };
  }

  /** Adds one lie (ListTamper) to what the list routes tell of `list`; rules stack in the order added, a later field over an earlier, until untamperList. */
  tamperList(list: string, rule: ListTamper): void {
    const held = this.lists.get(list);
    if (held === undefined) throw new Error("No such list");
    const forkAt = rule.fork?.[0] === undefined ? null : seqOfText(rule.fork[0]);
    if (rule.fork !== undefined && forkAt === null) throw new Error("A fork starts with an entry");
    if (rule.answerList !== undefined && !this.lists.has(rule.answerList)) throw new Error("No such list to answer with");
    const reader = rule.reader;
    const session = reader !== undefined && "token" in reader ? this.tokens.get(reader.token) : undefined;
    if (reader !== undefined && "token" in reader && session === undefined) throw new Error("No such token");
    held.tamper.push({ rule, family: session?.family ?? null, server_id: reader !== undefined && "server_id" in reader ? reader.server_id : null });
  }

  untamperList(list: string): void { this.lists.get(list)?.tamper.splice(0); }

  /** Sets the account's lies (AccountTamper), in place of any before; `untamperAccount` ends them. */
  tamperAccount(account: string, lie: AccountTamper): void { this.accountLies.set(account, lie); }

  untamperAccount(account: string): void { this.accountLies.delete(account); }

  /**
   * A birth of the fake's own (a lie for the migration's tests): the service stores, as the account's list, a genesis
   * signed by a key of its own, a `carried` entry for each of `keys` (by default every registered key the account has
   * that is not removed) and of `endpoints`, a hand-over to another key of its own and the `epoch` it opens. No check is
   * asked of it, and it answers as the account's list on every route. A device or PC that holds the account's list to who
   * started it (a key it already admits) refuses it.
   */
  async forgeBirth(account: string, options: { readonly keys?: readonly string[]; readonly endpoints?: readonly string[] } = {}): Promise<string> {
    const p256 = { name: "ECDSA", namedCurve: "P-256" } as const;
    const spkiOf = async (key: CryptoKey): Promise<string> => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
    const newKey = async () => {
      const pair = await crypto.subtle.generateKey(p256, false, ["sign", "verify"]);
      const enc = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      return { pair, key: await spkiOf(pair.publicKey), enc: await spkiOf(enc.publicKey) };
    };
    const [first, next] = [await newKey(), await newKey()];
    const keys = options.keys ?? [...(this.registries.get(account)?.devices ?? [])].filter(([, device]) => !device.removed).map(([key]) => key);
    const issued = Math.floor(this.now() / 1000);
    // commitments to epoch keys nobody holds: the forged list opens no names, as a lying service's would not
    const opens = () => randomHex(32);
    const zero = await signEntry(kindBody({ issued_at: issued, list: "", prev: "", seq: 0, signer: first.key }, { kind: "genesis", account, enc: first.enc, opens: opens(), sealed: null }), first.pair.privateKey);
    const held: HeldEntry[] = [(await firstState(zero)).first];
    const texts = [entryToText(zero)];
    const sign = async (by: CryptoKeyPair, signer: string, kind: ListKind) => {
      const before = held.at(-1)!;
      const entry = await signEntry(kindBody({ issued_at: issued, list: before.list, prev: before.hash, seq: before.body.seq + 1, signer }, kind), by.privateKey);
      held.push(await entryHolds(entry, before));
      texts.push(entryToText(entry));
    };
    const list = held[0]!.hash;
    for (const key of keys) await sign(first.pair, first.key, { kind: "carried", key, role: "drive", sealed: null });
    for (const endpoint of options.endpoints ?? []) await sign(first.pair, first.key, { kind: "carried", endpoint, sealed: null });
    const card = await signCard({ key: next.key, enc: next.enc, list, endpoint: null, invite: null }, next.pair.privateKey);
    await sign(first.pair, first.key, { kind: "device", key: next.key, power: "full", role: "drive", until: null, enc: next.enc, card, sealed: null, rotates: true });
    await sign(next.pair, next.key, { kind: "epoch", epoch: 0, opens: opens(), link: crypto.getRandomValues(new Uint8Array(EPOCH_LINK_BYTES)) });
    let state = firstListState(held[0]!, LIST_SERVICE_LEVEL);
    for (const entry of held.slice(1)) state = (await takeEntry(state, entry)).state;
    const forged: FakeList = { id: list, account, texts, hashes: held.map(({ hash }) => hash), last: held.at(-1)!, state, wraps: new Map(), claims: new Map(), posts: new Map(), additions: [], links: new Map(), tamper: [] };
    const before = this.accountLists.get(account);
    if (before !== undefined) this.lists.delete(before);
    this.lists.set(list, forged);
    this.accountLists.set(account, list);
    return list;
  }

  /** OVIS_LIST_MIGRATE_ACCOUNTS as the service reads it, as listNamed reads OVIS_LIST_ACCOUNTS. */
  private migrateOn(account: string): boolean {
    for (const entry of this.listMigrateAccounts.split(",")) {
      const named = entry.trim();
      if (named === "*" || named === account) return true;
    }
    return false;
  }

  /** The key this sign-in registered (registerSessionKey, POST /v1/devices), while the account holds it unremoved. */
  private registeredKey(account: string, family: string): string | undefined {
    const registry = this.registries.get(account);
    for (const [key, of] of this.keyFamily) if (of === family && registry?.devices.get(key)?.removed === false) return key;
    return undefined;
  }

  /**
   * The registered key a link names, once `link` holds both signatures over `ovis-list-link/1` for this account, list
   * and member key (D11.2): the member key's and the calling sign-in's own registered key's. `400 link_unsigned` for the
   * member key's signature alone (a bare text); `400 link_invalid` for a sign-in that registered no key (or whose key was
   * removed) and for a signature that does not hold.
   */
  private async linkedKey(session: Session, list: string, key: string, link: unknown): Promise<string | Response> {
    if (typeof link === "string") return this.v2Problem(400, "link_unsigned", "A link carries the registered device key's own signature beside the member key's");
    const { member, device } = link as { member: string; device: string };
    const [byMember, byDevice] = [member, device].map((text) => (text.length === LINK_SIGNATURE_CHARS ? canonicalBase64Url(text) : null));
    const own = this.registeredKey(session.account, session.family);
    const invalid = this.v2Problem(400, "link_invalid", "The link is not the member key's and this sign-in's registered device key's signatures over each other");
    if (byMember === null || byMember === undefined || byDevice === null || byDevice === undefined || own === undefined) return invalid;
    let bytes: Uint8Array;
    try {
      bytes = linkBytes({ account: session.account, list, key, device: own });
    } catch (error) {
      if (error instanceof ListKindError) return invalid;
      throw error;
    }
    if (!(await verifySignature(bytes, byMember, key) && await verifySignature(bytes, byDevice, own))) return invalid;
    // kept beside the link it proves, for the link's log once the link is written
    this.linkProofs.set(`${list} ${key} ${own}`, { member, device });
    return own;
  }

  /** The two signatures of each link a sign-in proved, by list, member key and registered key: what the link's log keeps. */
  private readonly linkProofs = new Map<string, { readonly member: string; readonly device: string }>();

  /** The link of `key` to `own` goes into the list's log of links, with its two signatures, when it is written. */
  private logLink(list: FakeList, key: string, own: string): void {
    const link = this.linkProofs.get(`${list.id} ${key} ${own}`);
    if (link === undefined) return;
    (list.linkLog ??= []).push({ key, device: own, link, linked_at: Math.floor(this.now() / 1000) });
  }

  /**
   * Writes `key`'s link to the registered key `own` (D11.2 rule 2): a link of `own` to another member key that does not
   * `stay` (no longer in) gives way; one to a member that stays stands, and then nothing is written (false). A member key's
   * earlier link is replaced.
   */
  private writeLink(list: FakeList, key: string, own: string, stays: (member: string) => boolean): boolean {
    if (this.linkTaken(list, key, own, stays)) return false;
    const others = [...list.links].filter(([member, registered]) => registered === own && member !== key).map(([member]) => member);
    for (const member of others) list.links.delete(member);
    list.links.set(key, own);
    this.logLink(list, key, own);
    return true;
  }

  /**
   * Whether the registered key `own` is linked to a member other than `key` that `stays`: another member's link, or `own`
   * itself where it is a key of the list that is in (on the list's state as it stands, after a placement's batch).
   */
  private linkTaken(list: FakeList, key: string, own: string, stays: (member: string) => boolean): boolean {
    return (own !== key && signerPower(list.state, own) !== null) || [...list.links].some(([member, registered]) => registered === own && member !== key && stays(member));
  }

  /**
   * What the account's list adds to Step 2's rules (D11.3), by registered key: `allowed`, the key is linked to a device a
   * member allowed (it came in by a counted `device` entry another member signed: not entry 0, not `carried`; a key that
   * took another's place has that key's standing) that the list lets in to drive at the service's clock; `allowers`, the
   * registered keys linked to the members up the chain of who let it in, nearest first, each still in the list (a member
   * that is its own link, selfLinked, counts as its own registered key). A PC's
   * key and an invite's key have no sign-in and are passed through; a key that handed its place on counts as its heir.
   */
  private listAllows(list: FakeList): { readonly allowed: (registered: string) => boolean; readonly allowers: (registered: string) => string[] } {
    const state = list.state;
    const linkOf = (member: string): string | undefined => list.links.get(member) ?? (this.selfLinked(list, state, member) ? member : undefined);
    const clock = listClock(state, Math.floor(this.now() / 1000), null);
    const memberOf = new Map([...list.links].map(([member, registered]) => [registered, member]));
    const signer = (key: string) => rowOf(state.signers, key) ?? undefined;
    const steps = Object.keys(state.signers).length;
    const cameFrom = (key: string): string | null => {
      const added = signer(key);
      const before = added === undefined || added.by === null || added.by === key ? undefined : signer(added.by);
      return added?.as === "device" && added.by !== null && before?.as === "device" && before.ended === added.seq ? added.by : null;
    };
    const heir = new Map<string, string>();
    for (const key of Object.keys(state.signers)) {
      const from = cameFrom(key);
      if (from !== null) heir.set(from, key);
    }
    const byAnother = (key: string): boolean => {
      let at = key;
      for (let step = 0; step <= steps; step++) {
        const from = cameFrom(at);
        if (from === null) break;
        at = from;
      }
      const added = signer(at);
      return added?.as === "device" && added.by !== null && added.by !== at && rowOf(state.devices, at)?.carried !== true;
    };
    return {
      allowed: (registered) => {
        const member = memberOf.get(registered);
        return member !== undefined && admitsDevice(state, member, clock) === "drive" && byAnother(member);
      },
      allowers: (registered) => {
        const found: string[] = [];
        let at = memberOf.get(registered);
        for (let step = 0; at !== undefined && step <= steps; step++) {
          const by: string | null | undefined = signer(at)?.by;
          if (by === null || by === undefined || by === at) break;
          let current = by;
          for (let hops = 0; heir.has(current) && hops <= heir.size; hops++) current = heir.get(current) ?? current;
          const linked = linkOf(current);
          if (linked !== undefined && linked !== registered && signerPower(state, current) !== null && !found.includes(linked)) found.push(linked);
          at = by;
        }
        return found;
      },
    };
  }

  /** An invite that may still be redeemed: unused, not revoked, its maker's sign-in still there, not past its end. */
  private inviteOpen(invite: FakeInvite, now = this.now()): boolean {
    return invite.used === null && !invite.revoked && !this.revokedFamilies.has(invite.family) && now < inviteEnd(invite);
  }

  /** A key that was an invite's, of any account and in any state, or that some account registered as a device's: never an invite's key. */
  private inviteKeyUsed(key: string): boolean {
    return [...this.invites.values()].some((invite) => invite.key === key) || [...this.registries.values()].some((registry) => registry.devices.has(key));
  }

  /** The list holds an invite of `key` as open (D11.5): counted, not ended, its placer still a signer, its use left, not past its `exp` by the service's clock. */
  private listHoldsInvite(list: FakeList, key: string): boolean {
    const held = rowOf(list.state.invites, key);
    return held !== null && inviteRefusal(list.state, key) === null && listClock(list.state, Math.floor(this.now() / 1000), null) <= held.exp;
  }

  /**
   * Why the service's invite for a list's `invite` entry cannot be made now (D11.5); null when it can. An open invite of the
   * account with that key and that `auto` is taken as it is, while the entry's `exp` is no later than its end; else the key
   * is new (never an invite's, never a device's), the `exp` within fifteen minutes, and fewer than five invites open.
   */
  private inviteUnfit(account: string, invite: { readonly index: number; readonly key: string; readonly auto: boolean; readonly exp: number }): Response | null {
    const now = this.now();
    const tooLate = () => this.refusedAt(invite.index, "service", "exp_too_late", "An invite's exp is no later than the service's invite lasts: fifteen minutes from now, or the end of the invite made for this key");
    const stands = this.standingInvite(account, invite);
    if (stands !== undefined) return invite.exp * 1000 > inviteEnd(stands) ? tooLate() : null;
    if (this.inviteKeyUsed(invite.key)) return this.v2Problem(409, "invite_key_used", "An invite or a device already has this key; make a new key pair");
    if (invite.exp * 1000 > now + PC_INVITE_TTL_MS) return tooLate();
    if ([...this.invites.values()].filter((held) => held.account === account && this.inviteOpen(held, now)).length >= INVITES_OPEN_MAX) {
      return this.v2Problem(409, "invites_full", `An account holds at most ${INVITES_OPEN_MAX} open invites; revoke one or let one expire`);
    }
    return null;
  }

  /** The account's open invite of that key and that `auto`, which a list's `invite` entry takes as it is. */
  private standingInvite(account: string, invite: { readonly key: string; readonly auto: boolean }): FakeInvite | undefined {
    return [...this.invites.values()].find((held) => held.key === invite.key && held.account === account && held.auto === invite.auto && this.inviteOpen(held));
  }

  /** 429 `pc_add_cap` with its retry-after once the account's one-press adds of the last day reached the cap; null below it. */
  private capRefusal(account: string): Response | null {
    const now = this.now();
    const times = (this.admitTimes.get(account) ?? []).filter((at) => now - at < PC_NEW_MS);
    return times.length < PC_ADMITS_PER_DAY ? null : this.v2Problem(429, "pc_add_cap", "This account added enough PCs today", {}, Math.ceil((times[0]! + PC_NEW_MS - now) / 1000));
  }

  /**
   * The member keys the list lets in now, in either role, that the sign-in's own registered key stands for (D11.6): linked
   * to it, or that key itself where it is its own link (selfLinked).
   */
  private ownDevices(list: FakeList, session: Session): string[] {
    const own = this.registeredKey(session.account, session.family);
    if (own === undefined) return [];
    const clock = listClock(list.state, Math.floor(this.now() / 1000), null);
    const linked = [...list.links].filter(([, registered]) => registered === own).map(([member]) => member);
    return [...new Set([...linked, ...(this.selfLinked(list, list.state, own) ? [own] : [])])].filter((key) => admitsDevice(list.state, key, clock) !== null);
  }

  /**
   * A registered key of the account that is itself a member key, entry 0's or a carried one, until it hands over: it is its
   * own link, unless the table links that member key to another sign-in's key, or links that registered key to another
   * member that is in (a link in the table comes first).
   */
  private selfLinked(list: FakeList, state: ListState, key: string): boolean {
    const signer = rowOf(state.signers, key);
    return this.registries.get(list.account)?.devices.has(key) === true && signer !== null && signer.ended === null
      && (signer.by === null || rowOf(state.devices, key)?.carried === true) && !list.links.has(key)
      && ![...list.links].some(([member, registered]) => registered === key && member !== key && signerPower(state, member) !== null);
  }

  /** The account's lie `withholdAnswer`: what was just stored stays, and the caller's `fetch` rejects as on a lost connection. */
  private withheld(account: string): void {
    if (this.accountLies.get(account)?.withholdAnswer === true) throw new TypeError("fetch failed: the fake account service withheld its answer");
  }

  /** OVIS_LIST_ACCOUNTS as the service reads it: `all` once an entry is `*`, else the account ids it names. */
  private listNamed(): "all" | string[] {
    const named: string[] = [];
    for (const entry of this.listAccounts.split(",")) {
      const account = entry.trim();
      if (account === "*") return "all";
      if (ACCOUNT_ID.test(account)) named.push(account);
    }
    return named;
  }

  private listsOn(account: string): boolean {
    const named = this.listNamed();
    return named === "all" || named.includes(account);
  }

  /** No account may have a list: every /v2 route is an unknown one before anything is read or counted. */
  private listsOff(): boolean {
    const named = this.listNamed();
    return named !== "all" && named.length === 0;
  }

  private listOfAccount(account: string): FakeList | undefined {
    const id = this.accountLists.get(account);
    return id === undefined ? undefined : this.lists.get(id);
  }

  /** The caller's account's list `id`, or undefined: another account's list is not told apart from none. */
  private ownList(account: string, id: string): FakeList | undefined {
    const list = this.lists.get(id);
    return list?.account === account ? list : undefined;
  }

  /** A listing the account's devices take as the account's: what the mailbox calls confirmed. */
  private confirmed(row: FakePc): boolean {
    return !(this.opensAll && row.listed_by_device === true);
  }

  private bearerSession(request: Request): Session | undefined {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    return session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family) ? undefined : session;
  }

  /**
   * frozenSignIn, as the service's PC invites and list writes ask it: a block that no lift names stands below the key this
   * sign-in registered, or was kept before the sign-in was made. The second covers a sign-in with no key: any key it
   * registered would be numbered after the blocked one. A key-less sign-in made before the block is not frozen by it.
   */
  private frozenSignIn(account: string, family: string): boolean {
    const registry = this.registries.get(account);
    if (registry === undefined) return false;
    const nos = [...this.keyFamily].filter(([, of]) => of === family).map(([key]) => registry.devices.get(key)?.no).filter((no) => no !== undefined);
    const madeAt = this.signedInAt.get(family) ?? Number.NEGATIVE_INFINITY;
    return registry.freezes.some((line) => nos.some((no) => line.after < no) || (this.blocksKeptAt.get(line.block) ?? Number.POSITIVE_INFINITY) < madeAt);
  }

  /** A device writes only from an app's own sign-in (a device code can be typed for someone else's screen) that no standing block freezes. Null when it may. */
  private writeRefusal(account: string, family: string): Response | null {
    if (this.deviceFamilies.has(family)) return this.v2Problem(403, "own_sign_in_required", "Sign in on this device first");
    if (this.frozenSignIn(account, family)) return this.v2Problem(403, "frozen", "A sign-in a block freezes places nothing");
    return null;
  }

  /** The sign-in behind a claim still locks: still there, an app's own, not frozen. */
  private signInStands(account: string, family: string): boolean {
    return !this.revokedFamilies.has(family) && this.writeRefusal(account, family) === null;
  }

  private v2Json(body: Record<string, unknown>, status = 200, retryAfter?: number): Response {
    const answer = new Response(JSON.stringify({ ...body, now: Math.floor(this.now() / 1000) }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (retryAfter !== undefined) answer.headers.set("retry-after", String(Math.max(1, retryAfter)));
    return answer;
  }

  private v2Problem(status: number, code: string, message: string, details: Record<string, unknown> = {}, retryAfter?: number): Response {
    return this.v2Json({ error: { ...details, code, message } }, status, retryAfter);
  }

  private v2Unknown(): Response { return this.v2Problem(404, "not_found", "Unknown request"); }

  private v2Invalid(): Response { return this.v2Problem(400, "invalid_request", "The body or the query is not in its form"); }

  /** The body as a JSON object, at most `max` bytes, and at most `maxFor` of what it holds when that is given. */
  private async v2Body(request: Request, max: number, maxFor?: (body: Record<string, unknown>) => number): Promise<Record<string, unknown> | Response> {
    const text = await request.text();
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > max) return this.v2Problem(413, "too_large", "The body is too large");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.v2Problem(400, "invalid_json", "The body is not JSON");
    }
    if (!isRecord(value)) return this.v2Invalid();
    return maxFor !== undefined && bytes > maxFor(value) ? this.v2Problem(413, "too_large", "The body is too large") : value;
  }

  /** A fixed window of `window` ms, as withinRateLimit's, answering 429 `code` with retry-after past `max`. */
  private listLimited(key: string, max: number, window: number, code = "rate_limited"): Response | null {
    const now = this.now();
    const counter = this.counters.get(key);
    const fresh = counter === undefined || now - counter.start >= window;
    const held = fresh ? { start: now, count: 1 } : { start: counter.start, count: counter.count + 1 };
    this.counters.set(key, held);
    return held.count <= max ? null : this.v2Problem(429, code, "Too many requests; try again later", {}, Math.ceil((held.start + window - now) / 1000));
  }

  /** What the service tells `caller` of the list's log, with every lie a test turned on for it. */
  private servedLog(list: FakeList, caller: ListCaller): { readonly id: string; readonly texts: readonly string[]; readonly head: ListPlace; readonly cuts: readonly number[] } {
    const lie = this.tamperFor(list, caller);
    const base = (lie.answerList === undefined ? undefined : this.lists.get(lie.answerList)) ?? list;
    let texts = [...base.texts];
    const forkAt = lie.fork?.[0] === undefined ? null : seqOfText(lie.fork[0]);
    if (lie.fork !== undefined && forkAt !== null) texts = [...texts.slice(0, forkAt), ...lie.fork];
    if (lie.withholdAfter !== undefined) texts = texts.slice(0, Math.max(0, lie.withholdAfter) + 1);
    if (lie.inject !== undefined) texts = [...texts, ...lie.inject];
    const flip = lie.flipEntry;
    const flipped = flip === undefined ? undefined : texts[flip.seq];
    if (flip !== undefined && flipped !== undefined) texts[flip.seq] = flipEntryText(flipped, flip.byte);
    const last = texts.length - 1;
    const head = lie.head ?? { seq: last, hash: hashOfText(texts[last] ?? "") ?? base.hashes[last] ?? "0".repeat(64) };
    return { id: lie.listId ?? base.id, texts, head, cuts: lie.pages ?? [] };
  }

  /** The wraps the service tells `caller` that `member` has: the latest LIST_WRAPS_READ epochs, ascending. */
  private servedWraps(list: FakeList, caller: ListCaller, member: string): { epoch: number; wrap: string }[] {
    const lie = this.tamperFor(list, caller);
    const base = (lie.answerList === undefined ? undefined : this.lists.get(lie.answerList)) ?? list;
    const wraps = new Map(base.wraps.get(member) ?? []);
    for (const wrap of lie.wraps ?? []) if (wrap.member === member) wraps.set(wrap.epoch, wrap.wrap);
    const flip = lie.flipWrap;
    const flipped = flip?.member === member ? wraps.get(flip.epoch) : undefined;
    if (flip !== undefined && flipped !== undefined) wraps.set(flip.epoch, flipText(flipped, flip.byte));
    return [...wraps].sort(([a], [b]) => a - b).slice(-LIST_WRAPS_READ).map(([epoch, wrap]) => ({ epoch, wrap }));
  }

  private tamperFor(list: FakeList, caller: ListCaller): ListTamper {
    let lie: ListTamper = {};
    for (const { rule, family, server_id } of list.tamper) {
      if ((family !== null && caller.family !== family) || (server_id !== null && caller.server_id !== server_id)) continue;
      lie = { ...lie, ...rule };
    }
    return lie;
  }

  /**
   * POST /v2/pc/list/links: every link the list's log of links holds, oldest first, each with its two signatures
   * (`seq` counts from 1), after `after`, at most `limit`; `more` while more follow. A link a tamper rule withholds is
   * left out: a PC that verifies each pair can be denied a link, never shown a false one.
   */
  private linksPage(list: FakeList, caller: ListCaller, after: number | null, limit: number): Response {
    const lie = this.tamperFor(list, caller);
    const withheld = new Set(lie.withholdLinks ?? []);
    const all = (list.linkLog ?? []).map((one, index) => ({ seq: index + 1, ...one })).filter((one) => !withheld.has(one.key));
    const after0 = after ?? 0;
    const rest = all.filter((one) => one.seq > after0);
    const links = rest.slice(0, limit);
    return this.v2Json({ list: list.id, after, links, more: rest.length > links.length });
  }

  /** One page of the log after `after` (from entry 0 for null), as served to `caller`. */
  private logPage(list: FakeList, caller: ListCaller, after: number | null, limit: number): Response {
    const served = this.servedLog(list, caller);
    const from = after === null ? 0 : after + 1;
    const cut = Math.min(Number.POSITIVE_INFINITY, ...served.cuts.filter((seq) => seq >= from));
    const entries: string[] = [];
    let chars = 0;
    for (let seq = from; seq < served.texts.length && seq <= cut && entries.length < limit; seq++) {
      const text = served.texts[seq]!;
      // about 1 MiB of text a page, and never an empty page while entries follow
      if (entries.length > 0 && chars + text.length > LIST_PAGE_CHARS) break;
      entries.push(text);
      chars += text.length;
    }
    return this.v2Json({ list: list.id, after, entries, head: served.head, more: from + entries.length < served.texts.length });
  }

  /** The mailbox pull's `with_list`: the list's id and head for a PC the account lists confirmed, else null. */
  private mailboxList(serverId: string, account: string, row: FakePc | undefined): { id: string; head: ListPlace } | null {
    const list = this.listsOn(account) ? this.listOfAccount(account) : undefined;
    if (list === undefined || row === undefined || !this.confirmed(row)) return null;
    const served = this.servedLog(list, { server_id: serverId, endpoint: row.public_key });
    return { id: served.id, head: served.head };
  }

  /**
   * The signed list's routes (Part D of the account service, as the service builds them; docs/account-list.md, "The list
   * routes in tests"). Every answer, a refusal included, carries the service's clock as `now`, in seconds.
   */
  private async v2(request: Request, url: URL): Promise<Response> {
    if (this.listsOff()) return this.v2Unknown();
    const path = url.pathname;
    if (path.startsWith("/v2/pc/")) return request.method === "POST" ? await this.v2Pc(request, path) : this.v2Unknown();
    const named = /^\/v2\/lists\/([^/]+)\/(log|wraps|entries|claims|posts|links)$/.exec(path);
    const attempted = /^\/v2\/lists\/([^/]+)\/posts\/([^/]+)\/attempt$/.exec(path);
    const route = path === "/v2/lists" ? `${request.method} genesis` : path === "/v2/lists/mine" ? `${request.method} mine`
      : attempted !== null ? `${request.method} attempt` : named === null ? null : `${request.method} ${named[2]}`;
    if (route === null || !LIST_ROUTES.includes(route)) return this.v2Unknown();
    const session = this.bearerSession(request);
    // with only some accounts named, a missing sign-in is not told apart from an account that is not named
    if (session === undefined) return this.listNamed() === "all" ? this.v2Problem(401, "unauthorized", "Sign in again") : this.v2Unknown();
    const account = session.account;
    if (!this.listsOn(account)) return this.v2Unknown();
    const id = named?.[1] ?? attempted?.[1] ?? "";
    // a device's batch is counted once its body is read: removals alone by a signer of the list spend that signer's own counter
    if (route === "POST entries") return await this.deviceBatch(request, session, id);
    const limited = this.listLimited(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW, LIMIT_WINDOW_MS);
    if (limited !== null) return limited;
    const caller = { family: session.family };
    switch (route) {
      case "POST genesis": return await this.genesis(request, session);
      case "GET mine": {
        const list = this.listOfAccount(account);
        // an account on the migrate switch with no list yet may move onto one by the one-request birth (F10b)
        if (list === undefined) return this.v2Json({ list: null, ...(this.migrateOn(account) ? { migrate: true } : {}) });
        const served = this.servedLog(list, caller);
        return this.v2Json({ list: served.id, head: served.head });
      }
      case "GET log": {
        const query = Object.fromEntries(url.searchParams);
        const after = query.after === undefined ? null : listNumber(query.after);
        const limit = query.limit === undefined ? LIST_PAGE_MAX : /^[1-9][0-9]{0,2}$/.test(query.limit) ? Number(query.limit) : 0;
        if (!Object.keys(query).every((name) => name === "after" || name === "limit") || (query.after !== undefined && after === null) || limit < 1 || limit > LIST_PAGE_MAX) return this.v2Invalid();
        const list = this.ownList(account, id);
        return list === undefined ? this.v2Unknown() : this.logPage(list, caller, after, limit);
      }
      case "GET wraps": {
        const list = this.ownList(account, id);
        if (list === undefined) return this.v2Unknown();
        const member = url.searchParams.get("member");
        if (member === null || !isListKeyEncoding(member)) return this.v2Invalid();
        return this.v2Json({ wraps: this.servedWraps(list, caller, member) });
      }
      case "POST claims": return await this.claim(request, session, id);
      case "POST links": return await this.links(request, session, id);
      case "PUT wraps": return await this.putWraps(request, session, id);
      case "POST attempt": return await this.attempt(request, session, id, attempted![2]!);
      case "GET claims": {
        const list = this.ownList(account, id);
        if (list === undefined) return this.v2Unknown();
        return this.v2Json({ claims: this.liveClaims(list).map(({ key, enc, card, at }) => ({ key, enc, card, until: untilOf(at) })) });
      }
      default: {
        const list = this.ownList(account, id);
        if (list === undefined) return this.v2Unknown();
        return this.v2Json({ posts: this.livePosts(list).map(([endpoint, post]) => postView(endpoint, post)) });
      }
    }
  }

  /**
   * POST /v2/lists: entry 0 of the account's one list, from an app's own sign-in, not frozen, fresh or proving its key, with
   * the first device's link when sent (D11.2). With `entries` beside it, a birth (`birth`).
   */
  private async genesis(request: Request, session: Session): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.birth, (sent) => (sent.entries === undefined ? LIST_BODY.genesis : LIST_BODY.birth));
    if (body instanceof Response) return body;
    const wraps = wrapsOf(body.wraps);
    if (!hasOnly(body, ["entry"], ["wraps", "key_proof", "link", "entries"]) || typeof body.entry !== "string" || wraps === null
      || (body.key_proof !== undefined && keyProofOf(body.key_proof) === null) || (body.link !== undefined && !isLinkForm(body.link))) return this.v2Invalid();
    if (body.entries !== undefined) return await this.birth(session, body.entry, body.entries, wraps, body.link, body.key_proof);
    const refused = this.writeRefusal(session.account, session.family);
    if (refused !== null) return refused;
    const read = await this.readGenesis(session, body.entry);
    if (read instanceof Response) return read;
    const { first, state } = read;
    const before = this.listExists(session.account);
    if (before !== null) return before;
    const wrapAt = wrapRefusal(wraps, state, Math.floor(this.now() / 1000));
    if (wrapAt !== null) return this.wrapInvalid(wrapAt);
    const linked = body.link === undefined ? null : await this.linkedKey(session, first.hash, first.body.signer, body.link);
    if (linked instanceof Response) return linked;
    const fresh = await this.freshOrProved(session, body.key_proof, "list-genesis", first.hash, "");
    if (fresh !== null) return fresh;
    // judged again in the write: another genesis of the account may have come, or the sign-in gone, while this one was checked
    const raced = this.listExists(session.account) ?? this.writerFell(session);
    if (raced !== null) return raced;
    const list: FakeList = { id: first.hash, account: session.account, texts: [body.entry], hashes: [first.hash], last: first, state, wraps: new Map(), claims: new Map(), posts: new Map(), additions: [],
      links: new Map(linked === null ? [] : [[first.body.signer, linked]]), tamper: [] };
    if (linked !== null) this.logLink(list, first.body.signer, linked);
    for (const wrap of wraps) storeWrap(list, wrap);
    this.lists.set(list.id, list);
    this.accountLists.set(session.account, list.id);
    this.withheld(session.account);
    return this.v2Json({ list: list.id, head: headOf(list) }, 201);
  }

  /**
   * POST /v2/lists with `entries`: the one-request birth of the list of an account from before lists (Part F, F10b, as the
   * service built it), placed whole or not at all. Entry 0 is a genesis signed by the key the calling sign-in registered;
   * then 0 to 64 `carried`, each a key or PC the account holds as let in today, one `device` that rotates entry 0's signer
   * (the hand-over) and one `epoch`, read in that order before the library's verdict on each. Each holds and counts on the
   * state before it. No key proof and no freshness; wraps for epoch 1, the one the birth opens; the link is the hand-over's
   * key's; outside the budget of additions. An `index` is the entry's place in the log: entry 0 is 0.
   */
  private async birth(session: Session, entry: string, texts: unknown, wraps: readonly ListWrap[], link: unknown, proof: unknown): Promise<Response> {
    const account = session.account;
    if (!Array.isArray(texts) || texts.length < 2 || texts.length > MIGRATION_CARRIED_MAX + 2 || !texts.every((text) => typeof text === "string")) return this.v2Invalid();
    const refused = this.writeRefusal(account, session.family);
    if (refused !== null) return refused;
    const read = await this.readGenesis(session, entry);
    if (read instanceof Response) return read;
    const { first } = read;
    // a birth sent again after its answer was lost gets its own list back before anything of its run is read
    const before = this.listExists(account);
    if (before !== null) return before;
    if (!this.migrateOn(account)) return this.refusedAt(1, "service", "carried_not_open", "Carrying members in from before the list is not open for this account");
    if (proof !== undefined) return this.v2Problem(400, "invalid_request", "A birth takes no key proof: entry 0 is signed by this sign-in's registered key");
    const firstSigner = () => (first.body.signer === this.registeredKey(account, session.family) ? null
      : this.refusedAt(0, "service", "first_signer", "Entry 0 of a birth is signed by the key this sign-in registered"));
    const signerRefused = firstSigner();
    if (signerRefused !== null) return signerRefused;
    // the first signer is held to what a carried key is held to: a sign-in Step 2 keeps waiting starts no birth
    const notCarried = (index: number) => this.v2Problem(403, "not_carried", "A carried key is a registered key of a live own sign-in of the account, eligible today; a carried PC is one the account lists as let in", { index });
    if (!this.carriableKey(account, first.body.signer)) return notCarried(0);
    const run = parseTexts(texts as string[]);
    if (!Array.isArray(run)) return this.v2Problem(400, run.code, run.message, { index: run.index + 1 });
    const nowS = Math.floor(this.now() / 1000);
    let state = read.state;
    let last = first;
    const held: HeldEntry[] = [first];
    let handOver: string | null = null;
    let carried = 0;
    const carriedAt: { readonly index: number; readonly kind: Extract<ListKind, { kind: "carried" }> }[] = [];
    let opened = false;
    const misshaped = (index: number) => this.refusedAt(index, "service", "birth_shape", "A birth is 0 to 64 carried, one device that rotates entry 0's signer, one epoch, and nothing after");
    for (const [at, { entry: next }] of run.entries()) {
      const index = at + 1;
      try {
        last = await entryHolds(next, last);
      } catch (error) {
        if (error instanceof ListEntryError) return this.v2Problem(400, error.code, error.message, { index });
        throw error;
      }
      const kind = readKind(last.body);
      // the shape, in order: `carried` (64 at most), then the hand-over, then the `epoch`, and nothing after
      const shaped = handOver === null
        ? (kind?.kind === "carried" && carried < MIGRATION_CARRIED_MAX) || (kind?.kind === "device" && kind.rotates && last.body.signer === first.body.signer)
        : !opened && kind?.kind === "epoch";
      if (!shaped) return misshaped(index);
      const taken = await takeEntry(state, last);
      if (taken.outcome.outcome !== "counts" || kind === null) {
        const reason = "code" in taken.outcome ? taken.outcome.code : null;
        return this.refusedAt(index, taken.outcome.outcome === "counts" ? "no_effect" : taken.outcome.outcome, reason, "A member would not count this entry");
      }
      if (last.body.issued_at > nowS + LIST_ISSUED_AHEAD_S) return this.refusedAt(index, "service", "issued_at_ahead", "An entry's issued_at is not ahead of the service's clock");
      if (kind.kind === "carried") {
        carried += 1;
        carriedAt.push({ index, kind });
      }
      if (kind.kind === "device") handOver = kind.key;
      if (kind.kind === "epoch") opened = true;
      state = taken.state;
      held.push(last);
    }
    // a run that stops before its hand-over or its epoch; then the service's word on each key and PC carried in
    if (!opened) return misshaped(run.length + 1);
    const unfit = carriedAt.find(({ kind }) => !this.carriable(account, kind));
    if (unfit !== undefined) return notCarried(unfit.index);
    const wrapAt = wrapRefusal(wraps, state, nowS);
    if (wrapAt !== null) return this.wrapInvalid(wrapAt);
    const linked = link === undefined || handOver === null ? null : await this.linkedKey(session, first.hash, handOver, link);
    if (linked instanceof Response) return linked;
    // read again in the write: the list, the writer, entry 0's signer and every carried key and PC
    const raced = this.listExists(account) ?? this.writerFell(session) ?? firstSigner();
    if (raced !== null) return raced;
    if (!this.carriableKey(account, first.body.signer, true)) return notCarried(0);
    const fell = carriedAt.find(({ kind }) => !this.carriable(account, kind, true));
    if (fell !== undefined) return notCarried(fell.index);
    const list: FakeList = { id: first.hash, account, texts: [entry, ...texts as string[]], hashes: held.map(({ hash }) => hash), last, state, wraps: new Map(), claims: new Map(), posts: new Map(),
      additions: [], links: new Map(linked === null || handOver === null ? [] : [[handOver, linked]]), tamper: [] };
    if (linked !== null && handOver !== null) this.logLink(list, handOver, linked);
    for (const wrap of wraps) storeWrap(list, wrap);
    this.lists.set(list.id, list);
    this.accountLists.set(account, list.id);
    this.withheld(account);
    return this.v2Json({ list: list.id, head: headOf(list) }, 201);
  }

  /** Entry 0 as D1 reads it: a genesis of the caller's account at level 1, not dated ahead; with the state it starts. */
  private async readGenesis(session: Session, text: string): Promise<{ readonly first: HeldEntry; readonly state: ListState } | Response> {
    let first: HeldEntry;
    try {
      first = (await firstState(entryFromText(text))).first;
    } catch (error) {
      if (error instanceof ListEntryError) return this.v2Problem(400, error.code, error.message, { index: 0 });
      throw error;
    }
    let state: ListState;
    try {
      state = firstListState(first, LIST_SERVICE_LEVEL);
    } catch (error) {
      if (error instanceof ListKindError) return this.v2Problem(400, "entry_refused", "Entry 0 is no genesis this service can read", { index: 0, outcome: "no_effect", reason: "entry_invalid" });
      throw error;
    }
    if (first.body.issued_at > Math.floor(this.now() / 1000) + LIST_ISSUED_AHEAD_S) return this.refusedAt(0, "service", "issued_at_ahead", "An entry's issued_at is not ahead of the service's clock");
    const kind = readKind(first.body);
    if (kind?.kind !== "genesis" || kind.account !== session.account) return this.v2Problem(403, "account_mismatch", "The genesis names another account");
    return { first, state };
  }

  /** 409 `list_exists` with the account's list and head, or null for an account with none. */
  private listExists(account: string): Response | null {
    const held = this.listOfAccount(account);
    return held === undefined ? null : this.v2Problem(409, "list_exists", "This account has a list", { list: held.id, head: headOf(held) });
  }

  /** The device's sign-in, judged again in a write: gone (401), or no longer one that writes; null while it stands. */
  private writerFell(session: Session): Response | null {
    if (this.revokedFamilies.has(session.family)) return this.v2Problem(401, "unauthorized", "Sign in again");
    return this.writeRefusal(session.account, session.family);
  }

  /**
   * A `carried` of a birth (F10.3): a key a live, unfrozen own sign-in of the account registered and still holds, eligible
   * today and on the curve, or a PC of the account that no device code's sign-in listed.
   */
  private carriable(account: string, kind: Extract<ListKind, { kind: "carried" }>, inWrite = false): boolean {
    if ("endpoint" in kind) return this.pcs(account).some((row) => row.public_key === kind.endpoint && row.listed_by_device !== true);
    return this.carriableKey(account, kind.key, inWrite);
  }

  /**
   * A key a birth may carry, or start with (entry 0's signer): a live, unfrozen own sign-in's registered key of the account,
   * eligible today (Step 2's rules and the freeze line), on the curve. Read again in the write (`inWrite`) without the
   * eligibility, as the service reads it there.
   */
  private carriableKey(account: string, key: string, inWrite = false): boolean {
    const registry = this.registries.get(account);
    const device = registry?.devices.get(key);
    const family = this.keyFamily.get(key);
    return registry !== undefined && device !== undefined && !device.removed && (inWrite || (device.eligible && !this.frozen(registry, device.no)))
      && family !== undefined && !this.revokedFamilies.has(family) && !this.deviceFamilies.has(family) && !this.frozenSignIn(account, family) && isListKey(key);
  }

  /**
   * The second lock's age rule for a device (`mayAddPc`): an own sign-in made in the last ten minutes, or older with a
   * proof (provedKey) by the key registered for that very sign-in, over the purpose, the list id (or "" for an invite) in
   * the place of the server_id and `slot` (or the invite's key) in the place of the listing. A proof that is sent is judged, its challenge spent, whatever the
   * sign-in's age. Null when it passes.
   */
  private async freshOrProved(session: Session, proof: unknown, purpose: PcAddPurpose | "invite" | "invite-auto", list: string, slot: string): Promise<Response | null> {
    const recent = this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) <= REAUTH_MS;
    // `invite` and `invite-auto` are the make proof's purposes (inviteMakeBytes): the same bytes as pcAddSigningBytes
    const proved = await this.provedKey(session, proof, purpose as PcAddPurpose, list, slot);
    if (proved instanceof Response) {
      const { error } = await proved.json() as { error: { code: string; message: string } };
      return this.v2Problem(proved.status, error.code, error.message);
    }
    return proved !== null || recent ? null : this.v2Problem(403, "session_not_fresh", "Sign in again on this device first");
  }

  /** POST /v2/lists/{list}/claims: a device claims its member key with the card its `device` entry will carry. */
  private async claim(request: Request, session: Session, id: string): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.small);
    if (body instanceof Response) return body;
    const { key, enc, card } = body;
    if (!hasOnly(body, ["key", "enc", "card"], ["key_proof", "link"]) || typeof key !== "string" || typeof enc !== "string" || typeof card !== "string" || card.length !== CARD_SIGNATURE_CHARS
      || (body.key_proof !== undefined && keyProofOf(body.key_proof) === null) || (body.link !== undefined && !isLinkForm(body.link))) return this.v2Invalid();
    const refused = this.writeRefusal(session.account, session.family);
    if (refused !== null) return refused;
    const list = this.ownList(session.account, id);
    if (list === undefined) return this.v2Unknown();
    if (!isListKey(key) || !isListKey(enc)) return this.v2Invalid();
    if (!await cardHolds({ key, enc, list: list.id, endpoint: null, invite: null }, card)) return this.v2Problem(400, "card_invalid", "The card is not that key's for this list");
    // the key's link to this sign-in's registered key, kept with the claim and written with the member when its entry is placed
    const link = body.link === undefined ? null : await this.linkedKey(session, list.id, key, body.link);
    if (link instanceof Response) return link;
    const fresh = await this.freshOrProved(session, body.key_proof, "list-claim", list.id, key);
    if (fresh !== null) return fresh;
    // judged again in the write: the sign-in still stands and the list is still the account's, or another's claim stays
    if (this.revokedFamilies.has(session.family)) return this.v2Problem(401, "unauthorized", "Sign in again");
    const fell = this.writeRefusal(session.account, session.family);
    if (fell !== null) return fell;
    if (this.ownList(session.account, id) !== list) return this.v2Unknown();
    // one claim per sign-in and list, and one per key and list: a later claim of a key takes it over
    for (const [claimed, held] of list.claims) if (held.family === session.family && claimed !== key) list.claims.delete(claimed);
    const at = this.now();
    list.claims.set(key, { family: session.family, enc, card, at, link });
    return this.v2Json({ key, until: untilOf(at) });
  }

  /**
   * POST /v2/lists/{list}/links: a device that is in the list says which registered key is its own (D11.2), with both
   * signatures; of any age, since a token alone holds neither key. The member key's earlier link is replaced; a registered
   * key linked to another device that is in is `409 link_taken`. Written while the head and the sign-in stand (`409 try_again`).
   */
  private async links(request: Request, session: Session, id: string): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.small);
    if (body instanceof Response) return body;
    if (!hasOnly(body, ["key", "link"]) || typeof body.key !== "string" || !isLinkForm(body.link)) return this.v2Invalid();
    const refused = this.writeRefusal(session.account, session.family);
    if (refused !== null) return refused;
    const list = this.ownList(session.account, id);
    if (list === undefined) return this.v2Unknown();
    const halted = this.halted(list, { family: session.family });
    if (halted !== null) return halted;
    const key = body.key;
    if (!isListKey(key)) return this.v2Invalid();
    if (signerPower(list.state, key) === null || rowOf(list.state.signers, key)?.as !== "device") return this.v2Problem(409, "not_member", "That key is no device of this list");
    const judged = list.last;
    const own = await this.linkedKey(session, list.id, key, body.link);
    if (own instanceof Response) return own;
    const stays = (member: string) => signerPower(list.state, member) !== null;
    if (this.linkTaken(list, key, own, stays)) {
      return this.v2Problem(409, "link_taken", "This sign-in's key is linked to another device of the list that is in; a sign-in is one device");
    }
    if (list.last !== judged || this.lists.get(list.id) !== list || !this.signInStands(session.account, session.family) || this.registeredKey(session.account, session.family) !== own) {
      return this.v2Problem(409, "try_again", "The list changed while this was written; send it again");
    }
    this.writeLink(list, key, own, stays);
    return this.v2Json({ key, linked: true });
  }

  /** PUT /v2/lists/{list}/wraps: wraps with no entry (D11.6), from a sign-in that stands for a device the list lets in now. */
  private async putWraps(request: Request, session: Session, id: string): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.entries);
    if (body instanceof Response) return body;
    const wraps = wrapsOf(body.wraps);
    if (!hasOnly(body, ["wraps"]) || wraps === null || wraps.length === 0) return this.v2Invalid();
    // the sign-in read again once the body is in: one that signed out meanwhile stores nothing
    const refused = this.writerFell(session);
    if (refused !== null) return refused;
    const list = this.ownList(session.account, id);
    if (list === undefined) return this.v2Unknown();
    const halted = this.halted(list, { family: session.family });
    if (halted !== null) return halted;
    if (this.ownDevices(list, session).length === 0) return this.v2Problem(403, "not_linked", "Only a device that is in the list, and linked to this sign-in, stores wraps");
    return this.storeWraps(list, wraps);
  }

  /** Wraps with no entry (D11.6): each for the list's current epoch and a key of wrapKeys at the head, stored only where none stands. */
  private storeWraps(list: FakeList, wraps: readonly ListWrap[]): Response {
    const wrapAt = wrapRefusal(wraps, list.state, Math.floor(this.now() / 1000));
    if (wrapAt !== null) return this.wrapInvalid(wrapAt);
    let stored = 0;
    for (const wrap of wraps) {
      if (list.wraps.get(wrap.member)?.has(wrap.epoch) === true) continue;
      storeWrap(list, wrap);
      stored += 1;
    }
    return this.v2Json({ list: list.id, stored });
  }

  /** The claims that still lock, oldest first: at most ten minutes old, by a sign-in still there, an app's own of the account, not frozen. */
  private liveClaims(list: FakeList): (ListClaim & { readonly key: string })[] {
    return [...list.claims].filter(([, claim]) => this.now() - claim.at <= LIST_CLAIM_MS && this.signInStands(list.account, claim.family))
      .map(([key, claim]) => ({ key, ...claim })).sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  }

  /** The posts that stand (shown, and carrying the comparison), by endpoint, oldest first: at most ten minutes old, of a PC the account lists in any state. */
  private livePosts(list: FakeList): [string, ListPost][] {
    return [...list.posts].filter(([, post]) => this.now() - post.at <= LIST_CLAIM_MS && this.directories.get(list.account)?.has(post.server_id) === true)
      .sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : 1));
  }

  /**
   * POST /v2/lists/{list}/entries. Read, and asked whether the sign-in may write, before it is counted: a removal (`remove`
   * entries, at most one `epoch` last, at the list's head) from a caller that may write, whose first entry verifies under a
   * signer of the list, spends that signer's own counter; anything else, a body out of form included, spends the
   * account's requests. So nothing else the account's sign-ins send stands in a removal's way, and a replayed one spends
   * nothing of its signer's. The answers keep their order: 429, `entry_malformed`, 404, `own_sign_in_required` / `frozen`.
   */
  private async deviceBatch(request: Request, session: Session, id: string): Promise<Response> {
    const account = session.account;
    const body = await this.v2Body(request, LIST_BODY.entries);
    const texts = body instanceof Response ? null : entriesOf(body.entries);
    const wraps = body instanceof Response ? null : wrapsOf(body.wraps);
    if (body instanceof Response || !hasOnly(body, ["entries"], ["wraps", "key_proof", "link"]) || texts === null || wraps === null || (body.key_proof !== undefined && keyProofOf(body.key_proof) === null)
      || (body.link !== undefined && !isLinkForm(body.link))) {
      return this.listLimited(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW, LIMIT_WINDOW_MS) ?? (body instanceof Response ? body : this.v2Invalid());
    }
    const list = this.ownList(account, id);
    if (list !== undefined) {
      const halted = this.halted(list, { family: session.family });
      if (halted !== null) return halted;
    }
    const batch = parseTexts(texts);
    const refused = list === undefined ? null : this.writeRefusal(account, session.family);
    const first = Array.isArray(batch) ? batch[0] : undefined;
    // the head and the signer are read again after the signature check, right before the counter is chosen: a copy of a
    // removal placed meanwhile is a replay, on the account's requests
    const removal = list !== undefined && refused === null && Array.isArray(batch) && first !== undefined && isRemoval(list, batch)
      && await verifySignature(first.entry.body, first.entry.signature, first.body.signer) && isRemoval(list, batch) && signerPower(list.state, first.body.signer) !== null;
    const limited = removal
      ? this.listLimited(`removals:${first!.body.signer}:${account}`, this.listLimits.removalsPerWindow, LIMIT_WINDOW_MS)
      : this.listLimited(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW, LIMIT_WINDOW_MS);
    if (limited !== null) return limited;
    if (!Array.isArray(batch)) return this.v2Problem(400, batch.code, batch.message, { index: batch.index });
    if (list === undefined) return this.v2Unknown();
    if (refused !== null) return refused;
    return await this.place(list, batch, wraps, { family: session.family }, { session, proof: body.key_proof, link: body.link });
  }

  /** The 503 a test turned on for this list (ListTamper `rebuilding`, `stopped`), or null. */
  private halted(list: FakeList, caller: ListCaller): Response | null {
    const lie = this.tamperFor(list, caller);
    if (lie.stopped === true) return this.v2Problem(503, "list_stopped", "This list takes no entries until the service's maintainer has looked at it");
    if (lie.rebuilding === true) return this.v2Problem(503, "list_rebuilding", "The service is reading this list again; try again in a moment", {}, 1);
    return null;
  }

  /** The PC routes of the list: the relay-key proof in the body, one challenge spent per call. */
  private async v2Pc(request: Request, path: string): Promise<Response> {
    const shape = Object.hasOwn(PC_SHAPES, path) ? PC_SHAPES[path] : undefined;
    if (shape === undefined) return this.v2Unknown();
    const body = await this.v2Body(request, shape.size);
    if (body instanceof Response) return body;
    if (!hasOnly(body, [...PC_PROOF, ...shape.members], shape.optional ?? []) || !pcBodyFormed(path, body)) return this.v2Invalid();
    if (typeof body.server_id !== "string" || !/^[0-9a-f]{32}$/.test(body.server_id)) return this.v2Invalid();
    const key = proofKey(body.public_key);
    if (!key || deriveServerId(key) !== body.server_id) return this.v2Problem(400, "server_key_mismatch", "That key does not give that server_id");
    if (!this.takeProof({ server_id: body.server_id, challenge_id: body.challenge_id, proof: body.proof })) return this.v2Problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const serverId = body.server_id;
    const endpoint = body.public_key as string;
    const limited = this.listLimited(`list-pc:${serverId}`, this.listLimits.pcCallsPerMinute, 60_000);
    if (limited !== null) return limited;
    const caller = { server_id: serverId, endpoint };
    if (path === "/v2/pc/list") {
      const account = body.account as string;
      if (!this.listsOn(account)) return this.v2Unknown();
      const list = this.listOfAccount(account);
      const listed = this.directories.get(account)?.has(serverId) === true;
      // a listing in any state (the PC needs the id for its card), or a row in the list (a PC removed from the directory)
      if (list === undefined) return listed ? this.v2Json({ list: null }) : this.v2Unknown();
      if (!listed && rowOf(list.state.pcs, endpoint) === null) return this.v2Unknown();
      const halted = listed ? null : this.halted(list, caller);
      if (halted !== null) return halted;
      const served = this.servedLog(list, caller);
      return this.v2Json({ list: served.id, head: served.head });
    }
    const list = this.lists.get(body.list as string);
    if (list === undefined || !this.listsOn(list.account)) return this.v2Unknown();
    const listing = this.directories.get(list.account)?.get(serverId);
    if (path === "/v2/pc/list/log" || path === "/v2/pc/list/wraps" || path === "/v2/pc/list/links") {
      // a listing the account confirmed, or a row in the list, removed or not: a removed PC reads its removal
      const confirmed = listing !== undefined && this.confirmed(listing);
      if (!confirmed && rowOf(list.state.pcs, endpoint) === null) return this.v2Unknown();
      const halted = confirmed ? null : this.halted(list, caller);
      if (halted !== null) return halted;
      if (path === "/v2/pc/list/log") return this.logPage(list, caller, body.after === undefined ? null : body.after as number, body.limit === undefined ? LIST_PAGE_MAX : body.limit as number);
      if (path === "/v2/pc/list/links") return this.linksPage(list, caller, body.after === undefined ? null : body.after as number, body.limit === undefined ? LIST_PAGE_MAX : body.limit as number);
      if (!isListKeyEncoding(body.member as string)) return this.v2Invalid();
      return this.v2Json({ wraps: this.servedWraps(list, caller, body.member as string) });
    }
    if (path === "/v2/pc/list/wraps/put") {
      // a PC that is in the list by the list's own word (holdsPc) stores wraps as a device does; any other has no such route
      if (listing === undefined && rowOf(list.state.pcs, endpoint) === null) return this.v2Unknown();
      const halted = this.halted(list, caller);
      if (halted !== null) return halted;
      return holdsPc(list.state, endpoint) ? this.storeWraps(list, body.wraps as ListWrap[]) : this.v2Unknown();
    }
    if (path === "/v2/pc/list/entries") {
      // a machine neither in the list nor listed by its account learns nothing here, not even where the head stands: the
      // unknown route before its batch is looked at
      if (listing === undefined && rowOf(list.state.pcs, endpoint) === null) return this.v2Unknown();
      const halted = this.halted(list, caller);
      if (halted !== null) return halted;
      // a PC that is not in the list places nothing but a join of its own: any other batch of its is the unknown route too
      const inside = holdsPc(list.state, endpoint);
      const batch = parseTexts(body.entries as string[]);
      if (!Array.isArray(batch)) return inside ? this.v2Problem(400, batch.code, batch.message, { index: batch.index }) : this.v2Unknown();
      // a PC in the list, or one whose every entry is a join naming it (the proof is the join's second lock)
      if (!inside && !batch.every(({ body: entry }) => namesEndpoint(entry, endpoint))) return this.v2Unknown();
      return await this.place(list, batch, wrapsOf(body.wraps)!, caller);
    }
    // the keys route and the attempt route: only while the account lists this PC, so that the proof locks something
    if (listing === undefined) return this.v2Unknown();
    if (path === "/v2/pc/list/attempt") return this.pcAttempt(list, endpoint, body.commitment as string | undefined, body.nonce as string | undefined);
    const posted = { key: body.key as string, enc: body.enc as string, card: body.card as string };
    if (!isListKey(posted.key) || !isListKey(posted.enc)) return this.v2Invalid();
    if (!await cardHolds({ ...posted, list: list.id, endpoint, invite: null }, posted.card)) return this.v2Problem(400, "card_invalid", "The card is not that key's for this list and this PC");
    // a PC that joins by the line of an invite a person holds posts that invite's key and the line's proof for the card it
    // posts (`ovis-list-line/1`, never a redeem signature); the account's devices check both themselves, and the service only
    // refuses junk early
    const invite = body.invite as string | undefined;
    const inviteProof = body.invite_proof as string | undefined;
    if ((invite === undefined) !== (inviteProof === undefined) || (invite !== undefined && !isListPoint(invite))) return this.v2Problem(400, "invalid_request", "Send an invite's key and its line's proof together");
    if (invite !== undefined) {
      const halted = this.halted(list, caller);
      if (halted !== null) return halted;
      if (!this.listHoldsInvite(list, invite)) return this.v2Problem(409, "invite_not_in_list", "The list holds no open invite of this key");
      if (!await verifyLineProof({ account: list.account, server_id: serverId, list: list.id, card: { key: posted.key, enc: posted.enc, endpoint } }, inviteProof, invite)) {
        return this.v2Problem(400, "invite_proof_invalid", "The proof is not that invite line's signature for this account, this PC and this card");
      }
    }
    // posting the same keys again while the post still stands renews it and keeps an open comparison; a post that ran out is
    // over, and other keys are another card: either way the comparison goes
    const before = list.posts.get(endpoint);
    const stands = before !== undefined && this.now() - before.at <= LIST_CLAIM_MS;
    const attempt = stands && before.key === posted.key && before.enc === posted.enc ? before.attempt : null;
    const at = this.now();
    list.posts.set(endpoint, { ...posted, server_id: serverId, at, attempt, invite: invite === undefined ? null : { key: invite, proof: inviteProof! } });
    return this.v2Json({ endpoint, key: posted.key, until: untilOf(at) });
  }

  /**
   * Places a batch at the head, whole or not at all, as the service judges it: the first entry at the head (the
   * compare-and-swap); then entry by entry, each holds after the one before it and counts for the library on the service's
   * state, and what only the service judges (no `carried` yet, an invite from a sign-in and by its clock, a join by the
   * PC it names, the list's size); then the second lock, the wraps, and the head again with the writer and the budget, at
   * the write. From the second lock to the write nothing waits, so of two writers at one head exactly one is placed.
   * The write does what S2 adds outside the log (D11): the claims' links go with their members, a device put out is signed
   * out, an invite put out is revoked, and a list's `invite` is made the service's invite.
   */
  private async place(list: FakeList, batch: readonly ParsedEntry[], wraps: readonly ListWrap[], caller: ListCaller, device?: { readonly session: Session; readonly proof: unknown; readonly link?: unknown }): Promise<Response> {
    const lie = this.tamperFor(list, caller);
    if (lie.headMoved === true) return this.headMoved(list);
    const head = headOf(list);
    const first = batch[0]!;
    if (first.body.list !== list.id) return this.v2Problem(400, "chain_broken", "list is not this list's id", { index: 0 });
    if (first.body.seq !== head.seq + 1 || first.body.prev !== head.hash) return this.notAtHead(list, batch);
    const judged = list.last;
    let last = judged;
    let state = list.state;
    const nowS = Math.floor(this.now() / 1000);
    const held: HeldEntry[] = [];
    const claims: { index: number; key: string }[] = [];
    const posts: { index: number; key: string; endpoint: string }[] = [];
    const joins: { index: number; server_id: string; endpoint: string; invite: string }[] = [];
    let invited: { readonly index: number; readonly key: string; readonly auto: boolean; readonly exp: number } | null = null;
    // the device keys and the invite keys a `remove` of the batch put out: their sign-ins and the service's invites end with them
    const out = { devices: [] as string[], invites: [] as string[] };
    // a later hand-over (F10b): the batch's one `device`, ending its own signer, which is the key this sign-in registered
    const own = caller.family === undefined ? undefined : this.registeredKey(list.account, caller.family);
    let handOver: string | null = null;
    const limits = this.listLimits;
    for (const [index, { entry }] of batch.entries()) {
      const previous = last;
      try {
        last = await entryHolds(entry, last);
      } catch (error) {
        if (error instanceof ListEntryError) return this.v2Problem(400, error.code, error.message, { index });
        throw error;
      }
      const kind = readKind(last.body);
      const invite = kind?.kind === "join" ? rowOf(state.invites, last.body.signer) : null;
      const taken = await takeEntry(state, last);
      if (taken.outcome.outcome !== "counts" || kind === null) {
        const reason = "code" in taken.outcome ? taken.outcome.code : null;
        return this.refusedAt(index, taken.outcome.outcome === "counts" ? "no_effect" : taken.outcome.outcome, reason, "A member would not count this entry");
      }
      // from here on, what only the service judges: a member counts each of these entries. The list's own time is the latest
      // issued_at a full signer wrote, so one dated far ahead would end every invite and every borrowed browser at once
      if (last.body.issued_at > nowS + LIST_ISSUED_AHEAD_S) return this.refusedAt(index, "service", "issued_at_ahead", "An entry's issued_at is not ahead of the service's clock");
      // carrying members in from before the list has no second lock yet, so the service places none
      if (kind.kind === "carried") return this.refusedAt(index, "service", "carried_not_open", "Carrying members in from before the list is not open yet");
      if (kind.kind === "invite") {
        // an invite lets a PC in with nobody else awake: a PC's key alone opens no way in for a machine; and what the sign-in
        // that places it must be is asked for one invite, so a batch holds one
        if (caller.family === undefined) return this.v2Problem(403, "sign_in_required", "An invite is placed by a sign-in of the account", { index });
        if (invited !== null) return this.refusedAt(index, "service", "invite_alone", "A batch holds at most one invite");
        // the service's invite is single use: one with more uses would stand open after its one join, wrapped to every epoch
        if (kind.uses !== 1) return this.refusedAt(index, "service", "uses_one", "An invite lets one PC in: uses is 1");
        invited = { index, key: kind.key, auto: kind.auto, exp: kind.exp };
      }
      if (kind.kind === "join") {
        if (invite !== null && nowS > invite.exp) return this.v2Problem(409, "invite_expired", "That invite has expired", { index });
        if (caller.endpoint !== kind.endpoint) return this.v2Problem(403, "pc_proof_required", "A join is placed by the PC it names, with its own proof", { index });
        joins.push({ index, server_id: caller.server_id!, endpoint: kind.endpoint, invite: last.body.signer });
      }
      if (kind.kind === "epoch") {
        // an epoch is opened because a key went out, never at will: the state only grows, and one full signer opening epochs
        // as fast as it can send them would fill the list for good
        if (sealEpoch(state, nowS) !== null) return this.refusedAt(index, "service", "epoch_not_needed", "Nobody went out since the current epoch was opened");
        if (previous.body.kind !== "remove" && sealEpoch(taken.state, nowS) === null) {
          return this.refusedAt(index, "service", "epoch_no_use", "An invite or a device past its time is still in: put it out first, then open the epoch");
        }
      }
      // the writers' rule (the library's sealEpoch, at the service's clock): names are sealed only under an epoch opened after
      // the last entry that put a member out, and while nobody in is over its time; else whoever is out still reads them
      if ("sealed" in kind && kind.sealed !== null && sealEpoch(state, nowS) === null) {
        return this.refusedAt(index, "service", "epoch_stale", "Names are sealed only under an epoch opened after the last removal: open the next epoch, or write this entry without names");
      }
      if (kind.kind === "remove" && "ends" in kind) {
        // what the key was before this entry: a device that goes is signed out at the service, an invite that goes is revoked
        const was = rowOf(state.signers, kind.ends)?.as;
        if (was === "device") out.devices.push(kind.ends);
        if (was === "invite") out.invites.push(kind.ends);
      }
      // a hand-over needs no claim: its own signature, by the sign-in's registered key, is its lock; only a device the list
      // holds by a `carried` entry hands over so
      const handsOver = rowOf(state.signers, last.body.signer)?.as === "device" && rowOf(state.devices, last.body.signer)?.carried === true;
      if (kind.kind === "device" && batch.length === 1 && kind.rotates && own !== undefined && last.body.signer === own && handsOver) handOver = kind.key;
      else if (kind.kind === "device") claims.push({ index, key: kind.key });
      if (kind.kind === "pc") posts.push({ index, key: kind.key, endpoint: kind.endpoint });
      const tail = kind.kind === "remove" || kind.kind === "epoch";
      const size = JSON.stringify(taken.state).length;
      if (last.body.seq >= limits.closedFrom || (!tail && (last.body.seq >= limits.removalsOnlyFrom || size > limits.stateChars)) || (kind.kind !== "remove" && size > limits.stateHardChars)) {
        return this.v2Problem(409, "list_full", last.body.seq >= limits.closedFrom ? "This list takes no more entries" : "This list takes only removals now");
      }
      state = taken.state;
      held.push(last);
    }
    const lock = this.lockRefusal(list, claims, posts, joins);
    if (lock !== null) return lock;
    // a link goes with a hand-over alone: judged after the second lock
    if (device?.link !== undefined && handOver === null) return this.v2Problem(400, "invalid_request", "A link goes with a hand-over");
    const wrapAt = wrapRefusal(wraps, state, nowS);
    if (wrapAt !== null) return this.wrapInvalid(wrapAt);
    // an invite is placed as one is made: by a sign-in made in the last ten minutes, or proving its registered key for this
    // very invite (purpose `invite` or `invite-auto`, no server_id, the invite's key as the listing); a proof with no invite
    // to prove is the caller's mistake
    if (device?.proof !== undefined && invited === null) return this.v2Problem(400, "invalid_request", "A key proof goes with an invite");
    const handOverLink = handOver !== null && device?.link !== undefined ? await this.linkedKey(device.session, list.id, handOver, device.link) : null;
    if (handOverLink instanceof Response) return handOverLink;
    if (invited !== null && device !== undefined) {
      // the service's invite is made with the entry, under its own limits (D11.5): counted per account, a key new to invites
      // and devices, at most five open, and for one a PC joins with by itself the day's cap of adds
      if (!this.withinRateLimit(`invites:${list.account}`, INVITES_PER_WINDOW)) return this.v2Problem(429, "rate_limited", "Too many requests; try again later", {}, 60);
      const unfit = this.inviteUnfit(list.account, invited);
      if (unfit !== null) return unfit;
      const fresh = await this.freshOrProved(device.session, device.proof, invited.auto ? "invite-auto" : "invite", "", invited.key);
      if (fresh !== null) return fresh;
      const capped = invited.auto ? this.capRefusal(list.account) : null;
      if (capped !== null) return capped;
    }
    // the write, judged again as one: the list still stands (an account's deletion takes it), the head it was judged on,
    // the writer, the locks; nothing waits from here on
    if (this.lists.get(list.id) !== list) return this.v2Unknown();
    if (list.last !== judged) return this.notAtHead(list, batch);
    if (caller.family !== undefined) {
      if (this.revokedFamilies.has(caller.family)) return this.v2Problem(401, "unauthorized", "Sign in again");
      const fell = this.writeRefusal(list.account, caller.family);
      if (fell !== null) return fell;
    }
    const fallen = this.lockRefusal(list, claims, posts, joins);
    if (fallen !== null) return fallen;
    // a hand-over's lock is its signer, still the key the calling sign-in registered
    if (handOver !== null && (caller.family === undefined || this.registeredKey(list.account, caller.family) !== own)) {
      return this.v2Problem(403, "not_claimed", "That device's key has no live claim by a sign-in of this account", { index: 0 });
    }
    const making = device === undefined ? null : invited;
    if (making !== null) {
      const unfit = this.inviteUnfit(list.account, making);
      if (unfit !== null) return unfit;
      // an invite that stands was made under the cap; only a new one is held to it here
      const capped = making.auto && this.standingInvite(list.account, making) === undefined ? this.capRefusal(list.account) : null;
      if (capped !== null) return capped;
    }
    const now = this.now();
    // a hand-over is outside the budget of additions
    const additions = handOver !== null ? 0 : held.filter(({ body }) => LIST_ADDITIONS.includes(body.kind)).length;
    const day = list.additions.filter((at) => at > now - LIST_ADDITIONS_DAY_MS);
    const waits = [
      budgetWait(day.filter((at) => at > now - LIMIT_WINDOW_MS), additions, limits.additionsPerWindow, LIMIT_WINDOW_MS, now),
      budgetWait(day, additions, limits.additionsPerDay, LIST_ADDITIONS_DAY_MS, now),
    ];
    if (additions > 0 && waits.some((wait) => wait !== null)) {
      return this.v2Problem(429, "entry_budget", "Too many devices, PCs and invites added to this list; try again later", {}, Math.max(...waits.map((wait) => wait ?? 1)));
    }
    list.texts.push(...batch.map(({ text }) => text));
    list.hashes.push(...held.map(({ hash }) => hash));
    list.last = held.at(-1)!;
    list.state = state;
    // the links the claims carried go with their members while the sign-in that claimed still holds that registered key, and
    // the hand-over's with its key; a link to a device the batch leaves out gives way (D11.2)
    const stay = new Set(Object.entries(state.signers).filter(([, row]) => row.as === "device" && row.ended === null).map(([key]) => key));
    for (const { key } of claims) {
      const claim = list.claims.get(key);
      if (claim !== undefined && claim.link !== null && this.registeredKey(list.account, claim.family) === claim.link) this.writeLink(list, key, claim.link, (member) => stay.has(member));
    }
    if (handOver !== null && handOverLink !== null) this.writeLink(list, handOver, handOverLink, (member) => stay.has(member));
    // a lock is used up by the entry it let in
    for (const { key } of claims) list.claims.delete(key);
    for (const { endpoint } of posts) list.posts.delete(endpoint);
    if (lie.dropWraps !== true) for (const wrap of wraps) storeWrap(list, wrap);
    list.additions.splice(0, list.additions.length, ...day, ...Array<number>(additions).fill(now));
    // a device put out is signed out and its registered key removed (D11.4), read after this batch's links: the key linked to
    // it, and a registered key that is the ended key itself (a key carried in, or entry 0's), unless that sign-in is linked to
    // a device the batch leaves in. Last, as the writer may be among them
    const registry = this.registries.get(list.account);
    const selfOut = (key: string) => registry?.devices.has(key) === true && ![...list.links].some(([member, registered]) => registered === key && stay.has(member));
    for (const key of out.devices) {
      for (const registered of new Set([list.links.get(key), selfOut(key) ? key : undefined])) {
        if (registered === undefined) continue;
        const family = this.keyFamily.get(registered);
        if (family !== undefined) this.revokeFamily(family);
        this.removeDevice(list.account, registered);
      }
    }
    // the list's invite is the service's invite: made here unless one of that key stands already, for fifteen minutes or to
    // the entry's `exp`, by the sign-in that placed it; then an invite whose key the batch put out is revoked, while nobody
    // used it (one the same batch made and put out among them)
    if (making !== null && device !== undefined && ![...this.invites.values()].some((held) => held.key === making.key)) {
      const made: FakeInvite = { id: randomHex(16), account: list.account, key: making.key, auto: making.auto, family: device.session.family, madeAt: now,
        expiresAt: Math.min(now + PC_INVITE_TTL_MS, making.exp * 1000), revoked: false, used: null };
      this.invites.set(made.id, made);
    }
    for (const invite of this.invites.values()) if (invite.account === list.account && invite.used === null && out.invites.includes(invite.key)) invite.revoked = true;
    // the doorbell rings the account's other devices from a budget of its own, never the one admissions ring from
    if (this.withinRateLimit(`list_rings:${list.account}`, LIST_RINGS_PER_WINDOW)) this.ring(list.account, caller.family ?? "");
    this.withheld(list.account);
    return this.v2Json({ list: list.id, head: headOf(list), placed: held.length });
  }

  /** The first entry of the batch whose second lock does not hold now, as its refusal; null when every one holds. */
  private lockRefusal(list: FakeList, claims: readonly { index: number; key: string }[], posts: readonly { index: number; key: string; endpoint: string }[],
    joins: readonly { index: number; server_id: string; endpoint: string; invite: string }[]): Response | null {
    const claimed = this.liveClaims(list);
    const directory = this.directories.get(list.account);
    // a listing an own sign-in made or let in (an own sign-in's listing, a confirm, the one-press admit, an auto invite's
    // redeem): one a device code wrote and nobody confirmed locks nothing, since any PC of the account holds such a sign-in
    const ownListed = (serverId: string): boolean => { const row = directory?.get(serverId); return row !== undefined && row.listed_by_device !== true; };
    const posted = this.livePosts(list).filter(([, post]) => ownListed(post.server_id));
    // that very PC redeemed that very auto invite of the account (POST /v1/pc-invites/redeem): the join passes what a redeem asks
    const redeemed = ({ server_id, endpoint, invite }: { server_id: string; endpoint: string; invite: string }): boolean =>
      [...this.invites.values()].some((held) => held.account === list.account && held.key === invite && held.auto && held.used?.server_id === server_id && held.used.public_key === endpoint);
    const missing = [
      ...claims.filter(({ key }) => !claimed.some((claim) => claim.key === key)).map(({ index }) => ({ index, lock: "claim" })),
      ...posts.filter(({ key, endpoint }) => !posted.some(([at, post]) => at === endpoint && post.key === key)).map(({ index }) => ({ index, lock: "post" })),
      ...joins.filter((join) => !redeemed(join)).map(({ index }) => ({ index, lock: "redeem" })),
      ...joins.filter((join) => redeemed(join) && !ownListed(join.server_id)).map(({ index }) => ({ index, lock: "join" })),
    ].sort((a, b) => a.index - b.index)[0];
    if (missing === undefined) return null;
    if (missing.lock === "claim") return this.v2Problem(403, "not_claimed", "That device's key has no live claim by a sign-in of this account", { index: missing.index });
    if (missing.lock === "post") return this.v2Problem(403, "not_posted", "That PC has not posted that key with its own proof, or no own sign-in of the account listed or let it in", { index: missing.index });
    if (missing.lock === "redeem") return this.v2Problem(403, "not_redeemed", "That PC has not redeemed that invite with the account service", { index: missing.index });
    return this.v2Problem(403, "not_listed", "No own sign-in of the account listed or let in the PC that joins", { index: missing.index });
  }

  /**
   * POST /v2/lists/{list}/posts/{endpoint}/attempt: the adder's two messages of the comparison of numbers with a PC that
   * posted (the formats' B7), which the service only carries. Without `reveal`, its key and commitment open an attempt in
   * place of any before it (counted per PC); with `reveal`, the nonce it committed to, taken only for that very attempt
   * once the PC's nonce is there. `key` is the PC's key of the post the adder saw: a post of other keys since is another card.
   */
  private async attempt(request: Request, session: Session, id: string, endpoint: string): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.small);
    if (body instanceof Response) return body;
    const { key, adder, commitment, reveal } = body;
    if (!hasOnly(body, ["key", "adder", "commitment"], ["reveal"]) || typeof key !== "string" || typeof adder !== "string" || !isNonce(commitment) || (reveal !== undefined && !isNonce(reveal))) return this.v2Invalid();
    const refused = this.writeRefusal(session.account, session.family);
    if (refused !== null) return refused;
    const list = this.ownList(session.account, id);
    if (list === undefined) return this.v2Unknown();
    if (!/^[0-9a-f]{64}$/.test(endpoint) || !isListKeyEncoding(key) || !isListKeyEncoding(adder)) return this.v2Invalid();
    const post = this.livePosts(list).find(([at, held]) => at === endpoint && held.key === key)?.[1];
    if (post === undefined) return this.v2Problem(409, "post_changed", "That PC has no live post of that key; read the posts again");
    if (reveal === undefined) {
      // opening an attempt is counted per PC, and only a call that opens one: calls that open nothing spend nothing
      const spent = this.listLimited(`list_attempts:${endpoint}:${list.account}`, this.listLimits.attemptsPerWindow, LIMIT_WINDOW_MS, "attempts_spent");
      if (spent !== null) return spent;
      post.attempt = { adder, commitment, nonce: null, reveal: null };
    } else if (post.attempt !== null && post.attempt.adder === adder && post.attempt.commitment === commitment && post.attempt.nonce !== null
      && (post.attempt.reveal === null || post.attempt.reveal === reveal)) {
      // taken once: the same reveal again is the same answer, another is not this attempt's
      post.attempt = { ...post.attempt, reveal };
    } else return this.v2Problem(409, "attempt_changed", "That is not the open attempt, or the PC has not answered it yet");
    return this.v2Json({ endpoint, key, attempt: post.attempt });
  }

  /**
   * POST /v2/pc/list/attempt: the PC's side of the comparison, for the post it made. It reads the attempt the adder opened;
   * with `commitment` and `nonce` it answers that very attempt with its nonce, once: a second nonce for one commitment is
   * refused, the same one again is not.
   */
  private pcAttempt(list: FakeList, endpoint: string, commitment: string | undefined, nonce: string | undefined): Response {
    if ((commitment === undefined) !== (nonce === undefined)) return this.v2Problem(400, "invalid_request", "Answer a commitment with a nonce, or send neither");
    const post = this.livePosts(list).find(([at]) => at === endpoint)?.[1];
    if (nonce === undefined) return this.v2Json({ attempt: post?.attempt ?? null });
    const open = post?.attempt;
    if (post === undefined || open === null || open === undefined || open.commitment !== commitment || (open.nonce !== null && open.nonce !== nonce)) {
      return this.v2Problem(409, "attempt_changed", "That is not the open attempt, or it has its nonce already");
    }
    post.attempt = { ...open, nonce };
    return this.v2Json({ attempt: post.attempt });
  }

  /** `200` with `placed: 0` when the batch stands in the log already, text for text, at the places it names; else `409 head_moved` with the head now. */
  private notAtHead(list: FakeList, batch: readonly ParsedEntry[]): Response {
    const from = batch[0]?.body.seq ?? 0;
    return batch.every(({ text }, at) => list.texts[from + at] === text) ? this.v2Json({ list: list.id, head: headOf(list), placed: 0 }) : this.headMoved(list);
  }

  private headMoved(list: FakeList): Response {
    return this.v2Problem(409, "head_moved", "The list's head is not where this batch starts; read the log and sign again", { head: headOf(list) });
  }

  private refusedAt(index: number, outcome: string, reason: string | null, message: string): Response {
    return this.v2Problem(400, "entry_refused", message, { index, outcome, reason });
  }

  private wrapInvalid(index: number): Response {
    return this.v2Problem(400, "wrap_invalid", "A wrap is 151 characters for the list's current epoch and one of its members' encryption keys", { index });
  }

  private expire(): void {
    const cutoff = this.now() - MAILBOX_TTL_MS;
    for (const [id, box] of this.mailboxes) this.mailboxes.set(id, box.filter(({ at }) => at > cutoff));
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

/** One mailbox per PC and account: another account's records can neither fill nor hide this account's. */
function box(serverId: string, account: string): string {
  return `${serverId}\0${account}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** `key_proof` as the service reads it: `{ challenge_id, signature }`, 32 lowercase hex digits and 86 base64url characters; null otherwise. */
function keyProofOf(value: unknown): { challenge_id: string; signature: string } | null {
  if (value === null || typeof value !== "object" || Object.keys(value).length !== 2) return null;
  const { challenge_id, signature } = value as Record<string, unknown>;
  return typeof challenge_id === "string" && /^[0-9a-f]{32}$/.test(challenge_id) && typeof signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(signature)
    ? { challenge_id, signature } : null;
}

/**
 * A redeem's answer, the same for every rerun: the card that offers Add for a plain invite's PC lasts until
 * `card_until`, and an auto invite's admission waits to be taken until `admission_until`; the other is null, and so is
 * `admission_until` once the sign-in that made the invite ended (`makerGone`), which ended its admission.
 */
function redeemed(account: string, listing: string, auto: boolean, at: number, makerGone = false) {
  const until = new Date(at + ADMISSION_TTL_MS).toISOString();
  return { account, listing_id: listing, auto, card_until: auto ? null : until, admission_until: auto && !makerGone ? until : null };
}

function limited(code: "rate_limited" | "pc_add_cap", seconds: number): Response {
  const answer = problem(429, code, code === "pc_add_cap" ? "This account added enough PCs today" : "Too many requests; try again later");
  answer.headers.set("retry-after", String(seconds));
  return answer;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A link's half as text (D11.2): the base64url of `r || s`, 64 bytes, in its one spelling. */
const LINK_SIGNATURE_CHARS = 86;

/** A `link` in its JSON form: the two halves `{ member, device }`, or the bare member half (refused as `link_unsigned`). */
const isLinkForm = (value: unknown): boolean => (typeof value === "string" && value.length === LINK_SIGNATURE_CHARS)
  || (isRecord(value) && hasOnly(value, ["member", "device"]) && typeof value.member === "string" && value.member.length === LINK_SIGNATURE_CHARS
    && typeof value.device === "string" && value.device.length === LINK_SIGNATURE_CHARS);

/** A post as the routes show it: the plain invite's key and proof only where the post carried them. */
const postView = (endpoint: string, { server_id, key, enc, card, at, attempt, invite }: ListPost): ListPostView =>
  ({ endpoint, server_id, key, enc, card, until: untilOf(at), attempt, ...(invite === null ? {} : { invite: invite.key, invite_proof: invite.proof }) });

/** When a PC invite ends, in ms. */
const inviteEnd = (invite: FakeInvite): number => invite.expiresAt ?? invite.madeAt + PC_INVITE_TTL_MS;

/** The level the service reads lists at: a kind at a higher `v` is `cannot_read` there, and so never placed. */
const LIST_SERVICE_LEVEL = 1;
const LIST_ADDITIONS: readonly string[] = ["device", "invite", "pc", "join"];
/** The day of the additions budget. */
const LIST_ADDITIONS_DAY_MS = 24 * 60 * 60 * 1000;
/** Rings of a list's placements per account in ten minutes, counted apart from the rings of admissions. */
const LIST_RINGS_PER_WINDOW = 10;
/** The latest wraps one read gives of a member. */
const LIST_WRAPS_READ = 256;
const NUMBER_MAX = 999_999_999_999_999;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LIST_NUMBER = /^(?:0|[1-9][0-9]{0,14})$/;
const LIST_ROUTES: readonly string[] = ["POST genesis", "GET mine", "GET log", "GET wraps", "PUT wraps", "POST entries", "POST claims", "GET claims", "GET posts", "POST links", "POST attempt"];
const PC_PROOF: readonly string[] = ["server_id", "public_key", "challenge_id", "proof"];
const PC_SHAPES: Readonly<Record<string, { readonly size: number; readonly members: readonly string[]; readonly optional?: readonly string[] }>> = {
  "/v2/pc/list": { size: LIST_BODY.small, members: ["account"] },
  "/v2/pc/list/log": { size: LIST_BODY.small, members: ["list"], optional: ["after", "limit"] },
  "/v2/pc/list/links": { size: LIST_BODY.small, members: ["list"], optional: ["after", "limit"] },
  "/v2/pc/list/wraps": { size: LIST_BODY.small, members: ["list", "member"] },
  "/v2/pc/list/wraps/put": { size: LIST_BODY.entries, members: ["list", "wraps"] },
  "/v2/pc/list/entries": { size: LIST_BODY.entries, members: ["list", "entries"], optional: ["wraps"] },
  "/v2/pc/list/keys": { size: LIST_BODY.small, members: ["list", "key", "enc", "card"], optional: ["invite", "invite_proof"] },
  "/v2/pc/list/attempt": { size: LIST_BODY.small, members: ["list"], optional: ["commitment", "nonce"] },
};

/** A 32-byte value of the comparison on the wire: 43 base64url characters in their one spelling. */
const isNonce = (value: unknown): value is string => typeof value === "string" && value.length === 43 && canonicalBase64Url(value)?.length === 32;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPlace = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= NUMBER_MAX;
const untilOf = (at: number): number => Math.floor((at + LIST_CLAIM_MS) / 1000);

/** A PC route's own members in their forms, as the service's schema reads them (the proof's members are judged by the proof). */
function pcBodyFormed(path: string, body: Record<string, unknown>): boolean {
  if (path === "/v2/pc/list") return typeof body.account === "string" && ACCOUNT_ID.test(body.account);
  if (typeof body.list !== "string" || !isListHash(body.list)) return false;
  switch (path) {
    case "/v2/pc/list/log": case "/v2/pc/list/links": return (body.after === undefined || isPlace(body.after)) && (body.limit === undefined || (isPlace(body.limit) && body.limit >= 1 && body.limit <= LIST_PAGE_MAX));
    case "/v2/pc/list/wraps": return typeof body.member === "string";
    case "/v2/pc/list/entries": return entriesOf(body.entries) !== null && wrapsOf(body.wraps) !== null;
    case "/v2/pc/list/wraps/put": return (wrapsOf(body.wraps)?.length ?? 0) >= 1;
    case "/v2/pc/list/attempt": return (body.commitment === undefined || isNonce(body.commitment)) && (body.nonce === undefined || isNonce(body.nonce));
    default: return typeof body.key === "string" && typeof body.enc === "string" && typeof body.card === "string" && body.card.length === CARD_SIGNATURE_CHARS
      && (body.invite === undefined || typeof body.invite === "string") && (body.invite_proof === undefined || typeof body.invite_proof === "string");
  }
}

/** The seconds until a batch of `additions` fits a budget of `max` in `window`, given when the list's additions in it were placed (ascending); null when it fits now. */
function budgetWait(placed: readonly number[], additions: number, max: number, window: number, now: number): number | null {
  const leaving = placed.length + additions - max;
  if (leaving < 1) return null;
  return Math.max(1, Math.ceil(((placed[leaving - 1] ?? now) + window - now) / 1000));
}

/** A removal for the counting: `remove` entries with at most one `epoch` last, standing at the list's head (a replay never does). */
function isRemoval(list: FakeList, batch: readonly ParsedEntry[]): boolean {
  const first = batch[0];
  const head = headOf(list);
  if (first === undefined || first.body.kind !== "remove" || first.body.list !== list.id || first.body.seq !== head.seq + 1 || first.body.prev !== head.hash) return false;
  return batch.every(({ body }, index) => body.kind === "remove" || (body.kind === "epoch" && index === batch.length - 1));
}

function headOf(list: FakeList): ListPlace {
  return { seq: list.texts.length - 1, hash: list.last.hash };
}

function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

/** A body read strictly: every required member, and no member but these. */
function hasOnly(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((name) => Object.hasOwn(body, name)) && Object.keys(body).every((name) => required.includes(name) || optional.includes(name));
}

function listNumber(text: string): number | null {
  return LIST_NUMBER.test(text) ? Number(text) : null;
}

/** A placement's `entries`: 1 to 16 texts. */
function entriesOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.length >= 1 && value.length <= LIST_BATCH_MAX && value.every((text) => typeof text === "string") ? value as string[] : null;
}

/** `wraps` in its JSON form (absent: none): up to 1024 objects of exactly `epoch`, `member` and `wrap`. Their values are judged by wrapRefusal. */
function wrapsOf(value: unknown): ListWrap[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIST_WRAPS_MAX) return null;
  return value.every((wrap) => isRecord(wrap) && hasOnly(wrap, ["epoch", "member", "wrap"]) && isPlace(wrap.epoch) && typeof wrap.member === "string" && typeof wrap.wrap === "string")
    ? value as ListWrap[] : null;
}

/**
 * The index of the first wrap the service does not store, or null: not 151 characters of base64url in one spelling, or
 * not for the epoch current in the state after the batch and one of its wrapKeys at `now` (seconds, the service's clock:
 * no invite past its `exp`, no device past its `until`). A wrap is not signed: the service checks its length and spelling only.
 */
function wrapRefusal(wraps: readonly ListWrap[], state: ListState, now: number): number | null {
  const members = new Set(wrapKeys(state, now));
  const index = wraps.findIndex((wrap) => wrap.wrap.length !== WRAP_TEXT || canonicalBase64Url(wrap.wrap)?.length !== WRAP_BYTES || wrap.epoch !== state.epoch || !members.has(wrap.member));
  return index < 0 ? null : index;
}

/** A wrap is written once: one already stored for its epoch and member stays, and the later one is dropped. */
function storeWrap(list: FakeList, wrap: ListWrap): void {
  const member = list.wraps.get(wrap.member) ?? new Map<number, string>();
  if (!member.has(wrap.epoch)) member.set(wrap.epoch, wrap.wrap);
  list.wraps.set(wrap.member, member);
}

/** An entry of a batch as sent: its text, the entry and its body in their forms. */
interface ParsedEntry { readonly text: string; readonly entry: Entry; readonly body: EntryBody }

/** Each text as an entry and its body, or the first that is not in its form, with its index. */
function parseTexts(texts: readonly string[]): ParsedEntry[] | { readonly index: number; readonly code: string; readonly message: string } {
  const parsed: ParsedEntry[] = [];
  for (const [index, text] of texts.entries()) {
    try {
      const entry = entryFromText(text);
      parsed.push({ text, entry, body: readBody(entry.body) });
    } catch (error) {
      if (error instanceof ListEntryError) return { index, code: error.code, message: error.message };
      throw error;
    }
  }
  return parsed;
}

/** Whether a body is a `join` whose `endpoint` field is this relay key: read as sent, before anything is judged. */
function namesEndpoint(body: EntryBody, endpoint: string): boolean {
  return body.kind === "join" && body.own.some(({ name, value }) => name === "endpoint" && new TextDecoder().decode(value) === endpoint);
}

function seqOfText(text: string): number | null {
  const parsed = parseTexts([text]);
  return Array.isArray(parsed) ? parsed[0]?.body.seq ?? null : null;
}

function hashOfText(text: string): string | null {
  try {
    return entryHash(entryFromText(text).body);
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

/** The text with one byte of its body flipped (the middle one unless said), written again in its one spelling. */
function flipEntryText(text: string, byte?: number): string {
  const entry = entryFromText(text);
  const body = new Uint8Array(entry.body);
  const at = byte ?? Math.floor(body.length / 2);
  body[at] = (body[at] ?? 0) ^ 0x01;
  return entryToText({ body, signature: entry.signature });
}

function flipText(text: string, byte?: number): string {
  const bytes = new Uint8Array(fromBase64Url(text));
  const at = byte ?? Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return toBase64Url(bytes);
}
