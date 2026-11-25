import { canonicalBase64Url, isListHash } from "../../shared/account-list-entry.ts";
import type { Sealed } from "../../shared/account-list.ts";
import type { SignedNaming, SignedVouch } from "../../shared/account-list-migrate.ts";
import { ACCOUNT_ENROLL_MAX, ACCOUNT_RECORDS_MAX, isAccountKeyEncoding } from "../../shared/account-records.ts";
import type { AccountAddRelay, AccountAddTaken } from "../../shared/machines.ts";
import { toBase64Url } from "../../shared/relay-pair-sas.ts";
import type { Access } from "../access.ts";
import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { parseIntroducedList, parseIntroducedPcs } from "./introductions.ts";
import { ACCOUNT_HELD_MAX } from "./holds.ts";
import { AccountAddError } from "../machines.ts";
import { ListAddAway, type AddState } from "./list-add.ts";
import type { JoinOutcome } from "./list-follow.ts";
import { noteListAdd, notePressAsk, pressOnce, waitingForAdd } from "./one-press.ts";
import { applyAccountRecords, applyEnrollment, applyLink, listNamedBy, listNamingOf, LIST_NAMED_LINK, LIST_NAMED_OTHER, LIST_REMOVED_FROM, type LinkRefusal } from "./records.ts";
import { addOverSshByList } from "./ssh-add-list.ts";

const LINK_STATUS: Record<LinkRefusal, number> = {
  record_invalid: 400, signature_invalid: 400, account_mismatch: 409, signer_not_member: 403,
  tombstoned: 409, link_not_owner: 403, key_in_use: 409, account_unavailable: 503, enrolling: 409, removal_pending: 409,
  link_required: 403, unverified_device: 403, pairing_ended: 409, older_device: 403, closed: 409, read_pending: 409,
  replacement_needs_app: 409, list_followed: 409, list_removed: 409, list_named: 409,
};

/**
 * How long the last read of the list answers a row that asks again where its naming stands (POST /api/account/list/named):
 * one read at the account service per pairing in this time. Well under the row's own PAIRING_LINK_MS (30 s, from its
 * pairing on), so the entry that adds the PC is still read while the row that named the list waits: with 30 s here,
 * every ask after the first was answered `waiting` until the row's own time ended its session (auth_revoked), and the
 * QR path could never answer `added`.
 */
export const NAMED_READ_MS = 5_000;

/** The last read of the list for each row that named it, by device store: asked again within NAMED_READ_MS, it is the answer. */
const namedReads = new WeakMap<object, Map<string, { readonly at: number; readonly outcome: Promise<JoinOutcome> }>>();

/** The id of one add by the list (ListAdd), as its starter names it. */
const RUN_ID = /^[0-9a-f]{16}$/;

/** The most entries a member hands this PC in one call (POST /api/account/list/page), and the longest text of one. */
const LIST_PEER_PAGE_MAX = 256;
const LIST_PEER_ENTRY_CHARS = 16_384;

/** The most vouches a device hands this PC with one naming (POST /api/account/list/name). */
const LIST_NAMING_VOUCHES_MAX = 16;

/** What `ovis join` is told where this PC joins no list (POST /api/account/list/join…), by the refusal's name. */
const JOIN_REFUSALS: Readonly<Record<string, string>> = {
  invalid_list: "Name the account, its list and the invite by their ids.",
  other_account: "This PC is in another account.",
  pinned: "This PC already follows another list. Revoke all on this PC to leave its account first.",
  removed: LIST_REMOVED_FROM,
  unavailable: "This PC's relay identity, its list or its keys cannot be read or written.",
  other_adder: "The list holds this PC already, by another entry than this invite's.",
  other_keys: "The list holds this PC by an entry with other keys than its own.",
  line_unproven: "The invite's line did not sign for this PC and this list.",
  not_read: "The account's list could not be read from the account service.",
  invite_unknown: "The account's list holds no such invite.",
  invite_revoked: "This invite was revoked.",
  invite_void: "This invite no longer counts: the device that made it is out of the account.",
  invite_spent: "This invite was used already.",
  invite_expired: "This invite ran out.",
  invite_plain: "This invite adds a PC only once a device of the account chooses Add.",
  invite_uses: "This invite lets more than one PC in, so no PC joins with it by itself.",
  not_written: "This PC's join would not count on the account's list.",
  behind: "Ovis on this PC is older than what a device wrote into the account's list, so this PC cannot join it by itself. Update Ovis on this PC (Settings → Updates), then run this again. Nothing was written to the list.",
};

/**
 * /api/account/* (docs/account.md, "PC API"): drive access only, directly or through the relay,
 * and the app's own mutation guard for changes.
 */
export async function handleAccountRequest(request: Request, pathname: string, context: ServerContext, access: Access): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const limited = () => {
    const refused = fail("rate_limited", "Too many calls; try again in a minute", 429);
    refused.headers.set("retry-after", "60");
    return refused;
  };
  // An add by the list that still runs counts as waiting for Add (GET /api/account/status). What was asked of a run that
  // was replaced tells nothing of the run that stands, which keeps its own
  const noted = (state: AddState): AddState => {
    if (state.state !== "replaced") noteListAdd(devices, state.state === "waiting" || state.state === "number" || state.state === "confirmed");
    return state;
  };
  const devices = context.services.devices;
  const peer = context.peer;
  // a device that waits to link (it paired with a code made for a PC in no account; docs/account.md, "Who may admit
  // a device") makes two calls here: it reads its own status, and sends its link
  const waiting = peer.kind === "relay" && peer.device.provisional === true ? peer.device.id : null;
  // the one route a watching device may use: its own introduction, over its own session
  if (pathname === "/api/account/introduction" && request.method === "GET") {
    setRequestRoute(pathname);
    const pcs = peer.kind === "relay" ? context.services.accountIntroductions.get(peer.key) : null;
    // on a PC that follows no list, the member that allowed this device names its place in the account's list here;
    // one that follows the list says it in AUTH_OK instead, and names none here: never both
    const list = peer.kind === "relay" && !devices.listFollowed() ? context.services.accountIntroductions.list(peer.key) : null;
    return pcs ? reply({ pcs, ...(list ? { list } : {}) }) : fail("introduction_none", "No introduction waits for this device", 404);
  }
  if (waiting !== null && pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    // this one body, whatever else the PC holds: it names no account, and no mailbox is read for it (`fresh` is
    // ignored). The read is a moment the device's time is judged at
    if (!devices.provisionalStands(waiting)) return fail("link_required", "This device did not link itself into an account in time. Pair it again.", 403);
    return reply({ account: null, members: 0, unlinked: [waiting], own_word: [], removals: [], adds: [], blocked: [], enrolling: false, blocked_all: false, mailbox: { last_pull_at: null, error: null } });
  }
  // A member and this PC say where the account's signed list stands, and the member hands the PC the entries it lacks
  // (docs/account.md, "What the account service still can"). Any device that is signed in may, one that only watches
  // too: an entry proves itself, so nothing is taken on the device's word, and a removal the account service
  // withholds reaches the PC this way. A PC that follows no list a person named answers 404
  if (waiting === null && access.level === "full" && request.method === "POST" && (pathname === "/api/account/list/head" || pathname === "/api/account/list/page")) {
    setRequestRoute(pathname);
    if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Manage the account from this app", 403);
    const list = context.services.accountList;
    const own = list?.peerHead() ?? null;
    if (list === null || own === null) return fail("not_found", "This PC follows no list", 404);
    // Each call may cost signature checks: 30 a minute for one caller, charged before its body is read. A caller is the
    // key the PC let the session in by (a device's sessions share its count), or this PC's own window and direct clients
    const session = peer.kind === "relay" ? `key ${peer.key}` : "direct";
    if (!list.peerBudget(session)) return limited();
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    // the PC may have left its list while the body was on its way: the call is answered as a new one would be
    const now = list.peerHead();
    if (now === null) return fail("not_found", "This PC follows no list", 404);
    const placeOf = (value: unknown): { seq: number; hash: string } | null => {
      const { seq, hash } = (typeof value === "object" && value !== null ? value : {}) as { seq?: unknown; hash?: unknown };
      return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 && typeof hash === "string" && isListHash(hash) ? { seq, hash } : null;
    };
    if (pathname === "/api/account/list/head") {
      // where the device stands: its list and the last entry a member signed in its copy, or null before it read any
      const theirs = body.place === null ? null : placeOf(body.place);
      // and, where it wants them, this PC's own entries after a place it names (its own read: a place where the two
      // differ, or the search for where they part): a list id and a place, or null for entry 0. Left out when there is
      // none; a read sent as null is out of form
      const { asks } = body as { asks?: unknown };
      const read = typeof asks === "object" && asks !== null ? asks as { list?: unknown; after?: unknown } : null;
      const wanted = asks === undefined ? null
        : read !== null && typeof read.list === "string" && isListHash(read.list) && (read.after === null || (typeof read.after === "number" && Number.isSafeInteger(read.after) && read.after >= 0))
          ? { list: read.list, after: read.after } : undefined;
      if (typeof body.list !== "string" || !isListHash(body.list) || (body.place !== null && theirs === null) || wanted === undefined) {
        return fail("invalid_head", "Send the list's id and the place the device stands at", 400);
      }
      // the read is answered only to a key this PC's list lets in now; any other signed-in row gets the plain exchange
      const member = peer.kind === "relay" && list.role(peer.key) != null;
      const answered = list.peerHeads({ list: body.list, place: theirs }, session, member ? wanted : null);
      return answered === null ? fail("not_found", "This PC follows no list", 404) : reply(answered);
    }
    const { entries, after } = body as { entries?: unknown; after?: unknown };
    const head = placeOf(body.head);
    if (body.list !== now.list) return fail("not_my_list", "This PC follows another list", 409);
    if (!Array.isArray(entries) || entries.length > LIST_PEER_PAGE_MAX || !entries.every((entry) => typeof entry === "string" && entry.length <= LIST_PEER_ENTRY_CHARS)
      || !(after === null || (typeof after === "number" && Number.isSafeInteger(after) && after >= 0)) || head === null) {
      return fail("invalid_page", "Send the entries after a place, and the head they lead to", 400);
    }
    const taken = await list.takePeerPage({ list: now.list, after, entries: entries as string[], head }, session);
    if (taken === null) return fail("not_found", "This PC follows no list", 404);
    // Verified and acted on, and not on disk: the device is not told the page was taken, and hands it again later
    if (taken.verdict === "not_saved") return fail("not_saved", "This PC could not save the entries it was handed; hand them again later.", 503);
    // a page nobody asked for whose first entry follows no entry this PC holds: no signature of it was checked
    if (taken.verdict === "unasked") return fail("not_continued", "Those entries do not follow this PC's copy of the list. Ask where it stands first (POST /api/account/list/head).", 409);
    const stands = list.peerHead();
    if (stands === null) return fail("not_found", "This PC follows no list", 404);
    return reply({ verdict: taken.verdict, ...(taken.asks ? { asks: taken.asks } : {}), ...stands });
  }
  const ownLink = waiting !== null && (pathname === "/api/account/link" || pathname === "/api/account/list/named") && request.method === "POST";
  if (!ownLink && (access.level !== "full" || access.role !== "drive")) return fail("read_only", "this device can only watch", 403);
  if (pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    const mailbox = context.services.accountMailbox;
    // a client about to enroll another PC reads this one's removals after its mailbox, so one waiting there counts too
    const fresh = new URL(request.url).searchParams.get("fresh") === "1" ? await mailbox.freshen() : undefined;
    const blocked = [...new Set([...devices.tombstoneKeys(), ...mailbox.waitingRemoveKeys(), ...context.services.accountHolds.list()])];
    return reply({
      account: devices.account(), ...(devices.accountPolicyActive() ? { pc_add_from_account: devices.accountError === null ? true : "unavailable" } : {}),
      // a PC its account stopped listing: a device sends it no link, and an add at the PC brings it back (docs/account.md)
      ...(devices.addAtPcRequired() ? { pc_add_required: true } : {}),
      ...devices.accountRows(), removals: devices.accountRemovals(), adds: devices.accountAdds(), blocked,
      enrolling: context.services.accountHolds.enrolling(), blocked_all: mailbox.holdsEveryAdd(), ...(fresh === undefined ? {} : { fresh }), mailbox: { last_pull_at: mailbox.lastPullAt, error: mailbox.error },
      // a yes or no only, never the account asked for: the account is named here once this PC is in it
      waiting_for_add: waitingForAdd(devices),
      // a PC pinned to its account's list: which list, where the PC stands in it, and why it lets nobody in when it does not
      ...(context.services.accountList?.summary() ? { list: context.services.accountList.summary() } : {}),
      // a staging run that turned the waits of a move onto the list down (server/account/migrate-time.ts)
      ...((context.services.accountWitness?.scale ?? 1) !== 1 ? { migrate_time_scale: context.services.accountWitness!.scale } : {}),
    });
  }
  if (pathname === "/api/account/list/witness" && request.method === "GET") {
    setRequestRoute(pathname);
    // A device of this PC's account asks, before the account moves onto its signed list, whom this PC lets in through
    // the account and for how long (docs/account-list.md, "An account that was in use"): the device's own session, or
    // this PC's own window. Keys and durations only, and of removals the keys alone, never why
    if (peer.kind === "relay" && !devices.accountSession(peer.device.id, peer.key)) return fail("account_required", "Ask this from a device of this PC's account", 403);
    // within the caller's calls a minute, with the list's other session calls
    if (context.services.accountList?.peerBudget(peer.kind === "relay" ? `key ${peer.key}` : "direct") === false) return limited();
    const account = devices.account();
    if (account === null) return fail("not_in_account", "This PC is in no account", 409);
    // a PC in its account whose rows cannot be read now has no answer: that is not an answer that nobody is let in
    const held = context.services.accountWitness?.admits() ?? null;
    if (held === null || held.account !== account) return fail("witness_unavailable", "This PC cannot say now whom it lets in; ask again later", 503);
    const removed = [...new Set([...devices.removalKeys(), ...context.services.accountHolds.list()])].sort();
    return reply({ account, pinned: context.services.accountList?.summary()?.pinned_list ?? null, admits: held.admits, removed });
  }
  if (pathname === "/api/account/list" && request.method === "GET") {
    setRequestRoute(pathname);
    // this PC's own window and CLI alone (dispatch.ts ownWindow)
    const list = context.services.accountList;
    return list === null ? fail("not_found", "This PC follows no list", 404) : reply(list.status());
  }
  if (pathname === "/api/account/list/add" && request.method === "GET") {
    setRequestRoute(pathname);
    // this PC's own window and CLI alone (dispatch.ts ownWindow): the number is shown only at this PC
    const add = context.services.listAdd;
    if (add === null) return fail("not_found", "This PC follows no list", 404);
    // `run`: the run the caller started. Another one in its place is answered `replaced`, and nothing of it is told
    const run = new URL(request.url).searchParams.get("run");
    if (run !== null && !RUN_ID.test(run)) return fail("invalid_run", "Name the run by its id", 400);
    return reply(noted(await add.state(run ?? undefined)));
  }
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Manage the account from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const serverId = peer.kind === "relay" ? peer.serverId : context.services.relay.currentIdentity()?.server_id ?? null;
  switch (pathname) {
    case "/api/account/relay-account": {
      setRequestRoute(pathname);
      // the account this PC asks its relay pass under (docs/relay.md, "Relay pass"): named over a direct
      // connection with drive access (the PC's own screen, after listing it), or through the relay only by a
      // member of this PC's own account
      const account = body.account;
      // null forgets the one named, over a direct connection only and only on a PC in no account (`ovis join` that ended
      // unbound puts back what it found): a PC bound to an account keeps the name its pass is asked under
      if (account === null && peer.kind !== "relay") {
        if (devices.account() !== null) return fail("in_account", "This PC is in an account: its name stays", 409);
        context.services.relay.clearRelayAccount();
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      if (peer.kind === "relay" && !(devices.isAccountApproverSession(peer.device.id, peer.key) && devices.account() === account)) return fail("account_required", "Name this PC's account from a device linked to it", 403);
      if (!context.services.relay.setRelayAccount(account)) return fail("invalid_account", "Name the account", 400);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/pc-proof": {
      setRequestRoute(pathname);
      // this PC's own window or CLI alone (dispatch.ts ownWindow): the proof lists the PC again after its leave
      try { return reply(await context.services.accountMailbox.listingProof()); }
      catch (error) { return fail("account_unavailable", error instanceof Error ? error.message : String(error), 503); }
    }
    case "/api/account/list/pin": {
      setRequestRoute(pathname);
      // a person at this PC names the list of its account: this PC's own window and CLI alone (dispatch.ts ownWindow)
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      if (typeof body.list !== "string") return fail("invalid_list", "Name the list by its id", 400);
      const named = await list.wantList(body.list);
      if ("status" in named) return reply(named.status);
      const refusals = {
        invalid_list: ["Name the list by its id: 64 characters of 0-9 and a-f", 400],
        not_in_account: ["Add this PC to your account first.", 409],
        pinned: ["This PC already follows another list. Revoke all on this PC to leave its account first.", 409],
        removed: [LIST_REMOVED_FROM, 409],
        unavailable: ["This PC's list or its keys cannot be read or written.", 503],
      } as const;
      const [message, status] = refusals[named.refused];
      return fail(named.refused === "removed" ? "list_removed" : named.refused, message, status);
    }
    case "/api/account/list/add": {
      setRequestRoute(pathname);
      // a person at this PC adds it to an account that keeps a signed list (dispatch.ts ownWindow): the PC posts its
      // card, and shows the number to compare with the phone that adds it. `no_list`: the account keeps none
      const add = context.services.listAdd;
      if (add === null) return fail("not_found", "This PC follows no list", 404);
      const account = body.account;
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      // as one press: the account named for this PC, a PC in no account, and never one that account's list removed
      if (context.services.relay.savedRelayAccount() !== account) return fail("account_mismatch", "This PC was set up for another account. Sign in to that one, or add this PC again.", 409);
      // in an account already: only a PC that follows that account's list with no key of its own in it is added so, for its keys
      if (devices.account() !== null && !(devices.account() === account && context.services.accountList?.needsKeys() === true)) return fail("in_account", "This PC is already in an account", 409);
      if (devices.listRemovedFrom(account)) return fail("list_removed", LIST_REMOVED_FROM, 409);
      try { return reply(noted(await add.start(account))); }
      catch (error) {
        if (!(error instanceof ListAddAway)) throw error;
        return fail("account_unavailable", error.message, 503);
      }
    }
    case "/api/account/list/add/confirm": {
      setRequestRoute(pathname);
      // the person at this PC says the phone shows the same number, and says which: only that names the list
      const add = context.services.listAdd;
      if (add === null) return fail("not_found", "This PC follows no list", 404);
      if (typeof body.digits !== "string" || !/^[0-9]{6}$/.test(body.digits)) return fail("invalid_digits", "Send the six digits this PC shows", 400);
      if (body.run !== undefined && (typeof body.run !== "string" || !RUN_ID.test(body.run))) return fail("invalid_run", "Name the run by its id", 400);
      const outcome = await add.confirm(body.digits, body.run);
      // a number that is not the one on this PC's screen confirms nothing and ends that number; the answer names none
      if ("mismatch" in outcome) return fail("wrong_number", "That is not the number this PC shows now, so nothing was confirmed. A number lasts 2 minutes, and a wrong one ends it: have the device ask again.", 409);
      return reply("confirmed" in outcome ? noted(outcome.confirmed) : outcome);
    }
    case "/api/account/list/add/cancel": {
      setRequestRoute(pathname);
      const add = context.services.listAdd;
      if (add === null) return fail("not_found", "This PC follows no list", 404);
      if (body.run !== undefined && (typeof body.run !== "string" || !RUN_ID.test(body.run))) return fail("invalid_run", "Name the run by its id", 400);
      return reply(noted(await add.cancel(body.run)));
    }
    case "/api/account/list/join":
    case "/api/account/list/join/prepare":
    case "/api/account/list/join/body":
    case "/api/account/list/join/place": {
      setRequestRoute(pathname);
      // `ovis join` at this PC, with the line of an invite that names the account's list (dispatch.ts ownWindow): a
      // person confirmed the account there, and the line names the list. The line itself stays with the command
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      const { account, list: id } = body;
      if (typeof account !== "string" || typeof id !== "string") return fail("invalid_list", "Name the account and its list", 400);
      const inAccount = devices.account();
      if (inAccount !== null && inAccount !== account) return fail("in_account", "This PC is already in an account", 409);
      if (inAccount === null && context.services.relay.savedRelayAccount() !== account) return fail("account_mismatch", "This PC was set up for another account. Sign in to that one, or add this PC again.", 409);
      if (devices.listRemovedFrom(account)) return fail("list_removed", LIST_REMOVED_FROM, 409);
      const refusal = (code: string, detail?: string | null) => fail(code === "removed" ? "list_removed" : code, JOIN_REFUSALS[code] ?? `This PC could not join the account's list (${detail ?? code}).`, code === "unavailable" || code === "not_read" ? 503 : 409);
      const ended = async (outcome: JoinOutcome | { readonly again: true } | { readonly refused: string; readonly detail?: string | null }): Promise<Response> => {
        if ("again" in outcome) return reply({ state: "again" });
        if ("refused" in outcome) return refusal(outcome.refused, "detail" in outcome ? outcome.detail : null);
        if ("waiting" in outcome) return reply({ state: "waiting", standing: outcome.waiting });
        context.services.accountMailbox.joinedByList();
        return reply({ state: "added", account });
      };
      const invite = body.invite;
      if (typeof invite !== "string") return fail("invalid_invite", "Name the invite by its key", 400);
      // An invite a person adds a PC with: the PC joins once the list holds its entry. The line is what names the
      // list, so the caller shows that it holds the line: first it is handed this PC's own card for that list, which
      // the line signs its proof for (signLineProof), then it sends that proof with every ask. A list id alone, even
      // from this PC's own window, names nothing
      if (pathname === "/api/account/list/join") {
        if (body.proof === undefined) {
          const card = await list.lineCard(id);
          return card === null ? refusal("unavailable") : reply({ state: "prove", card });
        }
        if (typeof body.proof !== "string") return fail("invalid_invite", "Send the line's signature", 400);
        return await ended(await list.joinByLine({ account, list: id, invite, proof: body.proof }));
      }
      if (pathname === "/api/account/list/join/prepare") {
        const prepared = await list.joinPrepare({ account, list: id, invite });
        if ("prove" in prepared) return reply({ state: "prove", card: prepared.prove });
        return "prepared" in prepared ? reply({ state: "prepared", ...prepared.prepared }) : await ended(prepared);
      }
      if (pathname === "/api/account/list/join/body") {
        const { seq, sealed } = body as { seq?: unknown; sealed?: unknown };
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return fail("invalid_join", "Name the place the join takes", 400);
        let names: Sealed | null = null;
        if (sealed !== undefined && sealed !== null) {
          const { epoch, bytes } = sealed as { epoch?: unknown; bytes?: unknown };
          const read = typeof bytes === "string" && bytes.length <= 4096 ? canonicalBase64Url(bytes) : null;
          if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || read === null) return fail("invalid_join", "The sealed names are an epoch and bytes", 400);
          names = { epoch, bytes: read };
        }
        const built = await list.joinBody({ account, list: id, invite, seq, sealed: names });
        return "body" in built ? reply({ state: "body", body: toBase64Url(built.body) }) : await ended(built);
      }
      const { entry, wraps } = body as { entry?: unknown; wraps?: unknown };
      const given = wraps === undefined ? [] : Array.isArray(wraps) && wraps.length <= 4 ? wraps.flatMap((wrap: unknown) => {
        const { epoch, member, wrap: text } = (typeof wrap === "object" && wrap !== null ? wrap : {}) as { epoch?: unknown; member?: unknown; wrap?: unknown };
        return typeof epoch === "number" && Number.isSafeInteger(epoch) && typeof member === "string" && typeof text === "string" && text.length <= 1024 ? [{ epoch, member, wrap: text }] : [];
      }) : null;
      if (typeof entry !== "string" || entry.length > 16_384 || given === null || (Array.isArray(wraps) && given.length !== wraps.length)) return fail("invalid_join", "Send the signed join and its wraps", 400);
      return await ended(await list.joinPlace({ account, list: id, invite, entry, wraps: given }));
    }
    case "/api/account/one-press": {
      if (!devices.opensAll()) return fail("not_found", "Unknown account action", 404);
      setRequestRoute(pathname);
      // only the PC's owner here names the account it joins: never a device through the relay (security-triage, t13r)
      if (peer.kind === "relay") return fail("owner_only", "Add this PC to your account on this PC itself.", 403);
      const account = body.account;
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      const pressed = await pressOnce(context.services, account);
      notePressAsk(devices, pressed);
      return "refused" in pressed ? fail(pressed.refused.code, pressed.refused.message, pressed.refused.status) : reply(pressed);
    }
    case "/api/account/ssh-add": {
      if (!devices.opensAll()) return fail("not_found", "Unknown account action", 404);
      setRequestRoute(pathname);
      // only this PC's owner here vouches for another PC with this PC's account (dispatch.ts ownWindow refuses the rest)
      if (peer.kind === "relay") return fail("owner_only", "Add another PC to your account from this PC itself.", 403);
      // the account comes from this PC's own binding, never from the request
      const account = devices.account();
      if (account === null || devices.accountError !== null) return fail("not_in_account", "Add another PC to your account from a PC that is in it.", 409);
      const { job_id: jobId, server_id: target } = body;
      if (typeof jobId !== "string" || typeof target !== "string") return fail("invalid_body", "Name the setup job and the PC it reached", 400);
      if (target === context.services.relay.currentIdentity()?.server_id) return fail("self", "That is this PC.", 409);
      const machines = context.services.core.machines;
      if (!machines) return fail("not_found", "This PC adds no other PCs", 404);
      // that PC waits up to ADDED_RELAY_ONLINE_MS for its relay after its press: more than the default budget of an API call
      context.timeout(request, 120);
      let taken: { account: string; relay: AccountAddRelay | null; unanswered?: true; listJoined?: true };
      // A PC that follows its account's signed list adds another one by that list alone: it names the list and its own
      // key over the SSH channel and signs that PC's entry itself (ssh-add-list.ts). With no list, as ever
      const list = context.services.accountList;
      try {
        if (list === null || !list.pinned()) taken = await machines.accountTake(jobId, target, account);
        else {
          const endpoint = machines.accountAddEndpoint(jobId);
          if (endpoint === null) return fail("job_not_found", "No add over SSH of that PC is waiting here. Connect to it again.", 404);
          const byList = await addOverSshByList({ endpoint, list, take: (named) => machines.accountTake(jobId, target, account, named), end: () => machines.accountAddEnd(jobId) });
          if ("refused" in byList) return fail(byList.refused.code, byList.refused.message, byList.refused.status);
          taken = byList;
        }
      } catch (error) {
        if (!(error instanceof AccountAddError)) throw error;
        return fail(error.code, error.message, error.code === "job_not_found" ? 404 : 409);
      }
      // this PC left or changed its account while that PC took it: that PC is in the account named then, and says so
      if (devices.account() !== taken.account) return fail("account_changed", "This PC's account changed while the other PC was being added.", 409);
      return reply({ account: taken.account, server_id: target, relay: taken.relay, ...(taken.unanswered ? { unanswered: true as const } : {}),
        ...("listJoined" in taken && taken.listJoined === true ? { list_joined: true as const } : {}) } satisfies AccountAddTaken);
    }
    case "/api/account/introduce": {
      setRequestRoute(pathname);
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key)) return fail("account_required", "Introduce devices from a device linked to the account", 403);
      if (typeof body.key !== "string" || !devices.wasAddedByMember(body.key)) return fail("introduction_unknown_key", "No account member added that device here", 404);
      const pcs = parseIntroducedPcs(body.pcs);
      if (!pcs) return fail("introduction_invalid", "List at most 32 PCs, each with a server_id its key derives", 400);
      // `list`: the device's place in the account's signed list, as the member that signed it in names it. Carried for
      // the device, form checked only; a PC that follows the list itself tells the device its place, and keeps none
      const list = body.list === undefined ? undefined : parseIntroducedList(body.list);
      if (list === null) return fail("introduction_invalid", "Name the list by its id and the place of the device's entry", 400);
      context.services.accountIntroductions.set(body.key, pcs, devices.listFollowed() ? undefined : list);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/list/name": {
      setRequestRoute(pathname);
      // A device of this PC's account names the account's signed list in its own session, signed in with its key
      // (docs/account-list.md, "An account that was in use"): the PC follows it only on what it holds itself (V4-1)
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      if (peer.kind !== "relay" || peer.key === "") return fail("session_required", "Name the list from the device's own session", 403);
      // each call may cost signature checks and a read of the account service: within the session's calls a minute
      if (!list.peerBudget(`key ${peer.key}`)) return limited();
      const { naming, vouches = [] } = body as { naming?: unknown; vouches?: unknown };
      if (typeof naming !== "object" || naming === null || Array.isArray(naming) || !Array.isArray(vouches) || vouches.length > LIST_NAMING_VOUCHES_MAX) {
        return fail("invalid_naming", `Send the naming, and at most ${LIST_NAMING_VOUCHES_MAX} vouches`, 400);
      }
      if (devices.account() === null) return fail("not_in_account", "This PC is in no account", 409);
      const outcome = await list.nameList({ session: peer.key, naming: naming as SignedNaming, vouches: vouches as SignedVouch[] });
      return reply(outcome);
    }
    case "/api/account/list/card": {
      setRequestRoute(pathname);
      // A device the list this PC is pinned to holds to drive with full power asks, in its own session, for this PC's
      // card: it signs the `pc` entry that gives this PC its keys (docs/account-list.md, "An account that was in use")
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      if (peer.kind !== "relay" || peer.key === "") return fail("session_required", "Ask for this PC's card from the device's own session", 403);
      // each call posts this PC's keys at the account service: within the session's calls a minute
      if (!list.peerBudget(`key ${peer.key}`)) return limited();
      const asked = await list.cardForMember(peer.key);
      if ("card" in asked) return reply(asked.card);
      const refusals = {
        not_pinned: ["This PC follows no list.", 409],
        not_member: ["Only a device that can add devices to your account's list may add this PC to it.", 403],
        has_keys: ["Your account's list holds this PC's keys already.", 409],
        unavailable: ["This PC's list, its keys or the account service cannot be used now; try again.", 503],
      } as const;
      const [message, status] = refusals[asked.refused];
      return fail(asked.refused === "not_member" ? "list_cannot_allow" : asked.refused === "has_keys" ? "list_holds_pc" : asked.refused, message, status);
    }
    case "/api/account/list/named": {
      setRequestRoute(pathname);
      // A device that scanned this PC's QR code names its account's signed list over the pairing that code made, in
      // the place of its link: every rule of a link holds for it (listNamedBy). The PC then joins by that list alone,
      // once the list holds its entry signed by that device's key; this call writes no member
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      if (peer.kind !== "relay") return fail("link_not_owner", "Name the list from the device's own connection through the relay", 403);
      const { account, list: id } = body;
      if (typeof account !== "string" || typeof id !== "string" || !isListHash(id)) return fail("invalid_list", "Name the account and its list", 400);
      // The first naming is one of the row's few tries, as a link is; asking again where it stands is not, and a naming
      // of another list is refused before it spends one
      const before = listNamingOf(devices, peer.device.id);
      const again = before !== undefined && before.account === account && before.list === id && before.key === peer.key;
      if (before !== undefined && !again) return fail("pairing_ended", LIST_NAMED_OTHER, LINK_STATUS.pairing_ended);
      const arrival = devices.linkArrived(peer.device.id, peer.device.provisional === true, !again);
      if (arrival === null) return fail("link_required", "The list was not named: link_required", LINK_STATUS.link_required);
      const named = await listNamedBy(devices, { account, list: id }, { deviceId: peer.device.id, sessionKey: peer.key }, arrival, {
        setUpFor: () => context.services.relay.savedRelayAccount(),
        vouch: (of, key, firstLink) => context.services.accountMailbox.vouch(of, key, firstLink),
      });
      if ("refused" in named) {
        const refused = fail(named.refused, named.message ?? `The list was not named: ${named.refused}`, LINK_STATUS[named.refused]);
        if (named.retryAfter !== undefined) refused.headers.set("retry-after", String(named.retryAfter));
        return refused;
      }
      // Each read of the list costs this PC a read at the account service with its own proof: a row that asks again
      // where its naming stands is answered from the last read for NAMED_READ_MS, one read at a time
      const reads = namedReads.get(devices) ?? new Map<string, { readonly at: number; readonly outcome: Promise<JoinOutcome> }>();
      namedReads.set(devices, reads);
      const now = devices.waitClock().now();
      const last = again ? reads.get(peer.device.id) : undefined;
      let reading = last !== undefined && now - last.at >= 0 && now - last.at < NAMED_READ_MS ? last.outcome : null;
      if (reading === null) {
        const asked = list.joinList({ account, list: id, by: peer.key });
        reading = asked;
        reads.set(peer.device.id, { at: now, outcome: asked });
        // a read that failed answers nobody after it
        asked.catch(() => { if (reads.get(peer.device.id)?.outcome === asked) reads.delete(peer.device.id); });
      }
      const joined = await reading;
      if ("joined" in joined) {
        context.services.accountMailbox.joinedByList();
        return reply({ state: "added", account });
      }
      if ("refused" in joined) return fail(joined.refused === "removed" ? "list_removed" : joined.refused, JOIN_REFUSALS[joined.refused] ?? `This PC could not join the account's list (${joined.refused}).`, joined.refused === "unavailable" ? 503 : 409);
      // its card, handed over this very pairing: what the device signs into the entry that adds this PC
      const card = await list.cardFor(id);
      if (card === null) return fail("unavailable", JOIN_REFUSALS.unavailable!, 503);
      return reply({ state: "waiting", standing: joined.waiting, ...card });
    }
    case "/api/account/link": {
      setRequestRoute(pathname);
      // a link proves the key of the row whose session sends it, and only the relay carries a row's key
      if (peer.kind !== "relay") return fail("link_not_owner", "Link a device from its own connection through the relay", 403);
      // a row that named its account's signed list is added by that list or not at all: its link spends none of its tries
      if (listNamingOf(devices, peer.device.id) !== undefined) return fail("list_named", LIST_NAMED_LINK, LINK_STATUS.list_named);
      // what stood when the link arrived, before its signature is checked: its checks are held to it. A row that
      // waits to link sends five links, whatever each is answered; the next turned it away
      const arrival = devices.linkArrived(peer.device.id, peer.device.provisional === true);
      if (arrival === null) return fail("link_required", "The link was refused: link_required", LINK_STATUS.link_required);
      // a link that may bring this PC into an account: account adds wait until its member enrolls it. On disk
      // first, so a stop keeps them waiting; never lifted by a refused link, as another may be on its way
      // (with no account here no add applies anyway, and the next first member takes the barrier over)
      if (context.services.accountHolds.error !== null) return fail("account_unavailable", context.services.accountHolds.error, 503);
      const first = devices.account() === null;
      // a barrier confirmed by a member who has since left (the PC has no account again) is this link's to take over.
      // Nothing of a device that waits to link is written before its link has passed every check: its barrier goes to
      // disk in the turn that writes its row, before it (applyLink). So one whose link is refused, or outlives its
      // time, leaves none
      if (first && !arrival.provisional) context.services.accountHolds.startEnrolling(peer.device.id, { stale: true });
      const linked = await applyLink(devices, body.record, { deviceId: peer.device.id, serverId: peer.serverId, sessionKey: peer.key, sessionId: peer.sessionId }, arrival, {
        gates: context.services.accountMailbox.gates(),
        barrier: () => context.services.accountHolds.startEnrollingBeforeRow(peer.device.id),
        setUpFor: () => context.services.relay.savedRelayAccount(),
        vouch: (account, key, firstLink) => context.services.accountMailbox.vouch(account, key, firstLink),
      });
      if ("refused" in linked) {
        const refused = fail(linked.refused, linked.message ?? `The link was refused: ${linked.refused}`, LINK_STATUS[linked.refused]);
        // when the PC may ask the account service again: the device sends the same link after it
        if (linked.retryAfter !== undefined) refused.headers.set("retry-after", String(linked.retryAfter));
        return refused;
      }
      // the wait is this device's to end: a link refused meanwhile may have named another; the first link that succeeds keeps it
      if (first) context.services.accountHolds.confirmEnrolling(peer.device.id);
      return reply({ device: linked.device });
    }
    case "/api/account/records": {
      setRequestRoute(pathname);
      const records = body.records;
      if (!Array.isArray(records) || records.length > ACCOUNT_RECORDS_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_RECORDS_MAX} records`, 400);
      const mailbox = context.services.accountMailbox;
      // with the release flag on a block applies at once, each with its own receipt (T51, T60); an app that sends none
      // gets today's answer
      const blocks = context.services.safetyLog === null ? [] : records.filter((record) => (record as { kind?: unknown } | null)?.kind === "block");
      const wasMember = blocks.length > 0 && peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      const receipts = [];
      for (const block of blocks) receipts.push(await devices.applyBlock(block, "handed"));
      const gates = { ...mailbox.gates(), safetyLog: context.services.safetyLog, deferAdd: devices.opensAll() ? (record: unknown) => mailbox.wait(record) : undefined,
        requestRead: devices.opensAll() ? () => { void mailbox.readSnapshot(); } : undefined };
      const remaining = records.filter((record) => !blocks.includes(record));
      // Only a current member's session may leave a removal waiting. A session blocked in this batch may do neither that nor apply any other record.
      const member = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      const results = wasMember && !member
        ? remaining.map((record: unknown) => ({
          id: typeof record === "object" && record !== null && "id" in record && typeof record.id === "string" ? record.id : null,
          outcome: "refused", code: "account_required",
        }))
        : await applyAccountRecords(devices, remaining, serverId, Date.now(), gates, member ? (record) => mailbox.wait(record) : undefined);
      return reply({ results, ...(blocks.length > 0 ? { receipts } : {}) });
    }
    case "/api/account/enroll": {
      setRequestRoute(pathname);
      const { records, held, held_full: heldFull, last } = body;
      if (!Array.isArray(records) || records.length > ACCOUNT_ENROLL_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_ENROLL_MAX} records`, 400);
      if ((last !== undefined && typeof last !== "boolean") || (heldFull !== undefined && typeof heldFull !== "boolean")) return fail("record_invalid", "last and held_full are true or false", 400);
      if (held !== undefined && (!Array.isArray(held) || held.length > ACCOUNT_HELD_MAX || !held.every(isAccountKeyEncoding))) return fail("record_invalid", `Hold at most ${ACCOUNT_HELD_MAX} account keys`, 400);
      // what a member hands a PC it brought into the account: the caller is a member of that account here already
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key) || typeof body.account !== "string" || devices.account() !== body.account) {
        return fail("account_required", "Link this device to the account on this PC first", 403);
      }
      const holds = context.services.accountHolds;
      const mailbox = context.services.accountMailbox;
      if (holds.error !== null) return fail("account_unavailable", holds.error, 503);
      // before any add, and before the barrier lifts: the keys the member found removed elsewhere stay out of every path
      holds.hold(held ?? []);
      // more keys than one enrollment carries: every add is held back from now on, rather than one let in by the cut
      if (heldFull === true) holds.overflow();
      const gates = mailbox.gates();
      // only the member whose link brought this PC in hands over its adds during the wait; another member's wait with the mailbox's
      // the member whose link brought this PC in, or any member once that one is no longer a drive member here (revoked, say)
      const named = holds.enrollingMember();
      const linker = named === peer.device.id || (named !== null && !devices.isAccountApprover(named));
      const results = await applyEnrollment(devices, records, serverId, { gates: { enrolling: () => !linker && holds.enrolling(), held: gates.held, ...(gates.removing ? { removing: gates.removing } : {}) }, wait: (record) => mailbox.wait(record), settle: () => mailbox.settle() });
      // only the member that linked this PC ends its wait, with the last part of its enrollment, once every remove was decided
      const undecided = results.some((result) => result.outcome === "refused" && result.code === "account_unavailable");
      if (last !== false && !undecided && linker) {
        // the hand-over is journalled before the barrier ends: a journal that cannot be written keeps it (T14)
        devices.journalEvent({ kind: "account", how: "enrolled", key: peer.key, no: null, row: peer.device.id, label: peer.device.label, by: null, account: body.account });
        holds.endEnrolling();
        await mailbox.settle();
      }
      return reply({ results });
    }
    default: return fail("not_found", "Unknown account action", 404);
  }
}
